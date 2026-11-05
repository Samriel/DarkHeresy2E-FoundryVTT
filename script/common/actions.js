/**
 * Action economy in combat (core rulebook, table 7-1 «Боевые действия»).
 *
 * Every combatant has two half actions per turn and one reaction per round. Spent halves are
 * stored on the combatant (flag «dark-heresy.actions») and counted by the active GM client:
 * attack rolls by attack type, aiming, focus power rolls by the power's action, movement by the
 * distance moved this turn; an evasion roll uses the reaction. The combat tracker shows the pips
 * next to each combatant; the GM and the combatant's owner can click them to correct the count.
 * When the current combatant has spent both halves the turn passes on (setting «autoEndTurn»).
 */

const FLAG = "actions";
const EMPTY = { attack: 0, aim: 0, move: 0, manual: 0, charge: false, reaction: false };

// Halves per attack type; called shot, charge and all-out attack are full actions
const ATTACK_COST = { standard: 1, semi_auto: 1, full_auto: 1, lightning: 1, swift: 1,
    called_shot: 2, charge: 2, allout: 2, none: 0 };

/**
 * @param {Combatant} combatant
 * @returns {object} the combatant's action record this turn
 */
export function actionsOf(combatant) {
    return { ...EMPTY, ...(combatant?.getFlag("dark-heresy", FLAG) ?? {}) };
}

/**
 * Spent halves (0–2) of an action record.
 * @param {object} a
 * @returns {number}
 */
export function spentHalves(a) {
    if (a.charge) return 2;
    return Math.max(0, Math.min(2, a.attack + a.aim + a.move + a.manual));
}

/**
 * Halves of a focus power action text: «Полудействие»/«Half» → 1, «Полное»/«Full» → 2, otherwise 0.
 * @param {string} action
 * @returns {number}
 */
function powerCost(action) {
    const text = String(action ?? "").toLowerCase();
    if (/полн|full/.test(text)) return 2;
    if (/полу|half/.test(text)) return 1;
    return 0;
}

/**
 * The combatant of the active combat a chat message or token belongs to.
 * @param {object} speaker {token, actor}
 * @returns {Combatant|undefined}
 */
function combatantFor(speaker) {
    const combat = game.combat;
    if (!combat?.started) return undefined;
    return combat.combatants.find(c => (speaker.token && c.tokenId === speaker.token))
        ?? combat.combatants.find(c => speaker.actor && c.actorId === speaker.actor);
}

async function update(combatant, changes) {
    const next = { ...actionsOf(combatant), ...changes };
    await combatant.setFlag("dark-heresy", FLAG, next);
    if (combatant === game.combat?.combatant) maybeEndTurn(combatant);
}

let endTimer = null;

/**
 * Pass the turn on shortly after the current combatant has spent both halves.
 * @param {Combatant} combatant
 */
function maybeEndTurn(combatant) {
    if (!game.settings.get("dark-heresy", "autoEndTurn")) return;
    if (spentHalves(actionsOf(combatant)) < 2) return;
    clearTimeout(endTimer);
    endTimer = setTimeout(async () => {
        const combat = game.combat;
        if (combat?.combatant !== combatant || spentHalves(actionsOf(combatant)) < 2) return;
        ui.notifications.info(game.i18n.format("ACTIONS.TURN_ENDED", { name: combatant.name }));
        await combat.nextTurn();
    }, 2500);
}

const isActiveGM = () => game.user === game.users.activeGM;

/** createChatMessage: count attacks, aiming, focus powers and evasions (active GM only). */
async function onChatMessage(message) {
    if (!isActiveGM()) return;
    const rollData = message.getFlag("dark-heresy", "rollData");
    if (!rollData || rollData.flags?.isReRoll) return;
    const combatant = combatantFor(message.speaker);
    if (!combatant) return;
    const a = actionsOf(combatant);
    if (rollData.flags.isEvasion) {
        await update(combatant, { reaction: true });
        return;
    }
    if (!rollData.flags.isCombatRoll || combatant !== game.combat.combatant) return;
    if (rollData.psy?.display) {
        await update(combatant, { attack: a.attack + powerCost(rollData.powerAction) });
        return;
    }
    const type = rollData.attackType?.name ?? "standard";
    const aim = rollData.aim?.base >= 20 ? 2 : rollData.aim?.base > 0 ? 1 : 0;
    await update(combatant, { attack: a.attack + (ATTACK_COST[type] ?? 1), aim: a.aim + aim,
        charge: a.charge || type === "charge" });
}

