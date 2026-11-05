/**
 * First aid and Blood Loss (core rulebook: Medicae «Первая помощь» p. 131, healing p. 298,
 * «Потеря Крови» p. 289, talent Die Hard p. 155, trait Undying p. 167).
 *
 * - First aid: Ordinary (+0) Medicae test, −10 if the patient is Heavily Wounded (damage above twice
 *   his Toughness bonus), or −10 per point of Critical damage if Critically Wounded. On a success the
 *   patient removes damage equal to the healer's Intelligence bonus plus one per degree of success,
 *   Critical damage first. Once per patient in 24 hours (game time). The active GM applies the
 *   healing when the healer does not own the patient.
 * - Blood Loss («bleeding» condition): at the start of his turn the character gains 1 level of
 *   Fatigue (Undying: immune; Die Hard: a Willpower test avoids it). Once per round he or someone
 *   who can reach him may test Medicae −10 as a free action to stop it.
 */

import { appliesResults, resolveActor } from "./pinning.js";
import { prepareCommonRoll } from "./dialog.js";
import DarkHeresyUtil from "./util.js";

const DAY = 24 * 60 * 60;

const UNDYING = /^(?:неумирающ[а-яё]*|undying)/i;
const DIE_HARD = /^(?:крепкий орешек|die hard)/i;

/**
 * Wound state of an actor: light, heavy or critical (core p. 298).
 * @param {Actor} actor
 * @returns {string} "none" | "light" | "heavy" | "critical"
 */
export function woundState(actor) {
    const damage = Number(actor.system.wounds?.value) || 0;
    const critical = Number(actor.system.wounds?.critical) || 0;
    const tb = Number(actor.system.characteristics?.toughness?.bonus) || 0;
    if (critical > 0) return "critical";
    if (damage > tb * 2) return "heavy";
    if (damage > 0) return "light";
    return "none";
}

/**
 * First aid test modifier for a patient.
 * @param {Actor} patient
 * @returns {number}
 */
export function firstAidModifier(patient) {
    const state = woundState(patient);
    if (state === "critical") return -10 * (Number(patient.system.wounds.critical) || 0);
    if (state === "heavy") return -10;
    return 0;
}

/**
 * Hours since the patient last received first aid, or null.
 * @param {Actor} patient
 * @returns {number|null}
 */
function hoursSinceFirstAid(patient) {
    const last = patient.getFlag("dark-heresy", "firstAid");
    if (typeof last !== "number") return null;
    return (game.time.worldTime - last) / 3600;
}

/**
 * Tokens offered as patients: targets, the healer's own token, then the other tokens of the scene.
 * @param {Actor} healer
 * @returns {Token[]}
 */
function patientCandidates(healer) {
    if (!canvas.ready) return [];
    const list = [...game.user.targets, ...canvas.tokens.placeables.filter(t => t.actor === healer),
        ...canvas.tokens.placeables.filter(t => t.actor && (!t.document.hidden || game.user.isGM))];
    return [...new Set(list)].filter(t => t.actor?.system?.wounds);
}

/**
 * Ask for the patient and roll first aid.
 * @param {Actor} [healer] defaults to the selected token's or the user's actor
 * @returns {Promise<void>}
 */
export async function firstAid(healer) {
    healer ??= game.macro.getActor();
    if (!healer) {
        ui.notifications.warn(game.i18n.localize("NOTIFICATION.MACRO_ACTOR_NOT_FOUND"));
        return;
    }
    const tokens = patientCandidates(healer);
    if (!tokens.length) {
        ui.notifications.warn(game.i18n.localize("MEDICAE.NO_PATIENT"));
        return;
    }
    const options = tokens.map(t => `<option value="${t.id}">${foundry.utils.escapeHTML(t.name)} — ${
        game.i18n.localize(`MEDICAE.STATE_${woundState(t.actor).toUpperCase()}`)}</option>`).join("");
    const content = `<div class="dark-heresy dialog"><div class="wrapper"><label>${game.i18n.localize("MEDICAE.PATIENT")}</label>
        <select name="patient">${options}</select></div></div>`;
    const tokenId = await foundry.applications.api.DialogV2.prompt({
        window: { title: game.i18n.format("MEDICAE.FIRST_AID_TITLE", { name: healer.name }) },
        content,
        ok: { label: game.i18n.localize("BUTTON.ROLL"), callback: (event, button) => button.form.elements.patient.value },
        rejectClose: false
    });
    const token = tokenId ? canvas.tokens.get(tokenId) : null;
    if (token) await rollFirstAid(healer, token);
}

