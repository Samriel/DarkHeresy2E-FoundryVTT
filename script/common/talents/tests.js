/**
 * Talents of tests: fear, pinning, psychic powers, skills, initiative (core rulebook chapter IV, Enemies Within,
 * Without and Beyond; Russian editions).
 *
 * Talents that act through other characters (Into the Jaws of Hell, Penitent Psyker) are granted to allies
 * whose token stands within 10 m of a token with the talent; Psychic Null grants Deny the Witch.
 */
import { signed, tokenOf, registerTalentGrants } from "../talents.js";
import { tokenDistance } from "../situational.js";
import { traitRating } from "../traits.js";
import { requestDamage } from "../damage.js";
import { updateMessage } from "../fate.js";

const t = (key, data) => game.i18n.format(`TALENTS.EFFECT.${key}`, data);
const NEVER = /(?!)/; // definitions only granted, never on a sheet

const isFearOrPinning = rd => Boolean(rd.flags?.isFear || (rd.pinning && !rd.pinning.recover));
// A test against a focus power: the opposed test or an evasion of a psychic attack
const againstPower = rd => Boolean(rd.opposedTo || (rd.flags?.isEvasion && rd.powerUuid));
const isDouble = n => n === 100 || (n > 0 && n < 100 && n % 11 === 0);
const plainTest = rd => !(rd.flags?.isAttack || rd.flags?.isEvasion || rd.flags?.isFear || rd.pinning || rd.opposedTo);
const characteristicKey = { WS: "weaponSkill", BS: "ballisticSkill", S: "strength", T: "toughness", Ag: "agility",
    Int: "intelligence", Per: "perception", WP: "willpower", Fel: "fellowship", Inf: "influence" };

/**
 * The actor's talent item matching a name (grants are not looked at: used by the grant source itself).
 * @param {Actor} actor
 * @param {RegExp} re
 * @returns {Item|undefined}
 */
const itemTalent = (actor, re) => actor?.items?.find(i => i.type === "talent" && re.test(i.name.trim()));

/**
 * Friendly tokens with a talent within some metres of the actor's token, closest first.
 * @param {Actor} actor
 * @param {RegExp} re talent name
 * @param {number} metres
 * @param {boolean} [self] the actor's own token counts
 * @returns {Token[]}
 */
function nearbyWith(actor, re, metres, self = false) {
    const token = tokenOf(actor);
    if (!token) return [];
    return canvas.tokens.placeables
        .filter(o => o.actor && (self ? true : o !== token && o.actor !== actor) && itemTalent(o.actor, re)
            && o.document.disposition === token.document.disposition)
        .map(o => ({ o, d: o === token ? 0 : tokenDistance(token, o) }))
        .filter(x => x.d <= metres + 1e-6)
        .sort((a, b) => a.d - b.d)
        .map(x => x.o);
}

/**
 * Degrees of failure less by a value; none left: passed with one degree of success.
 * @param {object} rollData
 * @param {number} value
 * @returns {string} card text
 */
function reduceFailure(rollData, value) {
    const left = (Number(rollData.dof) || 0) - value;
    if (left > 0) {
        rollData.dof = left;
        return t("DOF_REDUCED", { value });
    }
    rollData.flags.isSuccess = true;
    rollData.dof = 0;
    rollData.dos = 1;
    return t("PASSED", { value });
}

/**
 * Discipline of a psychic power from the head line of its description («Телепатия · …»), or null.
 * @param {Item|null} power
 * @returns {string|null}
 */
function powerDiscipline(power) {
    return String(power?.system?.description ?? "").match(/^\s*<p><em>([^<·]+)/)?.[1]?.trim() || null;
}
const powerOf = rd => (rd.powerUuid ? fromUuidSync(rd.powerUuid) : null);

/**
 * The daemon whose fear the test answers: the fear card's source token, or the single target.
 * @param {object} ctx talent context
 * @returns {TokenDocument|null}
 */
function daemonSource({ rollData, target }) {
    const fear = rollData.fear;
    const doc = fear?.tokenId ? game.scenes.get(fear.sceneId)?.tokens.get(fear.tokenId) : target?.document;
    return doc?.actor && traitRating(doc.actor, "daemonic") > 0 ? doc : null;
}

