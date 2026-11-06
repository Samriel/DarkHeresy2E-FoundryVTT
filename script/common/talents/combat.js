/**
 * Talents of attacks and damage (core rulebook chapter IV, Russian edition page numbers; EW — Enemies Within,
 * EWo — Enemies Without, EB — Enemies Beyond).
 * Also applied elsewhere: Swift and Lightning Attack unlock their attack types (dialog.js), Grenadier and Divine
 * Protection (area.js), Weapon Training, Two-Weapon Wielder / Master, Ambidextrous (weapons.js, two-weapon.js).
 */
import { signed, hasTalent } from "../talents.js";
import { recordOfActor } from "../conditions.js";
import { traitRating } from "../traits.js";
import { parseQualities, qualityValue } from "../qualities.js";
import { isTrained } from "../weapons.js";
import { tokenDistance } from "../situational.js";

const halfUp = n => Math.ceil(n / 2);
const t = (key, data) => game.i18n.format(`TALENTS.EFFECT.${key}`, data);

const MELEE_SPEC = /(?:рукоп|ближн|melee|weapon\s*skill)/i;
const RANGED_SPEC = /(?:стрел|дальн|ranged|ballistic)/i;
const UNARMED = /(?:безоружн|unarmed)/i;
const SUPPRESSING = ["suppress_semi", "suppress_full"];
const TECH_WEAPONS = ["plasma", "power", "exotic", "melta"];
const OUT = ["dead", "unconscious"];
// Bladed weapons for Blademaster: chain weapons and blades or axes by name
const BLADE = /(?:меч|клин|нож|кинжал|топор|секир|сабл|тесак|шпаг|рапир|катан|chain|цепн|sword|blade|knife|dagger|axe|sabre|saber|cleaver|rapier|katana)/i;
const SHIELD = /(?:щит|shield|defensive|защитн)/i;

/** Does a talent's specialisation (Melee / Ranged) fit the weapon? No specialisation fits both. */
const specFits = (spec, weapon) => !String(spec ?? "").trim() || (weapon?.isMelee ? MELEE_SPEC : RANGED_SPEC).test(spec);

/** A part of the situational modifiers (situational.js) of a single-target attack; 0 under suppressing fire. */
const part = (rollData, key) => (SUPPRESSING.includes(rollData.attackType?.name) ? 0 : rollData.situationalParts?.[key]);

const isDaemon = actor => Boolean(actor) && traitRating(actor, "daemonic") > 0;
const sameGroup = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/**
 * One on one: no other standing token next to the attacker or his target.
 * @param {Token|null} token
 * @param {Token|null} target
 * @returns {boolean}
 */
function alone(token, target) {
    if (!token || !target || !canvas.ready) return false;
    const near = (a, b) => tokenDistance(a, b) <= canvas.dimensions.distance + 1e-6;
    return !canvas.tokens.placeables.some(o => o !== token && o !== target && !o.document.hidden
        && !OUT.some(s => o.actor?.statuses?.has(s)) && (near(o, token) || near(o, target)));
}

/**
 * Double Tap: the actor's last attack this turn was a hit with a ranged weapon on the same target.
 * @param {Actor} actor
 * @param {Token|null} target
 * @param {object} record the actor's action record (actions.js)
 * @returns {boolean}
 */
function firstShotHit(actor, target, record) {
    if (!target || !(record.attack > 0)) return false;
    const mine = r => r?.flags?.isCombatRoll && !r.flags.isEvasion && !r.flags.isDamageRoll
        && (r.actorUuid ? r.actorUuid === actor.uuid : r.ownerId === actor.id);
    const last = game.messages.contents.slice(-30).reverse().map(m => m.getFlag("dark-heresy", "rollData")).find(mine);
    return Boolean(last?.weapon?.isRange && last.flags.isSuccess && last.targetTokenId === target.id);
}

/**
 * Armour-Monger points by hit location: the talent item's flag «dark-heresy.armourMonger» {head, body…} up to
 * the Intelligence bonus; points not given to a location go to the body.
 * @param {Item|null} item
 * @param {number} points
 * @returns {object} {"ARMOUR.BODY": n…}
 */
