/**
 * Malignancies, mutations, mental traumas and disorders (core rulebook, Russian edition, chapter VIII:
 * «Безумие» p. 350–353, «Порча» p. 353–356).
 *
 * - Trauma test failed (p. 350): roll table 8-13 «Умственные Травмы», 1d100 +10 per degree of failure after
 *   the first (the table heading; the text on p. 350 says «for each degree»). The effect is temporary; its duration
 *   is rolled.
 * - Malignancy test failed (p. 354): roll table 8-15 «Рудименты»; a result the character already has is rolled
 *   again.
 * - Mutation test failed (p. 354): roll table 8-16 «Мутации»; a result the character already has is rolled again.
 * - Disorders (p. 350–353): no roll; at 40/60/80 Insanity the GM or player picks a Minor/Severe/Acute disorder
 *   (a worse degree of an existing one, or a new one) from the examples or makes one up.
 *
 * The failed test card has a button to roll the table; the result card has «Add to sheet», which creates the item
 * (malignancy, mutation, mentalDisorder) with the full text and source, through the active GM when the user does not
 * own the character. Table rows may carry markup (see sources/rules/tables/README.md in the campaign repository):
 * `characteristics` (permanent change rolled and applied to the characteristic base on adding), `traits`
 * (trait items created with the mutation), `fateFailure` / `willNotDie` (flags read by fate.js), `duration`.
 * Texts are registered by the world module (game.darkHeresy.registerTables); the system ships none.
 */

import { getTable, resultView } from "./tables.js";
import { rollActor } from "./fate.js";

const SOCKET = "system.dark-heresy";

const KINDS = {
    trauma: { table: "trauma", number: "8-13", type: "mentalDisorder", label: "MIND.TRAUMA" },
    malignancy: { table: "malignancy", number: "8-15", type: "malignancy", label: "CORRUPTION.MALIGNANCY" },
    mutation: { table: "mutation", number: "8-16", type: "mutation", label: "CORRUPTION.MUTATION" }
};
const SEVERITY_FALLBACK = [
    { severity: "minor", label: "MIND.SEVERITY_MINOR", suppress: 10, insanity: 40 },
    { severity: "severe", label: "MIND.SEVERITY_SEVERE", suppress: 0, insanity: 60 },
    { severity: "acute", label: "MIND.SEVERITY_ACUTE", suppress: -10, insanity: 80 }
];
const MAX_REROLLS = 30;

/** Dice notation for display: «1d10» → «1к10» is left to the data; the code shows formulas as written. */
const escape = s => foundry.utils.escapeHTML(String(s ?? ""));

/**
 * Does the actor already have this table result?
 * @param {Actor} actor
 * @param {string} kind
 * @param {object} view resultView of the row
 * @returns {boolean}
 */
function hasResult(actor, kind, view) {
    const { table, type } = KINDS[kind];
    return actor.items.some(i => {
        const flag = i.getFlag("dark-heresy", "table");
        if (flag) return flag.id === table && flag.min === view.min;
        return i.type === type && view.name && i.name.trim().toLowerCase() === view.name.trim().toLowerCase();
    });
}

/**
 * Roll a table of chapter VIII and post the result card.
 * @param {Actor} actor
 * @param {string} kind trauma, malignancy or mutation
 * @param {object} [options]
 * @param {number} [options.dof=1] degrees of failure of the Trauma test
 * @param {string} [options.formula] roll formula instead of 1d100 (e.g. «5d10» for a Mutant's starting mutations)
 * @returns {Promise<ChatMessage|undefined>}
 */
