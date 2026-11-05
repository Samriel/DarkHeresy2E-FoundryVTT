/**
 * Requisition, Influence and Subtlety (core rulebook: availability and table 5-1 p. 171, craftsmanship
 * and table 5-2 p. 172, the requisition test, quantity and Subtlety p. 173, Commerce and barter p. 174,
 * using and losing Influence, Sacrifice p. 327–329, the Inquisitor's Influence p. 330, Subtlety p. 330–332).
 *
 * The requisition window (item sheet header, Item directory and compendium context menu):
 * - Influence test of the acolyte: availability (Ubiquitous succeeds automatically), craftsmanship,
 *   a free location modifier, an optional opposed Commerce test against the seller (+10 per degree of
 *   success, −10 and a possible Subtlety hit on three or more degrees of failure), an optional barter
 *   item of lower availability (bonus = difference of the availability modifiers, −20 if damaged; the
 *   item is lost only on a success).
 * - Sacrifice: −1d5 Influence before the roll for an automatic success with degrees = Fellowship bonus.
 * - Inquisitor's Influence: −2 Subtlety, the test uses the Inquisitor's Influence (world setting) and
 *   losses come from it.
 * - Success: the item goes onto the acolyte's sheet with the chosen craftsmanship; a weapon comes with
 *   two magazines (one loaded) plus one per degree after the first, ammunition with two magazines plus
 *   one per degree, grenades and drugs one item plus one per degree.
 * - Failure: degrees of failure above the Fellowship bonus are lost from Influence.
 * - A test for an item with a negative availability modifier lowers the group's Subtlety by its tens.
 * Subtlety and the Inquisitor's Influence are world settings only the active GM changes; their changes
 * are whispered to the GMs and logged. The GM panel (system settings) edits them and rolls Subtlety tests.
 */

const SOCKET = "system.dark-heresy";
const LOG_LIMIT = 200;

/** Table 5-1: availability → test modifier (null: acquired automatically). */
export const AVAILABILITY_MODIFIER = {
    ubiquitous: null, abundant: 30, plentiful: 20, common: 10, average: 0, scarce: -10, rare: -20,
    "very-rare": -30, "extremely-rare": -40, "near-unique": -50, unique: -60
};

/** Table 5-2: craftsmanship → requisition modifier. */
export const CRAFTSMANSHIP_MODIFIER = { poor: 10, common: 0, good: -20, best: -30 };

const signed = n => (n > 0 ? `+${n}` : `${n}`);
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const degrees = (a, b) => Math.floor(a / 10) - Math.floor(b / 10);

/**
 * d100 test against a target: {result, success, dos, dof}.
 * @param {number} target
 * @returns {Promise<object>}
 */
async function d100(target) {
    const roll = await new Roll("1d100").evaluate();
    const result = roll.total;
    const success = result <= target;
    return { roll, result, target, success,
        dos: success ? 1 + degrees(target, result) : 0, dof: success ? 0 : 1 + degrees(result, target) };
}

/**
 * What a success yields: kind and count.
 * @param {Item} item
 * @param {number} dos
 * @returns {object} {kind: "magazines"|"items"|null, count}
 */
export function requisitionYield(item, dos) {
    const extra = Math.max(0, dos - 1);
    if (item.type === "ammunition") return { kind: "magazines", count: 2 + extra };
    if (item.type === "weapon") {
        if (item.system.class === "thrown") return { kind: "items", count: 1 + extra };
        if (item.system.class !== "melee" && Number(item.system.clip?.max) > 0) return { kind: "magazines", count: 2 + extra };
        return { kind: null, count: 1 };
    }
    if (item.type === "drug") return { kind: "items", count: 1 + extra };
    return { kind: null, count: 1 };
}

/** Subtlety loss of a test for an item: the tens of a negative availability modifier. */
export const subtletyCost = modifier => (modifier < 0 ? Math.floor(-modifier / 10) : 0);

/* -------------------------------------------- */
/*  Requisition window                          */
/* -------------------------------------------- */

/**
 * Open the requisition window for an item and resolve the test.
 * @param {Item} item
 * @param {Actor} [actor] defaults to the selected token's or the user's actor, then the item's owner
 * @returns {Promise<void>}
 */