/**
 * Medicae test for first aid on a token.
 * @param {Actor} healer
 * @param {Token} token patient
 */
export async function rollFirstAid(healer, token) {
    const patient = token.actor;
    const hours = hoursSinceFirstAid(patient);
    if (hours !== null && hours < 24) {
        const text = game.i18n.format("MEDICAE.TOO_SOON", { name: token.name, hours: Math.max(0, Math.floor(hours)) });
        if (!game.user.isGM) {
            ui.notifications.warn(text);
            return;
        }
        ui.notifications.info(text);
    }
    if (woundState(patient) === "none") {
        ui.notifications.info(game.i18n.format("MEDICAE.UNHURT", { name: token.name }));
        return;
    }
    const rollData = DarkHeresyUtil.createSkillRollData(healer, "medicae");
    rollData.target.modifier = firstAidModifier(patient);
    rollData.name = game.i18n.format("MEDICAE.FIRST_AID_NAME", { name: token.name });
    rollData.firstAid = { sceneId: token.document.parent?.id ?? null, tokenId: token.id, actorId: patient.id,
        intelligenceBonus: Number(healer.system.characteristics.intelligence.bonus) || 0, healer: healer.name };
    prepareCommonRoll(rollData);
}

/**
 * Remove damage from an actor, Critical damage first.
 * @param {Actor} actor
 * @param {number} amount
 * @returns {Promise<object>} {critical, wounds} removed
 */
export async function healDamage(actor, amount) {
    const critical = Number(actor.system.wounds.critical) || 0;
    const damage = Number(actor.system.wounds.value) || 0;
    const fromCritical = Math.min(critical, amount);
    const fromWounds = Math.min(damage, amount - fromCritical);
    await actor.update({ "system.wounds.critical": critical - fromCritical, "system.wounds.value": damage - fromWounds });
    return { critical: fromCritical, wounds: fromWounds };
}

/* -------------------------------------------- */
/*  Blood Loss                                  */
/* -------------------------------------------- */

const hasItem = (actor, type, re) => actor.items.some(i => i.type === type && re.test(i.name.trim()));

/**
 * Add one level of Fatigue.
 * @param {Actor} actor
 * @returns {Promise<number>} the new fatigue
 */
async function addFatigue(actor) {
    const value = (Number(actor.system.fatigue?.value) || 0) + 1;
    await actor.update({ "system.fatigue.value": value });
    return value;
}

const lastTick = new Map();

/** updateCombat: Blood Loss at the start of the current combatant's turn (active GM only). */
async function onCombatUpdate(combat, changes) {
    if (game.user !== game.users.activeGM || !combat.started) return;
    if (!("turn" in changes || "round" in changes)) return;
    const key = `${combat.round}.${combat.turn}`;
    if (lastTick.get(combat.id) === key) return;
    lastTick.set(combat.id, key);
    const combatant = combat.combatant;
    const actor = combatant?.actor;
    if (!actor?.statuses?.has("bleeding") || hasItem(actor, "trait", UNDYING)) return;
    const name = combatant.token?.name ?? actor.name;
    const link = { sceneId: combatant.sceneId ?? combat.scene?.id ?? null, tokenId: combatant.tokenId, actorId: combatant.actorId };
    const dieHard = hasItem(actor, "talent", DIE_HARD);
    const fatigue = dieHard ? null : await addFatigue(actor);
    const content = await renderTemplate("systems/dark-heresy/template/chat/bleeding.hbs", { name, dieHard, fatigue });
    await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }),
        flags: { "dark-heresy": { bleeding: link } } });
}

