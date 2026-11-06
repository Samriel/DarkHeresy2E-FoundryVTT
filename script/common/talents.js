/**
 * Talents on rolls (core rulebook chapter IV; Enemies Within, Without and Beyond; Russian editions).
 *
 * A talent is found on the actor by its name (Russian or English, the specialisation in brackets; the same
 * talent taken several times counts as ranks) and acts at the steps of a roll. Definitions are in
 * script/common/talents/*.js and registered with registerTalents:
 *
 *   { id, match: /^(?:ненависть|hatred)\b/i,
 *     test(ctx), against(ctx), evasion(ctx), after(ctx), reroll(ctx), action(ctx), damage(ctx), defence(ctx),
 *     initiative(ctx) }
 *
 * - test(ctx) → effect(s): before a test or an attack of the actor. Evaluated when the roll dialog is
 *   confirmed (the attack type, range and evasion chosen there count) and previewed in the dialog.
 * - against(ctx) → effect(s): talents of the attack's target on the attacker's test (Hard Target…).
 * - evasion(ctx) → effect(s): talents of the attacker on an evasion test against his attack.
 *   Effect: { text, modifier, target (another target number), force: {result} | {success, dos},
 *   damage: {...} (kept for the damage roll of this attack, see damage step), apply(rollData),
 *   toggle, checked, fate, input: {min, max, value} with resolve(n) → effect, key (several per talent) }.
 *   toggle: true is an activated talent: a checkbox in the roll dialog, unticked unless checked; fate: 1
 *   spends a Fate point when ticked (an Unlucky waste cancels it); limit ("round"…, as for re-rolls) hides
 *   the checkbox once used.
 * - after(ctx) → text: after the d100; changes rollData (dos, dof, flags.isSuccess) itself.
 * - reroll(ctx) → { text, modifier, limit: "round" | "combat" | "day" | "session" }: after a failed test,
 *   a re-roll button on the card (not on a re-roll). damageReroll(ctx) → same, on the damage card.
 * - action(ctx) → { text, data, fate, limit, ownerUuid } | [...]: after the d100, a button on the card; a click
 *   by the owner (the talent's actor unless ownerUuid) spends Fate / a use and calls
 *   def.onAction({actor, owner, action, message, rollData}) → text for a chat line (or nothing). Other cards
 *   offer buttons the same way with talentActions(actor, step, ctx) (phenomena step: tables.js, ctx {power, perils}).
 * - damage(ctx) → { text, damage, penetration, proven, rfFace, rerollBelow, firstHit: {damage,
 *   penetration}, crit: n, apply(rollData) }: the damage roll of an attack. Effects saved from the test
 *   step (rollData.talentDamage) apply here too.
 * - defence(ctx) → { text, armour: n | {"ARMOUR.BODY": n…}, critReduce }: damage taken by the actor
 *   (DarkHeresyActor#applyDamage); armour counts only where worn armour covers the location.
 * - initiative(ctx) → { formula, text }: the actor's initiative roll (ctx: actor, talent, bonus).
 *
 * ctx: { actor, talent: {def, item, name, spec, rank}, rollData, kind (conditions.rollKind), skill,
 * speciality, characteristic, weapon (roll data), weaponItem, attackType, token, target (Token),
 * targetActor, attacker (evasion), record (actions.js), bonus(key) }.
 * Every talent that changed a roll is listed on its chat card: rollData.talents (test, after, re-roll),
 * rollData.damageTalents (damage card), the notes of the damage report (defence).
 */
import { rollKind, rollActor, recordOfActor } from "./conditions.js";
import { spendFate, updateMessage } from "./fate.js";

const defs = [];
const grantSources = [];

/**
 * Register talent definitions.
 * @param {object[]} list
 */
export function registerTalents(list) {
    defs.push(...list);
}

/**
 * Register a source of talents an actor has without the item (states, auras):
 * fn(actor) → [{id, name, spec, ...}]; the whole grant is kept as talent.grant.
 * @param {Function} fn
 */
