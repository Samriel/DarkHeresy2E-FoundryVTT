/**
 * Fate points (core rulebook, Russian edition p. 357–358, «Использование Очков Судьбы» and «Сжигание Судьбы»).
 *
 * Spending a Fate point is a free action, on the character's turn or in reaction, and does one of:
 * - re-roll a test (chat card context menu);
 * - +10 to a test, chosen before the roll (checkbox in the roll dialog);
 * - +1 degree of success to a successful test, after the roll (chat card context menu);
 * - roll 10 for initiative;
 * - remove 1d5 damage at once (not critical damage);
 * - recover from Stunned at once;
 * - remove all levels of Fatigue.
 * The last four are in the Fate dialog on the character sheet.
 *
 * Burning Fate: facing certain death the character permanently lowers the Fate threshold by 1 (current points
 * drop to the new threshold, so burning works with no points left) and survives, out of the fight; with critical
 * damage he suffers every effect but death. Results that kill offer it on their chat card.
 *
 * Items that change Fate:
 * - Malignancy «Неудачливый» / Unlucky (table 8-15, p. 355): roll 1d10 on each spent point, 7–10 wastes it.
 * - Mutation «Это не умрёт!» / It Will Not Die (table 8-16, p. 356): cannot burn Fate to survive; survives as if
 *   it did and gains 1d10+5 Corruption.
 * - Daemonic pact boon «Судьба, сплетённая с тенями» (Enemies Beyond p. 78): test against total Corruption
 *   on each spent point, success returns it; curse «Превратности судьбы» (same page): a 9 on 1d10 wastes it.
 * Items created from the tables carry the rule as a flag; items typed by hand are recognised by name.
 */

const SOCKET = "system.dark-heresy";

/** Roll-dependent failures of a spent point, by item name when the item has no flag. */
const FAILURE_NAMES = [
    { re: /^\s*(неудачлив|unlucky)/i, failure: { formula: "1d10", min: 7, max: 10 } },
    { re: /превратности\s+судьбы/i, failure: { formula: "1d10", min: 9, max: 9 } }
];
const SHADOWS_NAME = /судьба,?\s+сплет[её]нная\s+с\s+тенями/i;
const WILL_NOT_DIE_NAME = /это\s+не\s+умр[её]т|it\s+will\s+not\s+die/i;

/**
 * Roll formulas to failure rules of the actor's items (Unlucky and the like).
 * @param {Actor} actor
 * @returns {{name: string, formula: string, min: number, max: number}[]}
 */
function fateFailures(actor) {
    const out = [];
    for (const item of actor.items) {
        const flag = item.getFlag("dark-heresy", "fateFailure");
        const failure = flag ?? FAILURE_NAMES.find(f => f.re.test(item.name))?.failure;
        if (failure) out.push({ name: item.name, ...failure });
    }
    return out;
}

/**
 * Corruption formula of It Will Not Die!, if the actor has that mutation.
 * @param {Actor} actor
 * @returns {string|null}
 */
export function willNotDie(actor) {
    for (const item of actor?.items ?? []) {
        const flag = item.getFlag("dark-heresy", "willNotDie");
        if (flag) return flag;
        if (item.type === "mutation" && WILL_NOT_DIE_NAME.test(item.name)) return "1d10+5";
    }
    return null;
}

/**
 * Can the actor survive a deadly result by burning Fate (or by It Will Not Die!)?
 * @param {Actor} actor
 * @returns {boolean}
 */
export function canBurnFate(actor) {
    return Boolean(actor && (Number(actor.system?.fate?.max) > 0 || willNotDie(actor)));
}

/**
 * The actor of a roll: the token's actor for unlinked tokens, otherwise the sheet's actor.
 * @param {object} rollData
 * @returns {Actor|null}
 */
export function rollActor(rollData) {
    // An evasion carries the attack's owner; the evading character is recorded separately (chat.js)
    if (rollData?.flags?.isEvasion && rollData.evader) {
        const evader = rollData.evader;
        return (evader.tokenId && canvas?.tokens?.get(evader.tokenId)?.actor) || game.actors.get(evader.actorId) || null;
    }
    const token = rollData?.tokenId ? canvas?.tokens?.get(rollData.tokenId) : null;
    return token?.actor ?? game.actors.get(rollData?.ownerId) ?? null;
}

/**
 * Post the Fate card.
 * @param {Actor} actor
 * @param {object} data template data
 * @param {Roll[]} [rolls]
 * @returns {Promise<ChatMessage>}
 */
async function fateCard(actor, data, rolls = []) {
    const fate = actor.system.fate;
    const content = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/fate.hbs",
        { name: actor.name, value: fate.value, max: fate.max, ...data });
    return ChatMessage.create({ content, rolls, speaker: ChatMessage.getSpeaker({ actor }),
        flags: { "dark-heresy.fate": { purpose: data.purpose ?? null } } });
}

