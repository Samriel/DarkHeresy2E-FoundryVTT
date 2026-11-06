/**
 * Activated talent states and auras (core rulebook chapter IV; Enemies Within; Enemies Beyond).
 *
 * A talent state is an ActiveEffect on the actor carrying the flag «dark-heresy.talentState»: {id, talent,
 * until, combat, combatant, round, turns, expires, data, stats, then}. The activation card carries the
 * operation that creates it (ops.js «effect», key «talentState.<id>») and the active GM applies it. An effect
 * rather than the combatant's action record (actions.js): states outlast the turn, show on the token and the
 * sheet, and the GM can delete one by hand. Durations («until»):
 * - "turnEnd": until the end of the character's next turn (his turn ends are counted);
 * - "turnStart": until the start of his next turn; a state with «then» turns into that state there;
 * - "round": until the end of the round;
 * - "combat": until the combat is deleted;
 * - "hour": an hour of world time; with data.encounter also the end of the combat it began in;
 * - none: until removed (Frenzy ends by its Willpower test).
 * «stats» are read while the actor's data is prepared: characteristic changes (DarkHeresyActor), ignore:
 * ["fatigue", "stunned"] and bans: ["DISENGAGE"] (conditions.js conditionRule «ignore:<status>», «ban:<action>»).
 *
 * Talent definitions (talents/states.js) add:
 * - actions(ctx) → [{key, label, hint, cost (halves), fate, disabled (reason), run(ctx)}]: the Talents menu
 *   (sheet header, combat tracker) and chat buttons «.dh-talent-action»; run → {lines, ops, rolls} for the
 *   card, or null when it opened a roll dialog or was cancelled. The menu spends the Fate point, posts the card
 *   with the operations and the half actions, and keeps the durations.
 * - onResult(ctx) → {lines, ops}: the result of a test the talent opened (rollData.talentTest {talent, action}),
 *   applied by the active GM (the author without a GM).
 * - offer: {status, action}: a button card for the owners when the actor gets that status (Iron Jaw).
 * - combatEnd(ctx) → {lines, action}: a card when the combat ends while the state lasts (Frenzy).
 * Auras and their grants are in talents/states.js; tokensNear gives the distances (situational.js).
 */
import { registerTalentGrants, actorTalents, tokenOf } from "./talents.js";
import { spendFate } from "./fate.js";
import { runOps, postWithOps } from "./ops.js";
import { card, combatantOfActor, rollActor, registerConditionRule } from "./conditions.js";
import { actionsOf, spentHalves, halvesPerTurn } from "./actions.js";
import { tokenDistance } from "./situational.js";
import { registerPsyRatingSource } from "./psychic.js";
import { registerTraitFilter } from "./traits.js";
import STATES, { auraGrants, psyRatingChanges, traitFilter } from "./talents/states.js";

const FLAG = "talentState";
const KEY = id => `talentState.${id}`;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const loc = key => game.i18n.localize(key);
const asList = value => (value ? (Array.isArray(value) ? value.filter(Boolean) : [value]) : []);
const isActiveGM = () => game.user === game.users.activeGM;
const COST_KEY = { 0: "COMBAT_ACTION.COST_FREE", 1: "COMBAT_ACTION.COST_HALF", 2: "COMBAT_ACTION.COST_FULL" };

let prepareCommonRollRef = null;
let createCharacteristicRollDataRef = null;

/* -------------------------------------------- */
/*  States                                      */
/* -------------------------------------------- */

const expired = state => Number.isFinite(state?.expires) && (game.time?.worldTime ?? 0) >= state.expires;
const COMBAT_BOUND = ["turnEnd", "turnStart", "round", "combat"];
/** Does the state end with the combat it began in? */
const endsWithCombat = state => Boolean(state.combat) && (COMBAT_BOUND.includes(state.until) || (state.until === "hour" && state.data?.encounter));

/**
 * Talent state effects of an actor.
 * @param {Actor} actor
 * @returns {ActiveEffect[]}
 */
