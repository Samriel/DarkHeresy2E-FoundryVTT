/**
 * Combat actions of table 7-1 (core rulebook pp. 268–277, Russian edition) that are not an ordinary
 * weapon attack: a menu on the actor sheet and in the combat tracker.
 *
 * - All Out Attack (Full, p. 269): the melee attack dialog with the attack type preselected (+30); no
 *   Evasion until the next turn (actions.js / conditions.js).
 * - Defensive Stance (Full, p. 269): an extra Evasion reaction, opponents −20 to Weapon Skill against him
 *   (situational.js) until his next turn. The Russian text says «until the start of the next round»; the
 *   record lasts until the character's next turn like the other per-turn effects.
 * - Guarded Action (Half, p. 273): −10 to his WS/BS tests this turn, +10 to Evasion until his next turn.
 * - Feint (Half, p. 270): opposed Weapon Skill; if he wins, the target cannot evade his next Standard Attack
 *   this turn.
 * - Manoeuvre (Half, p. 274): opposed Weapon Skill; if he wins, the opponent moves 1 m in a direction of
 *   his choice (moving the token is left to the players).
 * - Knock-Down (Half, p. 274): opposed Strength, +10 after a Charge or a move this turn; winning knocks the
 *   target prone, winning by two or more degrees may instead deal 1d5−3+SB impact damage and a level of
 *   fatigue; losing by two or more degrees knocks the attacker prone.
 * - Stun (Full, p. 276): Hard (−20) Weapon Skill test, unarmed or with a melee weapon; on a hit (after the
 *   target's evasion) 1d10 + SB against the target's TB + head armour: stunned for the difference in rounds
 *   and a level of fatigue.
 * - Grapple (p. 281, pp. 272–273): starting it is a melee attack (Standard Attack, +10) that may be evaded;
 *   on a hit both are grappled, the attacker controls. Controller options (Full): damage (opposed Strength,
 *   1d5−3+SB impact to the body and a level of fatigue), throw down (opposed Strength, target prone), push
 *   (opposed Strength, 1 m + 1 per degree), stand up (opposed Strength), release (Free). Grappled target
 *   options (Half): break free (opposed Strength), slip free (Acrobatics), take control (opposed Strength).
 *   The bigger participant gets an extra degree of success per size step on successful grapple tests.
 * - Delay, Overwatch, Tactical Advance, Disengage (Full), Stand Up (Half): the cost and a reminder card;
 *   standing up removes the prone condition. Cover: take or change cover (cover.js), no cost of its own.
 * Opposed tests (p. 28): the one who passes wins; both pass — more degrees, then the higher characteristic
 * bonus, then the lower roll; both fail — nobody wins. The initiator's client rolls for both sides.
 * Effects on documents go through the active GM (ops.js). Activated talents have their own menu (talent-states.js).
 */
import { postWithOps } from "./ops.js";
import { card, ownModifiers, recordOfActor, combatantOfActor, grappleOf, conditionRule } from "./conditions.js";
import { actionsOf, spentHalves, halvesPerTurn } from "./actions.js";
import { applySituationalModifiers } from "./situational.js";
import { takeCover } from "./cover.js";

const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const loc = key => game.i18n.localize(key);
const signed = n => (n > 0 ? `+${n}` : `${n}`);

let prepareCombatRollRef = null;
let utilRef = null;

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/**
 * The token of an actor on the current scene (controlled first).
 * @param {Actor} actor
 * @returns {Token|null}
 */
function tokenOf(actor) {
    if (!canvas.ready || !actor) return null;
    if (actor.isToken) return actor.token?.object ?? null;
    return canvas.tokens.controlled.find(t => t.actor === actor) ?? actor.getActiveTokens()[0] ?? null;
}

/**
 * Chat speaker of an actor.
 * @param {Actor} actor
 * @returns {object}
 */
function speakerOf(actor) {
    const token = tokenOf(actor);
    return ChatMessage.getSpeaker({ actor, token: token?.document });
}

/** The single targeted token of the user, or null. */
function singleTarget() {
    return game.user.targets.size === 1 ? [...game.user.targets][0] : null;
}

/** Actor uuid of a token (synthetic actor of unlinked tokens). */
const uuidOf = token => token?.actor?.uuid;

/**
 * Roll a d100 test.
 * @param {number} base characteristic or skill
 * @param {number} modifier
 * @returns {Promise<object>} {target, result, success, dos, dof, roll}
 */
async function d100(base, modifier) {
    const mod = Math.max(-60, Math.min(60, Number(modifier) || 0));
    const target = (Number(base) || 0) + mod;
    const roll = await new Roll("1d100").evaluate();
    const result = roll.total;
    const success = result <= target;
    const degrees = Math.floor(Math.abs(target - result) / 10);
    return { base, modifier: mod, target, result, success, dos: success ? 1 + degrees : 0, dof: success ? 0 : 1 + degrees, roll };
}