export function registerTalentGrants(fn) {
    grantSources.push(fn);
}

const asList = value => (value ? (Array.isArray(value) ? value.filter(Boolean) : [value]) : []);
const specOf = name => name.match(/\(([^)]*)\)/)?.[1]?.trim() ?? "";
export const signed = n => (n > 0 ? `+${n}` : `${n}`);

/**
 * Talents of an actor that have a definition.
 * @param {Actor} actor
 * @returns {{def: object, item: Item|null, name: string, spec: string, rank: number}[]}
 */
export function actorTalents(actor) {
    const out = [];
    const add = (def, item, name) => {
        const spec = specOf(name);
        const same = out.find(t => t.def === def && t.spec.toLowerCase() === spec.toLowerCase());
        if (same) same.rank++;
        else out.push({ def, item, name, spec, rank: 1 });
    };
    for (const item of actor?.items ?? []) {
        if (item.type !== "talent") continue;
        const name = item.name.trim();
        // A talent may have several definitions (different groups of effects)
        for (const def of defs.filter(d => d.match.test(name))) add(def, item, name);
    }
    for (const source of grantSources) {
        for (const grant of asList(source(actor))) {
            const def = defs.find(d => d.id === grant.id);
            if (def && !out.some(t => t.def === def && t.spec.toLowerCase() === (grant.spec ?? "").toLowerCase())) {
                out.push({ def, item: null, name: grant.name, spec: grant.spec ?? "", rank: 1, grant });
            }
        }
    }
    return out;
}

/**
 * The actor's talent with this id (and specialisation matching the regex, if given).
 * @param {Actor} actor
 * @param {string} id
 * @param {RegExp} [spec]
 * @returns {object|undefined}
 */
export function findTalent(actor, id, spec) {
    return actorTalents(actor).find(t => t.def.id === id && (!spec || spec.test(t.spec)));
}

export const hasTalent = (actor, id, spec) => Boolean(findTalent(actor, id, spec));

/**
 * The canvas token of an actor (the controlled one first).
 * @param {Actor} actor
 * @returns {Token|null}
 */
export function tokenOf(actor) {
    if (!canvas?.ready || !actor) return null;
    if (actor.isToken) return actor.token?.object ?? null;
    return canvas.tokens.controlled.find(t => t.actor?.id === actor.id) ?? actor.getActiveTokens?.()[0] ?? null;
}

/**
 * The attacker of an attack's roll data (not the evader).
 * @param {object} rollData
 * @returns {Actor|null}
 */
export function attackerOf(rollData) {
    const doc = rollData.actorUuid ? fromUuidSync(rollData.actorUuid) : null;
    return doc ?? game.actors.get(rollData.ownerId) ?? null;
}

/**
 * Context for the talent steps of one roll.
 * @param {object} rollData
 * @param {Actor} actor whose talents are asked
 * @returns {object}
 */
export function talentContext(rollData, actor) {
    const evasion = Boolean(rollData.flags?.isEvasion);
    const target = !evasion && game.user.targets.size === 1 ? [...game.user.targets][0] : null;
    const weaponItem = rollData.weaponUuid ? fromUuidSync(rollData.weaponUuid) : null;
    return {
        actor,
        rollData,
        kind: rollKind(rollData),
        skill: rollData.skillKey ?? null,
        speciality: rollData.specialityKey ?? null,
        characteristic: rollData.characteristicKey ?? null,
        weapon: evasion ? null : (rollData.weapon ?? null),
        weaponItem: evasion ? null : weaponItem,
        attackType: rollData.attackType?.name ?? null,
        token: tokenOf(actor),
        target,
        targetActor: target?.actor ?? null,
        attacker: evasion ? attackerOf(rollData) : null,
        record: recordOfActor(actor),
        bonus: key => Number(actor?.characteristics?.[key]?.bonus) || 0
    };
}

/* -------------------------------------------- */
/*  Before the roll                             */
/* -------------------------------------------- */

/**
 * Talent effects for a test: the roller's (test), the target's (against), the attacker's on an evasion.
 * @param {object} rollData
 * @returns {object[]} effects with {talent, side, key}
 */
