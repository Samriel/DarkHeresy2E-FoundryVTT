/**
 * Suppressing Fire and Pinning (core rulebook, table 7-1 and «Подавляющий огонь» p. 276–277,
 * «Подавление» p. 284).
 *
 * - Suppressing Fire is a full action with a weapon that fires semi- or full-auto bursts: the attacker
 *   marks a 30° (semi-auto) or 45° (full-auto) kill zone, spends the burst's ammunition and makes a
 *   Hard (−20) Ballistic Skill test without the burst modifiers; 94–100 jams the weapon (weapons.js). On a success
 *   the hits land on random targets in the zone: one hit plus one per two further degrees of success,
 *   at most the rate of fire of the mode.
 * - Every target in the zone tests Pinning: Willpower −10 (−20 against full-auto). On a failure the
 *   active GM sets the «pinned» condition.
 * - A pinned character may test Willpower (+0, +30 in cover or when not shot at last turn) at the end
 *   of his turn to shake it off; a pinned character gets −20 to Ballistic Skill tests and only one half
 *   action per turn (actions.js).
 * The kill zone is a Region drawn by area.js and removed by the same rules as Blast and Spray areas.
 */

import { coneArea } from "./area.js";

/** Suppressing fire attack types: cone angle, rate-of-fire key and Pinning test modifier. */
export const SUPPRESSION = {
    suppress_semi: { angle: 30, rof: "burst", pinning: -10 },
    suppress_full: { angle: 45, rof: "full", pinning: -20 }
};

/** BS test modifier of suppressing fire (Hard). */
export const SUPPRESSION_MODIFIER = -20;

/** Ballistic Skill penalty of a pinned character. */
export const PINNED_BS_PENALTY = -20;

/**
 * Can the weapon of the roll data fire this suppression mode?
 * @param {object} rollData
 * @param {string} type attack type key
 * @returns {boolean}
 */
export function canSuppress(rollData, type) {
    const mode = SUPPRESSION[type];
    return Boolean(mode && rollData.weapon?.isRange && Number(rollData.weapon.rateOfFire?.[mode.rof]) > 0);
}

/**
 * Draw the kill zone and target the tokens in it.
 * The zone reaches twice the weapon's range (the end of the normal range band).
 * @param {object} rollData
 * @returns {Promise<object|null>} {regionId, tokenIds}
 */
export async function suppressionArea(rollData) {
    const mode = SUPPRESSION[rollData.attackType?.name];
    if (!mode) return null;
    return coneArea(rollData, {
        angle: mode.angle,
        length: (Number(rollData.weapon.range) || 0) * 2,
        label: `${rollData.itemName ?? rollData.name}: ${game.i18n.localize("PINNING.SUPPRESSING_FIRE")} (${mode.angle}°)`,
        pickHint: game.i18n.localize("PINNING.PICK_DIRECTION")
    });
}

/**
 * Spread hits over random tokens: different tokens first, then random repeats.
 * @param {string[]} tokenIds
 * @param {number} hits
 * @returns {string[]} token id per hit
 */
export function assignHits(tokenIds, hits) {
    const pool = [...tokenIds];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const out = [];
    for (let i = 0; i < hits && pool.length; i++) {
        out.push(i < pool.length ? pool[i] : pool[Math.floor(Math.random() * pool.length)]);
    }
    return out;
}

/**
 * Suppression record of an attack after its roll (mutates rollData).
 * @param {object} rollData
 */
export function resolveSuppression(rollData) {
    const mode = SUPPRESSION[rollData.attackType?.name];
    if (!mode) return;
    // The jam itself (94+, Reliable/Unreliable) is checked by weapons.js and turns the attack into a miss
    const jammed = Boolean(rollData.weaponJam?.jammed);
    if (jammed) rollData.numberOfHits = 0;
    const tokenIds = rollData.area?.tokenIds ?? rollData.suppression?.tokenIds ?? [];
    const hits = rollData.flags.isSuccess ? assignHits(tokenIds, rollData.numberOfHits) : [];
    const counts = new Map();
    for (const id of hits) counts.set(id, (counts.get(id) ?? 0) + 1);
    rollData.suppression = {
        type: rollData.attackType.name,
        angle: mode.angle,
        pinning: mode.pinning,
        pinningText: `${mode.pinning}`,
        sceneId: canvas.scene?.id ?? null,
        tokenIds,
        hits,
        hitText: [...counts].map(([id, n]) => {
            const name = canvas.tokens?.get(id)?.name ?? id;
            return n > 1 ? `${name} ×${n}` : name;
        }).join(", "),
        jammed
    };
}

/**
 * Damages of a suppressing fire damage roll that land on a token.
 * @param {object} rollData damage roll data
 * @param {object[]} damages
 * @param {string} tokenId
 * @returns {object[]}
 */
export function suppressionDamages(rollData, damages, tokenId) {
    const hits = rollData?.suppression?.hits;
    if (!Array.isArray(hits)) return damages;
    return damages.filter((d, i) => hits[i] === tokenId);
}

/**
 * Name the token each damage of a suppressing fire damage roll lands on (mutates the damages).
 * @param {object} rollData
 */
export function labelSuppressionDamages(rollData) {
    const hits = rollData?.suppression?.hits;
    if (!Array.isArray(hits)) return;
    rollData.damages.forEach((d, i) => { d.targetName = canvas.tokens?.get(hits[i])?.name ?? ""; });
}