/**
 * Size advantage in grapple tests (p. 273): one extra degree per size step over the opponent.
 * @param {Actor} actor
 * @param {Actor} other
 * @returns {number}
 */
function sizeAdvantage(actor, other) {
    return Math.max(0, (Number(actor?.system.size) || 4) - (Number(other?.system.size) || 4));
}

/**
 * Opposed test (p. 28).
 * @param {object} a {actor, base, modifier, extraDos}
 * @param {object} b {actor, base, modifier, extraDos}
 * @param {string} key characteristic key for the tie-break
 * @returns {Promise<object>} {a, b, winner: "a"|"b"|null, dos}
 */
async function opposed(a, b, key) {
    const ra = await d100(a.base, a.modifier);
    const rb = await d100(b.base, b.modifier);
    if (ra.success) ra.dos += a.extraDos ?? 0;
    if (rb.success) rb.dos += b.extraDos ?? 0;
    let winner = null;
    if (ra.success && !rb.success) winner = "a";
    else if (rb.success && !ra.success) winner = "b";
    else if (ra.success && rb.success) {
        if (ra.dos !== rb.dos) winner = ra.dos > rb.dos ? "a" : "b";
        else {
            const ba = a.actor.system.characteristics[key]?.bonus ?? 0;
            const bb = b.actor.system.characteristics[key]?.bonus ?? 0;
            if (ba !== bb) winner = ba > bb ? "a" : "b";
            else if (ra.result !== rb.result) winner = ra.result < rb.result ? "a" : "b";
        }
    }
    const dos = winner === "a" ? ra.dos : winner === "b" ? rb.dos : 0;
    return { a: ra, b: rb, winner, dos };
}

/**
 * HTML line of one test result.
 * @param {string} name
 * @param {object} r d100 result
 * @returns {string}
 */
function resultLine(name, r) {
    const outcome = r.success
        ? `<span style="color: var(--color-success)">${loc("CHAT.SUCCESS")}</span> · ${game.i18n.format("COMBAT_ACTION.DOS", { n: r.dos })}`
        : `<span style="color: var(--color-failure)">${loc("CHAT.FAILURE")}</span> · ${game.i18n.format("COMBAT_ACTION.DOF", { n: r.dof })}`;
    return `<p><strong>${esc(name)}</strong>: ${r.result} / ${r.target} (${signed(r.modifier)}) — ${outcome}</p>`;
}

/**
 * Ask for the test modifiers (prefilled), with notes.
 * @param {string} title
 * @param {object[]} sides [{label, modifier, notes}]
 * @returns {Promise<number[]|null>}
 */
async function askModifiers(title, sides) {
    const content = sides.map((s, i) => `<div class="form-group"><label>${esc(s.label)}</label>
        <input type="number" name="m${i}" value="${s.modifier}"></div>
        ${(s.notes ?? []).map(n => `<p class="hint"><em>${esc(n)}</em></p>`).join("")}`).join("");
    const data = await foundry.applications.api.DialogV2.input({
        window: { title },
        content: `<div class="dh-combat-action-dialog">${content}</div>`,
        ok: { label: loc("BUTTON.ROLL"), icon: "fa-solid fa-dice" },
        rejectClose: false
    });
    if (!data) return null;
    return sides.map((s, i) => Number(data[`m${i}`]) || 0);
}

/**
 * Prefilled modifier of a test from own conditions.
 * @param {Actor} actor
 * @param {string} kind
 * @param {number} base
 * @returns {{modifier: number, notes: string[]}}
 */
function ownPrefill(actor, kind, base = 0) {
    const parts = ownModifiers(actor, kind);
    return { modifier: base + parts.reduce((s, p) => s + (Number(p.modifier) || 0), 0), notes: parts.map(p => p.note).filter(Boolean) };
}

/**
 * Modifier of a melee test against the targeted token: own conditions and the target's state (situational.js).
 * @param {Actor} actor
 * @param {number} base difficulty
 * @returns {{modifier: number, notes: string[]}}
 */
function meleePrefill(actor, base) {
    const rollData = { target: { base: 0, modifier: base }, weapon: { isMelee: true, isRange: false }, flags: {} };
    const notes = applySituationalModifiers(rollData, actor);
    const own = ownPrefill(actor, "melee", 0);
    return { modifier: rollData.target.modifier + own.modifier, notes: [...notes, ...own.notes] };
}