function stateEffects(actor) {
    return (actor?.effects ?? []).filter(e => e.getFlag("dark-heresy", FLAG)?.id);
}

/**
 * The actor's talent state with this id, if it lasts.
 * @param {Actor} actor
 * @param {string} id
 * @returns {object|null} the state flag with the effect's name
 */
export function stateOf(actor, id) {
    const effect = stateEffects(actor).find(e => e.getFlag("dark-heresy", FLAG).id === id);
    const state = effect?.getFlag("dark-heresy", FLAG);
    return state && !expired(state) ? { ...state, name: effect.name } : null;
}

/**
 * Characteristic changes and fatigue immunity of the actor's states (read during data preparation).
 * @param {Actor} actor
 * @returns {{characteristics: object, ignoreFatigue: boolean}}
 */
export function stateStats(actor) {
    const out = { characteristics: {}, ignoreFatigue: false };
    for (const effect of stateEffects(actor)) {
        const state = effect.getFlag("dark-heresy", FLAG);
        if (!state.stats || expired(state)) continue;
        for (const [key, value] of Object.entries(state.stats.characteristics ?? {})) {
            out.characteristics[key] = (out.characteristics[key] ?? 0) + (Number(value) || 0);
        }
        if (state.stats.ignore?.includes("fatigue")) out.ignoreFatigue = true;
    }
    return out;
}

/** conditions.js rule source: «ignore:<status>», «ban:<action>» from the states' stats. */
function stateRule(actor, key) {
    const [kind, what] = key.split(":");
    for (const effect of stateEffects(actor)) {
        const state = effect.getFlag("dark-heresy", FLAG);
        if (expired(state)) continue;
        const list = kind === "ignore" ? state.stats?.ignore : kind === "ban" ? state.stats?.bans : null;
        if (list?.includes(what)) return effect.name;
    }
    return null;
}

/**
 * Operation setting a talent state on the actor (replaces the same state).
 * @param {Actor} actor
 * @param {string} id state id
 * @param {object} options {name, img, talent (definition id), until, data, stats, then}
 * @returns {object} ops.js operation
 */
export function setStateOp(actor, id, { name, img, talent, until = null, data = {}, stats = null, then = null } = {}) {
    const combat = game.combat?.started ? game.combat : null;
    const combatant = combat ? combatantOfActor(actor) : null;
    const state = { id, talent: talent ?? id, until, data, stats, then, combat: combat?.id ?? null,
        combatant: combatant?.id ?? null, round: combat?.round ?? null };
    // Activated during his own turn: this turn ends first, then the next one
    if (until === "turnEnd") state.turns = combatant && combat.combatant === combatant ? 2 : 1;
    if (until === "hour") state.expires = (game.time?.worldTime ?? 0) + 3600;
    return { type: "effect", uuid: actor.uuid, key: KEY(id), data: { name: name ?? id, img: img ?? "icons/svg/aura.svg",
        statuses: [`talent-${id}`], flags: { "dark-heresy": { [FLAG]: state } } } };
}

/**
 * Operation ending a talent state.
 * @param {Actor} actor
 * @param {string} id
 * @returns {object}
 */
export function endStateOp(actor, id) {
    return { type: "effect", uuid: actor.uuid, key: KEY(id), active: false };
}

/* -------------------------------------------- */
/*  Canvas helpers                              */
/* -------------------------------------------- */

/**
 * Other tokens on the canvas with their distance to the actor's token (edge to edge).
 * @param {Actor} actor
 * @returns {{token: Token, actor: Actor, distance: number, self: Token}[]}
 */
export function tokensNear(actor) {
    if (!canvas?.ready) return [];
    const self = tokenOf(actor);
    if (!self) return [];
    return canvas.tokens.placeables.filter(t => t !== self && t.actor && t.actor !== actor)
        .map(t => ({ token: t, actor: t.actor, distance: tokenDistance(self, t), self }));
}

