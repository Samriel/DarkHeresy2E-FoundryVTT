/**
 * Activated talent states and auras (core rulebook chapter IV and the Untouchable talents pp. 114–115;
 * Enemies Within pp. 40–41, 65; Enemies Beyond p. 69; Russian edition page numbers). Durations, the Talents
 * menu and the cards are in talent-states.js; the effects act at the steps of talents.js while a state lasts.
 * Auras: the holder's talent (or state) is granted to every token in range as an effect definition of its own
 * (registerTalentGrants), so the affected character's roll lists it; the radius is measured edge to edge.
 */
import { signed, hasTalent } from "../talents.js";
import { stateOf, setStateOp, endStateOp, tokensNear, hostile, talentTest } from "../talent-states.js";
import { traitRating, hasWarpInstability } from "../traits.js";

const t = (key, data) => game.i18n.format(`TALENTS.EFFECT.${key}`, data);
const s = (key, data) => game.i18n.format(`TALENTS.STATE.${key}`, data);
const esc = v => foundry.utils.escapeHTML(String(v ?? ""));
const NEVER = /(?!)/;
const wpb = actor => Number(actor?.system?.characteristics?.willpower?.bonus) || 0;
const insanityBonus = actor => Number(actor?.system?.insanityBonus) || 0;
const names = list => list.map(n => esc(n.token.name)).join(", ");

/** Disabled reason of an action that needs the actor in the started combat. */
const needCombat = ({ combatant }) => (combatant ? "" : s("COMBAT_ONLY"));
/** Disabled reason while the state lasts. */
const running = (actor, id) => (stateOf(actor, id) ? s("ACTIVE") : "");

/**
 * Characteristic a test is made with (Frenzy's changes shown on the card).
 * @param {object} ctx talent context
 * @returns {string|null}
 */
function testCharacteristic({ actor, rollData, kind, skill }) {
    if (kind === "evasion") {
        const selected = rollData.evasions?.selected;
        return selected === "parry" ? "weaponSkill" : selected === "deny" ? "willpower" : "agility";
    }
    if (rollData.characteristicKey) return rollData.characteristicKey;
    if (kind === "melee" || kind === "ws") return "weaponSkill";
    if (kind === "ranged" || kind === "bs") return "ballisticSkill";
    if (rollData.flags?.isFear) return "willpower";
    const short = skill ? actor.system.skills?.[skill]?.characteristics?.[0] : null;
    return Object.entries(actor.system.characteristics).find(([, c]) => c.short === short)?.[0] ?? null;
}

/** Is the test a Willpower test (Rites of Banishment)? */
const willpowerTest = rollData => !rollData.flags?.isAttack && !rollData.flags?.isEvasion
    && (rollData.characteristicKey === "willpower" || Boolean(rollData.flags?.isFear) || Boolean(rollData.warpInstability));

/** Test step of the states that ignore fatigue: shown while the character is fatigued. */
const fatigueIgnored = id => ({ actor }) => (stateOf(actor, id) && Number(actor.system.fatigue?.value) > 0
    ? { text: t("FATIGUE_IGNORED") } : null);

/* -------------------------------------------- */
/*  Frenzy                                      */
/* -------------------------------------------- */

// Frenzy (p. 160): +10 WS, S, T, WP; −20 BS, Int, Fel (never below 1); immune to Fear, Pinning, Stun and
// Fatigue; no Parry (Battle Rage allows it), no retreat (Disengage), no psychic powers
const FRENZY = {
    characteristics: { weaponSkill: 10, strength: 10, toughness: 10, willpower: 10, ballisticSkill: -20,
        intelligence: -20, fellowship: -20 },
    ignore: ["fatigue", "stunned"],
    bans: ["DISENGAGE"]
};

const frenzyState = (name, attempts = 0) => ({ talent: "frenzy", name, img: "icons/svg/terror.svg", stats: FRENZY,
    data: { attempts } });

/**
 * Talent definitions.
 */
