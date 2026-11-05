/**
 * Conditions on the character himself (core rulebook chapter VII; Russian edition page numbers).
 * Modifiers against a target in a condition are in situational.js.
 *
 * - Prone (p. 284): −10 to his Weapon Skill tests, −20 to his Evasion tests; standing up is a half action.
 * - Pinned (p. 284): −20 to all his Ballistic Skill tests — ranged attacks and the single half action are in
 *   pinning.js / actions.js, here the other Ballistic Skill tests (clearing a jam…).
 * - Stunned (p. 289): no actions and no Evasion reactions. The active GM skips the turn of a stunned
 *   combatant; a duration in rounds (flag «dark-heresy.rounds» on the effect, set by the Stun action)
 *   counts down by one per skipped turn and the condition ends at his next turn after that.
 * - Fatigue (p. 287): characteristics whose bonus is below the fatigue level count half (already in
 *   DarkHeresyActor); fatigue above the threshold (TB + WB) knocks the character unconscious for 10 − TB
 *   minutes, above twice the threshold he dies (offered as a button).
 * - On fire (p. 289): 1d10 energy damage ignoring armour to the body and one level of fatigue each round
 *   (applied by the active GM at the start of his turn); a Willpower test at the start of each turn to act
 *   normally, otherwise he can only flail and scream (a Full Action); putting the fire out: drop prone and
 *   pass a Hard (−20) Agility test as a Full Action.
 * - Guarded Action (p. 273): −10 to his WS and BS tests this turn, +10 to Evasion until his next turn.
 * - Evasion (p. 270): only outside his own turn, one reaction per round (Defensive Stance gives two, p. 269),
 *   not when stunned, grappled (p. 281), after an All Out Attack (p. 269), nor against the Standard Attack
 *   following a won Feint (p. 270). The roll is still allowed after a warning: the GM has the last word.
 */
import { actionsOf, combatantFor, reactionLeft } from "./actions.js";
import { runOps, postWithOps, statusEffectOf, actorFrom } from "./ops.js";

const isActiveGM = () => game.user === game.users.activeGM;

/** Additional own-condition sources (cover, environment): fn(actor, kind, rollData) → [{modifier, note}]. */
const extraSources = [];

/**
 * Register another source of modifiers on the character's own tests.
 * @param {Function} fn (actor, kind, rollData) → {modifier, note}[]
 */
export function registerOwnModifierSource(fn) {
    extraSources.push(fn);
}

/**
 * The combatant of an actor in the started combat (synthetic token actors by token).
 * @param {Actor} actor
 * @returns {Combatant|undefined}
 */
export function combatantOfActor(actor) {
    if (!actor || !game.combat?.started) return undefined;
    if (actor.isToken) return combatantFor({ token: actor.token?.id });
    return combatantFor({ token: actor.getActiveTokens?.()[0]?.id, actor: actor.id });
}

/**
 * The action record of an actor's combatant (empty record outside combat).
 * @param {Actor} actor
 * @returns {object}
 */
export function recordOfActor(actor) {
    return actionsOf(combatantOfActor(actor));
}

const signed = n => (n > 0 ? `+${n}` : `${n}`);

/**
 * Kind of a roll for own-condition modifiers.
 * @param {object} rollData
 * @returns {string} melee | ranged | evasion | ws | bs | psychic | other
 */
export function rollKind(rollData) {
    if (rollData.flags?.isEvasion || rollData.sprayDodge) return "evasion";
    if (rollData.psy?.display) return "psychic";
    if (rollData.weapon?.isMelee) return "melee";
    if (rollData.weapon?.isRange) return "ranged";
    if (rollData.characteristicKey === "weaponSkill") return "ws";
    if (rollData.characteristicKey === "ballisticSkill") return "bs";
    return "other";
}

/**
 * Modifiers from the character's own conditions for one roll.
 * @param {Actor} actor
 * @param {string} kind see rollKind
 * @param {object} [rollData]
 * @returns {{modifier: number, note: string}[]}
 */
