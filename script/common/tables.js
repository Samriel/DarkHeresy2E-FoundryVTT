/**
 * Roll tables: critical effects, psychic phenomena, perils of the warp and shock.
 *
 * The system ships no table texts. A world module registers them with
 * game.darkHeresy.registerTables([{id, title, table, page, sourceLabel, rows: [{min, max, label, name?, text,
 * conditions?, next?}]}]). Table ids: «critical.<energy|explosive|impact|rending>.<arm|body|head|leg>»,
 * «phenomena», «perils», «shock». Without registered texts the cards still show the roll and the table number.
 *
 * Rules (DH2 core rulebook, Russian edition page numbers):
 * - Critical damage (p. 286–287, tables 7-7…7-22): the row is the target's total critical damage after the hit,
 *   on the table of the hit's damage type and location (results stack, see the machine example on p. 312).
 * - Righteous Fury (p. 280): a hit that deals damage also inflicts a 1d5 critical effect that does not count as
 *   critical damage; troop NPCs simply die.
 * - Psychic phenomena (p. 239–241, tables 6-1…6-3): unbound psykers add +10, or +5 per pushed point (max +20);
 *   daemonic ones +10 per pushed point (max +30), and perils hit everyone but them; +10 per sustained power after
 *   the first; Warp Conduit +30 (p. 150). 75+ on table 6-2 rolls table 6-3. Favoured by the Warp (p. 145): a
 *   result other than perils may be rolled again, the player chooses.
 * - Fear (p. 349, table 8-11): a failed fear test in combat rolls Shock at +10 per degree of failure after the
 *   first; failing by three or more degrees also gives 1d5 insanity points. Outside combat the character is
 *   shaken (−10 to tests requiring concentration). Warp Shock (p. 353): insanity from the fear of a Warp entity
 *   (Daemonic or Warp Instability source) also gives Corruption equal to its Fear rating.
 * - A result that kills (condition «dead») offers burning Fate to the target when it has a Fate threshold
 *   (fate.js, p. 357); a row with `noFateBurn` (perils 100+) does not.
 * Conditions a row imposes unconditionally are offered as buttons; nothing is applied automatically.
 */

import { canBurnFate } from "./fate.js";

const SOCKET = "system.dark-heresy";

const tables = new Map();

const DAMAGE_KEY = { E: "energy", I: "impact", R: "rending", X: "explosive" };
const LOCATION_KEY = {
    "ARMOUR.HEAD": "head", "ARMOUR.LEFT_ARM": "arm", "ARMOUR.RIGHT_ARM": "arm",
    "ARMOUR.BODY": "body", "ARMOUR.LEFT_LEG": "leg", "ARMOUR.RIGHT_LEG": "leg"
};
const TABLE_NUMBER = { phenomena: "6-2", perils: "6-3", shock: "8-11" };
const CRITICAL_NUMBER = {
    energy: { arm: "7-7", body: "7-8", head: "7-9", leg: "7-10" },
    explosive: { arm: "7-11", body: "7-12", head: "7-13", leg: "7-14" },
    impact: { arm: "7-15", body: "7-16", head: "7-17", leg: "7-18" },
    rending: { arm: "7-19", body: "7-20", head: "7-21", leg: "7-22" }
};
const PERILS_FROM = 75;

/**
 * Register roll table texts (called by a world module).
 * @param {object[]} list
 */
export function registerTables(list) {
    for (const t of list ?? []) if (t?.id) tables.set(t.id, t);
}

/**
 * The row of a registered table for a roll result; results below the first row use the first row.
 * @param {string} id
 * @param {number} value
 * @returns {object|null}
 */
export function tableRow(id, value) {
    const rows = tables.get(id)?.rows;
    if (!rows?.length) return null;
    return rows.find(r => value >= r.min && (r.max === null || r.max === undefined || value <= r.max))
        ?? (value < rows[0].min ? rows[0] : rows[rows.length - 1]);
}

/**
 * A registered table.
 * @param {string} id
 * @returns {object|undefined}
 */
export function getTable(id) {
    return tables.get(id);
}