/**
 * Post an action card: cost and effects applied by the active GM.
 * @param {Actor} actor
 * @param {string} title
 * @param {string} body HTML
 * @param {object[]} ops
 * @param {Roll[]} [rolls]
 * @param {object} [flags]
 */
async function post(actor, title, body, ops, rolls = [], flags = {}) {
    return postWithOps({ speaker: speakerOf(actor), rolls, content: card(esc(title), body),
        flags: { "dark-heresy": flags } }, ops);
}

/** Spend operation for the actor. */
const spend = (actor, halves) => ({ type: "spend", speaker: speakerOf(actor), halves });

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

/** All Out Attack: the attack dialog of a melee weapon with the type preselected. */
async function allOutAttack(actor) {
    const weapons = actor.items.filter(i => i.type === "weapon" && i.system.class === "melee");
    if (!weapons.length) return ui.notifications.warn(loc("COMBAT_ACTION.NO_MELEE_WEAPON"));
    let weapon = weapons[0];
    if (weapons.length > 1) {
        const options = weapons.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join("");
        const data = await foundry.applications.api.DialogV2.input({
            window: { title: loc("COMBAT_ACTION.ALL_OUT") },
            content: `<div class="form-group"><label>${loc("COMBAT_ACTION.WEAPON")}</label><select name="weapon">${options}</select></div>`,
            rejectClose: false
        });
        if (!data) return;
        weapon = actor.items.get(data.weapon) ?? weapon;
    }
    const rollData = utilRef.createWeaponRollData(actor, weapon);
    rollData.attackType = { name: "allOut", text: loc("ATTACK_TYPE.ALLOUT") };
    await prepareCombatRollRef(rollData, actor);
}

/** Stances: Defensive Stance and Guarded Action. */
function stance(id, halves) {
    return async actor => {
        await post(actor, loc(`COMBAT_ACTION.${id.toUpperCase()}`), `<p>${loc(`COMBAT_ACTION.${id.toUpperCase()}_HINT`)}</p>`,
            [spend(actor, halves), { type: "record", speaker: speakerOf(actor), changes: { stance: id } }]);
    };
}

/** Reminder-only actions with a cost. */
function reminder(id, halves, extraOps = () => []) {
    return async actor => {
        await post(actor, loc(`COMBAT_ACTION.${id}`), `<p>${loc(`COMBAT_ACTION.${id}_HINT`)}</p>`,
            [spend(actor, halves), ...extraOps(actor)]);
    };
}

/**
 * Opposed test action against the targeted token.
 * @param {object} cfg {id, key, halves, attackerBonus(actor), effects(result, actor, target) → {lines, ops, buttons}}
 * @returns {Function}
 */
function opposedAction({ id, key, halves, kind, attackerBonus, effects }) {
    return async actor => {
        const target = singleTarget();
        if (!target?.actor || target.actor === actor) return ui.notifications.warn(loc("COMBAT_ACTION.NEED_TARGET"));
        const title = loc(`COMBAT_ACTION.${id}`);
        const bonus = attackerBonus?.(actor) ?? { modifier: 0, notes: [] };
        const own = ownPrefill(actor, kind, bonus.modifier);
        const theirs = ownPrefill(target.actor, kind, 0);
        const mods = await askModifiers(title, [
            { label: actor.name, modifier: own.modifier, notes: [...bonus.notes, ...own.notes] },
            { label: target.name, modifier: theirs.modifier, notes: theirs.notes }
        ]);
        if (!mods) return;
        const r = await opposed(
            { actor, base: actor.system.characteristics[key].total, modifier: mods[0] },
            { actor: target.actor, base: target.actor.system.characteristics[key].total, modifier: mods[1] }, key);
        const winnerName = r.winner === "a" ? actor.name : r.winner === "b" ? target.name : null;
        const fx = effects(r, actor, target);
        const body = `<p><em>${loc(`COMBAT_ACTION.${id}_HINT`)}</em></p>
            ${resultLine(`${actor.name} (${loc(`CHARACTERISTIC.${key === "weaponSkill" ? "WEAPON_SKILL" : "STRENGTH"}`)})`, r.a)}
            ${resultLine(target.name, r.b)}
            <p><strong>${winnerName ? game.i18n.format("COMBAT_ACTION.WINNER", { name: esc(winnerName), dos: r.dos }) : loc("COMBAT_ACTION.NO_WINNER")}</strong></p>
            ${(fx.lines ?? []).map(l => `<p>${l}</p>`).join("")}${fx.buttons ?? ""}`;
        await post(actor, title, body, [spend(actor, halves), ...(fx.ops ?? [])], [r.a.roll, r.b.roll]);
    };
}