export function ownModifiers(actor, kind, rollData = {}) {
    const parts = [];
    if (!actor) return parts;
    const has = id => actor.statuses?.has(id);
    const weaponSkill = kind === "melee" || kind === "ws";
    const ballisticSkill = kind === "ranged" || kind === "bs";
    if (has("prone") && weaponSkill) parts.push({ modifier: -10, note: game.i18n.format("CONDITIONS.PRONE_WS", { modifier: "-10" }) });
    if (has("prone") && kind === "evasion") parts.push({ modifier: -20, note: game.i18n.format("CONDITIONS.PRONE_EVASION", { modifier: "-20" }) });
    // Ranged attacks of a pinned attacker are handled by pinning.js; here the other BS tests (clearing a jam…)
    if (has("pinned") && kind === "bs") parts.push({ modifier: -20, note: game.i18n.format("CONDITIONS.PINNED_BS", { modifier: "-20" }) });
    const record = recordOfActor(actor);
    if (record.stance === "cautious" && (weaponSkill || ballisticSkill)) {
        parts.push({ modifier: -10, note: game.i18n.format("CONDITIONS.CAUTIOUS_ATTACK", { modifier: "-10" }) });
    }
    if (record.stance === "cautious" && kind === "evasion") {
        parts.push({ modifier: 10, note: game.i18n.format("CONDITIONS.CAUTIOUS_EVASION", { modifier: "+10" }) });
    }
    for (const source of extraSources) {
        try {
            parts.push(...(source(actor, kind, rollData) ?? []));
        } catch (err) {
            console.error("dark-heresy | own modifier source failed", err);
        }
    }
    // Informational notes
    const fatigued = Object.values(actor.system.characteristics ?? {}).filter(c => c.fatigued);
    if (fatigued.length) {
        parts.push({ modifier: 0, note: game.i18n.format("CONDITIONS.FATIGUE_NOTE", { fatigue: actor.system.fatigue.value,
            list: fatigued.map(c => game.i18n.localize(c.short)).join(", ") }) });
    }
    if (has("fire")) parts.push({ modifier: 0, note: game.i18n.localize("CONDITIONS.FIRE_NOTE") });
    if (has("grappled") && kind !== "evasion") parts.push({ modifier: 0, note: game.i18n.localize("CONDITIONS.GRAPPLED_NOTE") });
    return parts;
}

/**
 * Apply the own-condition modifiers to roll data (mutates rollData.target.modifier).
 * @param {object} rollData
 * @param {Actor} actor
 * @returns {string[]} notes for the dialog
 */
export function applyOwnConditions(rollData, actor) {
    const parts = ownModifiers(actor, rollKind(rollData), rollData);
    const total = parts.reduce((sum, p) => sum + (Number(p.modifier) || 0), 0);
    if (total) rollData.target.modifier = (Number(rollData.target.modifier) || 0) + total;
    return parts.map(p => p.note).filter(Boolean);
}

/**
 * The actor a roll is made by: the evader, the token actor of the roll data, or the owner.
 * @param {object} rollData
 * @returns {Actor|null}
 */
export function rollActor(rollData) {
    const uuid = rollData.evaderUuid ?? rollData.actorUuid;
    const doc = uuid ? fromUuidSync(uuid) : null;
    return doc ?? game.actors.get(rollData.ownerId) ?? null;
}

/* -------------------------------------------- */
/*  Evasion                                     */
/* -------------------------------------------- */

/**
 * Reasons why the actor cannot evade an attack by the rules.
 * @param {Actor} actor the evader
 * @param {object} [attack] roll data of the attack
 * @returns {string[]}
 */
export function evasionProblems(actor, attack) {
    const problems = [];
    if (!actor) return problems;
    if (actor.statuses?.has("stunned")) problems.push(game.i18n.localize("EVASION.STUNNED"));
    if (actor.statuses?.has("grappled")) problems.push(game.i18n.localize("EVASION.GRAPPLED"));
    const combatant = combatantOfActor(actor);
    if (combatant) {
        const record = actionsOf(combatant);
        if (combatant === game.combat.combatant) problems.push(game.i18n.localize("EVASION.OWN_TURN"));
        if (record.allOut) problems.push(game.i18n.localize("EVASION.ALL_OUT"));
        if (!reactionLeft(record)) problems.push(game.i18n.localize("EVASION.NO_REACTION"));
    }
    const tokenId = actor.isToken ? actor.token?.id : actor.getActiveTokens?.()[0]?.id;
    if (attack?.feint && (attack.feint === tokenId || attack.feint === actor.id)) {
        problems.push(game.i18n.localize("EVASION.FEINT"));
    }
    return problems;
}

/**
 * Warn before an evasion the rules do not allow; the user may roll anyway.
 * @param {Actor} actor
 * @param {object} [attack]
 * @returns {Promise<boolean>} true to go on with the roll
 */