function armourMongerSplit(item, points) {
    const chosen = item?.getFlag("dark-heresy", "armourMonger") ?? {};
    const out = {};
    let left = points;
    for (const [key, label] of Object.entries(game.darkHeresy.config.hitLocations)) {
        const n = Math.min(left, Math.max(0, Number(chosen[key]) || 0));
        if (n) out[label] = n;
        left -= n;
    }
    if (left) out["ARMOUR.BODY"] = (out["ARMOUR.BODY"] ?? 0) + left;
    return out;
}

/** Talent sheet of Armour-Monger: inputs for the points by location (saved with the sheet form). */
function armourMongerSheet(sheet, html) {
    const item = sheet.item ?? sheet.document;
    if (item?.type !== "talent" || !ARMOUR_MONGER.test(item.name)) return;
    const root = html instanceof HTMLElement ? html : html[0];
    const tab = root?.querySelector('.tab[data-tab="data"] .stats');
    if (!tab || tab.querySelector(".dh-armour-monger")) return;
    const chosen = item.getFlag("dark-heresy", "armourMonger") ?? {};
    const row = document.createElement("div");
    row.className = "stats-row dh-armour-monger";
    row.innerHTML = `<p class="hint" style="flex-basis: 100%">${game.i18n.localize("TALENTS.EFFECT.ARMOUR_HINT")}</p>`
        + Object.entries(game.darkHeresy.config.hitLocations).map(([key, label]) => `<div class="stat">
            <label>${game.i18n.localize(label)}</label>
            <input name="flags.dark-heresy.armourMonger.${key}" type="number" min="0" value="${Number(chosen[key]) || 0}" data-dtype="Number" />
        </div>`).join("");
    tab.append(row);
}

const ARMOUR_MONGER = /^(?:мастер\s+брони|armou?r[-\s]?monger)/i;