const feint = opposedAction({
    id: "FEINT", key: "weaponSkill", halves: 1, kind: "ws",
    effects: (r, actor, target) => r.winner === "a"
        ? { lines: [game.i18n.format("COMBAT_ACTION.FEINT_WON", { name: esc(target.name) })],
            ops: [{ type: "record", speaker: speakerOf(actor), changes: { feint: target.id } }] }
        : {}
});

const manoeuvre = opposedAction({
    id: "MANOEUVRE", key: "weaponSkill", halves: 1, kind: "ws",
    effects: (r, actor, target) => r.winner === "a"
        ? { lines: [game.i18n.format("COMBAT_ACTION.MANOEUVRE_WON", { name: esc(target.name) })] } : {}
});

const knockdown = opposedAction({
    id: "KNOCKDOWN", key: "strength", halves: 1, kind: "other",
    attackerBonus: actor => {
        const record = recordOfActor(actor);
        return record.charge || record.move > 0
            ? { modifier: 10, notes: [loc("COMBAT_ACTION.KNOCKDOWN_BONUS")] } : { modifier: 0, notes: [] };
    },
    effects: (r, actor, target) => {
        if (r.winner === "a") {
            const ops = [{ type: "status", uuid: uuidOf(target), id: "prone" }];
            if (r.dos < 2) return { lines: [game.i18n.format("COMBAT_ACTION.KNOCKED_DOWN", { name: esc(target.name) })], ops };
            // Two or more degrees: knock down or strike instead
            return { lines: [game.i18n.format("COMBAT_ACTION.KNOCKDOWN_CHOICE", { name: esc(target.name) })],
                buttons: `<div class="dh-card-buttons">
                    <button type="button" class="dh-combat-button" data-op="knockdown" data-actor="${actor.uuid}" data-target="${uuidOf(target)}">${loc("COMBAT_ACTION.KNOCK_DOWN_BUTTON")}</button>
                    <button type="button" class="dh-combat-button" data-op="unarmedStrike" data-actor="${actor.uuid}" data-target="${uuidOf(target)}">${loc("COMBAT_ACTION.STRIKE_BUTTON")}</button>
                </div>` };
        }
        if (r.winner === "b" && r.dos >= 2) {
            return { lines: [game.i18n.format("COMBAT_ACTION.KNOCKDOWN_REVERSED", { name: esc(actor.name) })],
                ops: [{ type: "status", uuid: actor.uuid, id: "prone" }] };
        }
        return { lines: [game.i18n.format("COMBAT_ACTION.STAYS_STANDING", { name: esc(target.name) })] };
    }
});

/**
 * Melee test with an apply button (Stun, starting a Grapple): the target may evade before it is applied.
 * @param {object} cfg {id, halves, difficulty, button}
 * @returns {Function}
 */
function meleeTestAction({ id, halves, difficulty, op }) {
    return async actor => {
        const target = singleTarget();
        if (!target?.actor || target.actor === actor) return ui.notifications.warn(loc("COMBAT_ACTION.NEED_TARGET"));
        const title = loc(`COMBAT_ACTION.${id}`);
        const pre = meleePrefill(actor, difficulty);
        const mods = await askModifiers(title, [{ label: `${actor.name} (${loc("CHARACTERISTIC.WEAPON_SKILL")})`,
            modifier: pre.modifier, notes: pre.notes }]);
        if (!mods) return;
        const r = await d100(actor.system.characteristics.weaponSkill.total, mods[0]);
        const buttons = r.success ? `<p><em>${loc("COMBAT_ACTION.EVADE_FIRST")}</em></p><div class="dh-card-buttons">
            <button type="button" class="dh-combat-button" data-op="${op}" data-actor="${actor.uuid}" data-target="${uuidOf(target)}">${loc(`COMBAT_ACTION.${id}_APPLY`)}</button></div>` : "";
        const body = `<p><em>${loc(`COMBAT_ACTION.${id}_HINT`)}</em></p>
            <p>${game.i18n.format("COMBAT_ACTION.AGAINST", { name: esc(target.name) })}</p>${resultLine(actor.name, r)}${buttons}`;
        await post(actor, title, body, [spend(actor, halves)], [r.roll]);
    };
}

const stun = meleeTestAction({ id: "STUN", halves: 2, difficulty: -20, op: "stun" });
const grappleStart = meleeTestAction({ id: "GRAPPLE", halves: 1, difficulty: 10, op: "grapple" });

/**
 * Grapple option resolved by opposed Strength against the grapple partner.
 * @param {object} cfg {id, halves, effects(r, actor, partner, grapple) → {lines, ops}}
 * @returns {Function}
 */