export async function confirmEvasion(actor, attack) {
    const problems = evasionProblems(actor, attack);
    if (!problems.length) return true;
    const list = problems.map(p => `<li>${p}</li>`).join("");
    return foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize("EVASION.TITLE") },
        content: `<p>${game.i18n.format("EVASION.PROBLEMS", { name: foundry.utils.escapeHTML(actor.name) })}</p><ul>${list}</ul>
            <p>${game.i18n.localize("EVASION.ROLL_ANYWAY")}</p>`,
        rejectClose: false
    });
}

/* -------------------------------------------- */
/*  Turn start: stunned, on fire                */
/* -------------------------------------------- */

/**
 * A simple chat card.
 * @param {string} title
 * @param {string} body HTML
 * @returns {string}
 */
export function card(title, body) {
    return `<div class="dark-heresy chat roll dh-combat-card"><div class="background border"><h1>${title}</h1>${body}</div></div>`;
}

let skipTimer = null;

/** combatTurnChange (active GM): burning and stunned combatants. */
async function onTurnChange(combat, prior, current) {
    if (!isActiveGM()) return;
    clearTimeout(skipTimer);
    const combatant = combat.combatants.get(current.combatantId);
    const actor = combatant?.actor;
    if (!actor || combatant.isDefeated) return;
    if (actor.statuses.has("fire")) await burn(actor, combatant);
    if (actor.statuses.has("stunned")) await stunnedTurn(actor, combatant, combat);
}

/**
 * On fire at the start of the turn: damage, fatigue and a card with the Willpower and extinguish tests.
 * @param {Actor} actor
 * @param {Combatant} combatant
 */
async function burn(actor, combatant) {
    const roll = await new Roll("1d10").evaluate();
    const name = foundry.utils.escapeHTML(actor.name);
    const buttons = `<div class="dh-card-buttons">
        <button type="button" class="dh-fire-test" data-uuid="${actor.uuid}" data-test="willpower">${game.i18n.localize("FIRE.WILLPOWER")}</button>
        <button type="button" class="dh-fire-test" data-uuid="${actor.uuid}" data-test="extinguish">${game.i18n.localize("FIRE.EXTINGUISH")}</button>
    </div>`;
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor, token: combatant.token }),
        rolls: [roll],
        content: card(game.i18n.localize("FIRE.TITLE"), `<p>${game.i18n.format("FIRE.TEXT", { name, damage: roll.total })}</p>
            ${await roll.render()}${buttons}`)
    });
    await runOps([
        { type: "damage", uuid: actor.uuid, attack: { psychic: false, special: "" },
            damages: [{ amount: roll.total, location: "ARMOUR.BODY", penetration: 9999, type: "E", righteousFury: 0 }] },
        { type: "fatigue", uuid: actor.uuid, delta: 1 }
    ]);
}

/**
 * A stunned combatant loses his turn; the duration counts down.
 * @param {Actor} actor
 * @param {Combatant} combatant
 * @param {Combat} combat
 */
async function stunnedTurn(actor, combatant, combat) {
    const effect = statusEffectOf(actor, "stunned");
    const rounds = effect?.getFlag("dark-heresy", "rounds");
    const name = foundry.utils.escapeHTML(actor.name);
    const speaker = ChatMessage.getSpeaker({ actor, token: combatant.token });
    if (rounds !== undefined && rounds <= 0) {
        await actor.toggleStatusEffect("stunned", { active: false });
        await ChatMessage.create({ speaker, content: card(game.i18n.localize("CONDITION.STUNNED"),
            `<p>${game.i18n.format("STUN.RECOVERED", { name })}</p>`) });
        return;
    }
    if (rounds !== undefined) await effect.setFlag("dark-heresy", "rounds", rounds - 1);
    const left = rounds === undefined ? game.i18n.localize("STUN.UNTIL_REMOVED") : game.i18n.format("STUN.ROUNDS_LEFT", { rounds: rounds - 1 });
    await ChatMessage.create({ speaker, content: card(game.i18n.localize("CONDITION.STUNNED"),
        `<p>${game.i18n.format("STUN.LOSES_TURN", { name })} ${left}</p>`) });
    if (!game.settings.get("dark-heresy", "autoEndTurn")) return;
    skipTimer = setTimeout(() => {
        if (game.combat === combat && combat.combatant === combatant) combat.nextTurn();
    }, 2000);
}

/* -------------------------------------------- */
/*  Fire tests                                  */
/* -------------------------------------------- */

let prepareCommonRollRef = null;
let createCharacteristicRollDataRef = null;