/** moveToken: count the distance the current combatant moved this turn (active GM only). */
async function onMoveToken(token, movement) {
    if (!isActiveGM()) return;
    const combat = game.combat;
    const combatant = combat?.started ? combat.combatant : null;
    if (!combatant || combatant.tokenId !== token.id) return;
    const rates = token.actor?.system?.movement;
    if (!rates) return;
    const distance = (movement.history?.distance ?? 0) + (movement.passed?.distance ?? 0)
        + (movement.pending?.distance ?? 0);
    const move = distance <= 0 ? 0 : distance <= rates.half + 1e-6 ? 1 : 2;
    if (move !== actionsOf(combatant).move) await update(combatant, { move });
}

/** combatTurnChange: fresh actions for the new combatant, reactions reset each round (active GM only). */
async function onTurnChange(combat, prior, current) {
    if (!isActiveGM()) return;
    clearTimeout(endTimer);
    const updates = [];
    for (const c of combat.combatants) {
        const a = actionsOf(c);
        const reaction = current.round !== prior.round ? false : a.reaction;
        if (c.id === current.combatantId) updates.push({ _id: c.id, [`flags.dark-heresy.${FLAG}`]: { ...EMPTY, reaction } });
        else if (reaction !== a.reaction) updates.push({ _id: c.id, [`flags.dark-heresy.${FLAG}.reaction`]: reaction });
    }
    if (updates.length) await combat.updateEmbeddedDocuments("Combatant", updates);
}

/** renderCombatTracker: half-action and reaction pips next to each combatant. */
function onRenderTracker(app, html) {
    const root = html instanceof HTMLElement ? html : html[0];
    const combat = app.viewed;
    if (!root || !combat) return;
    for (const li of root.querySelectorAll("li.combatant[data-combatant-id]")) {
        const combatant = combat.combatants.get(li.dataset.combatantId);
        if (!combatant) continue;
        const a = actionsOf(combatant);
        const spent = spentHalves(a);
        const editable = game.user.isGM || combatant.isOwner;
        const box = document.createElement("div");
        box.className = "dh-actions";
        const pips = [1, 2].map(i => `<a class="dh-pip half${spent >= i ? " spent" : ""}" data-half="${i}"
            data-tooltip="${game.i18n.localize("ACTIONS.HALF")}"></a>`).join("");
        box.innerHTML = `${pips}<a class="dh-pip reaction${a.reaction ? " spent" : ""}"
            data-tooltip="${game.i18n.localize("ACTIONS.REACTION")}"></a>`;
        if (editable) {
            box.querySelectorAll(".dh-pip.half").forEach(pip => pip.addEventListener("click", ev => {
                ev.stopPropagation();
                const i = Number(pip.dataset.half);
                const target = spent >= i ? i - 1 : i;
                update(combatant, { charge: false, manual: target - (a.attack + a.aim + a.move) });
            }));
            box.querySelector(".dh-pip.reaction").addEventListener("click", ev => {
                ev.stopPropagation();
                update(combatant, { reaction: !a.reaction });
            });
        } else box.classList.add("readonly");
        (li.querySelector(".token-initiative") ?? li).before(box);
    }
}

/** Register the setting and hooks; call during init. */
export function registerActions() {
    game.settings.register("dark-heresy", "autoEndTurn", {
        name: "ACTIONS.SETTING_AUTO_END",
        hint: "ACTIONS.SETTING_AUTO_END_HINT",
        scope: "world",
        config: true,
        default: true,
        type: Boolean
    });
    Hooks.on("createChatMessage", onChatMessage);
    Hooks.on("moveToken", onMoveToken);
    Hooks.on("combatTurnChange", onTurnChange);
    Hooks.on("renderCombatTracker", onRenderTracker);
}