/**
 * Are two tokens on opposite sides (friendly against hostile)?
 * @param {Token} a
 * @param {Token} b
 * @returns {boolean}
 */
export function hostile(a, b) {
    return (a?.document?.disposition ?? 0) * (b?.document?.disposition ?? 0) < 0;
}

/* -------------------------------------------- */
/*  Tests opened by talents                     */
/* -------------------------------------------- */

/**
 * Open a characteristic test whose result the talent handles (onResult).
 * @param {Actor} actor
 * @param {string} key characteristic
 * @param {object} options {name, modifier, talent, action, extra (merged into the roll data)}
 */
export function talentTest(actor, key, { name, modifier = 0, talent, action, extra = {} } = {}) {
    const rollData = createCharacteristicRollDataRef(actor, key);
    rollData.name = name ?? rollData.name;
    rollData.target.modifier = modifier;
    rollData.talentTest = { talent, action };
    Object.assign(rollData, extra);
    prepareCommonRollRef(rollData);
}

/**
 * Does this client apply automatic results? The active GM, or the author when no GM is connected.
 * @param {ChatMessage} message
 * @returns {boolean}
 */
function appliesResults(message) {
    const gm = game.users.activeGM;
    return gm ? game.user === gm : message.author?.id === game.user.id;
}

/** createChatMessage: results of the tests talents opened. */
async function onTestResult(message) {
    const rollData = message.getFlag("dark-heresy", "rollData");
    const test = rollData?.talentTest;
    if (!test?.talent || !appliesResults(message)) return;
    const def = STATES.find(d => d.id === test.talent);
    const actor = rollActor(rollData);
    if (!def?.onResult || !actor) return;
    const result = await def.onResult({ actor, rollData, message, action: test.action,
        success: Boolean(rollData.flags?.isSuccess), isReRoll: Boolean(rollData.flags?.isReRoll) });
    if (!result) return;
    if (result.ops?.length) await runOps(result.ops);
    if (result.lines?.length) {
        await ChatMessage.create({ speaker: message.speaker, content: card(esc(result.title ?? rollData.name),
            result.lines.map(l => `<p>${l}</p>`).join("")) });
    }
}

/* -------------------------------------------- */
/*  Talents menu                                */
/* -------------------------------------------- */

/**
 * Context of a talent action.
 * @param {Actor} actor
 * @returns {object}
 */
function actionContext(actor) {
    const combat = game.combat?.started ? game.combat : null;
    const combatant = combat ? combatantOfActor(actor) : null;
    return { actor, token: tokenOf(actor), combat, combatant, ownTurn: Boolean(combatant && combat.combatant === combatant),
        record: actionsOf(combatant), target: game.user.targets.size === 1 ? [...game.user.targets][0] : null };
}

/**
 * Actions of the actor's activated talents.
 * @param {Actor} actor
 * @returns {object[]} entries {id, talent, key, label, hint, cost, fate, disabled, run}
 */
function talentActions(actor) {
    const ctx = actionContext(actor);
    const out = [];
    for (const talent of actorTalents(actor)) {
        if (!talent.def.actions) continue;
        for (const action of asList(talent.def.actions({ ...ctx, talent }))) {
            out.push({ cost: 0, ...action, talent, id: `${talent.def.id}:${action.key}`, ctx: { ...ctx, talent } });
        }
    }
    return out;
}

/**
 * Has the actor a talent with actions (the Talents menu button)?
 * @param {Actor} actor
 * @returns {boolean}
 */
export function hasTalentActions(actor) {
    return actorTalents(actor).some(t => t.def.actions);
}

/**
 * Carry out a talent action: Fate, the action itself, the card with its operations and half actions.
 * @param {Actor} actor
 * @param {object} entry see talentActions
 */