/**
 * Template data for one table result.
 * @param {string} id table id
 * @param {number} value the value looked up
 * @param {string} fallbackNumber table number shown when no texts are registered
 * @param {Actor|null} [actor] the character the result applies to: a deadly result offers burning Fate
 * @returns {object}
 */
export function resultView(id, value, fallbackNumber, actor = null) {
    const table = tables.get(id);
    const row = tableRow(id, value);
    const conditions = (row?.conditions ?? []).map(cid => {
        const status = CONFIG.statusEffects.find(s => s.id === cid);
        return status ? { id: cid, name: game.i18n.localize(status.name ?? status.label), img: status.img } : null;
    }).filter(Boolean);
    return {
        id, value,
        number: table?.table ?? fallbackNumber,
        title: table?.title ?? "",
        source: table?.sourceLabel ?? "",
        page: table?.page ?? "",
        label: row?.label ?? String(value),
        name: row?.name ?? "",
        text: row?.text ?? "",
        hasText: Boolean(row),
        min: row?.min ?? null,
        row: row ?? null,
        next: row?.next ?? (!row && id === "phenomena" && value >= PERILS_FROM ? "perils" : null),
        conditions,
        // Burning Fate (core p. 357): a result that kills the character, unless the row forbids it
        burn: Boolean(actor && !row?.noFateBurn && conditions.some(c => c.id === "dead") && canBurnFate(actor))
    };
}

/**
 * Critical effect for a hit: table by damage type letter and location, row by value.
 * @param {string} type damage letter (E, I, R, X)
 * @param {string} location armour location key (ARMOUR.BODY …)
 * @param {number} value total critical damage, or the Righteous Fury 1d5
 * @param {Actor|null} [actor] the target (offers burning Fate on a deadly result)
 * @returns {object}
 */
export function criticalEffect(type, location, value, actor = null) {
    const dtype = DAMAGE_KEY[String(type ?? "I").toUpperCase()] ?? "impact";
    const loc = LOCATION_KEY[location] ?? "body";
    return resultView(`critical.${dtype}.${loc}`, Math.max(1, Number(value) || 1), CRITICAL_NUMBER[dtype][loc], actor);
}

/* -------------------------------------------- */
/*  Conditions                                  */
/* -------------------------------------------- */

/**
 * Turn a status effect on for an actor: directly when owned, otherwise through the active GM.
 * @param {string} uuid actor uuid (synthetic token actors included)
 * @param {string} statusId
 */
async function applyCondition(uuid, statusId) {
    const actor = await fromUuid(uuid);
    if (!actor) return;
    if (actor.isOwner) {
        if (!actor.statuses?.has(statusId)) await actor.toggleStatusEffect(statusId, { active: true, overlay: statusId === "dead" });
    } else if (game.users.activeGM) {
        game.socket.emit(SOCKET, { type: "applyCondition", uuid, statusId });
    } else {
        ui.notifications.warn(game.i18n.format("DAMAGE.NO_GM", { name: actor.name }));
    }
}

/**
 * Chat button: apply the condition named on the button to the actor of the card.
 * @param {Event} event
 */
export async function onApplyConditionClick(event) {
    event.preventDefault();
    const { uuid, condition } = event.currentTarget.dataset;
    if (uuid && condition) await applyCondition(uuid, condition);
}

/* -------------------------------------------- */
/*  Psychic phenomena and perils of the warp    */
/* -------------------------------------------- */

/**
 * Modifier to the psychic phenomena roll for a focus power test.
 * @param {object} psy rollData.psy (class, rating, value, warpConduit)
 * @param {Actor|null} actor the psyker (sustained powers)
 * @returns {{total: number, parts: {label: string, value: number}[]}}
 */
export function phenomenaModifier(psy, actor) {
    const parts = [];
    const pushed = Math.max(0, (Number(psy.value) || 0) - (Number(psy.rating) || 0));
    if (psy.class === "unbound") {
        if (pushed) parts.push({ label: "TABLES.MOD_UNBOUND_PUSH", value: Math.min(5 * pushed, 20) });
        else parts.push({ label: "TABLES.MOD_UNBOUND", value: 10 });
    } else if (psy.class === "daemonic" && pushed) {
        parts.push({ label: "TABLES.MOD_DAEMONIC_PUSH", value: Math.min(10 * pushed, 30) });
    }
    const sustained = Number(actor?.system?.psy?.sustained) || 0;
    if (sustained > 1) parts.push({ label: "TABLES.MOD_SUSTAINED", value: 10 * (sustained - 1) });
    if (psy.warpConduit) parts.push({ label: "TABLES.MOD_WARP_CONDUIT", value: 30 });
    for (const p of parts) p.label = game.i18n.localize(p.label);
    return { total: parts.reduce((s, p) => s + p.value, 0), parts };
}