/**
 * Spend one Fate point and post what it was spent on. Applies Unlucky and the pact boon/curse.
 * The caller carries out the effect only when `effective` is true.
 * @param {Actor} actor
 * @param {string} purpose key under FATE_POINTS.PURPOSE_*
 * @param {object} [options]
 * @param {string} [options.detail] what exactly happened (shown on the card)
 * @param {boolean} [options.card=true] post the card now; false returns the data for a later card
 * @returns {Promise<{effective: boolean, notes: string[], rolls: Roll[]}|null>} null when nothing was spent
 */
export async function spendFate(actor, purpose, { detail = "", card = true } = {}) {
    if (!actor) return null;
    if (!actor.isOwner) {
        ui.notifications.warn(game.i18n.format("FATE_POINTS.NOT_OWNER", { name: actor.name }));
        return null;
    }
    const value = Number(actor.system.fate?.value) || 0;
    if (value <= 0) {
        ui.notifications.warn(game.i18n.format("FATE_POINTS.NONE", { name: actor.name }));
        return null;
    }
    await actor.update({ "system.fate.value": value - 1 });
    const notes = [];
    const rolls = [];
    let effective = true;
    for (const f of fateFailures(actor)) {
        const roll = await new Roll(f.formula).evaluate();
        rolls.push(roll);
        const wasted = roll.total >= f.min && roll.total <= f.max;
        if (wasted) effective = false;
        notes.push(game.i18n.format(wasted ? "FATE_POINTS.WASTED" : "FATE_POINTS.NOT_WASTED",
            { item: f.name, roll: roll.total, min: f.min, max: f.max }));
    }
    const shadows = actor.items.find(i => SHADOWS_NAME.test(i.name));
    if (shadows) {
        const corruption = Number(actor.system.corruption) || 0;
        const roll = await new Roll("1d100").evaluate();
        rolls.push(roll);
        const back = roll.total <= corruption;
        if (back) await actor.update({ "system.fate.value": Number(actor.system.fate.value) + 1 });
        notes.push(game.i18n.format(back ? "FATE_POINTS.RETURNED" : "FATE_POINTS.NOT_RETURNED",
            { item: shadows.name, roll: roll.total, target: corruption }));
    }
    const result = { effective, notes, rolls, purpose, detail };
    if (card) await fateCard(actor, { purpose: game.i18n.localize(`FATE_POINTS.PURPOSE_${purpose.toUpperCase()}`), detail, notes,
        wasted: !effective }, rolls);
    return result;
}

/* -------------------------------------------- */
/*  Effects of a spent point                    */
/* -------------------------------------------- */

/**
 * Remove 1d5 damage (not critical damage).
 * @param {Actor} actor
 */
export async function fateHeal(actor) {
    const spent = await spendFate(actor, "heal", { card: false });
    if (!spent) return;
    let detail = "";
    if (spent.effective) {
        const roll = await new Roll("1d5").evaluate();
        spent.rolls.push(roll);
        const before = Number(actor.system.wounds.value) || 0;
        const after = Math.max(0, before - roll.total);
        await actor.update({ "system.wounds.value": after });
        detail = game.i18n.format("FATE_POINTS.HEAL_DETAIL", { roll: roll.total, before, after });
    }
    await fateCard(actor, { purpose: game.i18n.localize("FATE_POINTS.PURPOSE_HEAL"), detail, notes: spent.notes,
        wasted: !spent.effective }, spent.rolls);
}

/**
 * Recover from Stunned.
 * @param {Actor} actor
 */
export async function fateUnstun(actor) {
    const spent = await spendFate(actor, "stun");
    if (spent?.effective) await actor.toggleStatusEffect("stunned", { active: false });
}

/**
 * Remove all levels of Fatigue.
 * @param {Actor} actor
 */
export async function fateFatigue(actor) {
    const before = Number(actor.system.fatigue?.value) || 0;
    const spent = await spendFate(actor, "fatigue", { detail: game.i18n.format("FATE_POINTS.FATIGUE_DETAIL", { before }) });
    if (spent?.effective) await actor.update({ "system.fatigue.value": 0 });
}

/**
 * Combatants of the actor in the current combat.
 * @param {Actor} actor
 * @returns {Combatant[]}
 */
function combatantsOf(actor) {
    const combat = game.combat;
    if (!combat) return [];
    return combat.combatants.filter(c => c.actor === actor);
}

/**
 * Roll 10 for initiative: the d10 counts as 10 (initiative is 1d10 + Agility bonus).
 * @param {Actor} actor
 */