async function runAction(actor, entry) {
    if (entry.disabled) return ui.notifications.warn(`${entry.talent.name}: ${entry.disabled}`);
    const { combatant } = entry.ctx;
    if (combatant && combatant === game.combat?.combatant) {
        const left = halvesPerTurn(combatant) - spentHalves(actionsOf(combatant));
        if (entry.cost > left) ui.notifications.warn(game.i18n.format("COMBAT_ACTION.NOT_ENOUGH", { n: Math.max(0, left) }));
    }
    if (entry.fate) {
        const spent = await spendFate(actor, "talent", { detail: entry.talent.name });
        if (!spent?.effective) return;
    }
    const result = await entry.run(entry.ctx);
    if (!result) return;
    const token = tokenOf(actor);
    const speaker = ChatMessage.getSpeaker({ actor, token: token?.document });
    const ops = [...(entry.cost ? [{ type: "spend", speaker, halves: entry.cost }] : []), ...(result.ops ?? [])];
    const body = `${entry.hint ? `<p><em>${esc(entry.hint)}</em></p>` : ""}${(result.lines ?? []).map(l => `<p>${l}</p>`).join("")}`;
    await postWithOps({ speaker, rolls: result.rolls ?? [], content: card(esc(`${entry.talent.name}: ${entry.label}`), body) }, ops);
}

/**
 * Open the Talents menu of an actor, or run one action by id («talent:key»).
 * @param {Actor} actor
 * @param {string} [id]
 */
export async function talentMenu(actor, id) {
    if (!actor?.isOwner) return ui.notifications.warn(loc("COMBAT_ACTION.NOT_OWNER"));
    const entries = talentActions(actor);
    if (id) {
        const entry = entries.find(e => e.id === id);
        return entry ? runAction(actor, entry) : ui.notifications.warn(loc("TALENTS.STATE.NOT_AVAILABLE"));
    }
    if (!entries.length) return ui.notifications.info(loc("TALENTS.STATE.NONE"));
    const first = entries.find(e => !e.disabled) ?? entries[0];
    const options = entries.map(e => `<option value="${esc(e.id)}"${e === first ? " selected" : ""}${e.disabled ? " disabled" : ""}>
        ${esc(`${e.talent.name}: ${e.label}`)} (${loc(COST_KEY[e.cost] ?? COST_KEY[0])}${e.fate ? `, ${loc("TALENTS.FATE_COST")}` : ""})</option>`).join("");
    const hint = e => [e.hint, e.disabled].filter(Boolean).join(" — ");
    const hints = Object.fromEntries(entries.map(e => [e.id, hint(e)]));
    const { combatant } = actionContext(actor);
    const left = combatant ? halvesPerTurn(combatant) - spentHalves(actionsOf(combatant)) : null;
    const data = await foundry.applications.api.DialogV2.input({
        window: { title: `${loc("TALENTS.STATE.MENU")}: ${actor.name}` },
        content: `<div class="dh-combat-action-dialog dh-talent-menu">
            <div class="form-group"><label>${loc("TALENTS.STATE.TALENT")}</label><select name="action">${options}</select></div>
            <p class="hint dh-action-hint">${esc(hints[first.id] ?? "")}</p>
            ${left !== null ? `<p class="hint">${game.i18n.format("COMBAT_ACTION.HALVES_LEFT", { n: Math.max(0, left) })}</p>` : ""}</div>`,
        ok: { label: loc("TALENTS.STATE.USE"), icon: "fa-solid fa-star" },
        rejectClose: false,
        render: (event, dialog) => {
            const select = dialog.element.querySelector("select[name=action]");
            const line = dialog.element.querySelector(".dh-action-hint");
            select?.addEventListener("change", () => { line.textContent = hints[select.value] ?? ""; });
        }
    });
    if (!data?.action) return;
    const entry = entries.find(e => e.id === data.action);
    if (entry) await runAction(actor, entry);
}