function testEffects(rollData) {
    const actor = rollActor(rollData);
    if (!actor || !rollData.target) return [];
    const ctx = talentContext(rollData, actor);
    const out = [];
    const collect = (owner, step, side, base) => {
        for (const talent of actorTalents(owner)) {
            const effects = asList(talent.def[step]?.({ ...base, talent }));
            effects.forEach((effect, i) => out.push({ ...effect, talent, side,
                key: `${side}:${talent.def.id}:${talent.spec}:${effect.key ?? i}` }));
        }
    };
    collect(actor, "test", "own", ctx);
    if (ctx.targetActor && rollData.flags?.isAttack) collect(ctx.targetActor, "against", "target", ctx);
    if (ctx.attacker) collect(ctx.attacker, "evasion", "attacker", ctx);
    return out;
}

/**
 * Label of an effect on the card and in the dialog.
 * @param {object} effect
 * @returns {string}
 */
function effectName(effect) {
    if (effect.side === "target") return game.i18n.format("TALENTS.TARGET_TALENT", { name: effect.talent.name });
    if (effect.side === "attacker") return game.i18n.format("TALENTS.ATTACKER_TALENT", { name: effect.talent.name });
    return effect.talent.name;
}

/**
 * Talents of the roll dialog: what applies by itself and what can be activated.
 * @param {object} rollData
 * @param {Set<string>} [checked] keys ticked so far (when the dialog is refreshed)
 * @returns {{passive: object[], toggles: object[]}|null}
 */
export function talentDialogData(rollData, checked) {
    const actor = rollActor(rollData);
    const effects = testEffects(rollData).filter(e => !(e.toggle && e.limit && usedUp(actor, toggleKey(e), e.limit)));
    if (!effects.length) return null;
    const passive = effects.filter(e => !e.toggle).map(e => ({ name: effectName(e), text: e.text }));
    const toggles = effects.filter(e => e.toggle).map(e => ({ key: e.key, name: effectName(e), text: e.text,
        fate: e.fate, input: e.input, checked: checked ? checked.has(e.key) : Boolean(e.checked) }));
    return { passive, toggles };
}

/**
 * HTML of the talents block of a roll dialog.
 * @param {object} rollData
 * @param {Set<string>} [checked]
 * @returns {Promise<string>}
 */
export async function talentBlock(rollData, checked) {
    return foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/dialog/talents.hbs",
        { talentDialog: talentDialogData(rollData, checked) });
}

/**
 * Keep the dialog's talents block up to date when its choices change.
 * @param {jQuery} html dialog content
 * @param {object} rollData
 * @param {Function} read (copy, html) → void: puts the dialog's current choices into a copy of the roll data
 */
export function watchTalentBlock(html, rollData, read) {
    html.find("select, input:not(.dh-talent-toggle):not(.dh-talent-input)").on("change", async () => {
        const copy = foundry.utils.deepClone(rollData);
        read(copy, html);
        const checked = new Set(html.find(".dh-talent-toggle:checked").map((i, el) => el.dataset.key).get());
        html.find(".dh-talents").replaceWith(await talentBlock(copy, checked));
    });
}

/**
 * Apply one effect to the roll data and list it on the card.
 * @param {object} rollData
 * @param {object} effect
 */
function applyEffect(rollData, effect) {
    if (effect.modifier) rollData.target.modifier = (Number(rollData.target.modifier) || 0) + effect.modifier;
    if (Number.isFinite(effect.target)) rollData.target.base = effect.target;
    if (effect.force) rollData.talentForce = { ...(rollData.talentForce ?? {}), ...effect.force, name: effect.talent.name };
    if (effect.damage) (rollData.talentDamage ??= []).push({ ...effect.damage, name: effect.talent.name });
    effect.apply?.(rollData);
    (rollData.talents ??= []).push({ name: effectName(effect), text: effect.text });
}