export async function fateInitiative(actor) {
    const combatants = combatantsOf(actor);
    if (!combatants.length) {
        ui.notifications.warn(game.i18n.format("FATE_POINTS.NOT_IN_COMBAT", { name: actor.name }));
        return;
    }
    const initiative = 10 + (Number(actor.system.initiative?.bonus) || 0);
    const spent = await spendFate(actor, "initiative", { detail: game.i18n.format("FATE_POINTS.INITIATIVE_DETAIL", { initiative }) });
    if (!spent?.effective) return;
    for (const c of combatants) await c.update({ initiative });
}

/**
 * Burn Fate to survive (or It Will Not Die!): Fate threshold −1, current points down to it, "dead" removed.
 * @param {Actor} actor
 * @param {object} [options]
 * @param {string} [options.reason] what nearly killed the character
 * @returns {Promise<boolean>} whether the character survived
 */
export async function burnFate(actor, { reason = "" } = {}) {
    if (!actor) return false;
    if (!actor.isOwner) {
        ui.notifications.warn(game.i18n.format("FATE_POINTS.NOT_OWNER", { name: actor.name }));
        return false;
    }
    const corruptionFormula = willNotDie(actor);
    const rolls = [];
    let detail;
    if (corruptionFormula) {
        // It Will Not Die!: cannot burn, survives as if it did and gains Corruption
        const roll = await new Roll(corruptionFormula).evaluate();
        rolls.push(roll);
        const before = Number(actor.system.corruption) || 0;
        await actor.update({ "system.corruption": before + roll.total });
        detail = game.i18n.format("FATE_POINTS.WILL_NOT_DIE_DETAIL", { roll: roll.total, before, after: before + roll.total });
    } else {
        const max = Number(actor.system.fate?.max) || 0;
        if (max <= 0) {
            ui.notifications.warn(game.i18n.format("FATE_POINTS.NO_THRESHOLD", { name: actor.name }));
            return false;
        }
        const value = Math.min(Number(actor.system.fate.value) || 0, max - 1);
        await actor.update({ "system.fate.max": max - 1, "system.fate.value": value });
        detail = game.i18n.format("FATE_POINTS.BURN_DETAIL", { before: max, after: max - 1 });
    }
    if (actor.statuses?.has("dead")) await actor.toggleStatusEffect("dead", { active: false });
    await fateCard(actor, {
        purpose: game.i18n.localize(corruptionFormula ? "FATE_POINTS.PURPOSE_WILL_NOT_DIE" : "FATE_POINTS.PURPOSE_BURN"),
        detail, reason, burned: true, notes: [game.i18n.localize("FATE_POINTS.BURN_NOTE")]
    }, rolls);
    return true;
}

/* -------------------------------------------- */
/*  Roll dialog and chat cards                  */
/* -------------------------------------------- */

/**
 * Before rendering a roll dialog: offer the +10 Fate checkbox when the roller has Fate points.
 * @param {object} rollData
 */
export function offerFateBonus(rollData) {
    const actor = rollActor(rollData);
    rollData.fateAvailable = Boolean(actor?.isOwner && Number(actor.system.fate?.value) > 0);
}

/**
 * Roll dialog callback: spend Fate for +10 when the checkbox is ticked.
 * @param {object} rollData (target.modifier already read from the dialog)
 * @param {jQuery|HTMLElement} html the dialog content
 */
export async function applyFateBonus(rollData, html) {
    const box = (html.find ? html.find("#fateBonus")[0] : html.querySelector?.("#fateBonus"));
    delete rollData.fateAvailable;
    if (!box?.checked) return;
    const actor = rollActor(rollData);
    const spent = await spendFate(actor, "bonus", { detail: rollData.name ?? "" });
    if (!spent) return;
    rollData.fateBonus = spent.effective ? "applied" : "wasted";
    if (spent.effective) rollData.target.modifier = (Number(rollData.target.modifier) || 0) + 10;
}

/**
 * Update a chat message: directly when allowed, otherwise through the active GM.
 * @param {ChatMessage} message
 * @param {object} changes
 */
export function updateMessage(message, changes) {
    if (message.isOwner) return message.update(changes);
    if (game.users.activeGM) game.socket.emit(SOCKET, { type: "fateUpdateMessage", messageId: message.id, changes });
}

/**
 * Context menu: +1 degree of success to a successful test.
 * @param {ChatMessage} message
 * @param {Function} addDegreesOfSuccess from roll.js
 */
export async function fateAddDegree(message, addDegreesOfSuccess) {
    const rollData = message.getRollData();
    const actor = rollActor(rollData);
    if (!rollData?.flags?.isSuccess || !actor) return;
    const spent = await spendFate(actor, "degree", { detail: rollData.name ?? "" });
    if (!spent?.effective) return;
    const content = await addDegreesOfSuccess(rollData, 1);
    await updateMessage(message, { content, "flags.dark-heresy.rollData": rollData });
}

/**
 * Can the context menu offer a Fate option for this message?
 * @param {ChatMessage} message
 * @returns {boolean}
 */