function grappleOption({ id, halves, effects }) {
    return async actor => {
        const grapple = grappleOf(actor);
        const partner = grapple?.partnerUuid ? fromUuidSync(grapple.partnerUuid) : null;
        const other = partner?.documentName === "Actor" ? partner : partner?.actor;
        if (!other) return ui.notifications.warn(loc("COMBAT_ACTION.NOT_GRAPPLING"));
        const title = loc(`COMBAT_ACTION.${id}`);
        const own = ownPrefill(actor, "other", 0);
        const theirs = ownPrefill(other, "other", 0);
        const mods = await askModifiers(title, [
            { label: actor.name, modifier: own.modifier, notes: own.notes },
            { label: other.name, modifier: theirs.modifier, notes: theirs.notes }
        ]);
        if (!mods) return;
        const r = await opposed(
            { actor, base: actor.system.characteristics.strength.total, modifier: mods[0], extraDos: sizeAdvantage(actor, other) },
            { actor: other, base: other.system.characteristics.strength.total, modifier: mods[1], extraDos: sizeAdvantage(other, actor) },
            "strength");
        const winnerName = r.winner === "a" ? actor.name : r.winner === "b" ? other.name : null;
        const fx = effects(r, actor, other) ?? {};
        const body = `<p><em>${loc(`COMBAT_ACTION.${id}_HINT`)}</em></p>
            ${resultLine(`${actor.name} (${loc("CHARACTERISTIC.STRENGTH")})`, r.a)}${resultLine(other.name, r.b)}
            <p><strong>${winnerName ? game.i18n.format("COMBAT_ACTION.WINNER", { name: esc(winnerName), dos: r.dos }) : loc("COMBAT_ACTION.NO_WINNER")}</strong></p>
            ${(fx.lines ?? []).map(l => `<p>${l}</p>`).join("")}`;
        const rolls = [r.a.roll, r.b.roll, ...(fx.rolls ?? [])];
        await post(actor, title, body, [spend(actor, halves), ...(fx.ops ?? [])], rolls);
    };
}

/** Operations ending a grapple for both participants. */
function endGrappleOps(actor, other) {
    return [{ type: "status", uuid: actor.uuid, id: "grappled", active: false },
        { type: "status", uuid: other.uuid, id: "grappled", active: false }];
}

/** Operations starting a grapple: both grappled, the first one controls. */
function startGrappleOps(controller, target) {
    return [
        { type: "status", uuid: controller.uuid, id: "grappled", flags: { grapple: { partner: target.uuid, controller: true } } },
        { type: "status", uuid: target.uuid, id: "grappled", flags: { grapple: { partner: controller.uuid, controller: false } } }
    ];
}

/**
 * Unarmed damage 1d5−3+SB impact to the body and one level of fatigue (grapple damage, knock-down strike).
 * @param {Actor} actor
 * @param {Actor} target
 * @returns {Promise<{roll: Roll, amount: number, ops: object[]}>}
 */
async function unarmedDamage(actor, target) {
    const sb = actor.system.characteristics.strength.bonus;
    const roll = await new Roll(`1d5 - 3 + ${sb}`).evaluate();
    const amount = Math.max(0, roll.total);
    return { roll, amount, ops: [
        { type: "damage", uuid: target.uuid, attack: { psychic: false, special: "", attackerId: actor.id },
            damages: [{ amount, location: "ARMOUR.BODY", penetration: 0, type: "I", righteousFury: 0 }] },
        { type: "fatigue", uuid: target.uuid, delta: 1 }
    ] };
}

const grappleDamage = async actor => {
    const grapple = grappleOf(actor);
    const other = grapple ? await fromUuid(grapple.partnerUuid) : null;
    const strike = other ? await unarmedDamage(actor, other.documentName === "Actor" ? other : other.actor) : null;
    return grappleOption({ id: "GRAPPLE_DAMAGE", halves: 2, effects: (r, a, o) => r.winner === "a" && strike
        ? { lines: [game.i18n.format("COMBAT_ACTION.GRAPPLE_DAMAGE_WON", { name: esc(o.name), damage: strike.amount })],
            ops: strike.ops, rolls: [strike.roll] }
        : { lines: [game.i18n.format("COMBAT_ACTION.GRAPPLE_HOLDS", { name: esc(o.name) })] } })(actor);
};

const grappleThrow = grappleOption({ id: "GRAPPLE_THROW", halves: 2, effects: (r, actor, other) => r.winner === "a"
    ? { lines: [game.i18n.format("COMBAT_ACTION.KNOCKED_DOWN", { name: esc(other.name) })],
        ops: [{ type: "status", uuid: other.uuid, id: "prone" }] } : {} });