export async function requisition(item, actor) {
    actor ??= game.macro.getActor() ?? item.actor;
    if (!actor?.system?.characteristics?.influence) {
        ui.notifications.warn(game.i18n.localize("NOTIFICATION.MACRO_ACTOR_NOT_FOUND"));
        return;
    }
    if (typeof item.system?.availability !== "string") return;
    const cfg = game.darkHeresy.config;
    const availability = item.system.availability;
    const availMod = AVAILABILITY_MODIFIER[availability];
    const availLabel = `${game.i18n.localize(cfg.availability[availability] ?? availability)}${availMod === null ? "" : ` (${signed(availMod)})`}`;
    const crafts = Object.entries(cfg.craftmanship).map(([key, label]) =>
        `<option value="${key}"${key === (item.system.craftsmanship || "common") ? " selected" : ""}>${
            game.i18n.localize(label)} (${signed(CRAFTSMANSHIP_MODIFIER[key])})</option>`).join("");
    const barterItems = availMod === null ? [] : actor.items.filter(i => i !== item && typeof i.system?.availability === "string"
        && AVAILABILITY_MODIFIER[i.system.availability] !== null && AVAILABILITY_MODIFIER[i.system.availability] < availMod);
    const barter = barterItems.map(i => `<option value="${i.id}">${esc(i.name)} (${signed(availMod - AVAILABILITY_MODIFIER[i.system.availability])})</option>`).join("");
    const L = k => game.i18n.localize(k);
    const content = `<div class="dark-heresy dialog requisition">
        <p>${esc(actor.name)} — ${L("REQUISITION.AVAILABILITY")}: <strong>${availLabel}</strong></p>
        <div class="form-group"><label>${L("REQUISITION.CRAFTSMANSHIP")}</label><select name="craftsmanship">${crafts}</select></div>
        <div class="form-group"><label>${L("REQUISITION.LOCATION")}</label><input name="location" type="number" value="0"/></div>
        <div class="form-group"><label>${L("REQUISITION.COMMERCE")}</label><input name="commerce" type="checkbox"/>
            <label>${L("REQUISITION.SELLER")}</label><input name="seller" type="number" value="30" style="max-width:4em"/></div>
        ${barter ? `<div class="form-group"><label>${L("REQUISITION.BARTER")}</label><select name="barter"><option value="">—</option>${barter}</select>
            <label>${L("REQUISITION.DAMAGED")}</label><input name="damaged" type="checkbox"/></div>` : ""}
        <div class="form-group"><label>${L("REQUISITION.SACRIFICE")}</label><input name="sacrifice" type="checkbox"/></div>
        <div class="form-group"><label>${L("REQUISITION.INQUISITOR")}</label><input name="inquisitor" type="checkbox"/></div>
    </div>`;
    const choice = await foundry.applications.api.DialogV2.prompt({
        window: { title: game.i18n.format("REQUISITION.TITLE", { item: item.name }) },
        position: { width: 420 },
        content,
        ok: {
            label: L("BUTTON.ROLL"),
            callback: (event, button) => {
                const f = button.form.elements;
                return { craftsmanship: f.craftsmanship.value, location: parseInt(f.location.value, 10) || 0,
                    commerce: f.commerce.checked, seller: parseInt(f.seller.value, 10) || 0,
                    barter: f.barter?.value || "", damaged: Boolean(f.damaged?.checked),
                    sacrifice: f.sacrifice.checked, inquisitor: f.inquisitor.checked };
            }
        },
        rejectClose: false
    });
    if (choice) await resolveRequisition(item, actor, choice);
}

/**
 * Roll a requisition with the window's choices and post the results.
 * @param {Item} item
 * @param {Actor} actor
 * @param {object} choice
 * @returns {Promise<object>} the result record
 */