export function canSpendOn(message) {
    const rollData = message?.getRollData();
    if (!message?.isRoll || !rollData || rollData.flags?.isDamageRoll || !message.isContentVisible) return false;
    const actor = rollActor(rollData);
    return Boolean(actor?.isOwner && Number(actor.system.fate?.value) > 0);
}

/**
 * Chat button on a deadly result: burn Fate to survive.
 * @param {Event} event
 */
export async function onBurnFateClick(event) {
    event.preventDefault();
    const button = event.currentTarget;
    const actor = await fromUuid(button.dataset.uuid);
    const message = game.messages.get(button.closest(".message")?.dataset.messageId);
    if (!actor) return;
    if (!actor.isOwner) {
        ui.notifications.warn(game.i18n.format("FATE_POINTS.NOT_OWNER", { name: actor.name }));
        return;
    }
    button.disabled = true;
    const survived = await burnFate(actor, { reason: button.dataset.reason ?? "" });
    if (!survived) {
        button.disabled = false;
        return;
    }
    if (message) await updateMessage(message, { "flags.dark-heresy.fateBurned": true });
}

/* -------------------------------------------- */
/*  Fate dialog on the sheet                    */
/* -------------------------------------------- */

/**
 * Dialog with the ways to spend or burn Fate that are open to the actor right now.
 * @param {Actor} actor
 */
export async function fateDialog(actor) {
    if (!actor?.isOwner) return;
    const fate = actor.system.fate ?? { value: 0, max: 0 };
    const hasPoint = Number(fate.value) > 0;
    const options = [];
    if (hasPoint) {
        if (Number(actor.system.wounds?.value) > 0) options.push({ action: "heal", label: "FATE_POINTS.ACTION_HEAL", icon: "fa-solid fa-kit-medical" });
        if (actor.statuses?.has("stunned")) options.push({ action: "stun", label: "FATE_POINTS.ACTION_STUN", icon: "fa-solid fa-person-falling-burst" });
        if (Number(actor.system.fatigue?.value) > 0) options.push({ action: "fatigue", label: "FATE_POINTS.ACTION_FATIGUE", icon: "fa-solid fa-bed" });
        if (combatantsOf(actor).length) options.push({ action: "initiative", label: "FATE_POINTS.ACTION_INITIATIVE", icon: "fa-solid fa-bolt" });
    }
    if (canBurnFate(actor)) {
        options.push({ action: "burn", label: willNotDie(actor) ? "FATE_POINTS.ACTION_WILL_NOT_DIE" : "FATE_POINTS.ACTION_BURN", icon: "fa-solid fa-fire" });
    }
    const content = `<p>${game.i18n.format("FATE_POINTS.DIALOG_STATE", { value: fate.value, max: fate.max })}</p>
        <p class="hint">${game.i18n.localize("FATE_POINTS.DIALOG_HINT")}</p>
        ${options.length ? "" : `<p><em>${game.i18n.localize("FATE_POINTS.DIALOG_NOTHING")}</em></p>`}`;
    const buttons = options.map(o => ({ action: o.action, label: game.i18n.localize(o.label), icon: o.icon }));
    buttons.push({ action: "cancel", label: game.i18n.localize("BUTTON.CANCEL"), icon: "fa-solid fa-times" });
    const choice = await foundry.applications.api.DialogV2.wait({
        window: { title: game.i18n.format("FATE_POINTS.DIALOG_TITLE", { name: actor.name }) },
        position: { width: 420 },
        content,
        buttons,
        rejectClose: false
    });
    switch (choice) {
        case "heal": return fateHeal(actor);
        case "stun": return fateUnstun(actor);
        case "fatigue": return fateFatigue(actor);
        case "initiative": return fateInitiative(actor);
        case "burn": {
            const ok = await foundry.applications.api.DialogV2.confirm({
                window: { title: game.i18n.localize("FATE_POINTS.ACTION_BURN") },
                content: `<p>${game.i18n.localize(willNotDie(actor) ? "FATE_POINTS.CONFIRM_WILL_NOT_DIE" : "FATE_POINTS.CONFIRM_BURN")}</p>`,
                rejectClose: false
            });
            if (ok) return burnFate(actor);
        }
    }
}

/** Register the API; call during init. */
export function registerFateApi() {
    Object.assign(game.darkHeresy, {
        fate: { spend: spendFate, burn: burnFate, heal: fateHeal, unstun: fateUnstun, fatigue: fateFatigue,
            initiative: fateInitiative, dialog: fateDialog }
    });
}

/** GM side of message updates requested by players; call on ready. */
export function registerFateSocket() {
    game.socket.on(SOCKET, async data => {
        if (data?.type !== "fateUpdateMessage" || game.user !== game.users.activeGM) return;
        await game.messages.get(data.messageId)?.update(data.changes);
    });
}