/** Use-limit key of an activated talent. */
const toggleKey = effect => `${effect.talent.def.id}${effect.talent.spec ? `-${effect.talent.spec.slugify?.() ?? effect.talent.spec}` : ""}-test`;

/**
 * Roll dialog callback (after the dialog's values are read into rollData): apply the talents that act by
 * themselves and the ticked ones; spend Fate for ticked talents that cost it.
 * @param {object} rollData
 * @param {jQuery|HTMLElement} [html] dialog content
 */
export async function applyTalents(rollData, html) {
    if (rollData.isReRoll) return;
    const root = html?.[0] ?? html;
    const ticked = new Map([...(root?.querySelectorAll?.(".dh-talent-toggle:checked") ?? [])]
        .map(el => [el.dataset.key, root.querySelector(`.dh-talent-input[data-key="${CSS.escape(el.dataset.key)}"]`)]));
    rollData.talents = [];
    delete rollData.talentForce;
    // An evasion keeps the attack's saved damage effects for the hits left after it
    if (!rollData.flags?.isEvasion) delete rollData.talentDamage;
    const actor = rollActor(rollData);
    for (let effect of testEffects(rollData)) {
        if (effect.toggle) {
            if (!ticked.has(effect.key)) continue;
            if (effect.limit && usedUp(actor, toggleKey(effect), effect.limit)) continue;
            if (effect.input && effect.resolve) {
                const n = Math.clamp(parseInt(ticked.get(effect.key)?.value, 10) || 0, effect.input.min ?? 0, effect.input.max ?? 99);
                if (!n) continue;
                effect = { ...effect, ...effect.resolve(n) };
            }
            if (effect.fate) {
                const spent = await spendFate(actor, "talent", { detail: effect.talent.name });
                if (!spent?.effective) continue;
            }
            if (effect.limit) await markUsed(actor, toggleKey(effect), effect.limit);
        }
        applyEffect(rollData, effect);
    }
}

/* -------------------------------------------- */
/*  After the roll                              */
/* -------------------------------------------- */

/**
 * After the d100: talents that change the degrees (after step).
 * @param {object} rollData
 */
export function afterRollTalents(rollData) {
    const actor = rollActor(rollData);
    if (!actor || !rollData.target) return;
    const ctx = talentContext(rollData, actor);
    for (const talent of actorTalents(actor)) {
        const text = talent.def.after?.({ ...ctx, talent });
        if (text) (rollData.talents ??= []).push({ name: talent.name, text });
    }
    // Card buttons, once the degrees are final
    const actions = talentActions(actor, "action", ctx);
    if (actions.length) rollData.talentActions = actions;
    else delete rollData.talentActions;
}

/**
 * Stamp of a use limit: a use is spent while the stamp stays the same.
 * @param {string} limit
 * @param {Actor} [actor] round and combat: the started combat the actor fights in, else the viewed one
 * @returns {string|null}
 */
function limitStamp(limit, actor) {
    const combat = game.combats?.find(c => c.started && c.combatants.some(cb => cb.actor === actor))
        ?? (game.combat?.started ? game.combat : null);
    switch (limit) {
        case "round": return combat ? `${combat.id}:${combat.round}` : null;
        case "combat": return combat?.id ?? null;
        case "day": return String(Math.floor((game.time?.worldTime ?? 0) / 86400));
        case "session": return new Date().toDateString();
        default: return null;
    }
}

function usedUp(actor, key, limit) {
    const stamp = limitStamp(limit, actor);
    return Boolean(stamp) && actor?.getFlag("dark-heresy", "talentUses")?.[key] === stamp;
}

async function markUsed(actor, key, limit) {
    const stamp = limitStamp(limit, actor);
    if (stamp && actor?.isOwner) await actor.update({ [`flags.dark-heresy.talentUses.${key}`]: stamp });
}

/**
 * After a failed test: re-roll buttons of talents (not on a re-roll), or on a damage card.
 * @param {object} rollData
 * @param {"test"|"damage"} [phase="test"]
 */