export async function rollMindTable(actor, kind, { dof = 1, formula = null } = {}) {
    const def = KINDS[kind];
    if (!actor || !def) return;
    const modifier = kind === "trauma" ? 10 * Math.max(0, (Number(dof) || 1) - 1) : 0;
    const base = formula || "1d100";
    const rolls = [];
    const rerolled = [];
    let roll;
    let view;
    for (let i = 0; i <= MAX_REROLLS; i++) {
        roll = await new Roll(modifier ? `${base} + ${modifier}` : base).evaluate();
        rolls.push(roll);
        view = resultView(def.table, roll.total, def.number);
        // A malignancy or mutation the character already has is rolled again (p. 354)
        if (kind === "trauma" || !view.hasText || !hasResult(actor, kind, view)) break;
        rerolled.push({ roll: roll.total, name: view.name || view.label });
    }
    let duration = null;
    const dur = view.row?.duration;
    if (dur?.formula) {
        const r = await new Roll(dur.formula).evaluate();
        rolls.push(r);
        duration = { total: r.total, unit: dur.unit ?? "", formula: dur.formula };
    }
    const table = getTable(def.table);
    const content = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/mind-result.hbs", {
        name: actor.name,
        title: game.i18n.localize(def.label),
        actorUuid: actor.uuid,
        roll: roll.total,
        modifier,
        dof,
        rerolled,
        result: view,
        duration,
        canAdd: view.hasText,
        hasTable: Boolean(table)
    });
    return ChatMessage.create({
        content,
        rolls,
        speaker: ChatMessage.getSpeaker({ actor }),
        flags: { "dark-heresy.mindResult": { kind, actorUuid: actor.uuid, value: roll.total, duration } }
    });
}

/**
 * Chat button on a failed Trauma / Malignancy / mutation test: roll the table.
 * @param {Event} event
 */
export async function onMindTableClick(event) {
    event.preventDefault();
    const message = game.messages.get(event.currentTarget.closest(".message")?.dataset.messageId);
    const rollData = message?.getRollData();
    const kind = rollData?.flags?.mindTest;
    const actor = rollActor(rollData);
    if (!kind || !actor) return;
    if (!(game.user.isGM || actor.isOwner)) {
        ui.notifications.warn(game.i18n.format("FATE_POINTS.NOT_OWNER", { name: actor.name }));
        return;
    }
    event.currentTarget.disabled = true;
    await rollMindTable(actor, kind, { dof: rollData.dof });
    if (message.isOwner) await message.setFlag("dark-heresy", "mindRolled", true);
}

/* -------------------------------------------- */
/*  Adding results to the sheet                 */
/* -------------------------------------------- */

/**
 * Source line for an item made from a table.
 * @param {object} table registered table
 * @param {string} [label] row label
 * @param {number} [page] page of the row when it differs from the table's
 * @returns {string}
 */
function sourceLine(table, label = "", page = null) {
    if (!table) return "";
    return game.i18n.format(table.table ? "MIND.SOURCE_TABLE" : "MIND.SOURCE_PAGE", {
        source: table.sourceLabel ?? "", page: page ?? table.page ?? "", table: table.table ?? "", title: table.title ?? "", label
    }).trim();
}

/**
 * Roll the permanent characteristic changes of a row: {agility: "-1d10"} → [{key, formula, value}].
 * @param {object} changes
 * @returns {Promise<{key: string, formula: string, value: number, roll: Roll}[]>}
 */
async function rollCharacteristicChanges(changes) {
    const out = [];
    for (const [key, formula] of Object.entries(changes ?? {})) {
        const roll = await new Roll(String(formula)).evaluate();
        out.push({ key, formula: String(formula), value: roll.total, roll });
    }
    return out;
}

/**
 * Create the items and apply characteristic changes: on the owner's client or the active GM's.
 * @param {Actor} actor
 * @param {object[]} items item data
 * @param {object} updates actor update (characteristic bases)
 */
async function applyToSheet(actor, items, updates) {
    if (actor.isOwner) {
        await actor.createEmbeddedDocuments("Item", items);
        if (Object.keys(updates).length) await actor.update(updates);
        return true;
    }
    if (!game.users.activeGM) {
        ui.notifications.warn(game.i18n.format("DAMAGE.NO_GM", { name: actor.name }));
        return false;
    }
    game.socket.emit(SOCKET, { type: "mindAdd", uuid: actor.uuid, items, updates });
    return true;
}

/**
 * Build the item data for a table result and add it to the actor.
 * @param {Actor} actor
 * @param {string} kind
 * @param {number} value the rolled value
 * @param {object|null} duration rolled duration of a trauma
 * @returns {Promise<{name: string, notes: string[]}|null>}
 */
