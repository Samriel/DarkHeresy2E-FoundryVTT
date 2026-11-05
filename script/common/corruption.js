/**
 * Corruption and Insanity thresholds (core rulebook, chapter VIII: «Безумие» p. 350–352 with
 * table 8-12, «Порча» p. 354–355 with table 8-14).
 *
 * When the points on the sheet change, the client that made the change posts a reminder:
 * - Insanity: one Trauma test (Willpower, table 8-12 modifier) per 10 points gained; a Minor, Severe
 *   or Acute disorder is gained on reaching 40, 60 and 80; 100+ removes the character from play.
 * - Corruption: one Malignancy test (Willpower, table 8-14 modifier) per 10 points gained; one
 *   mutation test of two characteristics of the player's choice per 30 points gained (not the same
 *   characteristic twice); 100+ removes the character from play.
 * The card has buttons for the tests and for choosing the disorder; a failed test card offers the roll on
 * table 8-13, 8-15 or 8-16 and the result card adds it to the sheet (mind.js).
 */

import DarkHeresyUtil from "./util.js";
import { prepareCommonRoll } from "./dialog.js";
import { chooseDisorder } from "./mind.js";

const DISORDERS = [[40, "MIND.DISORDER_MINOR", "minor"], [60, "MIND.DISORDER_SEVERE", "severe"], [80, "MIND.DISORDER_ACUTE", "acute"]];

const signed = n => (n > 0 ? `+${n}` : `${n}`);

/**
 * Number of multiples of a step crossed going from old to new points.
 * @param {number} before
 * @param {number} after
 * @param {number} step
 * @returns {number}
 */
export function crossed(before, after, step) {
    return Math.max(0, Math.floor(after / step) - Math.floor(before / step));
}

/**
 * Reminder lines and tests for a change of corruption and insanity points.
 * @param {object} before {corruption, insanity}
 * @param {object} after {corruption, insanity}
 * @returns {object} {lines: string[], tests: {key, label}[]}
 */
export function mindReminders(before, after) {
    const lines = [];
    const tests = [];
    const ins0 = Number(before.insanity) || 0, ins1 = Number(after.insanity) || 0;
    const cor0 = Number(before.corruption) || 0, cor1 = Number(after.corruption) || 0;

    const trauma = crossed(ins0, ins1, 10);
    if (trauma) {
        const modifier = signed(DarkHeresyUtil.getTraumaModifier(ins1));
        lines.push(game.i18n.format("MIND.TRAUMA_LINE", { before: ins0, after: ins1, count: trauma, modifier }));
        tests.push({ key: "trauma", label: game.i18n.format("MIND.TRAUMA_ROLL", { modifier }) });
    }
    for (const [at, key, severity] of DISORDERS) {
        if (!(ins0 < at && ins1 >= at)) continue;
        const disorder = game.i18n.localize(key);
        lines.push(game.i18n.format("MIND.DISORDER_LINE", { points: at, disorder }));
        tests.push({ key: "disorder", severity, label: game.i18n.format("MIND.DISORDER_BUTTON", { disorder }) });
    }
    if (ins0 < 100 && ins1 >= 100) lines.push(game.i18n.localize("MIND.INSANITY_LOST"));

    const malignancy = crossed(cor0, cor1, 10);
    if (malignancy) {
        const modifier = signed(DarkHeresyUtil.getMalignancyModifier(cor1));
        lines.push(game.i18n.format("MIND.MALIGNANCY_LINE", { before: cor0, after: cor1, count: malignancy, modifier }));
        tests.push({ key: "malignancy", label: game.i18n.format("MIND.MALIGNANCY_ROLL", { modifier }) });
    }
    const mutation = crossed(cor0, cor1, 30);
    if (mutation) {
        lines.push(game.i18n.format("MIND.MUTATION_LINE", { count: mutation }));
        tests.push({ key: "mutation", label: game.i18n.localize("MIND.MUTATION_ROLL") });
    }
    if (cor0 < 100 && cor1 >= 100) lines.push(game.i18n.localize("MIND.CORRUPTION_LOST"));
    return { lines, tests };
}

/** preUpdateActor: remember the points before the change (initiating client). */
function onPreUpdate(actor, changes, options) {
    const corruption = foundry.utils.getProperty(changes, "system.corruption");
    const insanity = foundry.utils.getProperty(changes, "system.insanity");
    if (corruption === undefined && insanity === undefined) return;
    options.dhMind = { corruption: actor.system.corruption, insanity: actor.system.insanity };
}

/** updateActor: post the reminder card from the client that changed the points. */
async function onUpdate(actor, changes, options, userId) {
    if (userId !== game.user.id || !options.dhMind) return;
    const { lines, tests } = mindReminders(options.dhMind,
        { corruption: actor.system.corruption, insanity: actor.system.insanity });
    if (!lines.length) return;
    const token = actor.token ?? null;
    const link = { actorId: actor.id, sceneId: token?.parent?.id ?? null, tokenId: token?.id ?? null };
    const content = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/mind.hbs", { name: actor.name, lines, tests });
    await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }), flags: { "dark-heresy": { mind: link } } });
}

/**
 * Reminder card buttons: Trauma, Malignancy or mutation test of the card's character, or the disorder choice.
 * @param {Event} event
 */
export function onMindTestClick(event) {
    event.preventDefault();
    const id = event.currentTarget.closest(".message")?.dataset.messageId;
    const link = game.messages.get(id)?.getFlag("dark-heresy", "mind");
    if (!link) return;
    const actor = (link.tokenId && game.scenes.get(link.sceneId)?.tokens.get(link.tokenId)?.actor) ?? game.actors.get(link.actorId);
    if (!actor?.isOwner) {
        ui.notifications.warn(game.i18n.localize("PINNING.NOT_OWNER"));
        return;
    }
    let rollData;
    switch (event.currentTarget.dataset.test) {
        case "trauma": rollData = DarkHeresyUtil.createTraumaTestRolldata(actor); break;
        case "malignancy": rollData = DarkHeresyUtil.createMalignancyTestRolldata(actor); break;
        case "mutation": rollData = DarkHeresyUtil.createMutationTestRolldata(actor); break;
        case "disorder": return chooseDisorder(actor, { severity: event.currentTarget.dataset.severity });
        default: return;
    }
    prepareCommonRoll(rollData);
}

/** Register the hooks; call during init. */
export function registerCorruption() {
    Hooks.on("preUpdateActor", onPreUpdate);
    Hooks.on("updateActor", onUpdate);
}