export function offerTalentRerolls(rollData, phase = "test") {
    const field = phase === "damage" ? "damageRerolls" : "talentRerolls";
    delete rollData[field];
    if (rollData.isReRoll || rollData.damageReroll) return;
    if (phase === "test" && (rollData.flags?.isSuccess || !rollData.target)) return;
    const actor = phase === "damage" ? attackerOf(rollData) : rollActor(rollData);
    if (!actor) return;
    const ctx = talentContext(rollData, actor);
    const step = phase === "damage" ? "damageReroll" : "reroll";
    const offers = [];
    for (const talent of actorTalents(actor)) {
        const offer = talent.def[step]?.({ ...ctx, talent });
        if (!offer) continue;
        const key = `${talent.def.id}${talent.spec ? `-${talent.spec.slugify?.() ?? talent.spec}` : ""}`;
        if (usedUp(actor, key, offer.limit)) continue;
        offers.push({ key, name: talent.name, text: offer.text ?? "", modifier: Number(offer.modifier) || 0,
            limit: offer.limit ?? null, actorUuid: actor.uuid });
    }
    if (offers.length) rollData[field] = offers;
}

/**
 * Chat button: re-roll a test or a damage roll by a talent.
 * @param {Event} event
 * @param {object} rolls {commonRoll, combatRoll, damageRoll}
 */
export async function onTalentRerollClick(event, rolls) {
    event.preventDefault();
    const button = event.currentTarget;
    const message = game.messages.get(button.closest(".message")?.dataset.messageId);
    const rollData = foundry.utils.deepClone(message?.getRollData() ?? null);
    const phase = button.dataset.phase ?? "test";
    const offer = rollData?.[phase === "damage" ? "damageRerolls" : "talentRerolls"]?.find(o => o.key === button.dataset.key);
    if (!offer) return;
    const actor = fromUuidSync(offer.actorUuid);
    if (!actor?.isOwner) {
        ui.notifications.warn(game.i18n.format("TALENTS.NOT_OWNER", { name: actor?.name ?? "" }));
        return;
    }
    if (usedUp(actor, offer.key, offer.limit)) {
        ui.notifications.warn(game.i18n.format("TALENTS.USED", { name: offer.name }));
        return;
    }
    await markUsed(actor, offer.key, offer.limit);
    button.disabled = true;
    delete rollData.talentRerolls;
    delete rollData.damageRerolls;
    if (phase === "damage") {
        rollData.damageReroll = { name: offer.name, text: offer.text };
        return rolls.damageRoll(rollData);
    }
    delete rollData.damages;
    delete rollData.fateDegrees;
    delete rollData.fateBonus;
    rollData.flags.isReRoll = true;
    rollData.isReRoll = true;
    rollData.rerollBy = offer.name;
    if (offer.modifier) rollData.target.modifier = (Number(rollData.target.modifier) || 0) + offer.modifier;
    (rollData.talents ??= []).push({ name: offer.name, text: game.i18n.format("TALENTS.REROLLED",
        { modifier: offer.modifier ? ` ${signed(offer.modifier)}` : "" }) });
    if (rollData.flags.isCombatRoll) {
        rollData.attributeBoni = attackerOf(rollData)?.attributeBoni;
        return rolls.combatRoll(rollData);
    }
    return rolls.commonRoll(rollData);
}

/* -------------------------------------------- */
/*  Card buttons                                */
/* -------------------------------------------- */

/**
 * Buttons of an actor's talents for a card: the action step on roll cards, other steps on other cards.
 * @param {Actor} actor
 * @param {string} step definition method: "action", "phenomena"…
 * @param {object} ctx context passed to the step (talent is added)
 * @returns {object[]} [{key, id, spec, name, text, fate, limit, ownerUuid, actorUuid, data}]
 */