export async function addMindResult(actor, kind, value, duration = null) {
    const def = KINDS[kind];
    const table = getTable(def?.table);
    const view = def && resultView(def.table, value, def.number);
    if (!view?.hasText || !actor) return null;
    const row = view.row;
    const name = row.name || `${table.title} (${row.label})`;
    const paragraphs = [`<p>${escape(row.text)}</p>`];
    if (duration) paragraphs.push(`<p><strong>${game.i18n.localize("MIND.DURATION")}:</strong> ${duration.total} ${escape(duration.unit)} (${escape(duration.formula)})</p>`);
    const notes = [];
    const updates = {};
    for (const change of await rollCharacteristicChanges(row.characteristics)) {
        const characteristic = actor.system.characteristics?.[change.key];
        if (!characteristic) continue;
        const base = Number(characteristic.base) || 0;
        const after = Math.max(1, base + change.value);
        updates[`system.characteristics.${change.key}.base`] = after;
        const note = game.i18n.format("MIND.CHARACTERISTIC_CHANGED", {
            characteristic: game.i18n.localize(characteristic.label), value: change.value > 0 ? `+${change.value}` : `${change.value}`,
            formula: change.formula, before: base, after
        });
        notes.push(note);
        paragraphs.push(`<p><em>${escape(note)}</em></p>`);
    }
    const source = sourceLine(table, row.label);
    const flags = { "dark-heresy": { table: { id: def.table, min: row.min, label: row.label } } };
    if (row.fateFailure) flags["dark-heresy"].fateFailure = row.fateFailure;
    if (row.willNotDie) flags["dark-heresy"].willNotDie = row.willNotDie;
    const items = [{ name, type: def.type, system: { description: paragraphs.join(""), source }, flags }];
    for (const trait of row.traits ?? []) {
        items.push({ name: trait, type: "trait", system: {
            description: `<p>${escape(game.i18n.format("MIND.TRAIT_FROM", { name }))}</p>`, source } });
        notes.push(game.i18n.format("MIND.TRAIT_ADDED", { trait }));
    }
    const ok = await applyToSheet(actor, items, updates);
    return ok ? { name, notes } : null;
}

/**
 * Chat button «Add to sheet» on a table result.
 * @param {Event} event
 */
export async function onMindAddClick(event) {
    event.preventDefault();
    const button = event.currentTarget;
    const message = game.messages.get(button.closest(".message")?.dataset.messageId);
    const data = message?.getFlag("dark-heresy", "mindResult");
    if (!data) return;
    const actor = await fromUuid(data.actorUuid);
    if (!actor) return;
    // The owner, the GM or whoever rolled the result; the latter adds it through the active GM
    if (!(game.user.isGM || actor.isOwner || message.isAuthor)) {
        ui.notifications.warn(game.i18n.format("FATE_POINTS.NOT_OWNER", { name: actor.name }));
        return;
    }
    button.disabled = true;
    const added = await addMindResult(actor, data.kind, data.value, data.duration);
    if (!added) {
        button.disabled = false;
        return;
    }
    const content = `<div class="dark-heresy chat roll"><div class="background border">
        <p>${escape(game.i18n.format("MIND.ADDED", { name: actor.name, item: added.name }))}</p>
        ${added.notes.map(n => `<p><em>${escape(n)}</em></p>`).join("")}</div></div>`;
    await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
    if (message.isOwner) await message.setFlag("dark-heresy", "mindAdded", true);
    else if (game.users.activeGM) game.socket.emit(SOCKET, { type: "fateUpdateMessage", messageId: message.id,
        changes: { "flags.dark-heresy.mindAdded": true } });
}

/* -------------------------------------------- */
/*  Mental disorders                            */
/* -------------------------------------------- */

/**
 * Severity rows: registered table «disorder-severity» or the fallback.
 * @returns {object[]}
 */
