/**
 * Two-weapon fighting (core rulebook p. 281–282, talents pp. 145, 158–159; Russian edition).
 *
 * With Two-Weapon Wielder (Melee or Ranged, matching the weapon) a character holding a one-handed weapon
 * in each hand attacks with one of them (Standard, Swift or Lightning Attack in melee; Standard, Semi-Auto
 * or Full Auto Burst at range) and then once more with the other as part of the same half action; each of
 * the two attacks takes −20. Ambidextrous reduces the penalty to −10, Two-Weapon Master removes it. Mixing
 * a melee and a ranged weapon needs both specialisations. The attack dialog offers the option when the
 * talent matches; the first of the two attacks costs the half action, the second is free (actions.js).
 * Which weapons are one-handed is not recorded on the items: pistols are, other ranged weapons get a reminder.
 */

const WIELDER = /(?:обоерукий\s+воин|two[-\s]?weapon\s+wielder)/i;
const MASTER = /(?:обоерукий\s+мастер|two[-\s]?weapon\s+master)/i;
const AMBIDEXTROUS = /(?:амбидекстри|ambidextrous)/i;
const MELEE_SPEC = /(?:рукоп|ближн|melee|weapon\s*skill|навык\s+рукоп)/i;
const RANGED_SPEC = /(?:стрел|дальн|ranged|ballistic|навык\s+стрел)/i;

const ALLOWED = { melee: ["standard", "swift", "lightning"], ranged: ["standard", "semi_auto", "full_auto"] };

const talents = actor => actor?.items.filter(i => i.type === "talent") ?? [];

/**
 * Has the actor Two-Weapon Wielder for melee or ranged weapons? A talent without a specialisation counts for both.
 * @param {Actor} actor
 * @param {boolean} melee
 * @returns {boolean}
 */
export function hasWielder(actor, melee) {
    return talents(actor).some(t => {
        if (!WIELDER.test(t.name)) return false;
        const spec = String(t.name).match(/\(([^)]*)\)/)?.[1] ?? "";
        if (!spec.trim()) return true;
        return melee ? MELEE_SPEC.test(spec) : RANGED_SPEC.test(spec);
    });
}

/**
 * Two-weapon option for an attack with a weapon.
 * @param {Actor} actor
 * @param {object} rollData
 * @returns {{penalty: number, talent?: string}|null} null when the actor cannot fight with two weapons with it
 */
export function twoWeaponOption(actor, rollData) {
    if (!actor || rollData.psy?.display) return null;
    const melee = Boolean(rollData.weapon?.isMelee);
    if (!hasWielder(actor, melee)) return null;
    // The talent that lowers the penalty is named on the card
    const master = talents(actor).find(t => MASTER.test(t.name));
    if (master) return { penalty: 0, talent: master.name };
    const ambidextrous = talents(actor).find(t => AMBIDEXTROUS.test(t.name));
    if (ambidextrous) return { penalty: -10, talent: ambidextrous.name };
    return { penalty: -20 };
}

/**
 * Apply the two-weapon choice of the attack dialog (mutates rollData).
 * @param {object} rollData
 * @param {boolean} checked
 * @param {Item|null} weapon
 * @returns {string[]} reminders (attack type, one-handed weapon)
 */
export function applyTwoWeapon(rollData, checked, weapon) {
    delete rollData.twoWeapon;
    if (!checked || !rollData.twoWeaponOption) return [];
    const { penalty, talent } = rollData.twoWeaponOption;
    rollData.twoWeapon = { penalty, talent };
    rollData.target.modifier = (Number(rollData.target.modifier) || 0) + penalty;
    const warnings = [];
    const kind = rollData.weapon.isMelee ? "melee" : "ranged";
    if (!ALLOWED[kind].includes(rollData.attackType?.name)) warnings.push(game.i18n.localize(`TWO_WEAPON.TYPE_${kind.toUpperCase()}`));
    if (kind === "ranged" && weapon && weapon.system.class !== "pistol") warnings.push(game.i18n.localize("TWO_WEAPON.ONE_HANDED"));
    return warnings;
}