/** Chat button «.dh-talent-action»: run a talent action of the actor (data-uuid, data-talent, data-action). */
async function onActionButton(event) {
    event.preventDefault();
    const { uuid, talent, action } = event.currentTarget.dataset;
    const doc = uuid ? await fromUuid(uuid) : null;
    const actor = doc?.documentName === "Actor" ? doc : doc?.actor;
    if (!actor) return;
    await talentMenu(actor, `${talent}:${action}`);
}

/**
 * HTML of a chat button running a talent action.
 * @param {Actor} actor
 * @param {string} talent definition id
 * @param {string} action key
 * @param {string} label
 * @returns {string}
 */
export function actionButton(actor, talent, action, label) {
    return `<div class="dh-card-buttons"><button type="button" class="dh-talent-action" data-uuid="${actor.uuid}"
        data-talent="${talent}" data-action="${action}">${esc(label)}</button></div>`;
}

/* -------------------------------------------- */
/*  Durations (active GM)                       */
/* -------------------------------------------- */

/** combatTurnChange: states that end with a turn or a round; «then» states begin. */
async function onTurnChange(combat, prior, current) {
    if (!isActiveGM()) return;
    for (const c of combat.combatants) {
        const actor = c.actor;
        for (const effect of stateEffects(actor)) {
            const state = effect.getFlag("dark-heresy", FLAG);
            if (state.combat !== combat.id) continue;
            let end = false;
            if (state.until === "round") end = current.round !== state.round;
            else if (state.until === "turnStart") end = current.combatantId === state.combatant;
            else if (state.until === "turnEnd" && prior.combatantId === state.combatant) {
                const turns = (Number(state.turns) || 1) - 1;
                if (turns > 0) await effect.update({ [`flags.dark-heresy.${FLAG}.turns`]: turns });
                else end = true;
            }
            if (!end) continue;
            await runOps([endStateOp(actor, state.id)]);
            if (state.then?.id) {
                await runOps([setStateOp(actor, state.then.id, state.then)]);
                if (state.then.text) {
                    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor, token: c.token }),
                        content: card(esc(state.then.name), `<p>${state.then.text}</p>`) });
                }
            }
        }
    }
}

/** deleteCombat: states of the combat end; lasting states with a combat-end card post it (Frenzy). */
async function onDeleteCombat(combat) {
    if (!isActiveGM()) return;
    for (const c of combat.combatants) {
        const actor = c.actor;
        for (const effect of stateEffects(actor)) {
            const state = effect.getFlag("dark-heresy", FLAG);
            if (state.combat !== combat.id) continue;
            if (endsWithCombat(state)) {
                await runOps([endStateOp(actor, state.id)]);
                continue;
            }
            if (state.until) continue;
            const def = STATES.find(d => d.id === state.talent);
            const end = def?.combatEnd?.({ actor, state });
            if (!end) continue;
            const owners = game.users.filter(u => actor.testUserPermission(u, "OWNER")).map(u => u.id);
            await ChatMessage.create({ whisper: owners, speaker: ChatMessage.getSpeaker({ actor, token: c.token }),
                content: card(esc(effect.name), `${(end.lines ?? []).map(l => `<p>${l}</p>`).join("")}
                    ${end.action ? actionButton(actor, state.talent, end.action, end.label ?? effect.name) : ""}`) });
        }
    }
}

/** Remove states whose combat is gone or whose hour has passed (active GM, on ready and world time). */
async function sweep() {
    if (!isActiveGM()) return;
    const actors = new Set([...game.actors, ...(canvas?.ready ? canvas.tokens.placeables.map(t => t.actor).filter(Boolean) : [])]);
    for (const actor of actors) {
        for (const effect of stateEffects(actor)) {
            const state = effect.getFlag("dark-heresy", FLAG);
            const gone = endsWithCombat(state) && !game.combats.get(state.combat);
            if (gone || expired(state)) await runOps([endStateOp(actor, state.id)]);
        }
    }
}