function severities() {
    const rows = getTable("disorder-severity")?.rows;
    if (rows?.length) return rows.map(r => ({ ...r, label: r.label ?? r.name }));
    return SEVERITY_FALLBACK.map(s => ({ ...s, label: game.i18n.localize(s.label), name: game.i18n.localize(s.label), text: "" }));
}

/**
 * Pick a mental disorder (p. 350–353) and add it to the actor, or raise an existing one to the chosen degree.
 * @param {Actor} actor
 * @param {object} [options]
 * @param {string} [options.severity] minor, severe or acute; by default from the Insanity points
 * @returns {Promise<Item|undefined>}
 */
export async function chooseDisorder(actor, { severity = null } = {}) {
    if (!actor) return;
    if (!(game.user.isGM || actor.isOwner)) {
        ui.notifications.warn(game.i18n.format("FATE_POINTS.NOT_OWNER", { name: actor.name }));
        return;
    }
    const insanity = Number(actor.system.insanity) || 0;
    const levels = severities();
    severity ??= insanity >= 80 ? "acute" : insanity >= 60 ? "severe" : "minor";
    const table = getTable("disorders");
    const rows = table?.rows ?? [];
    const own = actor.items.filter(i => i.type === "mentalDisorder" && i.getFlag("dark-heresy", "disorder"));
    const groups = new Map();
    for (const r of rows) {
        if (!groups.has(r.group)) groups.set(r.group, []);
        groups.get(r.group).push(r);
    }
    let options = "";
    if (own.length) {
        options += `<optgroup label="${escape(game.i18n.localize("MIND.DISORDER_RAISE"))}">${own.map(i =>
            `<option value="item:${i.id}">${escape(i.name)}</option>`).join("")}</optgroup>`;
    }
    for (const [group, list] of groups) {
        options += `<optgroup label="${escape(group)}">${list.map(r =>
            `<option value="row:${r.min}">${escape(r.name)}</option>`).join("")}</optgroup>`;
    }
    options += `<option value="custom">${escape(game.i18n.localize("MIND.DISORDER_CUSTOM"))}</option>`;
    const content = `
        <p class="hint">${escape(game.i18n.format("MIND.DISORDER_HINT", { insanity }))}</p>
        <div class="form-group"><label>${escape(game.i18n.localize("MIND.DISORDER"))}</label>
            <select name="disorder">${options}</select></div>
        <div class="form-group"><label>${escape(game.i18n.localize("MIND.DISORDER_NAME"))}</label>
            <input type="text" name="custom" placeholder="${escape(game.i18n.localize("MIND.DISORDER_NAME_HINT"))}"></div>
        <div class="form-group"><label>${escape(game.i18n.localize("MIND.DISORDER_SEVERITY"))}</label>
            <select name="severity">${levels.map(l =>
                `<option value="${l.severity}"${l.severity === severity ? " selected" : ""}>${escape(l.label)}</option>`).join("")}</select></div>`;
    const result = await foundry.applications.api.DialogV2.prompt({
        window: { title: game.i18n.format("MIND.DISORDER_TITLE", { name: actor.name }) },
        position: { width: 460 },
        content,
        ok: {
            label: game.i18n.localize("MIND.ADD_TO_SHEET"),
            callback: (event, button) => ({
                disorder: button.form.elements.disorder.value,
                custom: button.form.elements.custom.value.trim(),
                severity: button.form.elements.severity.value
            })
        },
        rejectClose: false
    });
    if (!result) return;
    const level = levels.find(l => l.severity === result.severity) ?? levels[0];
    let base;
    let existing = null;
    if (result.custom) {
        base = { name: result.custom, paragraphs: [] };
    } else if (result.disorder.startsWith("item:")) {
        existing = actor.items.get(result.disorder.slice(5));
        const flag = existing?.getFlag("dark-heresy", "disorder") ?? {};
        const row = rows.find(r => r.min === flag.min);
        base = row ? disorderBase(row) : { name: flag.name ?? existing?.name ?? "", paragraphs: [] };
    } else if (result.disorder.startsWith("row:")) {
        base = disorderBase(rows.find(r => r.min === Number(result.disorder.slice(4))));
    } else {
        ui.notifications.warn(game.i18n.localize("MIND.DISORDER_NAME_HINT"));
        return;
    }
    const paragraphs = [...base.paragraphs];
    if (level.text) paragraphs.push(`<p><strong>${escape(level.name)}:</strong> ${escape(level.text)}</p>`);
    paragraphs.push(`<p><em>${escape(game.i18n.format("MIND.DISORDER_SUPPRESS", { modifier: signed(level.suppress) }))}</em></p>`);
    const severityTable = getTable("disorder-severity");
    const data = {
        name: `${base.name} (${level.label})`,
        type: "mentalDisorder",
        system: { description: paragraphs.join(""), source: [base.source, sourceLine(severityTable)].filter(Boolean).join("; ") },
        flags: { "dark-heresy": { disorder: { min: base.min ?? null, name: base.name, severity: level.severity, suppress: level.suppress } } }
    };
    if (existing) {
        if (actor.isOwner) await existing.update(data);
        else game.socket.emit(SOCKET, { type: "mindUpdateItem", uuid: existing.uuid, data });
    } else if (!await applyToSheet(actor, [data], {})) return;
    await ChatMessage.create({
        content: `<div class="dark-heresy chat roll"><div class="background border"><h1>${escape(game.i18n.localize("MIND.DISORDER"))}</h1>
            <p>${escape(game.i18n.format("MIND.DISORDER_ADDED", { name: actor.name, item: data.name }))}</p>${paragraphs.join("")}</div></div>`,
        speaker: ChatMessage.getSpeaker({ actor })
    });
}