const DEFS = [
    {
        // Frenzy (p. 160): a Full Action working up, frenzied from the next turn (out of combat at once; a Free
        // Action under Flagellant); lasts until a Willpower test passes, +10 per earlier failed test; an hour of
        // rest before the next one
        id: "frenzy",
        match: /^(?:неистовство|frenzy)(?![\p{L}])/iu,
        actions: ({ actor, talent, combatant }) => {
            const frenzy = stateOf(actor, "frenzy");
            if (frenzy) {
                const modifier = 10 * (Number(frenzy.data?.attempts) || 0);
                return { key: "calm", label: s("FRENZY_CALM"), hint: s("FRENZY_CALM_HINT", { modifier: signed(modifier) }),
                    run: () => {
                        talentTest(actor, "willpower", { name: `${talent.name}: ${s("FRENZY_CALM")}`, modifier,
                            talent: "frenzy", action: "calm" });
                        return null;
                    } };
            }
            const quick = Boolean(stateOf(actor, "flagellant"));
            const name = esc(actor.name);
            const on = s("FRENZY_ON", { name });
            return { key: "enter", label: s("FRENZY_ENTER"), cost: quick ? 0 : 2,
                hint: quick ? s("FRENZY_QUICK_HINT") : s("FRENZY_ENTER_HINT"),
                disabled: stateOf(actor, "frenzyPending") ? s("FRENZY_PENDING") : stateOf(actor, "frenzyRest") ? s("FRENZY_RESTING") : "",
                run: () => (quick || !combatant
                    ? { lines: [on], ops: [setStateOp(actor, "frenzy", frenzyState(talent.name))] }
                    : { lines: [s("FRENZY_WORKING_UP", { name })], ops: [setStateOp(actor, "frenzyPending", {
                        talent: "frenzy", name: `${talent.name} (${s("PENDING")})`, img: "icons/svg/fire.svg", until: "turnStart",
                        then: { id: "frenzy", ...frenzyState(talent.name), text: on } })] }) };
        },
        test: ({ actor, rollData, kind, skill }) => {
            if (!stateOf(actor, "frenzy")) return null;
            if (rollData.flags?.isFear) return { force: { success: true, dos: 1 }, text: t("IMMUNE_FEAR") };
            if (rollData.pinning && !rollData.pinning.recover) return { force: { success: true, dos: 1 }, text: t("IMMUNE_PINNING") };
            if (kind === "evasion" && rollData.evasions?.selected === "parry" && !hasTalent(actor, "battleRage")) {
                return { force: { result: 100 }, text: t("NO_PARRY") };
            }
            if (kind === "psychic") return { text: t("NO_PSYCHIC") };
            const key = testCharacteristic({ actor, rollData, kind, skill });
            const change = FRENZY.characteristics[key];
            return change ? { text: t("IN_CHARACTERISTIC", { characteristic: game.i18n.localize(actor.system.characteristics[key].short),
                value: signed(change) }) } : null;
        },
        onResult: ({ actor, success, isReRoll }) => {
            const frenzy = stateOf(actor, "frenzy");
            if (!frenzy) return null;
            const name = esc(actor.name);
            if (success) {
                return { title: frenzy.name, lines: [s("FRENZY_CALMED", { name })], ops: [endStateOp(actor, "frenzy"),
                    setStateOp(actor, "frenzyRest", { talent: "frenzy", name: `${frenzy.name} (${s("REST")})`, img: "icons/svg/sleep.svg", until: "hour" })] };
            }
            // A re-roll (Battle Rage) does not count as another attempt
            if (isReRoll) return null;
            const attempts = (Number(frenzy.data?.attempts) || 0) + 1;
            return { title: frenzy.name, lines: [s("FRENZY_STILL", { name, modifier: signed(10 * attempts) })],
                ops: [setStateOp(actor, "frenzy", frenzyState(frenzy.name, attempts))] };
        },
        combatEnd: ({ actor }) => ({ lines: [s("FRENZY_COMBAT_OVER", { name: esc(actor.name) })], action: "calm",
            label: s("FRENZY_CALM") })
    },
    {
        // Battle Rage (p. 151): may Parry while frenzied; re-roll a failed test to calm down
        id: "battleRage",
        match: /^(?:боевая\s+ярость|battle\s+rage)/i,
        test: ({ actor, rollData, kind }) => (kind === "evasion" && rollData.evasions?.selected === "parry" && stateOf(actor, "frenzy")
            ? { text: t("PARRY_IN_FRENZY") } : null),
        reroll: ({ rollData }) => (rollData.talentTest?.talent === "frenzy" ? { text: "" } : null)
    },
    {
        // Flagellant (Enemies Within p. 65): Full Action, 1d5−2 fatigue (at least 1); then +10 to Willpower tests
        // against Fear, Pinning, psychic powers (by themselves) and Corruption (ticked) for an hour or until the
        // end of the encounter
        id: "flagellant",
        match: /^(?:флагеллант|flagellant)/i,
        actions: ({ actor, talent }) => ({ key: "scourge", label: s("FLAGELLANT_SCOURGE"), cost: 2, hint: s("FLAGELLANT_HINT"),
            run: async () => {
                const roll = await new Roll("1d5 - 2").evaluate();
                const levels = Math.max(1, roll.total);
                return { rolls: [roll], lines: [s("FLAGELLANT_ON", { name: esc(actor.name), roll: roll.total, levels })],
                    ops: [{ type: "fatigue", uuid: actor.uuid, delta: levels }, setStateOp(actor, "flagellant",
                        { name: talent.name, img: "icons/svg/blood.svg", until: "hour", data: { encounter: true } })] };
            } }),
        test: ({ actor, rollData }) => {
            if (!stateOf(actor, "flagellant") || !willpowerTest(rollData) || rollData.warpInstability) return null;
            if (rollData.flags?.isFear || (rollData.pinning && !rollData.pinning.recover) || rollData.opposedTo) return { modifier: 10, text: "+10" };
            return { toggle: true, modifier: 10, text: t("FLAGELLANT_CORRUPTION") };
        }
    },

    /* ---------------- Fate: until the end of the next turn, the round ---------------- */
    {
        // Spirit of the Martyr (Enemies Within p. 41): Fate point, Free Action; + Insanity bonus armour on every
        // location until the end of her next turn
        id: "spiritOfTheMartyr",
        match: /^(?:дух\s+мученичества|spirit\s+of\s+the\s+martyr)/i,
        actions: ctx => ({ key: "invoke", label: s("INVOKE"), fate: 1, hint: s("MARTYR_HINT", { value: insanityBonus(ctx.actor) }),
            disabled: needCombat(ctx) || running(ctx.actor, "spiritOfTheMartyr"),
            run: () => ({ lines: [s("MARTYR_ON", { name: esc(ctx.actor.name), value: insanityBonus(ctx.actor) })],
                ops: [setStateOp(ctx.actor, "spiritOfTheMartyr", { name: ctx.talent.name, img: "icons/svg/holy-shield.svg", until: "turnEnd" })] }) }),
        defence: ({ actor }) => {
            const value = stateOf(actor, "spiritOfTheMartyr") ? insanityBonus(actor) : 0;
            return value ? { armour: value, natural: true, text: t("ARMOUR", { value: signed(value) }) } : null;
        }
    },
    {
        // Emperor's Guidance (Enemies Within p. 41): Fate point, Free Action; + Insanity bonus penetration of her
        // weapons until the end of her next turn
        id: "emperorsGuidance",
        match: /^(?:покровительство\s+императора|emperor['’]?s\s+guidance)/i,
        actions: ctx => ({ key: "invoke", label: s("INVOKE"), fate: 1, hint: s("GUIDANCE_HINT", { value: insanityBonus(ctx.actor) }),
            disabled: needCombat(ctx) || running(ctx.actor, "emperorsGuidance"),
            run: () => ({ lines: [s("GUIDANCE_ON", { name: esc(ctx.actor.name), value: insanityBonus(ctx.actor) })],
                ops: [setStateOp(ctx.actor, "emperorsGuidance", { name: ctx.talent.name, img: "icons/svg/sword.svg", until: "turnEnd" })] }) }),
        damage: ({ actor, rollData }) => {
            const value = stateOf(actor, "emperorsGuidance") && !rollData.psy?.display ? insanityBonus(actor) : 0;
            return value ? { penetration: value, text: t("PENETRATION", { value: signed(value) }) } : null;
        }
    },
    {
        // Killing Strike (p. 165): Fate point at the start of his turn; until the end of the round his melee
        // attacks cannot be Parried or Dodged (conditions.js evasionProblems)
        id: "killingStrike",
        match: /^(?:убийственный\s+удар|killing\s+strike)/i,
        actions: ctx => ({ key: "invoke", label: s("INVOKE"), fate: 1, hint: s("KILLING_STRIKE_HINT"),
            disabled: needCombat(ctx) || (ctx.ownTurn ? "" : s("OWN_TURN")) || running(ctx.actor, "killingStrike"),
            run: () => ({ lines: [s("KILLING_STRIKE_ON", { name: esc(ctx.actor.name) })],
                ops: [setStateOp(ctx.actor, "killingStrike", { name: ctx.talent.name, img: "icons/svg/sword.svg", until: "round" })] }) }),
        test: ({ actor, rollData, kind, talent }) => (stateOf(actor, "killingStrike") && kind === "melee" && rollData.flags?.isAttack
            ? { text: t("UNAVOIDABLE"), apply: rd => { rd.unavoidable = talent.name; } } : null),
        evasion: ({ rollData }) => (rollData.unavoidable ? { text: t("UNAVOIDABLE") } : null)
    },

    /* ---------------- Fate: until the end of the combat ---------------- */
    {
        // Ceaseless Crusader (Enemies Within p. 40): Fate point, Free Action; ignores fatigue until the end of the
        // combat; every friendly character within 30 m removes one level of fatigue
        id: "ceaselessCrusader",
        match: /^(?:непреклонный\s+крестоносец|ceaseless\s+crusader)/i,
        actions: ctx => ({ key: "invoke", label: s("INVOKE"), fate: 1, hint: s("CRUSADER_HINT"),
            disabled: needCombat(ctx) || running(ctx.actor, "ceaselessCrusader"),
            run: () => {
                const { actor, talent } = ctx;
                const allies = tokensNear(actor).filter(n => n.distance <= 30 + 1e-6 && n.token.document.disposition === n.self.document.disposition
                    && Number(n.actor.system.fatigue?.value) > 0);
                return { lines: [s("CRUSADER_ON", { name: esc(actor.name) }), ...(allies.length ? [s("CRUSADER_ALLIES", { names: names(allies) })] : [])],
                    ops: [setStateOp(actor, "ceaselessCrusader", { name: talent.name, img: "icons/svg/upgrade.svg", until: "combat",
                        stats: { ignore: ["fatigue"] } }), ...allies.map(n => ({ type: "fatigue", uuid: n.actor.uuid, delta: -1 }))] };
            } }),
        test: fatigueIgnored("ceaselessCrusader")
    },
    {
        // Unkillable (p. 161): Fate point; ignores the effects of injuries (critical damage), fatigue and stun for
        // the combat, except what kills at once: fatigue penalties and the knock-out, the turn lost to a stun;
        // critical effects are a note on the damage report
        id: "unkillable",
        match: /^(?:неубиваемый|unkillable)/i,
        actions: ctx => ({ key: "invoke", label: s("INVOKE"), fate: 1, hint: s("UNKILLABLE_HINT"),
            disabled: needCombat(ctx) || running(ctx.actor, "unkillable"),
            run: () => ({ lines: [s("UNKILLABLE_ON", { name: esc(ctx.actor.name) })],
                ops: [setStateOp(ctx.actor, "unkillable", { name: ctx.talent.name, img: "icons/svg/regen.svg", until: "combat",
                    stats: { ignore: ["fatigue", "stunned"] } })] }) }),
        test: fatigueIgnored("unkillable"),
        defence: ({ actor }) => (stateOf(actor, "unkillable") ? { text: t("INJURY_IGNORED") } : null)
    },
    {
        // Zealot's Passion (Enemies Within p. 41): Fate point, Free Action, the targeted enemy; until the end of
        // the fight she and her allies within WPB × 10 m have Hatred against such enemies (talents/combat.js «hatred»)
        id: "zealotsPassion",
        match: /^(?:фанатичная\s+страсть|zealot['’]?s\s+passion)/i,
        actions: ctx => {
            const { actor, talent, target } = ctx;
            const range = wpb(actor) * 10;
            return { key: "invoke", label: s("INVOKE"), fate: 1, hint: s("ZEALOT_HINT", { range }),
                disabled: needCombat(ctx) || (target?.actor && target.actor !== actor ? "" : s("NEED_ENEMY")) || running(actor, "zealotsPassion"),
                run: () => {
                    const allies = tokensNear(actor).filter(n => n.distance <= range + 1e-6
                        && n.token.document.disposition === n.self.document.disposition);
                    const enemy = target.name;
                    return { lines: [s("ZEALOT_ON", { name: esc(actor.name), enemy: esc(enemy) }),
                        ...(allies.length ? [s("ZEALOT_ALLIES", { names: names(allies) })] : [])],
                    ops: [setStateOp(actor, "zealotsPassion", { name: talent.name, img: "icons/svg/angel.svg", until: "combat",
                        data: { enemy, allies: [actor.uuid, ...allies.map(n => n.actor.uuid)] } })] };
                } };
        }
    },

    /* ---------------- Actions without Fate ---------------- */
    {
        // Rites of Banishment (Enemies Beyond p. 69): Half Action once a round; daemons within WPB m −10 to
        // Willpower tests until the start of her next turn (aura «rites»)
        id: "ritesOfBanishment",
        match: /^(?:ритуалы\s+изгнания|rites\s+of\s+banishment)/i,
        actions: ctx => ({ key: "chant", label: s("RITES_CHANT"), cost: 1, hint: s("RITES_HINT", { range: wpb(ctx.actor) }),
            disabled: needCombat(ctx) || (stateOf(ctx.actor, "ritesOfBanishment") ? s("ONCE_PER_ROUND") : ""),
            run: () => {
                const { actor, talent } = ctx;
                const daemons = tokensNear(actor).filter(n => n.distance <= wpb(actor) + 1e-6 && traitRating(n.actor, "daemonic", { raw: true }) > 0);
                return { lines: [s("RITES_ON", { name: esc(actor.name), range: wpb(actor) }),
                    daemons.length ? s("RITES_DAEMONS", { names: names(daemons) }) : s("RITES_NONE")],
                ops: [setStateOp(actor, "ritesOfBanishment", { name: talent.name, img: "icons/svg/aura.svg", until: "turnStart" })] };
            } })
    },
    {
        // Iron Jaw (p. 157): when stunned, a Free Action Toughness test (+0); passed, the stun ends. A button card
        // when the stun is applied, and the Talents menu
        id: "ironJaw",
        match: /^(?:железная\s+челюсть|iron\s+jaw)/i,
        offer: { status: "stunned", action: "shake" },
        actions: ({ actor, talent }) => ({ key: "shake", label: s("IRON_JAW"), hint: s("IRON_JAW_HINT"),
            disabled: actor.statuses?.has("stunned") ? "" : s("NOT_STUNNED"),
            run: () => {
                talentTest(actor, "toughness", { name: `${talent.name}: ${s("IRON_JAW")}`, talent: "ironJaw", action: "shake" });
                return null;
            } }),
        onResult: ({ actor, success }) => (success && actor.statuses.has("stunned")
            ? { lines: [s("IRON_JAW_DONE", { name: esc(actor.name) })], ops: [{ type: "status", uuid: actor.uuid, id: "stunned", active: false }] }
            : null)
    },

    /* ---------------- Untouchable auras (holders) ---------------- */
    // Soulless Aura (p. 114): hostile characters within WPB m −10 to Charm and Deceive
    { id: "soullessAura", match: /^(?:аура\s+бездушия|soulless\s+aura|aura\s+of\s+soullessness)/i },
    // Warp Disruption (p. 115): psykers within WPB m psy rating −1 (0: no powers); Warp Anathema (p. 114): −2,
    // one more per further purchase; Warp Curse (p. 114): radius WPB × 2 m (psychic.js registerPsyRatingSource)
    { id: "warpDisruption", match: /^(?:разрушение\s+варпа|warp\s+disruption)/i },
    { id: "warpAnathema", match: /^(?:анафема\s+варпа|warp\s+anathema)/i },
    { id: "warpCurse", match: /^(?:проклятие\s+варпа|warp\s+curse)/i },
    // Null Field (p. 114): everyone within WPB m has Psychic Nullification (talents/tests.js «psychicNullification»)
    { id: "nullField", match: /^(?:нуль-?\s*поле|null\s+field)/i },
    // Daemonic Scourge (p. 114): Warp-unstable creatures within WPB m − WPB × 5 to their Warp Instability tests
    { id: "daemonScourge", match: /^(?:бич\s+демонов|scourge\s+of\s+daemons|daemon(?:ic)?\s+scourge)/i },
    // Daemonic Anathema (p. 114): Daemonic creatures within WPB m get nothing from the trait (traits.js filter)
    { id: "daemonicAnathema", match: /^(?:анафема\s+демонов|daemonic\s+anathema)/i },
    {
        // Daemonic Disruption (Enemies Beyond p. 69): a Warp-unstable creature making an attack test against him
        // tests Warp Instability after the attack (a button on the attack card)
        id: "daemonicDisruption",
        match: /^(?:разрушение\s+демонов|daemonic\s+disruption)/i,
        against: ({ actor }) => (hasWarpInstability(actor) ? { text: t("WARP_INSTABILITY_AFTER"),
            apply: rd => { rd.talentButtons = [{ uuid: actor.uuid, talent: "warpInstabilityTest", action: "test", label: s("WARP_INSTABILITY_TEST") }]; } }
            : null)
    },

    /* ---------------- Aura effects (granted, never on a sheet) ---------------- */
    {
        id: "soullessAuraEffect",
        match: NEVER,
        test: ({ skill }) => (skill === "charm" || skill === "deceive" ? { modifier: -10, text: "-10" } : null)
    },
    {
        id: "warpDisruptionEffect",
        match: NEVER,
        test: ({ actor, kind }) => {
            const reduce = kind === "psychic" ? warpReduction(actor) : 0;
            return reduce ? { text: t("PSY_RATING", { value: -reduce }) } : null;
        }
    },
    {
        id: "daemonScourgeEffect",
        match: NEVER,
        test: ({ actor, rollData }) => {
            if (!rollData.warpInstability) return null;
            const modifier = -5 * Math.max(0, ...aurasAround(actor, "daemonScourge").map(a => wpb(a.holder)));
            return modifier ? { modifier, text: signed(modifier) } : null;
        }
    },
    {
        id: "daemonicAnathemaEffect",
        match: NEVER,
        defence: () => ({ text: t("DAEMONIC_IGNORED") })
    },
    {
        id: "ritesAuraEffect",
        match: NEVER,
        test: ({ rollData }) => (willpowerTest(rollData) ? { modifier: -10, text: "-10" } : null)
    },
    {
        // Warp Instability (trait, p. 163): Willpower test; failed, 1 damage + 1 per degree of failure, banished
        // when the damage reaches the wounds. Granted to Warp-unstable creatures for the menu and the buttons
        id: "warpInstabilityTest",
        match: NEVER,
        actions: ({ actor }) => ({ key: "test", label: s("WARP_INSTABILITY_TEST"), hint: s("WARP_INSTABILITY_HINT"),
            run: () => {
                talentTest(actor, "willpower", { name: s("WARP_INSTABILITY_TEST"), talent: "warpInstabilityTest", action: "test",
                    extra: { warpInstability: true } });
                return null;
            } }),
        onResult: async ({ actor, success, rollData }) => {
            const name = esc(actor.name);
            if (success) return { title: s("WARP_INSTABILITY"), lines: [s("WARP_INSTABILITY_HOLDS", { name })] };
            const damage = 1 + (Number(rollData.dof) || 0);
            const max = Number(actor.system.wounds?.max) || 0;
            const value = Math.min(max, (Number(actor.system.wounds?.value) || 0) + damage);
            if (actor.isOwner) await actor.update({ "system.wounds.value": value });
            return { title: s("WARP_INSTABILITY"), lines: [s("WARP_INSTABILITY_DAMAGE", { name, damage }),
                ...(value >= max ? [s("WARP_INSTABILITY_BANISHED", { name })] : [])] };
        }
    }
];

export default DEFS;

/* -------------------------------------------- */
/*  Auras                                       */
/* -------------------------------------------- */

const DEF = id => DEFS.find(d => d.id === id);
const daemonic = actor => traitRating(actor, "daemonic", { raw: true }) > 0;

/** Auras: holder talents (or a holder state), the definition granted in range, radius, who is affected. */
const AURAS = {
    soullessAura: { talents: ["soullessAura"], grant: "soullessAuraEffect", radius: h => wpb(h),
        affects: (actor, n) => hostile(n.self, n.token) },
    warpDisruption: { talents: ["warpDisruption", "warpAnathema", "warpCurse"], grant: "warpDisruptionEffect",
        radius: (h, has) => wpb(h) * (has.warpCurse ? 2 : 1), affects: actor => Number(actor.system.psy?.rating) > 0 },
    nullField: { talents: ["nullField"], grant: "psychicNullification", radius: h => wpb(h), affects: () => true },
    daemonScourge: { talents: ["daemonScourge"], grant: "daemonScourgeEffect", radius: h => wpb(h), affects: actor => hasWarpInstability(actor) },
    daemonicAnathema: { talents: ["daemonicAnathema"], grant: "daemonicAnathemaEffect", radius: h => wpb(h), affects: daemonic },
    rites: { state: "ritesOfBanishment", grant: "ritesAuraEffect", radius: h => wpb(h), affects: daemonic }
};
const HOLDER_IDS = [...new Set(Object.values(AURAS).flatMap(a => a.talents ?? []))];

/**
 * Aura talents on the holder's own sheet (not granted ones: no recursion through the grants).
 * @param {Actor} holder
 * @returns {{ranks: object, names: object}}
 */
function holderTalents(holder) {
    const out = { ranks: {}, names: {} };
    for (const item of holder.items) {
        if (item.type !== "talent") continue;
        const name = item.name.trim();
        const id = HOLDER_IDS.find(i => DEF(i).match.test(name));
        if (!id) continue;
        out.ranks[id] = (out.ranks[id] ?? 0) + 1;
        out.names[id] ??= name;
    }
    return out;
}

/**
 * Holders of an aura whose range covers the actor.
 * @param {Actor} actor
 * @param {string} key AURAS key
 * @param {object[]} [near] tokensNear(actor)
 * @returns {{holder: Actor, token: Token, name: string, has: object, distance: number}[]}
 */
export function aurasAround(actor, key, near = tokensNear(actor)) {
    const aura = AURAS[key];
    const out = [];
    for (const n of near) {
        let name = "";
        let has = {};
        if (aura.state) {
            const state = stateOf(n.actor, aura.state);
            if (!state) continue;
            name = state.name;
        } else {
            const own = holderTalents(n.actor);
            const id = aura.talents.find(i => own.ranks[i]);
            if (!id) continue;
            name = own.names[id];
            has = own.ranks;
        }
        if (n.distance > aura.radius(n.actor, has) + 1e-6 || !aura.affects(actor, n)) continue;
        out.push({ holder: n.actor, token: n.token, name, has, distance: n.distance });
    }
    return out;
}

/**
 * Psy rating reduction of the Warp Disruption auras around a psyker (the largest).
 * @param {Actor} actor
 * @returns {number}
 */
function warpReduction(actor) {
    return Math.max(0, ...aurasAround(actor, "warpDisruption").map(a => (a.has.warpAnathema ? 1 + a.has.warpAnathema : 1)));
}

/**
 * Talents granted to an actor by auras and states around him (talents.js registerTalentGrants).
 * @param {Actor} actor
 * @returns {{id: string, name: string, spec?: string}[]}
 */
export function auraGrants(actor) {
    if (!actor) return [];
    const out = [];
    if (hasWarpInstability(actor)) out.push({ id: "warpInstabilityTest", name: s("WARP_INSTABILITY") });
    // Zealot's Passion: Hatred for her and the allies she named
    const zealots = [actor, ...(canvas?.ready ? canvas.tokens.placeables.map(tk => tk.actor).filter(a => a && a !== actor) : [])];
    for (const holder of zealots) {
        const state = stateOf(holder, "zealotsPassion");
        if (state?.data?.allies?.includes(actor.uuid)) out.push({ id: "hatred", name: state.name, spec: state.data.enemy });
    }
    const near = tokensNear(actor);
    if (!near.length) return out;
    for (const [key, aura] of Object.entries(AURAS)) {
        const found = aurasAround(actor, key, near)[0];
        if (found) out.push({ id: aura.grant, name: s("AURA_NAME", { talent: found.name, name: found.token.name }) });
    }
    return out;
}

/**
 * Psy rating changes of the focus power dialog (psychic.js registerPsyRatingSource).
 * @param {Actor} actor
 * @returns {object[]}
 */
export function psyRatingChanges(actor) {
    const out = [];
    if (stateOf(actor, "frenzy")) out.push({ note: s("FRENZY_NO_PSY") });
    for (const a of aurasAround(actor, "warpDisruption")) {
        const reduce = a.has.warpAnathema ? 1 + a.has.warpAnathema : 1;
        out.push({ reduce, note: s("PSY_REDUCED", { talent: a.name, name: a.token.name, value: reduce }) });
    }
    return out;
}

/**
 * Trait rating filter (traits.js registerTraitFilter): Daemonic Anathema takes the Daemonic trait away.
 * @param {Actor} actor
 * @param {string} key
 * @param {number} rating
 * @returns {number}
 */
export function traitFilter(actor, key, rating) {
    if (key !== "daemonic" || !canvas?.ready) return rating;
    return aurasAround(actor, "daemonicAnathema").length ? 0 : rating;
}