/**
 * Does the actor have Favoured by the Warp (Благоволение Варпа)?
 * @param {Actor|null} actor
 * @returns {boolean}
 */
function favouredByWarp(actor) {
    return Boolean(actor?.items.some(i => i.type === "talent" && /благоволение\s+варпа|favou?red\s+by\s+the\s+warp/i.test(i.name)));
}

/**
 * Roll psychic phenomena (and perils when the table says so) and post the result card.
 * @param {Actor|null} actor the psyker
 * @param {object} options
 * @param {number} options.modifier phenomena modifier
 * @param {number} options.perilsModifier perils modifier
 * @param {string} options.psykerClass bound, unbound or daemonic
 * @param {object[]} [options.parts] modifier breakdown for the card
 * @returns {Promise<ChatMessage>}
 */
export async function rollPhenomena(actor, { modifier = 0, perilsModifier = 0, psykerClass = "bound", parts = [] } = {}) {
    const rolls = [];
    const roll = await new Roll(`1d100 + ${Number(modifier) || 0}`).evaluate();
    rolls.push(roll);
    const phenomena = resultView("phenomena", roll.total, TABLE_NUMBER.phenomena);
    let alternative = null;
    if (phenomena.next !== "perils" && favouredByWarp(actor)) {
        const second = await new Roll(`1d100 + ${Number(modifier) || 0}`).evaluate();
        rolls.push(second);
        alternative = resultView("phenomena", second.total, TABLE_NUMBER.phenomena);
        alternative.roll = second.total;
    }
    let perils = null;
    if (phenomena.next === "perils") {
        const perilsRoll = await new Roll(`1d100 + ${Number(perilsModifier) || 0}`).evaluate();
        rolls.push(perilsRoll);
        perils = resultView("perils", perilsRoll.total, TABLE_NUMBER.perils, actor);
        perils.roll = perilsRoll.total;
        perils.modifier = Number(perilsModifier) || 0;
    }
    const content = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/phenomena.hbs", {
        name: actor?.name ?? "",
        actorUuid: actor?.uuid ?? "",
        roll: roll.total,
        modifier: Number(modifier) || 0,
        parts,
        phenomena,
        alternative,
        perils,
        daemonic: psykerClass === "daemonic"
    });
    return ChatMessage.create({
        content,
        rolls,
        speaker: ChatMessage.getSpeaker({ actor }),
        flags: { "dark-heresy.phenomena": { roll: roll.total, perils: perils?.roll ?? null } }
    });
}

/**
 * Chat button on a focus power card: confirm the modifiers, roll phenomena, mark the card as rolled.
 * @param {Event} event
 */
export async function onPhenomenaClick(event) {
    event.preventDefault();
    const message = game.messages.get(event.currentTarget.closest(".message")?.dataset.messageId);
    const rollData = message?.getRollData();
    if (!rollData?.psy) return;
    const actor = game.actors.get(rollData.ownerId) ?? null;
    if (!(game.user.isGM || message.isAuthor || actor?.isOwner)) return;
    const computed = rollData.psy.phenomena ?? phenomenaModifier(rollData.psy, actor);
    const breakdown = computed.parts.map(p => `${p.label} ${p.value >= 0 ? "+" : ""}${p.value}`).join(", ");
    const result = await foundry.applications.api.DialogV2.prompt({
        window: { title: game.i18n.localize("TABLES.PHENOMENA") },
        content: `<p>${breakdown || game.i18n.localize("TABLES.NO_MODIFIERS")}</p>
            <div class="form-group"><label>${game.i18n.localize("TABLES.PHENOMENA_MODIFIER")}</label>
            <input type="number" name="modifier" value="${computed.total}"></div>
            <div class="form-group"><label>${game.i18n.localize("TABLES.PERILS_MODIFIER")}</label>
            <input type="number" name="perilsModifier" value="0"></div>`,
        ok: {
            label: game.i18n.localize("BUTTON.ROLL"),
            callback: (event, button) => ({
                modifier: Number(button.form.elements.modifier.value) || 0,
                perilsModifier: Number(button.form.elements.perilsModifier.value) || 0
            })
        },
        rejectClose: false
    });
    if (!result) return;
    await rollPhenomena(actor, { ...result, psykerClass: rollData.psy.class, parts: computed.parts });
    if (message.isOwner) await message.setFlag("dark-heresy", "phenomenaRolled", true);
}

