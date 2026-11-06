/**
 * Applying a damage chat card to targeted tokens.
 *
 * The player targets tokens (T) and presses the button on the damage card. Damage to actors the
 * user owns is applied directly; anything else goes over the system socket to the active GM.
 * An active force field rolls first (DH2 core, «Силовые поля»): 1d100 ≤ protection rating cancels
 * the attack, and the same roll at or under the overload chance overloads the field.
 */

import { applyAttackQualities } from "./qualities.js";
import { traitRating } from "./traits.js";
import { deleteAreas } from "./area.js";
import { suppressionDamages } from "./pinning.js";

const SOCKET = "system.dark-heresy";

const DAMAGE_LETTER = { energy: "E", impact: "I", rending: "R", explosive: "X" };

// Table 5-13: overload chance by craftsmanship, used when the item has no own value
const OVERLOAD_BY_CRAFTSMANSHIP = { poor: 15, common: 10, good: 5, best: 1 };

/**
 * Damages of a damage chat message in the shape Actor#applyDamage expects.
 * @param {ChatMessage} message
 * @returns {object|null}
 */
function damagePayload(message) {
    const rollData = message.getRollData();
    if (!rollData?.flags?.isDamageRoll || !rollData.damages?.length) return null;
    const type = DAMAGE_LETTER[rollData.weapon?.damageType] ?? "I";
    const payload = {
        messageId: message.id,
        source: rollData.itemName ?? rollData.name ?? "",
        special: rollData.weapon?.special ?? "",
        attack: { psychic: Boolean(rollData.psy?.display), special: rollData.weapon?.special ?? "",
            attackerId: rollData.ownerId ?? null, talentCrit: rollData.talentCrit ?? null },
        damages: rollData.damages.map(d => ({
            amount: Number(d.total) || 0,
            location: d.location,
            penetration: Number(d.penetration) || 0,
            type,
            righteousFury: Number(d.righteousFury) || 0
        }))
    };
    applyAttackQualities(rollData, payload.damages, game.actors.get(rollData.ownerId) ?? null,
        actor => traitRating(actor, "daemonic"));
    return payload;
}

/**
 * Button handler: apply the card's damage to the user's current targets.
 * @param {Event} event
 */
export async function onApplyToTargetsClick(event) {
    event.preventDefault();
    const id = event.currentTarget.closest(".message")?.dataset.messageId;
    const targets = [...game.user.targets];
    if (!targets.length) {
        ui.notifications.warn(game.i18n.localize("DAMAGE.NO_TARGETS"));
        return;
    }
    await applyToActors(game.messages.get(id), targets);
}

/**
 * Apply a damage message to tokens: directly when the user owns the actor, otherwise via the GM.
 * @param {ChatMessage} message
 * @param {Token[]} tokens
 */
export async function applyToActors(message, tokens) {
    const payload = message && damagePayload(message);
    if (!payload) return;
    const evaded = new Set(message.getFlag("dark-heresy", "evaded") ?? []);
    const rollData = message.getRollData();
    for (const token of tokens) {
        if (evaded.has(token.id) || evaded.has(token.actor?.id)) continue;
        const actor = token.actor;
        if (!actor) continue;
        // Suppressing fire: each token takes only the hits that landed on it
        const damages = suppressionDamages(rollData, payload.damages, token.id);
        if (!damages.length) continue;
        const request = { ...payload, damages, sceneId: token.document.parent?.id, tokenId: token.id,
            actorId: actor.id, userId: game.user.id };
        if (actor.isOwner) await applyDamageRequest(request);
        else if (game.users.activeGM) game.socket.emit(SOCKET, { type: "applyDamage", request });
        else ui.notifications.warn(game.i18n.format("DAMAGE.NO_GM", { name: token.name }));
    }
    const regionId = rollData?.area?.regionId;
    if (regionId) await deleteAreas(r => r.id === regionId);
}

/**
 * Resolve the target actor of a request: the token's actor (synthetic for unlinked tokens) or the world actor.
 * @param {object} request
 * @returns {Actor|null}
 */
function requestActor(request) {
    const token = game.scenes.get(request.sceneId)?.tokens.get(request.tokenId);
    return token?.actor ?? game.actors.get(request.actorId) ?? null;
}

/**
 * Apply one damage request: force field first, then Actor#applyDamage.
 * @param {object} request
 */
async function applyDamageRequest(request) {
    const actor = requestActor(request);
    if (!actor) return;
    const blocked = await rollForceField(actor, request);
    if (!blocked) await actor.applyDamage(request.damages, request.attack);
}

/**
 * The active force field of an actor, if any.
 * @param {Actor} actor
 * @returns {Item|undefined}
 */
export function activeForceField(actor) {
    return actor.items.find(i => i.type === "forceField" && i.system.active && !i.system.overloaded);
}

/**
 * Roll the active force field against one attack; posts the result to chat.
 * @param {Actor} actor
 * @param {object} request
 * @returns {Promise<boolean>} true when the attack is cancelled
 */
async function rollForceField(actor, request) {
    const field = activeForceField(actor);
    if (!field) return false;
    const rating = Number(field.system.protectionRating) || 0;
    const overload = Number(field.system.overloadChance) || OVERLOAD_BY_CRAFTSMANSHIP[field.system.craftsmanship] || 0;
    const roll = await new Roll("1d100").evaluate();
    const blocked = roll.total <= rating;
    const overloaded = roll.total <= overload;
    if (overloaded) await field.update({ "system.overloaded": true, "system.active": false });
    const content = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/force-field.hbs", {
        target: actor.name, field: field.name, source: request.source, result: roll.total,
        rating, overload, blocked, overloaded
    });
    await ChatMessage.create({ content, rolls: [roll], speaker: ChatMessage.getSpeaker({ actor }) });
    return blocked;
}

/** Listen for damage requests from players; only the active GM applies them. */
export function registerDamageSocket() {
    game.socket.on(SOCKET, async data => {
        if (data?.type !== "applyDamage" || game.user !== game.users.activeGM) return;
        await applyDamageRequest(data.request);
    });
}