export function talentActions(actor, step, ctx = {}) {
    const out = [];
    for (const talent of actorTalents(actor)) {
        asList(talent.def[step]?.({ ...ctx, actor, talent })).forEach((a, i) => {
            const key = `${talent.def.id}${talent.spec ? `-${talent.spec.slugify?.() ?? talent.spec}` : ""}`;
            if (usedUp(actor, key, a.limit)) return;
            out.push({ key: `${key}:${step}:${a.key ?? i}`, useKey: key, id: talent.def.id, spec: talent.spec,
                name: talent.name, text: a.text ?? "", fate: a.fate ? 1 : 0, limit: a.limit ?? null,
                actorUuid: actor.uuid, ownerUuid: a.ownerUuid ?? actor.uuid, data: a.data ?? {} });
        });
    }
    return out;
}

/**
 * Wire the talent buttons of a rendered card; used ones are disabled.
 * @param {HTMLElement} html
 */
export function talentActionListeners(html) {
    const message = game.messages.get(html.dataset?.messageId);
    const used = message?.getFlag("dark-heresy", "talentActionsUsed") ?? [];
    html.querySelectorAll(".dh-talent-action").forEach(button => {
        if (used.includes(button.dataset.key)) button.disabled = true;
        button.addEventListener("click", onTalentActionClick);
    });
}

/**
 * Chat button: a talent's action (spends Fate or a use, then the definition's onAction).
 * @param {Event} event
 */