/** Chat button: the Willpower test to act normally or the attempt to put the fire out. */
async function onFireTestClick(event) {
    event.preventDefault();
    const { uuid, test } = event.currentTarget.dataset;
    const actor = await actorFrom(uuid);
    if (!actor?.isOwner) return ui.notifications.warn(game.i18n.localize("COMBAT_ACTION.NOT_OWNER"));
    const extinguish = test === "extinguish";
    const rollData = createCharacteristicRollDataRef(actor, extinguish ? "agility" : "willpower");
    rollData.name = game.i18n.localize(extinguish ? "FIRE.EXTINGUISH" : "FIRE.WILLPOWER");
    rollData.fireTest = test;
    if (extinguish) {
        rollData.target.modifier = -20;
        rollData.halfActions = 2;
    }
    prepareCommonRollRef(rollData);
}

/** createChatMessage (active GM): results of the fire tests. */
async function onFireTestResult(message) {
    if (!isActiveGM()) return;
    const rollData = message.getFlag("dark-heresy", "rollData");
    if (!rollData?.fireTest || rollData.flags?.isReRoll) return;
    const actor = rollActor(rollData);
    if (!actor) return;
    const speaker = message.speaker;
    if (rollData.fireTest === "willpower" && !rollData.flags.isSuccess) {
        await ChatMessage.create({ speaker, content: card(game.i18n.localize("FIRE.TITLE"),
            `<p>${game.i18n.format("FIRE.PANIC", { name: foundry.utils.escapeHTML(actor.name) })}</p>`) });
        await runOps([{ type: "spend", speaker, halves: 2 }]);
    } else if (rollData.fireTest === "extinguish") {
        const ops = [{ type: "status", uuid: actor.uuid, id: "prone" }];
        if (rollData.flags.isSuccess) ops.push({ type: "status", uuid: actor.uuid, id: "fire", active: false });
        await runOps(ops);
    }
}

/* -------------------------------------------- */
/*  Fatigue threshold                           */
/* -------------------------------------------- */

/** updateActor (active GM): fatigue above the threshold knocks out, above twice the threshold kills. */
async function onUpdateActor(actor, changes) {
    if (!isActiveGM() || !foundry.utils.hasProperty(changes, "system.fatigue.value")) return;
    const fatigue = Number(actor.system.fatigue?.value) || 0;
    const threshold = Number(actor.system.fatigue?.max) || 0;
    if (!(threshold > 0) || fatigue <= threshold) return;
    const name = foundry.utils.escapeHTML(actor.name);
    // Unfatigued Toughness bonus, as in the threshold (DarkHeresyActor#_computeCharacteristics)
    const t = actor.system.characteristics.toughness;
    const toughness = Math.floor(((Number(t.base) || 0) + (Number(t.advance) || 0)) / 10);
    if (fatigue > threshold * 2) {
        if (actor.statuses.has("dead")) return;
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: card(game.i18n.localize("FATIGUE"),
            `<p>${game.i18n.format("CONDITIONS.FATIGUE_DEATH", { name, fatigue, threshold })}</p>
            <div class="dh-table-conditions"><button type="button" class="dh-apply-condition" data-uuid="${actor.uuid}" data-condition="dead">
            ${game.i18n.localize("TABLES.APPLY_CONDITION")}: ${game.i18n.localize("EFFECT.StatusDead")}</button></div>`) });
        return;
    }
    if (actor.statuses.has("unconscious")) return;
    await actor.toggleStatusEffect("unconscious", { active: true });
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: card(game.i18n.localize("FATIGUE"),
        `<p>${game.i18n.format("CONDITIONS.FATIGUE_UNCONSCIOUS", { name, fatigue, threshold,
            minutes: Math.max(1, 10 - toughness), toughness })}</p>`) });
}

/**
 * Chat card listeners.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
function onRenderMessage(message, html) {
    html.querySelectorAll?.(".dh-fire-test").forEach(b => b.addEventListener("click", onFireTestClick));
}

/**
 * Register hooks; call during init.
 * @param {object} deps {prepareCommonRoll, createCharacteristicRollData}
 */
export function registerConditions({ prepareCommonRoll, createCharacteristicRollData }) {
    prepareCommonRollRef = prepareCommonRoll;
    createCharacteristicRollDataRef = createCharacteristicRollData;
    Hooks.on("combatTurnChange", onTurnChange);
    Hooks.on("createChatMessage", onFireTestResult);
    Hooks.on("updateActor", onUpdateActor);
    Hooks.on("renderChatMessageHTML", onRenderMessage);
}