const grapplePush = grappleOption({ id: "GRAPPLE_PUSH", halves: 2, effects: (r, actor, other) => r.winner === "a"
    ? { lines: [game.i18n.format("COMBAT_ACTION.GRAPPLE_PUSH_WON", { name: esc(other.name), metres: r.dos,
        max: actor.system.movement?.half ?? "?" })] } : {} });

const grappleStand = grappleOption({ id: "GRAPPLE_STAND", halves: 2, effects: (r, actor, other) => r.winner === "a"
    ? { lines: [loc("COMBAT_ACTION.GRAPPLE_STAND_WON")],
        ops: [{ type: "status", uuid: actor.uuid, id: "prone", active: false }, { type: "status", uuid: other.uuid, id: "prone", active: false }] }
    : { lines: [loc("COMBAT_ACTION.GRAPPLE_STAND_ALONE")], ops: [{ type: "status", uuid: actor.uuid, id: "prone", active: false }] } });

const grappleBreak = grappleOption({ id: "GRAPPLE_BREAK", halves: 1, effects: (r, actor, other) => r.winner === "a"
    ? { lines: [loc("COMBAT_ACTION.GRAPPLE_FREE")], ops: endGrappleOps(actor, other) } : {} });

const grappleControl = grappleOption({ id: "GRAPPLE_CONTROL", halves: 1, effects: (r, actor, other) => r.winner === "a"
    ? { lines: [game.i18n.format("COMBAT_ACTION.GRAPPLE_CONTROL_WON", { name: esc(actor.name) })], ops: startGrappleOps(actor, other) }
    : {} });

/** Slip free: Ordinary (+0) Acrobatics test (p. 273). */
async function grappleSlip(actor) {
    const grapple = grappleOf(actor);
    const partner = grapple?.partnerUuid ? fromUuidSync(grapple.partnerUuid) : null;
    const other = partner?.documentName === "Actor" ? partner : partner?.actor;
    if (!other) return ui.notifications.warn(loc("COMBAT_ACTION.NOT_GRAPPLING"));
    const title = loc("COMBAT_ACTION.GRAPPLE_SLIP");
    const own = ownPrefill(actor, "other", 0);
    const mods = await askModifiers(title, [{ label: `${actor.name} (${loc("SKILL.ACROBATICS")})`, modifier: own.modifier, notes: own.notes }]);
    if (!mods) return;
    const r = await d100(actor.system.skills.acrobatics?.total ?? actor.system.characteristics.agility.total - 20, mods[0]);
    const body = `<p><em>${loc("COMBAT_ACTION.GRAPPLE_SLIP_HINT")}</em></p>${resultLine(actor.name, r)}
        ${r.success ? `<p>${loc("COMBAT_ACTION.GRAPPLE_FREE")}</p>` : ""}`;
    await post(actor, title, body, [spend(actor, 1), ...(r.success ? endGrappleOps(actor, other) : [])], [r.roll]);
}

/** Release: the controller ends the grapple as a free action. */
async function grappleRelease(actor) {
    const grapple = grappleOf(actor);
    const other = grapple?.partnerUuid ? fromUuidSync(grapple.partnerUuid) : null;
    const otherActor = other?.documentName === "Actor" ? other : other?.actor;
    const ops = [{ type: "status", uuid: actor.uuid, id: "grappled", active: false }];
    if (otherActor) ops.push({ type: "status", uuid: otherActor.uuid, id: "grappled", active: false });
    await post(actor, loc("COMBAT_ACTION.GRAPPLE_RELEASE"), `<p>${loc("COMBAT_ACTION.GRAPPLE_RELEASE_HINT")}</p>`, ops);
}

/* -------------------------------------------- */
/*  Card buttons                                */
/* -------------------------------------------- */