/**
 * Bleeding card buttons: stop the bleeding (Medicae −10, selected token or the bleeding character)
 * or the Die Hard Willpower test.
 * @param {Event} event
 */
export function onBleedingClick(event) {
    event.preventDefault();
    const id = event.currentTarget.closest(".message")?.dataset.messageId;
    const link = game.messages.get(id)?.getFlag("dark-heresy", "bleeding");
    if (!link) return;
    const patient = resolveActor(link);
    if (!patient) return;
    let rollData;
    if (event.currentTarget.dataset.action === "die-hard") {
        if (!patient.isOwner) {
            ui.notifications.warn(game.i18n.localize("PINNING.NOT_OWNER"));
            return;
        }
        rollData = DarkHeresyUtil.createCharacteristicRollData(patient, "willpower");
        rollData.target.modifier = 0;
        rollData.name = game.i18n.localize("MEDICAE.DIE_HARD_NAME");
        rollData.bleeding = { ...link, test: "dieHard" };
    } else {
        const healer = game.macro.getActor() ?? (patient.isOwner ? patient : null);
        if (!healer) {
            ui.notifications.warn(game.i18n.localize("NOTIFICATION.MACRO_ACTOR_NOT_FOUND"));
            return;
        }
        rollData = DarkHeresyUtil.createSkillRollData(healer, "medicae");
        rollData.target.modifier = -10;
        rollData.name = game.i18n.format("MEDICAE.STOP_BLEEDING_NAME", { name: patient.name });
        rollData.bleeding = { ...link, test: "stop" };
    }
    prepareCommonRoll(rollData);
}

/** createChatMessage: apply first aid and Blood Loss test results. */
async function onResult(message) {
    const rollData = message.getFlag("dark-heresy", "rollData");
    if (!rollData || !(rollData.firstAid || rollData.bleeding) || !appliesResults(message)) return;
    const success = Boolean(rollData.flags?.isSuccess);
    if (rollData.firstAid) {
        const patient = resolveActor(rollData.firstAid);
        if (!patient || !success) return;
        const amount = rollData.firstAid.intelligenceBonus + (Number(rollData.dos) || 0);
        const removed = await healDamage(patient, amount);
        await patient.setFlag("dark-heresy", "firstAid", game.time.worldTime);
        await ChatMessage.create({
            speaker: message.speaker,
            content: `<div class="dark-heresy chat roll"><div class="background border"><p>${game.i18n.format("MEDICAE.HEALED", {
                name: foundry.utils.escapeHTML(patient.name), amount, critical: removed.critical, wounds: removed.wounds,
                damage: patient.system.wounds.value, criticalLeft: patient.system.wounds.critical })}</p></div></div>`
        });
        return;
    }
    const link = rollData.bleeding;
    const patient = resolveActor(link);
    if (!patient) return;
    if (link.test === "stop" && success) await patient.toggleStatusEffect("bleeding", { active: false });
    else if (link.test === "dieHard" && !success) await addFatigue(patient);
}

/** Register hooks and the macro API; call during init. */
export function registerMedicae() {
    Hooks.on("updateCombat", onCombatUpdate);
    Hooks.on("createChatMessage", onResult);
    const addButton = (sheet, buttons) => {
        const actor = sheet.actor ?? sheet.document;
        if (!actor?.isOwner || !actor.system?.skills?.medicae) return;
        buttons.unshift({ label: game.i18n.localize("MEDICAE.FIRST_AID"), class: "first-aid",
            icon: "fas fa-kit-medical", onclick: () => firstAid(actor) });
    };
    Hooks.on("getActorSheetHeaderButtons", addButton);
    Hooks.on("getHeaderControlsActorSheetV2", (sheet, controls) => {
        const actor = sheet.document;
        if (!actor?.isOwner || !actor.system?.skills?.medicae) return;
        controls.unshift({ label: "MEDICAE.FIRST_AID", icon: "fas fa-kit-medical", action: "dhFirstAid",
            onClick: () => firstAid(actor) });
    });
}