export async function resolveRequisition(item, actor, choice) {
    const L = k => game.i18n.localize(k);
    const cfg = game.darkHeresy.config;
    const availMod = AVAILABILITY_MODIFIER[item.system.availability];
    const fellowshipBonus = Number(actor.system.characteristics.fellowship?.bonus) || 0;
    const lines = [];
    const gmLines = [];
    const rolls = [];
    const effects = { subtlety: 0, inquisitor: 0, influence: 0, reasons: [] };
    const sub = subtletyCost(availMod ?? 0);
    if (sub) { effects.subtlety -= sub; effects.reasons.push(game.i18n.format("REQUISITION.LOG_AVAILABILITY", { item: item.name, amount: sub })); }
    if (choice.inquisitor) { effects.subtlety -= 2; effects.reasons.push(L("REQUISITION.LOG_INQUISITOR")); }

    const craftMod = CRAFTSMANSHIP_MODIFIER[choice.craftsmanship] ?? 0;
    const mods = [];
    if (availMod !== null) mods.push([L("REQUISITION.AVAILABILITY"), availMod]);
    if (craftMod) mods.push([L("REQUISITION.CRAFTSMANSHIP"), craftMod]);
    if (choice.location) mods.push([L("REQUISITION.LOCATION"), choice.location]);

    // Opposed Commerce test
    if (choice.commerce && availMod !== null && !choice.sacrifice) {
        const own = await d100(Number(actor.system.skills?.commerce?.total) || 0);
        const seller = await d100(choice.seller);
        rolls.push(own.roll, seller.roll);
        const won = own.success && (!seller.success || own.dos > seller.dos);
        let mod = 0;
        if (won) mod = 10 * own.dos;
        else if (own.dof >= 3) {
            mod = -10;
            gmLines.push(L("REQUISITION.COMMERCE_SUBTLETY"));
        }
        lines.push(game.i18n.format("REQUISITION.COMMERCE_LINE", { own: own.result, ownTarget: own.target,
            seller: seller.result, sellerTarget: seller.target,
            outcome: won ? game.i18n.format("REQUISITION.COMMERCE_WON", { dos: own.dos }) : own.success ? L("REQUISITION.COMMERCE_LOST") : game.i18n.format("REQUISITION.COMMERCE_FAILED", { dof: own.dof }) }));
        if (mod) mods.push([L("REQUISITION.COMMERCE"), mod]);
    }
    // Barter
    const barterItem = choice.barter ? actor.items.get(choice.barter) : null;
    if (barterItem && availMod !== null) {
        mods.push([`${L("REQUISITION.BARTER")}: ${barterItem.name}`, availMod - AVAILABILITY_MODIFIER[barterItem.system.availability]]);
        if (choice.damaged) mods.push([L("REQUISITION.DAMAGED"), -20]);
    }

    // Whose Influence
    const inquisitorInfluence = Number(game.settings.get("dark-heresy", "inquisitorInfluence")) || 0;
    const base = choice.inquisitor ? inquisitorInfluence : Number(actor.system.characteristics.influence.total) || 0;
    const modifier = Math.max(-60, Math.min(60, mods.reduce((a, [, m]) => a + m, 0)));
    let test;
    if (availMod === null) {
        test = { automatic: true, success: true, dos: 1, dof: 0 };
        lines.push(L("REQUISITION.AUTOMATIC"));
    } else if (choice.sacrifice) {
        const loss = await new Roll("1d5").evaluate();
        rolls.push(loss);
        effects.influence -= loss.total;
        test = { automatic: true, success: true, dos: fellowshipBonus, dof: 0 };
        lines.push(game.i18n.format("REQUISITION.SACRIFICE_LINE", { loss: loss.total, dos: fellowshipBonus }));
    } else {
        test = await d100(base + modifier);
        rolls.push(test.roll);
    }
    // Influence loss on a failure
    if (!test.success && test.dof > fellowshipBonus) {
        const loss = test.dof - fellowshipBonus;
        if (choice.inquisitor) {
            effects.inquisitor -= loss;
            effects.reasons.push(game.i18n.format("REQUISITION.LOG_INQUISITOR_LOSS", { item: item.name, amount: loss }));
        } else effects.influence -= loss;
    }
    // What is gained
    let gained = null;
    if (test.success) {
        const y = requisitionYield(item, test.dos);
        gained = { ...y, craftsmanship: choice.craftsmanship };
        if (y.kind === "magazines") lines.push(game.i18n.format(item.type === "weapon" ? "REQUISITION.GAINED_WEAPON" : "REQUISITION.GAINED_MAGAZINES", { count: y.count, spare: y.count - 1 }));
        else if (y.kind === "items") lines.push(game.i18n.format("REQUISITION.GAINED_ITEMS", { count: y.count }));
        if (barterItem) lines.push(game.i18n.format("REQUISITION.BARTER_LOST", { item: barterItem.name }));
    } else if (barterItem) lines.push(game.i18n.format("REQUISITION.BARTER_KEPT", { item: barterItem.name }));
    if (effects.influence < 0) lines.push(game.i18n.format("REQUISITION.INFLUENCE_LOSS", { amount: -effects.influence }));
    if (effects.inquisitor < 0) gmLines.push(game.i18n.format("REQUISITION.INQUISITOR_LOSS", { amount: -effects.inquisitor }));

    const record = {
        item: item.name, actor: actor.name, inquisitor: choice.inquisitor,
        craftsmanship: game.i18n.localize(cfg.craftmanship[choice.craftsmanship] ?? choice.craftsmanship),
        mods: mods.map(([label, m]) => ({ label, value: signed(m) })), modifier: signed(modifier),
        base, target: test.target ?? null, result: test.result ?? null, automatic: Boolean(test.automatic),
        success: test.success, dos: test.dos, dof: test.dof, lines
    };
    const content = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/requisition.hbs", record);
    await ChatMessage.create({ content, rolls, speaker: ChatMessage.getSpeaker({ actor }),
        flags: { "dark-heresy": { requisition: { success: test.success } } } });

    await applyRequisition({
        userId: game.user.id, actorUuid: actor.uuid, itemUuid: item.uuid, itemOwned: item.actor === actor,
        gained, barterId: test.success ? barterItem?.id ?? null : null,
        influence: effects.influence, subtlety: effects.subtlety, inquisitor: effects.inquisitor,
        reasons: effects.reasons, gmLines, label: `${actor.name}: ${item.name}`
    });
    return record;
}