/** Chat card buttons: apply a stun, a grapple, a knock-down or the unarmed strike. */
async function onCombatButton(event) {
    event.preventDefault();
    const button = event.currentTarget;
    const message = game.messages.get(button.closest(".message")?.dataset.messageId);
    const { op } = button.dataset;
    const actorDoc = await fromUuid(button.dataset.actor);
    const targetDoc = await fromUuid(button.dataset.target);
    const actor = actorDoc?.documentName === "Actor" ? actorDoc : actorDoc?.actor;
    const target = targetDoc?.documentName === "Actor" ? targetDoc : targetDoc?.actor;
    if (!actor || !target) return;
    if (!actor.isOwner) return ui.notifications.warn(loc("COMBAT_ACTION.NOT_OWNER"));
    if (message?.getFlag("dark-heresy", "applied")) return ui.notifications.info(loc("COMBAT_ACTION.ALREADY_APPLIED"));
    const name = esc(target.name);
    if (op === "stun") {
        const sb = actor.system.characteristics.strength.bonus;
        const roll = await new Roll(`1d10 + ${sb}`).evaluate();
        const resist = target.system.characteristics.toughness.bonus + (Number(target.system.armour?.head?.value) || 0);
        const lines = [game.i18n.format("COMBAT_ACTION.STUN_ROLL", { roll: roll.total, resist })];
        const ops = [];
        if (roll.total >= resist) {
            const rounds = roll.total - resist;
            lines.push(game.i18n.format("COMBAT_ACTION.STUNNED", { name, rounds }));
            ops.push({ type: "status", uuid: target.uuid, id: "stunned", rounds }, { type: "fatigue", uuid: target.uuid, delta: 1 });
        } else lines.push(game.i18n.format("COMBAT_ACTION.NOT_STUNNED", { name }));
        await post(actor, loc("COMBAT_ACTION.STUN"), `${lines.map(l => `<p>${l}</p>`).join("")}${await roll.render()}`, ops, [roll]);
    } else if (op === "grapple") {
        await post(actor, loc("COMBAT_ACTION.GRAPPLE"), `<p>${game.i18n.format("COMBAT_ACTION.GRAPPLE_STARTED", { name: esc(actor.name), target: name })}</p>`,
            startGrappleOps(actor, target));
    } else if (op === "knockdown") {
        await post(actor, loc("COMBAT_ACTION.KNOCKDOWN"), `<p>${game.i18n.format("COMBAT_ACTION.KNOCKED_DOWN", { name })}</p>`,
            [{ type: "status", uuid: target.uuid, id: "prone" }]);
    } else if (op === "unarmedStrike") {
        const strike = await unarmedDamage(actor, target);
        await post(actor, loc("COMBAT_ACTION.KNOCKDOWN"), `<p>${game.i18n.format("COMBAT_ACTION.STRIKE_DONE", { name, damage: strike.amount })}</p>
            ${await strike.roll.render()}`, strike.ops, [strike.roll]);
    }
    if (message?.isOwner) await message.setFlag("dark-heresy", "applied", true);
}

/* -------------------------------------------- */
/*  Menu                                        */
/* -------------------------------------------- */

const prone = a => a.statuses?.has("prone");
const grappling = a => a.statuses?.has("grappled");
const controls = a => grappling(a) && grappleOf(a)?.controller;
const held = a => grappling(a) && !grappleOf(a)?.controller;

/** Actions of the menu: id (key COMBAT_ACTION.<id>), cost in halves (for the label), availability, handler. */
const ACTIONS = [
    { id: "ALL_OUT", cost: 2, when: a => !grappling(a), run: allOutAttack },
    { id: "DEFENSIVE", cost: 2, when: a => !grappling(a), run: stance("defensive", 2) },
    { id: "CAUTIOUS", cost: 1, when: a => !grappling(a), run: stance("cautious", 1) },
    { id: "FEINT", cost: 1, when: a => !grappling(a), run: feint },
    { id: "MANOEUVRE", cost: 1, when: a => !grappling(a), run: manoeuvre },
    { id: "KNOCKDOWN", cost: 1, when: a => !grappling(a), run: knockdown },
    { id: "STUN", cost: 2, when: a => !grappling(a), run: stun },
    { id: "GRAPPLE", cost: 1, when: a => !grappling(a), run: grappleStart },
    { id: "GRAPPLE_DAMAGE", cost: 2, when: controls, run: grappleDamage },
    { id: "GRAPPLE_THROW", cost: 2, when: controls, run: grappleThrow },
    { id: "GRAPPLE_PUSH", cost: 2, when: controls, run: grapplePush },
    { id: "GRAPPLE_STAND", cost: 2, when: a => controls(a) && prone(a), run: grappleStand },
    { id: "GRAPPLE_RELEASE", cost: 0, when: controls, run: grappleRelease },
    { id: "GRAPPLE_BREAK", cost: 1, when: held, run: grappleBreak },
    { id: "GRAPPLE_SLIP", cost: 1, when: held, run: grappleSlip },
    { id: "GRAPPLE_CONTROL", cost: 1, when: held, run: grappleControl },
    { id: "STAND_UP", cost: 1, when: a => prone(a) && !grappling(a),
        run: reminder("STAND_UP", 1, actor => [{ type: "status", uuid: actor.uuid, id: "prone", active: false }]) },
    { id: "COVER", cost: 0, when: a => !grappling(a), run: takeCover },
    { id: "DELAY", cost: 2, when: a => !grappling(a), run: reminder("DELAY", 2) },
    { id: "OVERWATCH", cost: 2, when: a => !grappling(a), run: reminder("OVERWATCH", 2) },
    { id: "TACTICAL_ADVANCE", cost: 2, when: a => !grappling(a), run: reminder("TACTICAL_ADVANCE", 2) },
    { id: "DISENGAGE", cost: 2, when: a => !grappling(a), run: reminder("DISENGAGE", 2) }
];