export default [
    {
        // Crushing Blow (p. 164): + half the Weapon Skill bonus (rounded up) to melee damage
        id: "crushingBlow",
        match: /^(?:сокрушительный\s+удар|crushing\s+blow)/i,
        damage: ({ weapon, rollData, bonus }) => {
            if (!weapon?.isMelee || rollData.psy?.display) return null;
            const damage = halfUp(bonus("weaponSkill"));
            return damage ? { damage, text: signed(damage) } : null;
        }
    },
    {
        // Mighty Shot (p. 159): + half the Ballistic Skill bonus (rounded up) to ranged damage
        id: "mightyShot",
        match: /^(?:мощный\s+выстрел|mighty\s+shot)/i,
        damage: ({ weapon, rollData, bonus }) => {
            if (!weapon?.isRange || rollData.psy?.display) return null;
            const damage = halfUp(bonus("ballisticSkill"));
            return damage ? { damage, text: signed(damage) } : null;
        }
    },
    {
        // Marksman (p. 159): no penalty for long or extreme range
        id: "marksman",
        match: /^(?:меткий\s+стрелок|marksman)/i,
        test: ({ kind, rollData }) => {
            const range = Number(rollData.rangeMod) || 0;
            if (kind !== "ranged" || range >= 0) return null;
            return { modifier: -range, text: t("RANGE_PENALTY", { modifier: signed(-range) }) };
        }
    },
    {
        // Hatred (p. 160): +10 to Weapon Skill tests in melee against the hated group; the ticked group is kept
        // for Furious Zeal and Purity of Hatred
        id: "hatred",
        match: /^(?:ненависть|hatred)(?![\p{L}])/iu,
        test: ({ kind, talent }) => (kind === "melee"
            ? { toggle: true, modifier: 10, text: t("HATRED", { group: talent.spec || "?" }),
                apply: rollData => { (rollData.hatred ??= []).push(talent.spec); } } : null)
    },
    {
        // Eye of Vengeance (p. 157): Fate point before a ranged Standard Attack; on a hit + degrees of
        // success to the damage and penetration of that hit
        id: "eyeOfVengeance",
        match: /^(?:глаз\s+мстителя|eye\s+of\s+vengeance)/i,
        test: ({ kind, attackType }) => (kind === "ranged" && attackType === "standard"
            ? { toggle: true, fate: 1, text: t("EYE_OF_VENGEANCE"),
                apply: rollData => { rollData.eyeOfVengeance = true; } } : null),
        damage: ({ rollData }) => {
            if (!rollData.eyeOfVengeance) return null;
            const dos = Number(rollData.attackDos) || 0;
            return { firstHit: { damage: dos, penetration: dos }, text: t("DAMAGE_AND_PEN", { value: signed(dos) }) };
        }
    },
    {
        // True Grit (p. 158): critical damage taken − Toughness bonus (minimum 1)
        id: "trueGrit",
        match: /^(?:истинная\s+стойкость|true\s+grit)/i,
        defence: ({ bonus }) => ({ critReduce: bonus("toughness"), text: t("CRIT_REDUCE", { value: bonus("toughness") }) })
    },

    /* Attack modifiers */

    {
        // Double Team (p. 162): ganging up in melee +10 more, +20 if an ally next to the target has the talent too.
        // A Combat Master target denies it with the ganging-up bonus
        id: "doubleTeam",
        match: /^(?:плечом\s+к\s+плечу|double\s+team)/i,
        test: ({ kind, rollData, targetActor }) => {
            const out = part(rollData, "outnumber");
            if (kind !== "melee" || !out?.modifier || hasTalent(targetActor, "combatMaster")) return null;
            const partner = (out.allies ?? []).some(id => hasTalent(canvas.tokens.get(id)?.actor, "doubleTeam"));
            const modifier = partner ? 20 : 10;
            return { modifier, text: t("DOUBLE_TEAM", { modifier: signed(modifier) }) };
        }
    },
    {
        // Combat Master (p. 159): opponents in melee get no ganging-up bonus against the character
        id: "combatMaster",
        match: /^(?:мастер\s+боя|combat\s+master)/i,
        against: ({ kind, rollData }) => {
            const out = part(rollData, "outnumber");
            if (kind !== "melee" || !out?.modifier) return null;
            return { modifier: -out.modifier, text: t("NO_OUTNUMBER", { modifier: signed(-out.modifier) }) };
        }
    },
    {
        // Blind Fighting (p. 151): no darkness, fog or smoke penalty in melee
        id: "blindFighting",
        match: /^(?:бой\s+вслепую|blind\s+fighting)/i,
        test: ({ kind, rollData }) => {
            const penalty = (Number(part(rollData, "darkness")) || 0) + (Number(part(rollData, "fog")) || 0);
            if (kind !== "melee" || penalty >= 0) return null;
            return { modifier: -penalty, text: t("BLIND_FIGHTING", { modifier: signed(-penalty) }) };
        }
    },
    {
        // Target Selection (p. 155): no penalty for shooting into melee
        id: "targetSelection",
        match: /^(?:выбор\s+цели|target\s+selection)/i,
        test: ({ kind, rollData }) => {
            const penalty = Number(part(rollData, "intoMelee")) || 0;
            if (kind !== "ranged" || penalty >= 0) return null;
            return { modifier: -penalty, text: t("TARGET_SELECTION", { modifier: signed(-penalty) }) };
        }
    },
    {
        // Hard Target (p. 164): after a Run or Charge, −20 to ranged attacks against the character until his next
        // turn (the action record keeps both until then, actions.js)
        id: "hardTarget",
        match: /^(?:трудная\s+мишень|hard\s+target)/i,
        against: ({ kind, rollData, targetActor }) => {
            if (kind !== "ranged" || SUPPRESSING.includes(rollData.attackType?.name)) return null;
            const record = recordOfActor(targetActor);
            return record.charge || record.run ? { modifier: -20, text: t("HARD_TARGET", { modifier: "-20" }) } : null;
        }
    },
    {
        // Double Tap (p. 157): +20 to the second ranged attack in a turn against the same target if the first hit.
        // Ticked when the last attack this turn was such a hit
        id: "doubleTap",
        match: /^(?:двойной\s+выстрел|double\s+tap)/i,
        test: ({ actor, kind, rollData, target, record }) => (kind === "ranged" && !SUPPRESSING.includes(rollData.attackType?.name)
            ? { toggle: true, modifier: 20, checked: firstShotHit(actor, target, record), text: t("DOUBLE_TAP") } : null)
    },
    {
        // Deadeye Shot (p. 165, Melee or Ranged): no −20 for a Called Shot
        id: "deadeyeShot",
        match: /^(?:убийственная\s+точность|precision\s+killer|deadeye\s+shot)/i,
        test: ({ attackType, weapon, talent, rollData }) => (attackType === "called_shot" && weapon && !rollData.psy?.display
            && specFits(talent.spec, weapon) ? { modifier: 20, text: t("CALLED_SHOT", { modifier: "+20" }) } : null)
    },
    {
        // Inescapable Attack (p. 160, Melee or Ranged): after a successful All Out, Called Shot, Charge or Standard
        // Attack the opponent's Evasion (Dodge, Parry) takes −10 per degree of success of the attack
        id: "inescapableAttack",
        match: /^(?:неотразимая\s+атака|inescapable\s+attack)/i,
        evasion: ({ rollData, talent }) => {
            // Psychic attacks have neither a melee nor a ranged weapon
            const weapon = rollData.weapon;
            if (!(weapon?.isMelee || weapon?.isRange) || !["allOut", "called_shot", "charge", "standard"].includes(rollData.attackType?.name)) return null;
            if (!specFits(talent.spec, weapon) || rollData.evasions?.selected === "deny") return null;
            const dos = Number(rollData.attackDos) || 0;
            return dos > 0 ? { modifier: -10 * dos, text: t("EVASION_PENALTY", { modifier: signed(-10 * dos) }) } : null;
        }
    },
    {
        // One on One (EB p. 68): + half the Weapon Skill bonus (rounded down) degrees of success on a passed melee
        // attack in a duel. Ticked when nobody else stands next to the two (being shot at last round is not seen)
        id: "oneOnOne",
        match: /^(?:один\s+на\s+один|one[-\s]on[-\s]one)/i,
        test: ({ kind, token, target, bonus }) => {
            const dos = Math.floor(bonus("weaponSkill") / 2);
            if (kind !== "melee" || !dos) return null;
            return { toggle: true, checked: alone(token, target), text: t("ONE_ON_ONE", { value: dos }),
                apply: rollData => { rollData.oneOnOne = dos; } };
        },
        after: ({ kind, rollData }) => {
            if (kind === "melee" && rollData.oneOnOne && rollData.flags.isSuccess) rollData.dos += rollData.oneOnOne;
            return null;
        }
    },
    {
        // Weapon Intuition (EWo p. 76): the penalty for a weapon without Weapon Training is 10 less
        id: "weaponIntuition",
        match: /^(?:интуитивное\s+владение\s+оружием|weapon\s+intuition)/i,
        test: ({ actor, rollData }) => {
            const unjam = rollData.unjam ? fromUuidSync(rollData.unjam.weaponUuid) : null;
            if (!rollData.untrained && !(unjam && !isTrained(actor, unjam))) return null;
            return { modifier: 10, text: t("UNTRAINED", { modifier: "+10" }) };
        }
    },
    {
        // Field Vivisection (EWo p. 75, Melee or Ranged): a Called Shot against a xenos the character has
        // Forbidden Lore (Xenos) for is a Medicae test with that characteristic. Ticked by the player
        id: "fieldVivisection",
        match: /^(?:полевая\s+вивисекция|field\s+vivisection)/i,
        test: ({ actor, attackType, weapon, talent, rollData }) => {
            if (attackType !== "called_shot" || !weapon || rollData.psy?.display || !specFits(talent.spec, weapon)) return null;
            const lore = actor.skills?.forbiddenLore?.specialities?.xenos;
            const medicae = actor.skills?.medicae;
            if (!(Number(lore?.advance) >= 0) || !medicae) return null;
            // The weapon's characteristic (and its craftsmanship) with the Medicae advance instead of nothing
            const base = Number(rollData.target.base) || 0;
            return { toggle: true, target: base + (Number(medicae.advance) || 0),
                text: t("FIELD_VIVISECTION", { modifier: signed(Number(medicae.advance) || 0) }) };
        }
    },
    // Swift Attack (p. 151), Lightning Attack (p. 159): the attack types are offered only with the talent (dialog.js)
    { id: "swiftAttack", match: /^(?:быстрая\s+атака|swift\s+attack)/i },
    { id: "lightningAttack", match: /^(?:молниеносная\s+атака|lightning\s+attack)/i },

    /* Damage of the attacker */

    {
        // Hammer Blow (p. 162): an All Out Attack in melee + half the Strength bonus (rounded up) to penetration
        // and Concussive (2) for that attack
        id: "hammerBlow",
        match: /^(?:пробивающий\s+удар|hammer\s+blow)/i,
        damage: ({ weapon, attackType, bonus }) => {
            if (!weapon?.isMelee || attackType !== "allOut") return null;
            const penetration = halfUp(bonus("strength"));
            return { penetration, text: t("HAMMER_BLOW", { value: signed(penetration) }),
                apply: rollData => {
                    const special = String(rollData.weapon.special ?? "");
                    const current = parseQualities(special).find(q => q.key === "concussive");
                    if (current && (current.x ?? 0) >= 2) return;
                    rollData.weapon.special = current ? special.replace(current.raw, "Concussive (2)")
                        : [special, "Concussive (2)"].filter(s => s.trim()).join(", ");
                } };
        }
    },
    {
        // Weapon-Tech (p. 157): once per combat, a plasma, power, exotic or melta weapon gets + Intelligence bonus
        // damage and penetration until the end of the round. Ticked on an attack; the round is kept on the actor
        // (flag «dark-heresy.weaponTech»), later attacks with the weapon that round get it by themselves
        id: "weaponTech",
        match: /^(?:длань\s+омниссии|weapon[-\s]?tech)/i,
        test: ({ actor, weaponItem, rollData, bonus }) => {
            if (!rollData.flags?.isAttack || rollData.psy?.display || !TECH_WEAPONS.includes(weaponItem?.system?.type)) return null;
            const value = bonus("intelligence");
            if (!value) return null;
            const effect = { damage: { damage: value, penetration: value }, text: t("WEAPON_TECH", { value: signed(value) }) };
            const combat = game.combat?.started ? game.combat : null;
            const used = actor.getFlag("dark-heresy", "weaponTech");
            if (combat && used?.combat === combat.id) {
                return used.round === combat.round && used.weapon === weaponItem.uuid ? effect : null;
            }
            return { ...effect, toggle: true, apply: async () => {
                if (combat && actor.isOwner) {
                    await actor.setFlag("dark-heresy", "weaponTech", { combat: combat.id, round: combat.round, weapon: weaponItem.uuid });
                }
            } };
        }
    },
    {
        // Deathdealer (p. 161, Melee or Ranged): + Perception bonus to the critical damage of such attacks
        id: "deathdealer",
        match: /^(?:несущий\s+смерть|deathdealer|death\s+dealer)/i,
        damage: ({ weapon, talent, rollData, bonus }) => {
            if (!weapon || rollData.psy?.display || !specFits(talent.spec, weapon)) return null;
            const crit = bonus("perception");
            return crit ? { crit, text: game.i18n.format("TALENTS.CRIT_BONUS", { bonus: crit }) } : null;
        }
    },
    {
        // Unarmed Specialist (p. 158): Deadly Natural Weapons (p. 171) — unarmed attacks are natural weapons
        // (1d10 + SB, p. 167) without Primitive; their damage can be re-rolled
        id: "unarmedSpecialist",
        match: /^(?:костолом|unarmed\s+(?:specialist|master|warrior))/i,
        damage: ({ weapon, rollData }) => {
            if (!weapon?.isMelee || !(UNARMED.test(rollData.itemName ?? "") || UNARMED.test(weapon.special ?? ""))) return null;
            return { text: t("DEADLY_NATURAL"), apply: data => {
                data.weapon.damageFormula = String(data.weapon.damageFormula ?? "").replace(/^\s*1d5\s*-\s*3/i, "1d10");
                if (data.weapon.traits) delete data.weapon.traits.primitive;
                data.weapon.special = String(data.weapon.special ?? "").split(/\s*,\s*/)
                    .filter(q => q && !/^(?:примитивн|primitive)/i.test(q)).join(", ");
            } };
        },
        damageReroll: ({ weapon, rollData }) => (weapon?.isMelee
            && (UNARMED.test(rollData.itemName ?? "") || UNARMED.test(weapon.special ?? "")) ? { text: "" } : null)
    },
    {
        // Furious Zeal (EW p. 41): + Insanity bonus to melee damage against a target of her Hatred (ticked Hatred)
        id: "furiousZeal",
        match: /^(?:неистовый\s+фанатизм|(?:furious|fervent|fanatical)\s+zeal)/i,
        damage: ({ actor, weapon, rollData }) => {
            const value = Number(actor.system?.insanityBonus) || 0;
            return weapon?.isMelee && rollData.hatred?.length && value ? { damage: value, text: signed(value) } : null;
        }
    },
    {
        // Purity of Hatred (EW p. 66, a Hatred group): attacks against the group are Vengeful (9), a Vengeful
        // weapon's rating one lower. In melee the ticked Hatred of the same group counts, otherwise a checkbox
        id: "purityOfHatred",
        match: /^(?:чистая\s+ненависть|purity\s+of\s+hatred)/i,
        test: ({ actor, kind, rollData, talent }) => {
            if (!rollData.flags?.isAttack) return null;
            const hatred = kind === "melee" && actor.items.some(i => i.type === "talent"
                && /^(?:ненависть|hatred)(?![\p{L}])/iu.test(i.name.trim()) && sameGroup(i.name.match(/\(([^)]*)\)/)?.[1], talent.spec));
            if (hatred) return null;
            return { toggle: true, text: t("PURITY", { group: talent.spec || "?" }),
                apply: data => { (data.hatred ??= []).push(talent.spec); } };
        },
        damage: ({ weapon, rollData, talent }) => {
            if (!rollData.hatred?.some(g => !talent.spec || sameGroup(g, talent.spec))) return null;
            const own = Number(weapon?.traits?.rfFace) || 0;
            const rfFace = own ? Math.max(1, own - 1) : 9;
            return { rfFace, text: t("VENGEFUL", { value: rfFace }) };
        }
    },
    {
        // Daemonhunter (EB p. 68): attacks against daemons are Proven (3), ticked when the target is Daemonic;
        // the re-roll to detect daemons is daemonhunterDetect (tests.js)
        id: "daemonhunter",
        match: /^(?:демоноборец|da?emon\s*hunter)/i,
        test: ({ rollData, targetActor }) => (rollData.flags?.isAttack
            ? { toggle: true, checked: isDaemon(targetActor), damage: { proven: 3 }, text: t("DAEMON_PROVEN") } : null)
    },
    {
        // Cleanse and Purify (EW p. 40): with a Flame weapon re-roll damage dice below the Willpower bonus
        id: "cleanseAndPurify",
        match: /^(?:очищение\s+огн[её]м|cleanse\s+and\s+purify)/i,
        damage: ({ weapon, bonus }) => {
            const below = bonus("willpower");
            return qualityValue(weapon?.special ?? "", "flame") && below > 1
                ? { rerollBelow: below, text: t("REROLL_BELOW", { value: below }) } : null;
        }
    },
    {
        // Instrument of His Will (EB p. 69): after a successful attack on a daemon (psychic powers too) a Fate
        // point adds twice the Willpower bonus to the first hit, ignoring armour and toughness. Ticked by the
        // player; the point is spent when the damage is rolled
        id: "instrumentOfHisWill",
        match: /^(?:орудие\s+его\s+воли|instrument\s+of\s+his\s+will)/i,
        test: ({ rollData, targetActor, bonus }) => {
            const value = 2 * bonus("willpower");
            if (!rollData.flags?.isAttack || !value || (targetActor && !isDaemon(targetActor))) return null;
            return { toggle: true, fate: "hit", damage: { firstHit: { trueDamage: value } },
                text: t("TRUE_DAMAGE", { value }) };
        }
    },

    /* Damage taken */

    {
        // Armour-Monger (p. 159): + Intelligence bonus armour points spread over the locations the worn armour
        // covers; the split is set on the talent sheet (unassigned points: body)
        id: "armourMonger",
        match: ARMOUR_MONGER,
        init: () => Hooks.on("renderItemSheet", armourMongerSheet),
        defence: ({ bonus, talent }) => {
            const points = bonus("intelligence");
            if (!points) return null;
            const armour = armourMongerSplit(talent.item, points);
            const where = Object.entries(armour).map(([label, n]) => `${game.i18n.localize(label)} ${n}`).join(", ");
            return { armour, text: t("ARMOUR_AT", { value: points, where }) };
        }
    },

    /* Areas and cover */

    // Grenadier (EWo p. 75): shorter scatter, area.js
    { id: "grenadier", match: /^(?:гренадер|grenadier)/i },
    {
        // Divine Protection (EW p. 65): his Spray hits only enemies (area.js leaves allies out of the cone)
        id: "divineProtection",
        match: /^(?:божественная\s+защита|divine\s+protection)/i,
        damage: ({ weapon }) => (weapon?.traits?.spray ? { text: t("ALLIES_SPARED") } : null)
    },
    {
        // Honed Reflexes (EWo p. 75): Dodge instead of Agility to avoid a Spray (the better one is used)
        id: "honedReflexes",
        match: /^(?:отточенные\s+рефлексы|(?:honed|hardened|keen)\s+reflexes)/i,
        test: ({ actor, rollData }) => {
            const dodge = Number(actor.skills?.dodge?.total) || 0;
            if (!rollData.sprayDodge || dodge <= (Number(rollData.target.base) || 0)) return null;
            return { target: dodge, text: t("DODGE", { value: dodge }) };
        }
    },
    {
        // Nowhere to Hide (p. 159): damage to cover wears it by the attack's degrees of success more (1 without
        // a test); applied by the target's cover (actor.js, cover.js)
        id: "nowhereToHide",
        match: /^(?:негде\s+прятаться|nowhere\s+to\s+hide)/i,
        damage: ({ weapon, rollData }) => (weapon ? { cover: weapon.traits?.skipAttackRoll ? 1 : Math.max(1, Number(rollData.attackDos) || 0) } : null)
    },
    {
        // Blademaster (p. 159): re-roll one missed attack with a bladed weapon (chain, power and plain blades,
        // axes) per round
        id: "blademaster",
        match: /^(?:мастер\s+клинка|blade\s*master)/i,
        reroll: ({ weapon, weaponItem }) => (weapon?.isMelee && !weapon.traits?.skipAttackRoll
            && BLADE.test(`${weaponItem?.name ?? ""} ${weapon.type ?? weaponItem?.system?.type ?? ""}`) ? { text: "", limit: "round" } : null)
    },
    {
        // Shieldbearer (EB p. 69): with a shield, re-roll one failed Parry per round
        id: "shieldbearer",
        match: /^(?:щитоносец|shield[-\s]?bearer)/i,
        reroll: ({ rollData, actor }) => (rollData.flags?.isEvasion && rollData.evasions?.selected === "parry"
            && actor.items.some(i => i.type === "weapon" && SHIELD.test(`${i.name} ${i.system?.special ?? ""}`)) ? { text: "", limit: "round" } : null)
    }
];