/* -------------------------------------------- */
/*  Applying results (active GM)                */
/* -------------------------------------------- */

/**
 * Apply the document changes of a requisition: here when this user is the GM, otherwise via the active GM.
 * Without a GM the owner changes his own actor; Subtlety and the Inquisitor's Influence need a GM.
 * @param {object} request
 */
async function applyRequisition(request) {
    if (game.user.isGM) return applyRequest(request);
    if (game.users.activeGM) return game.socket.emit(SOCKET, { type: "requisition", request });
    ui.notifications.warn(game.i18n.localize("REQUISITION.NO_GM"));
    await applyRequest({ ...request, subtlety: 0, inquisitor: 0 });
}

async function applyRequest(request) {
    const actor = await fromUuid(request.actorUuid);
    if (actor) {
        if (request.influence) {
            const inf = actor.system.characteristics.influence;
            await actor.update({ "system.characteristics.influence.base": (Number(inf.base) || 0) + request.influence });
        }
        if (request.gained) await giveItem(actor, request);
        if (request.barterId) await actor.items.get(request.barterId)?.delete();
    }
    if (game.user.isGM && (request.subtlety || request.inquisitor || request.gmLines?.length)) {
        const user = game.users.get(request.userId)?.name ?? "";
        const lines = [...(request.gmLines ?? [])];
        if (request.subtlety) lines.push(game.i18n.format("REQUISITION.SUBTLETY_CHANGE", {
            delta: signed(request.subtlety), value: await changeSetting("subtlety", request.subtlety, request.reasons.join("; "), user, request.label) }));
        if (request.inquisitor) lines.push(game.i18n.format("REQUISITION.INQUISITOR_CHANGE", {
            delta: signed(request.inquisitor), value: await changeSetting("inquisitorInfluence", request.inquisitor, request.reasons.join("; "), user, request.label) }));
        await ChatMessage.create({ whisper: ChatMessage.getWhisperRecipients("GM"),
            content: `<div class="dark-heresy chat roll"><div class="background border"><h1>${esc(request.label)}</h1>${
                lines.map(l => `<p>${esc(l)}</p>`).join("")}</div></div>` });
    }
}