/**
 * Add Fatigue or Corruption to an actor the user owns (others: the card tells the GM).
 * @param {Actor} actor
 * @param {string} path system field
 * @param {number} n
 */
function addPoints(actor, path, n) {
    if (actor?.isOwner) actor.update({ [`system.${path}`]: (Number(foundry.utils.getProperty(actor.system, path)) || 0) + n });
}

// Skills by their Russian name (talent specialisations); English names are compared with the sheet labels
const SKILL_NAMES = [
    ["acrobatics", /^акробатик/], ["athletics", /^атлетик/], ["awareness", /^бдительн/], ["security", /^безопасн/],
    ["survival", /^выживани/], ["inquiry", /^дознани/], ["interrogation", /^допрос/], ["forbiddenLore", /^запретн/],
    ["intimidate", /^запугивани/], ["command", /^командовани/], ["commerce", /^коммерц/], ["linguistics", /^лингвистик/],
    ["sleightOfHand", /^ловкост[ьи]\s+рук/], ["logic", /^логик/], ["medicae", /^медик/], ["navigate", /^навигаци/],
    ["charm", /^обаяни/], ["deceive", /^обман/], ["commonLore", /^общи[а-я]*\s+знани/], ["parry", /^парировани/],
    ["scrutiny", /^проницательн/], ["psyniscience", /^психонаук/], ["trade", /^ремесл/], ["stealth", /^скрытн/],
    ["techUse", /^техпользовани/], ["dodge", /^уклонени/], ["operate", /^управлени/], ["scholasticLore", /^уч[её]н[а-я]*\s+знани/]
];

/**
 * Skill key of a talent specialisation («Уклонение», «Общие знания (Империум», «Dodge»).
 * @param {Actor} actor
 * @param {string} spec
 * @returns {string|null}
 */
function skillOfSpec(actor, spec) {
    const name = String(spec ?? "").toLowerCase().replace(/ё/g, "е").trim();
    if (!name) return null;
    const ru = SKILL_NAMES.find(([, re]) => re.test(name))?.[0];
    if (ru) return ru;
    return Object.entries(actor.skills ?? {}).find(([, skill]) => {
        const label = game.i18n.localize(skill.label ?? "").toLowerCase();
        return label && name.startsWith(label);
    })?.[0] ?? null;
}

/**
 * Does the test use Fellowship or Influence (Peer, Enemy)? Characteristic tests and skills based on Fellowship.
 * @param {object} ctx talent context
 * @returns {boolean}
 */
function fellowshipTest({ actor, rollData, skill, characteristic }) {
    if (!plainTest(rollData)) return false;
    if (["fellowship", "influence"].includes(characteristic)) return true;
    const data = skill ? actor.skills?.[skill] : null;
    return (data?.defaultCharacteristic || data?.characteristics?.[0]) === "Fel";
}

const INTERACTION = ["charm", "command", "commerce", "deceive", "inquiry", "interrogation", "intimidate", "scrutiny"];

const JAWS = /^(?:к\s+демону\s+в\s+пасть|into\s+the\s+jaws\s+of\s+hell)/i;
const PENITENT = /^(?:кающ[еи]йся\s+псайкер|penitent\s+psyker)/i;
const DENY = /^(?:отринь\s+ведьмовство|deny\s+the\s+witch)/i;
const PSYCHIC_NULL = /^(?:психическое\s+обнуление|psychic\s+null)/i;

// Allies near an Inquisitor with Into the Jaws of Hell or a Penitent Psyker; Psychic Null gives Deny the Witch
registerTalentGrants(actor => {
    const out = [];
    if (!canvas?.ready) return out;
    const fel = o => Number(o.actor.characteristics?.fellowship?.bonus) || 0;
    const jaws = nearbyWith(actor, JAWS, 10).sort((a, b) => fel(b) - fel(a))[0];
    if (jaws) out.push({ id: "intoTheJawsAlly", name: `${itemTalent(jaws.actor, JAWS).name} (${jaws.name})`, bonus: fel(jaws) });
    const penitent = nearbyWith(actor, PENITENT, 10, true)[0];
    if (penitent) {
        out.push({ id: "penitentPsykerAlly", name: `${itemTalent(penitent.actor, PENITENT).name} (${penitent.name})`,
            uuid: penitent.actor.uuid, tokenName: penitent.name });
    }
    const nul = itemTalent(actor, PSYCHIC_NULL);
    if (nul && !itemTalent(actor, DENY)) out.push({ id: "denyTheWitch", name: nul.name });
    return out;
});