/**
 * Ranged attacks of a pinned attacker: −20 to the test (mutates rollData).
 * @param {object} rollData
 * @param {Actor} actor
 * @returns {string[]} dialog notes
 */
export function applyPinnedPenalty(rollData, actor) {
    if (!rollData.weapon?.isRange || !actor?.statuses?.has("pinned")) return [];
    rollData.target.modifier = (Number(rollData.target.modifier) || 0) + PINNED_BS_PENALTY;
    return [game.i18n.format("PINNING.PINNED_NOTE", { modifier: PINNED_BS_PENALTY })];
}

/**
 * The token of an actor on the current scene: controlled first, then any.
 * @param {Actor} actor
 * @returns {Token|null}
 */
function tokenOf(actor) {
    return canvas.tokens?.controlled.find(t => t.actor === actor)
        ?? canvas.tokens?.placeables.find(t => t.actor === actor) ?? null;
}

/**
 * Pinning button on a suppressing fire card: Willpower test for the user's token in the zone.
 * @param {Event} event
 * @param {Function} prepareCommonRoll
 * @param {object} DarkHeresyUtil
 */
export function onPinningClick(event, prepareCommonRoll, DarkHeresyUtil) {
    event.preventDefault();
    const id = event.currentTarget.closest(".message")?.dataset.messageId;
    const suppression = game.messages.get(id)?.getRollData()?.suppression;
    const actor = game.macro.getActor();
    if (!suppression) return;
    if (!actor) {
        ui.notifications.warn(game.i18n.localize("NOTIFICATION.MACRO_ACTOR_NOT_FOUND"));
        return;
    }
    const token = tokenOf(actor);
    if (!token || !suppression.tokenIds.includes(token.id)) {
        ui.notifications.warn(game.i18n.format("PINNING.NOT_IN_ZONE", { name: token?.name ?? actor.name }));
        return;
    }
    const rollData = DarkHeresyUtil.createCharacteristicRollData(actor, "willpower");
    rollData.target.modifier = suppression.pinning;
    rollData.name = game.i18n.localize("PINNING.TEST_NAME");
    rollData.pinning = { sceneId: token.document.parent?.id ?? null, tokenId: token.id, actorId: actor.id, recover: false };
    prepareCommonRoll(rollData);
}

/**
 * Recovery button on the end-of-turn card: Willpower test of the pinned token to shake it off.
 * @param {Event} event
 * @param {Function} prepareCommonRoll
 * @param {object} DarkHeresyUtil
 */
export function onPinningRecoverClick(event, prepareCommonRoll, DarkHeresyUtil) {
    event.preventDefault();
    const id = event.currentTarget.closest(".message")?.dataset.messageId;
    const link = game.messages.get(id)?.getFlag("dark-heresy", "pinnedRecover");
    if (!link) return;
    const actor = resolveActor(link);
    if (!actor?.isOwner) {
        ui.notifications.warn(game.i18n.localize("PINNING.NOT_OWNER"));
        return;
    }
    const rollData = DarkHeresyUtil.createCharacteristicRollData(actor, "willpower");
    rollData.target.modifier = 0;
    rollData.name = game.i18n.localize("PINNING.RECOVER_NAME");
    rollData.pinning = { ...link, recover: true };
    prepareCommonRoll(rollData);
}

/**
 * Actor of a {sceneId, tokenId, actorId} link: the token's (synthetic) actor or the world actor.
 * @param {object} link
 * @returns {Actor|null}
 */
export function resolveActor(link) {
    const token = game.scenes.get(link.sceneId)?.tokens.get(link.tokenId);
    return token?.actor ?? game.actors.get(link.actorId) ?? null;
}

/**
 * Does this client apply automatic results? The active GM, or the author when no GM is connected.
 * @param {ChatMessage} message
 * @returns {boolean}
 */
export function appliesResults(message) {
    const gm = game.users.activeGM;
    return gm ? game.user === gm : message.author?.id === game.user.id;
}

/** createChatMessage: a failed Pinning test pins, a passed recovery test frees. */
async function onPinningResult(message) {
    const rollData = message.getFlag("dark-heresy", "rollData");
    const link = rollData?.pinning;
    if (!link || !appliesResults(message)) return;
    const actor = resolveActor(link);
    if (!actor) return;
    const success = Boolean(rollData.flags?.isSuccess);
    if (!link.recover && !success) await actor.toggleStatusEffect("pinned", { active: true });
    else if (link.recover && success) await actor.toggleStatusEffect("pinned", { active: false });
}

/** combatTurnChange: offer the pinned combatant whose turn ended a recovery test (active GM). */
async function onTurnChange(combat, prior) {
    if (game.user !== game.users.activeGM) return;
    const combatant = combat.combatants.get(prior?.combatantId);
    const actor = combatant?.actor;
    if (!actor?.statuses?.has("pinned")) return;
    const name = combatant.token?.name ?? actor.name;
    const link = { sceneId: combatant.sceneId ?? combat.scene?.id ?? null, tokenId: combatant.tokenId, actorId: combatant.actorId };
    const content = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/pinned.hbs", { name });
    const owners = game.users.filter(u => actor.testUserPermission(u, "OWNER")).map(u => u.id);
    await ChatMessage.create({ content, whisper: owners, speaker: ChatMessage.getSpeaker({ actor }),
        flags: { "dark-heresy": { pinnedRecover: link } } });
}

/** Register the result and turn hooks; call during init. */
export function registerPinning() {
    Hooks.on("createChatMessage", onPinningResult);
    Hooks.on("combatTurnChange", onTurnChange);
}