/**
 * Put the requisitioned item on the actor (a copy unless it already owns it).
 * @param {Actor} actor
 * @param {object} request
 */
async function giveItem(actor, request) {
    const source = await fromUuid(request.itemUuid);
    if (!source) return;
    const { kind, count, craftsmanship } = request.gained;
    let item = request.itemOwned ? actor.items.get(source.id) : null;
    if (!item) {
        const data = source.toObject();
        delete data._id;
        data.system.craftsmanship = craftsmanship;
        if (source.type === "ammunition") data.system.quantity = 0;
        [item] = await actor.createEmbeddedDocuments("Item", [data]);
    }
    if (!item) return;
    if (item.type === "ammunition") await item.update({ "system.quantity": (Number(item.system.quantity) || 0) + count });
    else if (item.type === "weapon" && kind === "magazines") {
        await item.update({ "system.clip.value": item.system.clip.max,
            "flags.dark-heresy.spareMagazines": (Number(item.getFlag("dark-heresy", "spareMagazines")) || 0) + count - 1 });
    } else if (kind === "items" && count > 1) {
        await item.setFlag("dark-heresy", "count", (Number(item.getFlag("dark-heresy", "count")) || 1) + count - 1);
    }
}

/**
 * Change a hidden group value and log it (GM only).
 * @param {string} key "subtlety" | "inquisitorInfluence"
 * @param {number} delta
 * @param {string} reason
 * @param {string} user
 * @param {string} label
 * @returns {Promise<number>} the new value
 */
export async function changeSetting(key, delta, reason, user = game.user.name, label = "") {
    const before = Number(game.settings.get("dark-heresy", key)) || 0;
    const value = Math.max(0, Math.min(100, before + delta));
    await game.settings.set("dark-heresy", key, value);
    const log = [...(game.settings.get("dark-heresy", "subtletyLog") ?? [])];
    log.push({ time: Date.now(), key, before, value, user, label, reason });
    await game.settings.set("dark-heresy", "subtletyLog", log.slice(-LOG_LIMIT));
    return value;
}

/* -------------------------------------------- */
/*  GM panel                                    */
/* -------------------------------------------- */

/** GM: Subtlety test (hidden d100 ≤ Subtlety), whispered to the GMs. */
export async function subtletyTest() {
    if (!game.user.isGM) return;
    const value = Number(game.settings.get("dark-heresy", "subtlety")) || 0;
    const test = await d100(value);
    // No roll attached: a whispered roll would still show players a «private roll» placeholder
    await ChatMessage.create({ whisper: ChatMessage.getWhisperRecipients("GM"),
        content: `<div class="dark-heresy chat roll"><div class="background border"><h1>${game.i18n.localize("SUBTLETY.TEST")} (${value})</h1>
            <h3 style="color: var(--color-${test.success ? "success" : "failure"})">${game.i18n.localize(test.success ? "CHAT.SUCCESS" : "CHAT.FAILURE")} (${test.result})</h3>
            <p>${game.i18n.localize(test.success ? "SUBTLETY.TEST_SUCCESS" : "SUBTLETY.TEST_FAILURE")}</p></div></div>` });
    return test;
}