/** createActiveEffect (active GM): a card with a talent's button when the actor gets a status (Iron Jaw). */
async function onStatus(effect) {
    if (!isActiveGM() || !(effect.parent instanceof Actor)) return;
    const actor = effect.parent;
    for (const talent of actorTalents(actor)) {
        const offer = talent.def.offer;
        if (!offer || !effect.statuses?.has(offer.status)) continue;
        // The status may not be on the actor's prepared data yet: the offer does not check «disabled»
        const entry = asList(talent.def.actions?.({ ...actionContext(actor), talent })).find(a => a.key === offer.action);
        if (!entry) continue;
        const owners = game.users.filter(u => actor.testUserPermission(u, "OWNER")).map(u => u.id);
        await ChatMessage.create({ whisper: owners, speaker: ChatMessage.getSpeaker({ actor }),
            content: card(esc(talent.name), `${entry.hint ? `<p><em>${esc(entry.hint)}</em></p>` : ""}
                ${actionButton(actor, talent.def.id, offer.action, `${talent.name}: ${entry.label}`)}`) });
    }
}

/* -------------------------------------------- */
/*  Buttons                                     */
/* -------------------------------------------- */

/** renderCombatTracker: a Talents menu button next to the action menu of owned combatants with such talents. */
function onRenderTracker(app, html) {
    const root = html instanceof HTMLElement ? html : html[0];
    const combat = app.viewed;
    if (!root || !combat) return;
    for (const li of root.querySelectorAll("li.combatant[data-combatant-id]")) {
        const combatant = combat.combatants.get(li.dataset.combatantId);
        if (!combatant?.actor?.isOwner || !hasTalentActions(combatant.actor)) continue;
        const button = document.createElement("a");
        button.className = "dh-talent-menu";
        button.dataset.tooltip = loc("TALENTS.STATE.MENU");
        button.innerHTML = '<i class="fa-solid fa-star"></i>';
        button.addEventListener("click", ev => {
            ev.stopPropagation();
            talentMenu(combatant.actor);
        });
        const box = li.querySelector(".dh-actions");
        if (box) box.append(button);
        else (li.querySelector(".token-initiative") ?? li).before(button);
    }
}

/** renderChatMessageHTML: talent action buttons, and buttons a roll card asks for (rollData.talentButtons). */
function onRenderMessage(message, html) {
    const rollData = message.getFlag("dark-heresy", "rollData");
    const extra = rollData?.talentButtons;
    if (extra?.length && !html.querySelector(".dh-talent-action")) {
        const box = html.querySelector(".dark-heresy.chat.roll > .background.border") ?? html.querySelector(".message-content");
        for (const b of extra) {
            const doc = fromUuidSync(b.uuid);
            const actor = doc?.documentName === "Actor" ? doc : doc?.actor;
            if (actor) box?.insertAdjacentHTML("beforeend", actionButton(actor, b.talent, b.action, b.label));
        }
    }
    html.querySelectorAll(".dh-talent-action").forEach(b => b.addEventListener("click", onActionButton));
}

/**
 * Register hooks and sources; call during init.
 * @param {object} deps {prepareCommonRoll, createCharacteristicRollData}
 */
export function registerTalentStates({ prepareCommonRoll, createCharacteristicRollData }) {
    prepareCommonRollRef = prepareCommonRoll;
    createCharacteristicRollDataRef = createCharacteristicRollData;
    registerConditionRule(stateRule);
    registerTalentGrants(auraGrants);
    registerPsyRatingSource(psyRatingChanges);
    registerTraitFilter(traitFilter);
    Hooks.on("combatTurnChange", onTurnChange);
    Hooks.on("deleteCombat", onDeleteCombat);
    Hooks.on("createChatMessage", onTestResult);
    Hooks.on("createActiveEffect", onStatus);
    Hooks.on("renderCombatTracker", onRenderTracker);
    Hooks.on("renderChatMessageHTML", onRenderMessage);
    Hooks.on("updateWorldTime", () => sweep());
    Hooks.once("ready", () => sweep());
}