/* -------------------------------------------- */
/*  Fear and shock                              */
/* -------------------------------------------- */

/**
 * Consequences of a failed fear test: Shock in combat, shaken outside it, insanity at 3+ degrees of failure.
 * @param {object} rollData the fear test (flags.isFear, dof, ownerId, fear?)
 * @returns {Promise<ChatMessage|undefined>}
 */
export async function fearConsequences(rollData) {
    if (!rollData?.flags?.isFear || rollData.flags.isSuccess) return;
    const actor = canvas?.tokens?.get(rollData.tokenId)?.actor ?? game.actors.get(rollData.ownerId);
    if (!actor) return;
    const dof = Number(rollData.dof) || 1;
    const combat = rollData.fear?.combat
        ?? Boolean(game.combat?.started && game.combat.combatants.some(c => c.actor === actor || c.actorId === actor.id));
    const rolls = [];
    let shock = null;
    if (combat) {
        const modifier = 10 * Math.max(0, dof - 1);
        const roll = await new Roll(`1d100 + ${modifier}`).evaluate();
        rolls.push(roll);
        shock = resultView("shock", roll.total, TABLE_NUMBER.shock);
        shock.roll = roll.total;
        shock.modifier = modifier;
    }
    let insanity = null;
    if (dof >= 3) {
        const roll = await new Roll("1d5").evaluate();
        rolls.push(roll);
        insanity = { points: roll.total, applied: false, trauma: false };
        if (actor.type === "acolyte" && actor.isOwner) {
            const before = Number(actor.system.insanity) || 0;
            const after = before + roll.total;
            await actor.update({ "system.insanity": after });
            insanity.applied = true;
            insanity.total = after;
            insanity.trauma = Math.floor(after / 10) > Math.floor(before / 10);
        }
        // Warp Shock (p. 353): insanity from fear of a Warp entity also gives Corruption equal to its Fear rating
        const rating = Number(rollData.fear?.rating) || 0;
        if (rollData.fear?.warp && rating) {
            insanity.warpShock = { points: rating, applied: false };
            if (actor.type === "acolyte" && actor.isOwner) {
                const total = (Number(actor.system.corruption) || 0) + rating;
                await actor.update({ "system.corruption": total });
                Object.assign(insanity.warpShock, { applied: true, total });
            }
        }
    }
    const content = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/shock.hbs", {
        name: actor.name, actorUuid: actor.uuid, dof, combat, shock, insanity
    });
    return ChatMessage.create({ content, rolls, speaker: ChatMessage.getSpeaker({ actor }),
        flags: { "dark-heresy.shock": { roll: shock?.roll ?? null, insanity: insanity?.points ?? 0 } } });
}

/** Register the public API, Handlebars helpers and the condition socket; call during init. */
export function registerTablesApi() {
    game.darkHeresy.registerTables = registerTables;
    game.darkHeresy.tableRow = tableRow;
    game.darkHeresy.rollPhenomena = rollPhenomena;
    Handlebars.registerHelper("dhSigned", v => (Number(v) >= 0 ? `+${Number(v)}` : `${Number(v)}`));
}

/** Listen for condition requests from players; only the active GM applies them. Call on ready. */
export function registerTablesSocket() {
    game.socket.on(SOCKET, async data => {
        if (data?.type !== "applyCondition" || game.user !== game.users.activeGM) return;
        const actor = await fromUuid(data.uuid);
        if (actor && !actor.statuses?.has(data.statusId)) {
            await actor.toggleStatusEffect(data.statusId, { active: true, overlay: data.statusId === "dead" });
        }
    });
}