const COST_KEY = { 0: "COMBAT_ACTION.COST_FREE", 1: "COMBAT_ACTION.COST_HALF", 2: "COMBAT_ACTION.COST_FULL" };

/**
 * Open the combat action menu for an actor, or run one action by id.
 * @param {Actor} actor
 * @param {string} [id] action id (COMBAT_ACTION key suffix)
 */
export async function combatActionMenu(actor, id) {
    if (!actor?.isOwner) return ui.notifications.warn(loc("COMBAT_ACTION.NOT_OWNER"));
    if (id) return ACTIONS.find(a => a.id === id)?.run(actor);
    // Talent states may take actions away (Frenzy: no Disengage), conditions.js conditionRule
    const available = ACTIONS.filter(a => (a.when?.(actor) ?? true) && !conditionRule(actor, `ban:${a.id}`));
    const combatant = combatantOfActor(actor);
    const left = combatant ? halvesPerTurn(combatant) - spentHalves(actionsOf(combatant)) : null;
    const target = singleTarget();
    const options = available.map(a => `<option value="${a.id}">${loc(`COMBAT_ACTION.${a.id}`)} (${loc(COST_KEY[a.cost])})</option>`).join("");
    const hints = Object.fromEntries(available.map(a => [a.id, loc(`COMBAT_ACTION.${a.id}_HINT`)]));
    const content = `<div class="dh-combat-action-dialog">
        <div class="form-group"><label>${loc("COMBAT_ACTION.ACTION")}</label><select name="action">${options}</select></div>
        <p class="hint dh-action-hint">${esc(hints[available[0]?.id] ?? "")}</p>
        <p class="hint">${target ? game.i18n.format("COMBAT_ACTION.TARGET", { name: esc(target.name) }) : loc("COMBAT_ACTION.NO_TARGET")}
        ${left !== null ? ` · ${game.i18n.format("COMBAT_ACTION.HALVES_LEFT", { n: Math.max(0, left) })}` : ""}</p></div>`;
    const data = await foundry.applications.api.DialogV2.input({
        window: { title: `${loc("COMBAT_ACTION.MENU")}: ${actor.name}` },
        content,
        ok: { label: loc("COMBAT_ACTION.PERFORM"), icon: "fa-solid fa-person-running" },
        rejectClose: false,
        render: (event, dialog) => {
            const select = dialog.element.querySelector("select[name=action]");
            const hint = dialog.element.querySelector(".dh-action-hint");
            select?.addEventListener("change", () => { hint.textContent = hints[select.value] ?? ""; });
        }
    });
    if (!data?.action) return;
    const action = ACTIONS.find(a => a.id === data.action);
    // Not enough half actions left this turn: warn, the GM decides
    if (combatant === game.combat?.combatant && action && action.cost > left) {
        ui.notifications.warn(game.i18n.format("COMBAT_ACTION.NOT_ENOUGH", { n: Math.max(0, left) }));
    }
    await action?.run(actor);
}

/** renderCombatTracker: an action menu button next to the pips of owned combatants. */
function onRenderTracker(app, html) {
    const root = html instanceof HTMLElement ? html : html[0];
    const combat = app.viewed;
    if (!root || !combat) return;
    for (const li of root.querySelectorAll("li.combatant[data-combatant-id]")) {
        const combatant = combat.combatants.get(li.dataset.combatantId);
        if (!combatant?.actor?.isOwner) continue;
        const button = document.createElement("a");
        button.className = "dh-action-menu";
        button.dataset.tooltip = loc("COMBAT_ACTION.MENU");
        button.innerHTML = '<i class="fa-solid fa-person-running"></i>';
        button.addEventListener("click", ev => {
            ev.stopPropagation();
            combatActionMenu(combatant.actor);
        });
        const box = li.querySelector(".dh-actions");
        if (box) box.append(button);
        else (li.querySelector(".token-initiative") ?? li).before(button);
    }
}

/**
 * Register hooks and the API; call during init.
 * @param {object} deps {prepareCombatRoll, util}
 */
export function registerCombatActions({ prepareCombatRoll, util }) {
    prepareCombatRollRef = prepareCombatRoll;
    utilRef = util;
    Hooks.on("renderCombatTracker", onRenderTracker);
    Hooks.on("renderChatMessageHTML", (message, html) => {
        html.querySelectorAll?.(".dh-combat-button").forEach(b => b.addEventListener("click", onCombatButton));
    });
}