const signed = n => (Number(n) > 0 ? `+${Number(n)}` : `${Number(n) || 0}`);

/**
 * Name, text and source of a disorder example row.
 * @param {object} row
 * @returns {{name: string, min: number, paragraphs: string[], source: string}}
 */
function disorderBase(row) {
    const paragraphs = [];
    if (row.groupText) paragraphs.push(`<p><strong>${escape(row.group)}:</strong> ${escape(row.groupText)}</p>`);
    paragraphs.push(`<p><strong>${escape(row.name)}:</strong> ${escape(row.text)}</p>`);
    return { name: row.name, min: row.min, paragraphs, source: sourceLine(getTable("disorders"), "", row.page) };
}

/**
 * Willpower test to suppress a disorder for the encounter (p. 351): +10 Minor, +0 Severe, −10 Acute.
 * @param {Actor} actor
 * @param {Item} item the mentalDisorder
 * @param {Function} prepareCommonRoll
 * @param {object} DarkHeresyUtil
 */
export function suppressDisorder(actor, item, prepareCommonRoll, DarkHeresyUtil) {
    const flag = item.getFlag("dark-heresy", "disorder");
    let modifier = flag?.suppress;
    if (modifier === undefined) {
        // Typed by hand: guess the degree from the name
        modifier = /остр|acute/i.test(item.name) ? -10 : /сильн|сложн|severe/i.test(item.name) ? 0 : 10;
    }
    const rollData = DarkHeresyUtil.createCharacteristicRollData(actor, "willpower");
    rollData.name = game.i18n.format("MIND.SUPPRESS_TEST", { name: item.name });
    rollData.target.modifier = modifier;
    prepareCommonRoll(rollData);
}

/** Register the API; call during init. */
export function registerMindApi() {
    Object.assign(game.darkHeresy, { mind: { rollTable: rollMindTable, addResult: addMindResult, chooseDisorder } });
}

/** GM side of sheet changes requested by players; call on ready. */
export function registerMindSocket() {
    game.socket.on(SOCKET, async data => {
        if (game.user !== game.users.activeGM) return;
        if (data?.type === "mindAdd") {
            const actor = await fromUuid(data.uuid);
            if (!actor) return;
            if (data.items?.length) await actor.createEmbeddedDocuments("Item", data.items);
            if (data.updates && Object.keys(data.updates).length) await actor.update(data.updates);
        } else if (data?.type === "mindUpdateItem") {
            await (await fromUuid(data.uuid))?.update(data.data);
        }
    });
}