async function onTalentActionClick(event) {
    event.preventDefault();
    const button = event.currentTarget;
    const message = game.messages.get(button.closest(".message")?.dataset.messageId);
    const rollData = message?.getFlag("dark-heresy", "rollData");
    const actions = rollData?.talentActions ?? message?.getFlag("dark-heresy", "talentActions") ?? [];
    const action = actions.find(a => a.key === button.dataset.key);
    const def = action && defs.find(d => d.id === action.id);
    if (!def?.onAction || (message.getFlag("dark-heresy", "talentActionsUsed") ?? []).includes(action.key)) return;
    const owner = fromUuidSync(action.ownerUuid);
    const actor = fromUuidSync(action.actorUuid);
    if (!owner?.isOwner) {
        ui.notifications.warn(game.i18n.format("TALENTS.NOT_OWNER", { name: owner?.name ?? "" }));
        return;
    }
    if (usedUp(actor, action.useKey, action.limit)) {
        ui.notifications.warn(game.i18n.format("TALENTS.USED", { name: action.name }));
        return;
    }
    button.disabled = true;
    if (action.fate) {
        const spent = await spendFate(actor, "talent", { detail: action.name });
        if (!spent) button.disabled = false;
        if (!spent?.effective) return;
    }
    await markUsed(actor, action.useKey, action.limit);
    await updateMessage(message, { "flags.dark-heresy.talentActionsUsed":
        [...(message.getFlag("dark-heresy", "talentActionsUsed") ?? []), action.key] });
    const text = await def.onAction({ actor, owner, action, message, rollData: foundry.utils.deepClone(rollData ?? null) });
    if (text) {
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div class="dark-heresy chat roll"><div class="background border"><p><strong>${
                foundry.utils.escapeHTML(action.name)}:</strong> ${foundry.utils.escapeHTML(text)}</p></div></div>` });
    }
}

/* -------------------------------------------- */
/*  Initiative                                  */
/* -------------------------------------------- */

/**
 * Initiative formula of an actor's talents (initiative step), or null.
 * @param {Actor} actor
 * @returns {{formula: string, name: string, text: string}|null}
 */
export function talentInitiative(actor) {
    const ctx = { actor, bonus: key => Number(actor?.characteristics?.[key]?.bonus) || 0 };
    for (const talent of actorTalents(actor)) {
        const effect = talent.def.initiative?.({ ...ctx, talent });
        if (effect?.formula) return { ...effect, name: talent.name };
    }
    return null;
}

/** Initiative rolls by talents and their line on the initiative card; call during init. */
export function registerTalentHooks() {
    const Base = CONFIG.Combatant.documentClass;
    CONFIG.Combatant.documentClass = class extends Base {
        /** @override */
        _getInitiativeFormula() {
            return talentInitiative(this.actor)?.formula ?? super._getInitiativeFormula();
        }
    };
    Hooks.on("preCreateChatMessage", (message, data) => {
        if (!message.getFlag("core", "initiativeRoll")) return;
        const actor = ChatMessage.getSpeakerActor(message.speaker);
        const talent = talentInitiative(actor);
        if (!talent) return;
        const line = `${game.i18n.localize("TALENTS.CHAT")}: ${talent.name} (${talent.text})`;
        message.updateSource({ flavor: [message.flavor, line].filter(Boolean).join("<br>") });
    });
}

/* -------------------------------------------- */
/*  Damage                                      */
/* -------------------------------------------- */

/**
 * Talent effects on the damage roll of an attack: the attacker's damage step and the effects saved from his
 * test step. Listed in rollData.damageTalents.
 * @param {object} rollData
 * @returns {{damage: number, penetration: number, proven: number, rfFace: number|null, rerollBelow: number,
 *   firstHit: {damage: number, penetration: number}, crit: number, critName: string}}
 */
export function damageTalents(rollData) {
    const sum = { damage: 0, penetration: 0, proven: 0, rfFace: null, rerollBelow: 0,
        firstHit: { damage: 0, penetration: 0 }, crit: 0, critName: "" };
    rollData.damageTalents = [];
    const actor = attackerOf(rollData);
    if (!actor) return sum;
    const ctx = talentContext(rollData, actor);
    const effects = [];
    for (const talent of actorTalents(actor)) {
        for (const effect of asList(talent.def.damage?.({ ...ctx, talent }))) effects.push({ ...effect, name: talent.name });
    }
    effects.push(...(rollData.talentDamage ?? []));
    for (const e of effects) {
        sum.damage += Number(e.damage) || 0;
        sum.penetration += Number(e.penetration) || 0;
        sum.proven = Math.max(sum.proven, Number(e.proven) || 0);
        if (e.rfFace) sum.rfFace = Math.min(sum.rfFace ?? 10, e.rfFace);
        sum.rerollBelow = Math.max(sum.rerollBelow, Number(e.rerollBelow) || 0);
        sum.firstHit.damage += Number(e.firstHit?.damage) || 0;
        sum.firstHit.penetration += Number(e.firstHit?.penetration) || 0;
        if (Number(e.crit)) {
            sum.crit += Number(e.crit);
            sum.critName = [sum.critName, e.name].filter(Boolean).join(", ");
        }
        e.apply?.(rollData);
        if (e.text) rollData.damageTalents.push({ name: e.name, text: e.text });
    }
    return sum;
}

/* -------------------------------------------- */
/*  Damage taken                                */
/* -------------------------------------------- */

/**
 * Talents of a character taking damage, and the attacker's critical damage bonus.
 * @param {Actor} actor the target
 * @param {object} [attack] attack data of the damage request (attackerId, talentCrit)
 * @returns {{armourAt: Function, critReduce: number, critBonus: number, notes: string[]}} armourAt(location) → extra
 *   armour points at a hit location ("ARMOUR.BODY"…); a talent's armour is a number (every location the worn
 *   armour covers) or {location: points}
 */
export function defenceTalents(actor, attack = {}) {
    const armour = [];
    const out = { armourAt: location => armour.reduce((sum, a) => sum + (typeof a === "number" ? a : Number(a[location]) || 0), 0),
        critReduce: 0, critBonus: Number(attack?.talentCrit?.bonus) || 0, notes: [] };
    if (out.critBonus) out.notes.push(`${attack.talentCrit.name}: ${game.i18n.format("TALENTS.CRIT_BONUS", { bonus: out.critBonus })}`);
    const ctx = { actor, attack, bonus: key => Number(actor?.characteristics?.[key]?.bonus) || 0 };
    for (const talent of actorTalents(actor)) {
        const effect = talent.def.defence?.({ ...ctx, talent });
        if (!effect) continue;
        if (effect.armour) armour.push(effect.armour);
        out.critReduce += Number(effect.critReduce) || 0;
        if (effect.text) out.notes.push(`${talent.name}: ${effect.text}`);
    }
    return out;
}