export default [
    {
        // Resistance (p. 164): +10 to tests resisting the chosen effect; Fear and psychic powers apply
        // by themselves, the others are ticked on the test
        id: "resistance",
        match: /^(?:сопротивление|resistance)(?![\p{L}])/iu,
        test: ({ rollData, talent }) => {
            const spec = talent.spec;
            if (/страх|fear/i.test(spec)) return rollData.flags?.isFear ? { modifier: 10, text: "+10" } : null;
            if (/псих|psychic|psyker/i.test(spec)) return rollData.opposedTo ? { modifier: 10, text: "+10" } : null;
            if (rollData.flags?.isAttack || rollData.flags?.isEvasion || rollData.flags?.isFear || rollData.pinning) return null;
            return { toggle: true, modifier: 10, text: t("RESISTANCE", { what: spec || "?" }) };
        }
    },
    {
        // Strong Minded (p. 161): re-roll a failed Willpower test resisting a psychic power
        id: "strongMinded",
        match: /^(?:непреклонный|strong[-\s]?minded)/i,
        reroll: ({ rollData }) => (rollData.opposedTo && rollData.characteristicKey === "willpower" ? { text: "" } : null)
    },
    {
        // Keen Intuition (p. 165): re-roll a failed Awareness test at −10
        id: "keenIntuition",
        match: /^(?:чуткая\s+интуиция|keen\s+intuition)/i,
        reroll: ({ skill }) => (skill === "awareness" ? { modifier: -10, text: "-10" } : null)
    },
    {
        // Unshakeable Faith (p. 161): degrees of failure on a Fear or pinning test − Willpower bonus;
        // none left: passed with one degree of success
        id: "unshakeableFaith",
        match: /^(?:несокрушимая\s+вера|unshakeable\s+faith)/i,
        after: ({ rollData, bonus }) => {
            if (rollData.flags.isSuccess || !(rollData.flags?.isFear || (rollData.pinning && !rollData.pinning.recover))) return null;
            const wp = bonus("willpower");
            const left = (Number(rollData.dof) || 0) - wp;
            if (left > 0) {
                rollData.dof = left;
                return t("DOF_REDUCED", { value: wp });
            }
            rollData.flags.isSuccess = true;
            rollData.dof = 0;
            rollData.dos = 1;
            return t("PASSED", { value: wp });
        }
    },

    /* Fear and pinning */
    {
        // Jaded (p. 157): mundane horrors need no Fear test and give no Insanity; a Fear test from a source
        // that is not of the Warp is ticked (the Warp and daemons frighten as before)
        id: "jaded",
        match: /^(?:искуш[её]нный|jaded)/i,
        test: ({ rollData }) => (rollData.flags?.isFear && !rollData.fear?.warp
            ? { toggle: true, checked: Boolean(rollData.fear), force: { success: true, dos: 1 }, text: t("JADED") } : null)
    },
    {
        // Iron Resolve (Enemies Beyond p. 68): re-roll a failed Fear or pinning test at −10
        id: "ironResolve",
        match: /^(?:железная\s+решимость|iron\s+resolve)/i,
        reroll: ({ rollData }) => (rollData.flags?.isFear || rollData.pinning ? { modifier: -10, text: "-10" } : null)
    },
    {
        // Into the Jaws of Hell (Enemies Within p. 65): the Inquisitor's allies within 10 m (granted above)
        id: "intoTheJaws",
        match: JAWS
    },
    {
        // Into the Jaws of Hell, ally side: ticked when the Inquisitor passed his own test; degrees of failure
        // of a Fear or pinning test − his Fellowship bonus, none left: passed with one degree
        id: "intoTheJawsAlly",
        match: NEVER,
        test: ({ rollData, talent }) => (isFearOrPinning(rollData)
            ? { toggle: true, text: t("JAWS", { value: talent.grant.bonus }), apply: rd => { rd.intoTheJaws = talent.grant.bonus; } } : null),
        after: ({ rollData }) => (rollData.intoTheJaws && !rollData.flags.isSuccess ? reduceFailure(rollData, rollData.intoTheJaws) : null)
    },
    {
        // Bulwark of Faith (Enemies Beyond p. 69): a passed Fear test caused by a daemon deals it 1 energy damage
        // per degree of success, ignoring armour and toughness (button on the card)
        id: "bulwarkOfFaith",
        match: /^(?:оплот\s+веры|bulwark\s+of\s+faith)/i,
        action: ctx => {
            const doc = ctx.rollData.flags?.isFear && ctx.rollData.flags.isSuccess ? daemonSource(ctx) : null;
            if (!doc) return null;
            const dos = Number(ctx.rollData.dos) || 1;
            return { text: t("BULWARK", { value: dos, name: doc.name }), data: { sceneId: doc.parent?.id, tokenId: doc.id, dos } };
        },
        onAction: async ({ action }) => {
            const doc = game.scenes.get(action.data.sceneId)?.tokens.get(action.data.tokenId);
            if (!doc?.actor) return null;
            await requestDamage(doc.actor, doc, [{ amount: action.data.dos, location: "ARMOUR.BODY", penetration: 0, type: "E" }],
                { direct: true }, action.name);
            return null;
        }
    },

    /* Psychic powers */
    {
        // Bastion of Iron Will (p. 148): + 5 × psy rating to opposed tests against psychic powers
        id: "bastionOfIronWill",
        match: /^(?:бастион\s+железной\s+воли|bastion\s+of\s+iron\s+will)/i,
        test: ({ rollData, actor }) => {
            const value = 5 * (Number(actor.system.psy?.rating) || 0);
            return rollData.opposedTo && value ? { modifier: value, text: signed(value) } : null;
        }
    },
    {
        // Psychic Null (p. 114): Deny the Witch (granted above); +20, +5 per further time taken, to opposed
        // tests against psychic powers and to evading psychic attacks (Dodge or Deny the Witch, not Parry)
        id: "psychicNull",
        match: PSYCHIC_NULL,
        test: ({ rollData, talent }) => {
            const value = 20 + 5 * (talent.rank - 1);
            if (rollData.flags?.isEvasion && rollData.evasions?.selected === "parry") return null;
            return againstPower(rollData) ? { modifier: value, text: signed(value) } : null;
        }
    },
    {
        // Deny the Witch (p. 162): Willpower evasion against psychic attacks; the option is offered only with
        // the talent and only against a focus power (chat.js)
        id: "denyTheWitch",
        match: DENY,
        test: ({ rollData }) => (rollData.flags?.isEvasion && rollData.evasions?.selected === "deny" ? { text: t("DENY_THE_WITCH") } : null)
    },
    {
        // Shield of Faith (Enemies Within p. 41): Deny the Witch against a power, Fate point: passed with degrees of
        // success equal to the Willpower bonus; the psyker then tests Fear (1) (button on the card)
        id: "shieldOfFaith",
        match: /^(?:щит\s+веры|shield\s+of\s+faith)/i,
        test: ({ rollData, bonus }) => {
            if (!(rollData.flags?.isEvasion && rollData.powerUuid && rollData.evasions?.selected === "deny")) return null;
            const dos = Math.max(1, bonus("willpower"));
            return { toggle: true, fate: 1, force: { success: true, dos }, text: t("SHIELD_OF_FAITH", { value: dos }),
                apply: rd => { rd.shieldOfFaith = true; } };
        },
        action: ({ rollData, attacker }) => (rollData.shieldOfFaith && attacker
            ? { text: t("SHIELD_FEAR", { name: attacker.name }), ownerUuid: attacker.uuid } : null),
        onAction: ({ actor, owner }) => {
            const rollData = game.darkHeresy.util.createFearTestRolldata(owner);
            rollData.name = game.i18n.format("FEAR.TEST_NAME", { name: actor.name, rating: 1 });
            rollData.fear = { rating: 1, combat: Boolean(game.combat?.started), warp: false };
            game.darkHeresy.testInit.prepareCommonRoll(rollData);
            return null;
        }
    },
    {
        // Penitent Psyker (Enemies Within p. 66): the psyker himself and allies within 10 m (granted above)
        id: "penitentPsyker",
        match: PENITENT
    },
    {
        // Penitent Psyker, target side: the psyker takes Fatigue levels for +10 each to the opposed test or the
        // evasion against a power; a double on that test causes psychic phenomena for the psyker (button)
        id: "penitentPsykerAlly",
        match: NEVER,
        test: ({ rollData, talent }) => {
            if (!againstPower(rollData)) return null;
            const { uuid, tokenName: name } = talent.grant;
            return { toggle: true, input: { min: 1, max: 10, value: 1 }, text: t("PENITENT", { name }),
                resolve: n => ({ modifier: 10 * n, text: t("PENITENT_TAKEN", { value: signed(10 * n), levels: n, name }),
                    apply: rd => {
                        rd.penitent = { uuid, name };
                        addPoints(fromUuidSync(uuid), "fatigue.value", n);
                    } }) };
        },
        after: ({ rollData }) => (rollData.penitent && isDouble(rollData.result) ? t("PENITENT_DOUBLE", { name: rollData.penitent.name }) : null),
        action: ({ rollData }) => (rollData.penitent && isDouble(rollData.result)
            ? { text: t("PENITENT_PHENOMENA", { name: rollData.penitent.name }), ownerUuid: rollData.penitent.uuid } : null),
        onAction: async ({ owner }) => {
            await game.darkHeresy.rollPhenomena(owner, { psykerClass: owner.system.psy?.class ?? "bound" });
            return null;
        }
    },
    {
        // Daemonologist (Enemies Beyond p. 68): +10 to Focus Power against a daemon; ticked when the target is Daemonic
        id: "daemonologist",
        match: /^(?:демонолог(?![\p{L}])|daemonologist)/iu,
        test: ({ kind, targetActor }) => (kind === "psychic"
            ? { toggle: true, checked: Boolean(targetActor && traitRating(targetActor, "daemonic") > 0), modifier: 10, text: t("DAEMON_TARGET") }
            : null)
    },
    {
        // Master Telepath (Enemies Beyond p. 38): Fate point before a Telepathy or Astropath power: psy rating
        // + half the Willpower bonus (rounded down) for this test (offered when the discipline is unknown)
        id: "masterTelepath",
        match: /^(?:высший\s+телепат|master\s+telepath|telepathic\s+mastery)/i,
        test: ({ kind, rollData, bonus }) => {
            const discipline = kind === "psychic" ? powerDiscipline(powerOf(rollData)) : "";
            const value = Math.floor(bonus("willpower") / 2);
            if (discipline === "" || (discipline && !/телепат|telepath|астропат|astropath/i.test(discipline)) || !value) return null;
            return { toggle: true, fate: 1, text: t("PSY_RATING", { value: signed(value) }),
                apply: rd => {
                    rd.psy.rating += value;
                    rd.psy.max += value;
                    rd.psy.value += value;
                } };
        }
    },
    {
        // Tainted Psyker (Enemies Within p. 66): up to psy rating Corruption points on a Focus Power test, +10 to
        // the test and +5 to the phenomena roll for each
        id: "taintedPsyker",
        match: /^(?:порч[её]н+ый\s+псайкер|tainted\s+psyker)/i,
        test: ({ kind, actor, talent }) => {
            const max = Number(actor.system.psy?.rating) || 0;
            if (kind !== "psychic" || !max) return null;
            return { toggle: true, input: { min: 1, max, value: 1 }, text: t("TAINTED", { max }),
                resolve: n => ({ modifier: 10 * n, text: t("TAINTED_TAKEN", { value: signed(10 * n), points: n, phenomena: signed(5 * n) }),
                    apply: rd => {
                        (rd.psy.talentPhenomena ??= []).push({ label: talent.name, value: 5 * n });
                        addPoints(actor, "corruption", n);
                    } }) };
        }
    },
    {
        // Warp Conduit (p. 153): when pushing, a Fate point before the test: psy rating + 1d5 (roll.js) and +30 to
        // the phenomena roll (tables.js)
        id: "warpConduit",
        match: /^(?:варп-?\s*канал|warp\s+conduit)/i,
        test: ({ kind, rollData }) => (kind === "psychic" && Number(rollData.psy?.value) > Number(rollData.psy?.rating)
            ? { toggle: true, fate: 1, text: t("WARP_CONDUIT"), apply: rd => { rd.psy.warpConduit = true; } } : null)
    },
    {
        // Warp Lock (p. 153): once per session cancel the rolled phenomenon (perils too); 1d5 energy damage to the
        // head ignoring armour and toughness, no powers or sustaining until the end of the turn
        id: "warpLock",
        match: /^(?:варп-?\s*блок|warp\s+lock)/i,
        phenomena: () => ({ text: t("WARP_LOCK"), limit: "session" }),
        onAction: async ({ actor, action }) => {
            const roll = await new Roll("1d5").evaluate();
            await requestDamage(actor, tokenOf(actor)?.document ?? null,
                [{ amount: roll.total, location: "ARMOUR.HEAD", penetration: 0, type: "E" }], { direct: true }, action.name);
            return t("WARP_LOCK_DONE", { value: roll.total });
        }
    },
    {
        // Sanctic Purity (Enemies Beyond p. 69): Fate point: cancel phenomena of a Sanctic power (offered when the
        // discipline is unknown)
        id: "sancticPurity",
        match: /^(?:святая\s+праведность|sanctic\s+purity)/i,
        phenomena: ({ power }) => {
            const discipline = powerDiscipline(power);
            return discipline && !/санктик|sanctic/i.test(discipline) ? null : { text: t("CANCEL_PHENOMENON"), fate: 1 };
        },
        onAction: () => t("PHENOMENON_CANCELLED")
    },
    {
        // Bound to the Highest Power (Enemies Beyond p. 38): Fate point: cancel the rolled phenomenon (perils too);
        // no Focus Power or sustaining until the next turn
        id: "boundToHighestPower",
        match: /^(?:связанный\s+с\s+высшей\s+силой|bound\s+to\s+the\s+highest\s+power)/i,
        phenomena: () => ({ text: t("CANCEL_PHENOMENON"), fate: 1 }),
        onAction: () => t("BOUND_DONE")
    },
    {
        // Soul Ward (Enemies Beyond p. 38): re-roll a Willpower test forced by phenomena or perils (against mutation
        // or possession); offered after a phenomena card of the actor among the last messages
        id: "soulWard",
        match: /^(?:ограда\s+души|soul\s+ward)/i,
        reroll: ({ rollData, actor }) => {
            if (rollData.characteristicKey !== "willpower" || !plainTest(rollData)) return null;
            const recent = game.messages.contents.slice(-10)
                .some(m => m.getFlag("dark-heresy", "phenomena") && m.speaker?.actor === actor.id);
            return recent ? { text: t("SOUL_WARD") } : null;
        }
    },

    /* Social tests and skills */
    {
        // Peer (p. 163): +10 per time taken to Fellowship and Influence tests with the group
        id: "peer",
        match: /^(?:связи|peer)(?![\p{L}])/iu,
        test: ctx => (fellowshipTest(ctx)
            ? { toggle: true, modifier: 10 * ctx.talent.rank, text: t("GROUP", { value: signed(10 * ctx.talent.rank), group: ctx.talent.spec || "?" }) }
            : null)
    },
    {
        // Enemy (p. 154): −10 per time taken to Fellowship and Influence tests with the group
        id: "enemy",
        match: /^(?:враг|enemy)(?![\p{L}])/iu,
        test: ctx => (fellowshipTest(ctx)
            ? { toggle: true, modifier: -10 * ctx.talent.rank, text: t("GROUP", { value: signed(-10 * ctx.talent.rank), group: ctx.talent.spec || "?" }) }
            : null)
    },
    {
        // Ambassador Imperialis (Enemies Without p. 74): Interaction tests with xenos or non-Imperials: the penalty
        // is 20 smaller; re-roll a failed one (ticked tests only)
        id: "ambassador",
        match: /^(?:посол\s+империума|ambassador\s+imperialis)/i,
        test: ({ skill, rollData }) => {
            if (!INTERACTION.includes(skill) || !plainTest(rollData)) return null;
            const value = Math.min(20, Math.max(0, -(Number(rollData.target.modifier) || 0)));
            return { toggle: true, modifier: value, text: value ? t("AMBASSADOR_APPLIED", { value: signed(value) }) : t("AMBASSADOR"),
                apply: rd => { rd.ambassador = true; } };
        },
        reroll: ({ rollData }) => (rollData.ambassador ? { text: "" } : null)
    },
    {
        // Coordinated Interrogation (p. 164): +10 to Interrogation, +5 per other interrogator with the talent
        id: "coordinatedInterrogation",
        match: /^(?:скоординированный\s+допрос|coordinated\s+interrogation)/i,
        test: ({ skill }) => (skill === "interrogation" ? [
            { key: "base", modifier: 10, text: "+10" },
            { key: "others", toggle: true, input: { min: 1, max: 10, value: 1 }, text: t("COORDINATED"),
                resolve: n => ({ modifier: 5 * n, text: t("COORDINATED_TAKEN", { value: signed(5 * n), count: n }) }) }
        ] : null)
    },
    {
        // Clues from the Crowds (p. 163): once a day re-roll a failed test gathering information from a group (Inquiry)
        id: "cluesFromCrowds",
        match: /^(?:разговор\s+с\s+толпой|clues\s+from\s+the\s+crowds?)/i,
        reroll: ({ skill }) => (skill === "inquiry" ? { text: "", limit: "day" } : null)
    },
    {
        // Archivator (Enemies Without p. 74): Scholastic or Forbidden Lore from records (ticked): re-roll a failure at −10
        id: "archivator",
        match: /^(?:архивариус|archivator|archivist)/i,
        test: ({ skill }) => (["scholasticLore", "forbiddenLore"].includes(skill)
            ? { toggle: true, text: t("RECORDS"), apply: rd => { rd.archivator = true; } } : null),
        reroll: ({ rollData }) => (rollData.archivator ? { modifier: -10, text: "-10" } : null)
    },
    {
        // Daemonhunter (Enemies Beyond p. 68): re-roll a failed Awareness or Psyniscience test detecting daemons
        // (ticked); Proven (3) against daemons is another definition of the same talent
        id: "daemonhunterDetect",
        match: /^(?:демоноборец|daemon\s*hunter)/i,
        test: ({ skill }) => (["awareness", "psyniscience"].includes(skill)
            ? { toggle: true, text: t("DAEMON_DETECT"), apply: rd => { rd.daemonDetect = true; } } : null),
        reroll: ({ rollData }) => (rollData.daemonDetect ? { text: "" } : null)
    },
    {
        // Warp Awareness (Enemies Beyond p. 39): Psyniscience instead of Awareness (when it is higher)
        id: "warpAwareness",
        match: /^(?:варп-?\s*бдительность|warp\s+awareness)/i,
        test: ({ skill, rollData, actor }) => {
            const value = Number(actor.skills?.psyniscience?.total) || 0;
            return skill === "awareness" && value > (Number(rollData.target.base) || 0)
                ? { target: value, text: t("WARP_AWARENESS", { value }) } : null;
        }
    },
    {
        // Blend In (p. 158): Fellowship instead of Agility for Shadowing (Stealth); ticked when Fellowship is higher
        id: "blendIn",
        match: /^(?:лицо\s+в\s+толпе|blend\s+in)/i,
        test: ({ skill, actor }) => {
            if (skill !== "stealth") return null;
            const value = (Number(actor.characteristics.fellowship?.total) || 0) + (Number(actor.skills.stealth?.advance) || 0);
            return { toggle: true, checked: actor.characteristics.fellowship.total > actor.characteristics.agility.total,
                target: value, text: t("BLEND_IN", { value }) };
        }
    },
    {
        // Mastery (p. 159): Fate point: a test of the chosen skill at +0 or easier passes with degrees of success
        // equal to the skill's characteristic bonus (every speciality of a specialist skill)
        id: "mastery",
        match: /^(?:мастерство|mastery)\s*\(/i,
        test: ({ actor, skill, rollData, talent }) => {
            const used = rollData.flags?.isEvasion ? rollData.evasions?.selected : skill;
            const key = skillOfSpec(actor, talent.spec);
            if (!key || key !== used || (Number(rollData.target.modifier) || 0) < 0) return null;
            const short = actor.skills[key]?.characteristics?.[0];
            const dos = Math.max(1, Number(actor.characteristics[characteristicKey[short]]?.bonus) || 1);
            return { toggle: true, fate: 1, force: { success: true, dos }, text: t("MASTERY", { value: dos }) };
        }
    },
    {
        // Inquisitor's Will (p. 109): Fate point before the d100: it counts as 01
        id: "inquisitorsWill",
        match: /^(?:воля\s+инквизитора|inquisitor'?s\s+will)/i,
        test: () => ({ toggle: true, fate: 1, force: { result: 1 }, text: t("RESULT_01") })
    },
    {
        // Master Chirurgeon (p. 162): +20 to Medicae; first aid ignores the Heavily Wounded penalty and has only −10
        // for Critical damage (medicae.js)
        id: "masterChirurgeon",
        match: /^(?:превосходный\s+хирургеон|master\s+chirurgeon)/i,
        test: ({ skill, rollData }) => {
            if (skill !== "medicae") return null;
            const aid = rollData.firstAid;
            const penalty = -(Number(aid?.penalty) || 0);
            const relief = aid?.state === "heavy" ? penalty : aid?.state === "critical" ? Math.max(0, penalty - 10) : 0;
            return { modifier: 20 + relief, text: relief ? t("CHIRURGEON", { relief: signed(relief) }) : "+20" };
        }
    },
    {
        // Bulging Biceps (p. 158): +20 to Heft (Athletics; ticked). Firing heavy weapons unbraced has no penalty
        // in this system, so there is nothing to cancel
        id: "bulgingBiceps",
        match: /^(?:крепкие\s+бицепсы|bulging\s+biceps)/i,
        test: ({ skill }) => (skill === "athletics" ? { toggle: true, modifier: 20, text: t("HEFT") } : null)
    },
    {
        // Push the Limit (Enemies Without p. 76): once per round +20 to Operate (Survival with a living mount);
        // failing by 4+ degrees: roll on the chassis / leg critical table (reminder on the card)
        id: "pushTheLimit",
        match: /^(?:до\s+предела|push\s+the\s+limit)/i,
        test: ({ skill }) => (["operate", "survival"].includes(skill)
            ? { toggle: true, limit: "round", modifier: 20, text: t("PUSH_LIMIT"), apply: rd => { rd.pushTheLimit = true; } } : null),
        after: ({ rollData }) => (rollData.pushTheLimit && !rollData.flags.isSuccess && rollData.dof >= 4 ? t("PUSH_LIMIT_CRIT") : null)
    },
    {
        // Hotshot Pilot (Enemies Without p. 75): after an Operate test, 1 level of Fatigue for + half the Agility
        // bonus degrees of success, or degrees of failure − the Agility bonus (minimum 1) (button on the card)
        id: "hotshotPilot",
        match: /^(?:бесстрашный\s+пилот|hotshot\s+pilot)/i,
        action: ({ skill, rollData, bonus }) => {
            if (skill !== "operate") return null;
            const value = rollData.flags.isSuccess ? Math.floor(bonus("agility") / 2) : bonus("agility");
            if (!value || (!rollData.flags.isSuccess && rollData.dof <= 1)) return null;
            return { text: t(rollData.flags.isSuccess ? "HOTSHOT_DOS" : "HOTSHOT_DOF", { value }), data: { value } };
        },
        onAction: async ({ actor, action, message, rollData }) => {
            if (!rollData) return null;
            const value = action.data.value;
            if (rollData.flags.isSuccess) rollData.dos += value;
            else rollData.dof = Math.max(1, rollData.dof - value);
            (rollData.talents ??= []).push({ name: action.name, text: action.text });
            delete rollData.talentActions;
            addPoints(actor, "fatigue.value", 1);
            const content = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/roll.hbs", rollData);
            await updateMessage(message, { content, "flags.dark-heresy.rollData": rollData });
            return null;
        }
    },
    {
        // Constant Vigilance (p. 151): initiative with Intelligence or Perception (the specialisation) instead of
        // Agility, two dice and the better one
        id: "constantVigilance",
        match: /^(?:постоянная\s+бдительность|constant\s+vigilance)/i,
        initiative: ({ actor, talent, bonus }) => {
            const key = /инт|int/i.test(talent.spec) ? "intelligence" : /восп|per/i.test(talent.spec) ? "perception" : null;
            if (!key) return null;
            const value = Math.max(bonus(key), Number(actor.system.initiative?.bonus) || 0);
            const dice = String(actor.system.initiative?.base || "1d10").replace(/^\s*1?d(\d+)\s*$/i, "2d$1kh");
            return { formula: `${dice} + ${value}`,
                text: t("INITIATIVE", { characteristic: game.i18n.localize(actor.characteristics[key].label), value }) };
        }
    },
    {
        // Contact Network (p. 163): Fellowship instead of Influence for requisition (requisition.js)
        id: "contactNetwork",
        match: /^(?:сеть\s+контактов|contact\s+network)/i
    }
];