/** GM panel: edit Subtlety and the Inquisitor's Influence, roll a Subtlety test, see the log. */
export async function subtletyPanel() {
    if (!game.user.isGM) return;
    const L = k => game.i18n.localize(k);
    const subtlety = game.settings.get("dark-heresy", "subtlety");
    const inquisitor = game.settings.get("dark-heresy", "inquisitorInfluence");
    const log = [...(game.settings.get("dark-heresy", "subtletyLog") ?? [])].reverse().slice(0, 50);
    const rows = log.map(e => `<tr><td>${new Date(e.time).toLocaleString()}</td><td>${L(e.key === "subtlety" ? "SUBTLETY.NAME" : "SUBTLETY.INQUISITOR")}</td>
        <td>${e.before} → ${e.value}</td><td>${esc(e.user)}</td><td>${esc(e.label)} ${esc(e.reason)}</td></tr>`).join("");
    const content = `<div class="dark-heresy subtlety-panel">
        <div class="form-group"><label>${L("SUBTLETY.NAME")}</label><input name="subtlety" type="number" min="0" max="100" value="${subtlety}"/></div>
        <div class="form-group"><label>${L("SUBTLETY.INQUISITOR")}</label><input name="inquisitor" type="number" min="0" max="100" value="${inquisitor}"/></div>
        <div class="form-group"><label>${L("SUBTLETY.REASON")}</label><input name="reason" type="text" value=""/></div>
        <h3>${L("SUBTLETY.LOG")}</h3>
        <div style="max-height: 240px; overflow-y: auto"><table class="subtlety-log">${rows || `<tr><td>—</td></tr>`}</table></div>
    </div>`;
    await foundry.applications.api.DialogV2.wait({
        window: { title: L("SUBTLETY.PANEL") },
        position: { width: 620 },
        content,
        rejectClose: false,
        buttons: [{
            action: "save", label: L("SUBTLETY.SAVE"), default: true,
            callback: async (event, button) => {
                const f = button.form.elements;
                const reason = f.reason.value || L("SUBTLETY.MANUAL");
                const s = parseInt(f.subtlety.value, 10), q = parseInt(f.inquisitor.value, 10);
                if (Number.isFinite(s) && s !== subtlety) await changeSetting("subtlety", s - subtlety, reason);
                if (Number.isFinite(q) && q !== inquisitor) await changeSetting("inquisitorInfluence", q - inquisitor, reason);
            }
        }, {
            action: "test", label: L("SUBTLETY.TEST"), callback: () => subtletyTest()
        }]
    });
}

/** Settings menu entry that opens the GM panel. */
class SubtletyMenu extends foundry.applications.api.ApplicationV2 {
    /** @override */
    async render() {
        subtletyPanel();
        return this;
    }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

/** Register settings, the socket handler, sheet buttons and context menus; call during init. */
export function registerRequisition() {
    game.settings.register("dark-heresy", "subtlety", { scope: "world", config: false, type: Number, default: 50 });
    game.settings.register("dark-heresy", "inquisitorInfluence", { scope: "world", config: false, type: Number, default: 75 });
    game.settings.register("dark-heresy", "subtletyLog", { scope: "world", config: false, type: Array, default: [] });
    game.settings.registerMenu("dark-heresy", "subtletyMenu", {
        name: "SUBTLETY.PANEL", label: "SUBTLETY.PANEL", hint: "SUBTLETY.PANEL_HINT",
        icon: "fas fa-user-secret", type: SubtletyMenu, restricted: true
    });

    const usable = item => typeof item?.system?.availability === "string";
    Hooks.on("getItemSheetHeaderButtons", (sheet, buttons) => {
        if (!usable(sheet.item)) return;
        buttons.unshift({ label: game.i18n.localize("REQUISITION.BUTTON"), class: "requisition",
            icon: "fas fa-coins", onclick: () => requisition(sheet.item) });
    });
    Hooks.on("getHeaderControlsItemSheetV2", (sheet, controls) => {
        if (!usable(sheet.document)) return;
        controls.unshift({ label: "REQUISITION.BUTTON", icon: "fas fa-coins", action: "dhRequisition",
            onClick: () => requisition(sheet.document) });
    });
    // Item directory and Item compendia
    Hooks.on("getItemContextOptions", (app, options) => {
        options.push({
            label: "REQUISITION.BUTTON", icon: "fa-solid fa-coins",
            onClick: async (event, li) => {
                const id = li.closest("[data-entry-id]")?.dataset.entryId;
                const coll = app.collection;
                const item = coll?.getDocument ? await coll.getDocument(id) : coll?.get(id);
                if (usable(item)) requisition(item);
                else ui.notifications.warn(game.i18n.localize("REQUISITION.NO_AVAILABILITY"));
            }
        });
    });
}

/** Socket handler for players' requisitions; call during ready. */
export function registerRequisitionSocket() {
    game.socket.on(SOCKET, async data => {
        if (data?.type !== "requisition" || game.user !== game.users.activeGM) return;
        await applyRequest(data.request);
    });
}
