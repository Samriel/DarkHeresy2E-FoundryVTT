/**
 * Talents of attacks and damage (core rulebook chapter IV, Russian edition page numbers).
 */
import { signed } from "../talents.js";

const halfUp = n => Math.ceil(n / 2);
const t = (key, data) => game.i18n.format(`TALENTS.EFFECT.${key}`, data);

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
        // Hatred (p. 160): +10 to Weapon Skill tests in melee against the hated group
        id: "hatred",
        match: /^(?:ненависть|hatred)(?![\p{L}])/iu,
        test: ({ kind, talent }) => (kind === "melee"
            ? { toggle: true, modifier: 10, text: t("HATRED", { group: talent.spec || "?" }) } : null)
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
    }
];
