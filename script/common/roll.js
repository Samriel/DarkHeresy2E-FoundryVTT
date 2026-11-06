import { blastArea, sprayArea, sprayJammed } from "./area.js";
import { qualityValue } from "./qualities.js";
import { checkWeaponJam, setSprayJam } from "./weapons.js";
import { phenomenaModifier, fearConsequences } from "./tables.js";
import { SUPPRESSION, SUPPRESSION_MODIFIER, suppressionArea, resolveSuppression, labelSuppressionDamages } from "./pinning.js";
import { psychicBlast, resolveOpposed } from "./psychic.js";
import { afterRollTalents, offerTalentRerolls, damageTalents, payTalentFate } from "./talents.js";

/**
 * Roll a generic roll, and post the result to chat.
 * @param {object} rollData
 */
export async function commonRoll(rollData) {
    await _computeCommonTarget(rollData);
    await _rollTarget(rollData);
    afterRollTalents(rollData);
    // Opposed test against a psychic power card (psychic.js)
    if (rollData.opposedTo) resolveOpposed(rollData);
    if (rollData.flags.isEvasion) {
        rollData.numberOfHits = _computeNumberOfHits(
            rollData.attackDos,
            rollData.dos,
            rollData.attackType,
            rollData.shotsFired,
            rollData.weapon.traits);
    }
    offerTalentRerolls(rollData);
    await _sendRollToChat(rollData);
    if (rollData.flags.isFear && !rollData.flags.isSuccess) await fearConsequences(rollData);
}

/**
 * Roll a combat roll, and post the result to chat.
 * @param {object} rollData
 */
export async function combatRoll(rollData) {
    const special = rollData.weapon.special ?? "";
    if (rollData.weapon.traits.spray && !rollData.isReRoll) {
        rollData.area = await sprayArea(rollData);
    }
    if (rollData.weapon.traits.skipAttackRoll) {
        rollData.attackResult = 5; // Attacks that skip the hit roll always hit body; 05 reversed 50 = body
        rollData.flags.isDamageRoll = true;
        await _rollDamage(rollData);
        // Reliable weapons with Spray never jam (core p. 179)
        if (rollData.weapon.traits.spray) {
            rollData.sprayJam = !qualityValue(special, "reliable") && sprayJammed(rollData.damages);
            if (rollData.sprayJam) await setSprayJam(rollData);
        }
        await _updateRangedAmmo(rollData);
        await sendDamageToChat(rollData);
    } else {
        const suppressing = Boolean(SUPPRESSION[rollData.attackType?.name]);
        if (suppressing) {
            rollData.rangeMod = 0; // hits land on random targets in the zone
            if (!rollData.flags.isReRoll) rollData.area = await suppressionArea(rollData);
        }
        await _computeCombatTarget(rollData);
        await _rollTarget(rollData);
        _applyHelplessTarget(rollData);
        afterRollTalents(rollData);
        await checkWeaponJam(rollData);
        rollData.attackDos = rollData.dos;
        rollData.attackResult = rollData.result;
        if (!rollData.isReRoll) {
            await _updateRangedAmmo(rollData);
        }
        rollData.numberOfHits = _computeNumberOfHits(
            rollData.attackDos,
            0,
            rollData.attackType,
            rollData.shotsFired,
            rollData.weapon.traits);
        if (suppressing) resolveSuppression(rollData);
        // Psychic blasts take their radius from the psy rating and do not scatter (psychic.js)
        const blast = rollData.psy?.display ? 0 : Number(qualityValue(special, "blast")) || 0;
        if (blast && !rollData.flags.isEvasion && !rollData.weaponJam?.jammed) rollData.area = await blastArea(rollData, blast);
        if (rollData.psy?.display && !rollData.flags.isEvasion) rollData.area = await psychicBlast(rollData);
        offerTalentRerolls(rollData);
        await _sendRollToChat(rollData);
    }
}

/**
 * Melee attack against a helpless target: automatic success with degrees of success equal to the
 * Weapon Skill bonus (core p. 283). The d100 still decides the hit location.
 * @param {object} rollData
 */
function _applyHelplessTarget(rollData) {
    if (!rollData.helplessTarget || !rollData.weapon?.isMelee) return;
    const actor = game.actors.get(rollData.ownerId);
    rollData.flags.isSuccess = true;
    rollData.dof = 0;
    rollData.dos = Math.max(1, Number(actor?.characteristics?.weaponSkill?.bonus) || 1);
}

/**
 * Roll damage for an attack and post the result to chat
 * @param {object} rollData
 */
export async function damageRoll(rollData) {
    await _rollDamage(rollData);
    offerTalentRerolls(rollData, "damage");
    await sendDamageToChat(rollData);
}

/**
 * Post an "empty clip, need to reload" message to chat.
 * @param {object} rollData
 */
export async function reportEmptyClip(rollData) {
    await _emptyClipToChat(rollData);
}

/**
 * Compute the target value, including all +/-modifiers, for a roll.
 * @param {object} rollData
 */
async function _computeCombatTarget(rollData) {

    let attackType = 0;
    if (rollData.attackType) {
        _computeRateOfFire(rollData);
        attackType = rollData.attackType.modifier;
    }
    let psyModifier = 0;
    if (typeof rollData.psy !== "undefined" && typeof rollData.psy.useModifier !== "undefined" && rollData.psy.useModifier) {
        // Set Current Psyrating to the allowed maximum if it is bigger
        if (rollData.psy.value > rollData.psy.max) {
            rollData.psy.value = rollData.psy.max;
        }
        psyModifier = (rollData.psy.rating - rollData.psy.value) * 10;
        rollData.psy.push = psyModifier < 0;
        if (rollData.psy.push && rollData.psy.warpConduit) {
            const ratingBonus = (await new Roll("1d5").evaluate()).total;
            rollData.psy.value += ratingBonus;
        }
    }

    let targetMods = rollData.target.modifier
        + (rollData.aim?.val ? rollData.aim.val : 0)
        + (rollData.rangeMod ? rollData.rangeMod : 0)
        + (rollData.weapon?.traits?.twinLinked ? 20 : 0)
        + attackType
        + psyModifier;

    rollData.target.final = _getRollTarget(targetMods, rollData.target.base);
}

/**
 * Compute the target value, including all +/-modifiers, for a roll.
 * @param {object} rollData
 */
async function _computeCommonTarget(rollData) {
    if (rollData.flags.isEvasion) {
        let skill;
        switch (rollData.evasions.selected) {
            case "dodge": skill = rollData.evasions.dodge; break;
            case "parry": skill = rollData.evasions.parry; break;
            case "deny": skill = rollData.evasions.deny; break;
        }
        rollData.target.final = _getRollTarget(rollData.target.modifier, skill.target.base);
    } else {
        rollData.target.final = _getRollTarget(rollData.target.modifier, rollData.target.base);
    }
}

/**
 * Checks and adjusts modifiers for the rolls target number and returns the final target number
 * @param {int} targetMod calculated bonuses
 * @param {int} baseTarget the intial target value to be modified
 * @returns {int} the final target number
 */
function _getRollTarget(targetMod, baseTarget) {
    if (targetMod > 60) {
        return baseTarget + 60;
    } else if (targetMod < -60) {
        return baseTarget + -60;
    } else {
        return baseTarget + targetMod;
    }
}


/**
 * Roll a d100 against a target, and apply the result to the rollData.
 * @param {object} rollData
 */
async function _rollTarget(rollData) {
    let r = new Roll("1d100", {});
    await r.evaluate();
    rollData.result = r.total;
    rollData.rollObject = r;
    // A talent may make the die count as a set result (the d100 still shows what was rolled)
    const force = rollData.talentForce;
    if (Number.isFinite(force?.result)) rollData.result = force.result;
    rollData.flags.isSuccess = rollData.result <= rollData.target.final;
    if (rollData.flags.isSuccess) {
        rollData.dof = 0;
        rollData.dos = 1 + _getDegree(rollData.target.final, rollData.result);
    } else {
        rollData.dos = 0;
        rollData.dof = 1 + _getDegree(rollData.result, rollData.target.final);
    }
    // A talent may pass the test automatically with set degrees of success (Mastery)
    if (force?.success) {
        rollData.flags.isSuccess = true;
        rollData.dof = 0;
        rollData.dos = Math.max(1, Number(force.dos) || 1);
    }
    if (rollData.psy) _computePsychicPhenomena(rollData);
}
/**
 * Handle rolling and collecting parts of a combat damage roll.
 * @param {object} rollData
 */
async function _rollDamage(rollData) {
    let formula = "0";
    rollData.damages = [];
    // Talents of the attacker: extra damage and penetration, Proven, Vengeful, re-rolled low dice (talents.js)
    await payTalentFate(rollData);
    const talents = damageTalents(rollData);
    const traits = { ...rollData.weapon.traits };
    if (talents.proven > (Number(traits.proven) || 0)) traits.proven = talents.proven;
    if (talents.rfFace) traits.rfFace = Math.min(Number(traits.rfFace) || 10, talents.rfFace);
    if (rollData.weapon.damageFormula) {
        formula = rollData.weapon.damageFormula;

        // Helpless target: roll the damage dice twice and add the results (core p. 283)
        if (rollData.helplessTarget && rollData.weapon.isMelee) {
            formula = formula.replace(/(\d*)d(\d+)/i, (m, n, faces) => `${(Number(n) || 1) * 2}d${faces}`);
        }
        if (traits.tearing) {
            formula = _appendTearing(formula);
        }
        if (talents.rerollBelow) {
            formula = formula.replace(/(\d*d\d+)/i, `$1r<${talents.rerollBelow}`);
        }
        if (traits.proven) {
            formula = _appendNumberedDiceModifier(formula, "min", traits.proven);
        }
        if (traits.primitive) {
            formula = _appendNumberedDiceModifier(formula, "max", traits.primitive);
        }

        formula = `${formula}+${rollData.weapon.damageBonus}${talents.damage ? `+${talents.damage}` : ""}`;
        formula = _replaceSymbols(formula, rollData);
    }


    let penetration = await _rollPenetration(rollData) + talents.penetration;

    let firstHit = await _computeDamage(
        formula,
        penetration,
        rollData.attackDos,
        rollData.aim?.isAiming,
        traits
    );
    // Talents that add to the first hit only (Eye of Vengeance…)
    if (talents.firstHit.damage || talents.firstHit.penetration) {
        firstHit.total += talents.firstHit.damage;
        firstHit.penetration += talents.firstHit.penetration;
    }
    // Damage ignoring armour and toughness (Instrument of His Will), applied by the target (actor.js)
    if (talents.firstHit.trueDamage) firstHit.trueDamage = talents.firstHit.trueDamage;
    // Critical damage and cover wear bonuses of the attacker's talents, applied by the target (actor.js)
    if (talents.crit) rollData.talentCrit = { bonus: talents.crit, name: talents.critName };
    else delete rollData.talentCrit;
    if (talents.cover) rollData.talentCover = { bonus: talents.cover, name: talents.coverName };
    else delete rollData.talentCover;
    // Called shot: the hit goes to the chosen location (core p. 269)
    const firstLocation = (rollData.attackType?.name === "called_shot" && rollData.calledShot)
        ? rollData.calledShot : _getLocation(rollData.attackResult);
    firstHit.location = firstLocation;
    rollData.damages.push(firstHit);

    let additionalhits = rollData.numberOfHits - 1;

    for (let i = 0; i < additionalhits; i++) {
        let additionalHit = await _computeDamage(
            formula,
            penetration,
            rollData.attackDos,
            rollData.aim?.isAiming,
            traits
        );
        additionalHit.location = _getAdditionalLocation(firstLocation, i);
        rollData.damages.push(additionalHit);
    }

    let minDamage = rollData.damages.reduce(
        (min, damage) => min.minDice < damage.minDice ? min : damage, rollData.damages[0]);

    if (minDamage.minDice < rollData.dos) {
        minDamage.total += (rollData.dos - minDamage.minDice);
    }
    labelSuppressionDamages(rollData);
}

/**
 * Calculates the amount of hits of a successful attack
 * @param {int} attackDos Degrees of success on the Attack
 * @param {int} evasionDos Degrees of success on the Evasion
 * @param {object} attackType The mode of attack and its parameters
 * @param {int} shotsFired Number actually achiveable hits
 * @param {object} weaponTraits The traits of the weapon used for the attack
 * @returns {int}  the number of hits the attack has scrored
 */
function _computeNumberOfHits(attackDos, evasionDos, attackType, shotsFired, weaponTraits) {

    let stormMod = weaponTraits.storm ? 2 : 1;
    let maxHits = attackType.maxHits * stormMod;

    if (weaponTraits.twinLinked && attackDos >= 2) {
        maxHits += 1;
        attackDos += attackType.hitMargin;
        if (shotsFired) shotsFired += 1;
    }

    let hits = (1 + Math.floor((attackDos - 1) / attackType.hitMargin)) * stormMod;

    if (shotsFired && shotsFired < maxHits) {
        maxHits = shotsFired;
    }

    if (hits > maxHits) {
        hits = maxHits;
    }

    hits -= evasionDos;

    if (hits <= 0) {
        return 0;
    } else {
        return hits;
    }
}

/**
 * Roll and compute damage.
 * @param {string} damageFormula
 * @param {number} penetration
 * @param {number} dos
 * @param {boolean} isAiming
 * @param {object} weaponTraits
 * @returns {object}
 */
async function _computeDamage(damageFormula, penetration, dos, isAiming, weaponTraits) {
    let r = new Roll(damageFormula);
    await r.evaluate();
    let damage = {
        total: r.total,
        righteousFury: 0,
        dices: [],
        penetration: penetration,
        dos: dos,
        formula: damageFormula,
        replaced: false,
        damageRender: await r.render(),
        damageRoll: r
    };

    if (weaponTraits.accurate && isAiming) {
        let numDice = ~~((dos - 1) / 2); // -1 because each degree after the first counts
        if (numDice >= 1) {
            if (numDice > 2) numDice = 2;
            let ar = new Roll(`${numDice}d10`);
            await ar.evaluate();
            damage.total += ar.total;
            ar.terms.flatMap(term => term.results).forEach(async die => {
                if (die.active && die.result < dos) damage.dices.push(die.result);
                if (die.active && (typeof damage.minDice === "undefined" || die.result < damage.minDice)) damage.minDice = die.result;
            });
            damage.accurateRender = await ar.render();
        }
    }

    for await (const term of r.terms) {
        if (typeof term === "object" && term !== null) {
            let rfFace = weaponTraits.rfFace ? weaponTraits.rfFace : term.faces; // Without the Vengeful weapon trait rfFace is undefined
            for await (const result of term.results ?? []) {
                let dieResult = result.count ? result.count : result.result; // Result.count = actual value if modified by term
                if (result.active && dieResult >= rfFace) damage.righteousFury = await _rollRighteousFury();
                if (result.active && dieResult < dos) damage.dices.push(dieResult);
                if (result.active && (typeof damage.minDice === "undefined" || dieResult < damage.minDice)) damage.minDice = dieResult;
            }
        }
    }
    return damage;
}

/**
 * Reduce Ammo of the used Weapon
 * @param {object} rollData
 * @returns {Promise}
 */
async function _updateRangedAmmo(rollData) {
    let firerate = 1;
    let mod = rollData.weapon.traits.storm || rollData.weapon.traits.twinLinked ? 2 : 1;
    if (rollData.weapon.isRange && rollData.weapon.clip.max > 0) {
        if (rollData.weapon.clip.value < 1) {
            return;
        }
        let weapon = game.actors.get(rollData.ownerId)?.items?.get(rollData.itemId);
        if (weapon) {
            switch (rollData.attackType.name) {
                case "standard":
                case "called_shot": {
                    rollData.weapon.clip.value -= firerate;
                    break;
                }
                case "semi_auto":
                case "suppress_semi": {
                    firerate = rollData.weapon.rateOfFire.burst * mod;
                    if (rollData.weapon.clip.value < firerate) {
                        rollData.shotsFired = rollData.weapon.clip.value;
                        rollData.weapon.clip.value = 0;
                    } else {
                        rollData.weapon.clip.value -= firerate;
                    }
                    break;
                }
                case "full_auto":
                case "suppress_full": {
                    firerate = rollData.weapon.rateOfFire.full * mod;
                    if (rollData.weapon.clip.value < firerate) {
                        rollData.shotsFired = rollData.weapon.clip.value;
                        rollData.weapon.clip.value = 0;
                    } else {
                        rollData.weapon.clip.value -= firerate;
                    }
                    break;
                }
            }
            await weapon.update({ "system.clip.value": rollData.weapon.clip.value });
        }
    }
}

/**
 * Evaluate final penetration, by leveraging the dice roll API.
 * @param {object} rollData
 * @returns {number}
 */
async function _rollPenetration(rollData) {
    let penetration = (rollData.weapon.penetrationFormula) ? _replaceSymbols(rollData.weapon.penetrationFormula, rollData) : "0";
    let multiplier = 1;

    if (rollData.dos >= 3) {
        if (penetration.includes("(")) // Legacy Support
        {
            let rsValue = penetration.match(/\(\d+\)/gi); // Get Razorsharp Value
            penetration = penetration.replace(/\d+.*\(\d+\)/gi, rsValue); // Replace construct BaseValue(RazorsharpValue) with the extracted date
        } else if (rollData.weapon.traits.razorSharp) {
            multiplier = 2;
        }
    }
    let r = new Roll(penetration.toString());
    await r.evaluate();
    return r.total * multiplier;
}

/**
 * Roll a Righteous Fury dice, and return the value.
 * @returns {Promise<number>}
 */
async function _rollRighteousFury() {
    let r = new Roll("1d5");
    await r.evaluate();
    return r.total;
}

/**
 * Check for psychic phenomena (i.e, the user rolled two matching numbers, etc.), and add the result to the rollData.
 * Table 6-1 (core p. 239): a pushing unbound or daemonic psyker always causes phenomena.
 * @param {object} rollData
 */
function _computePsychicPhenomena(rollData) {
    const alwaysWhenPushing = ["unbound", "daemonic"].includes(rollData.psy.class);
    if (rollData.psy.push) rollData.psy.hasPhenomena = alwaysWhenPushing || !_isDouble(rollData.result);
    else rollData.psy.hasPhenomena = _isDouble(rollData.result);
    if (rollData.psy.hasPhenomena && rollData.psy.display) {
        rollData.psy.phenomena = phenomenaModifier(rollData.psy, game.actors.get(rollData.ownerId) ?? null);
    }
}

/**
 * Check if a number (d100 roll) has two matching digits.
 * @param {number} number
 * @returns {boolean}
 */
function _isDouble(number) {
    if (number === 100) {
        return true;
    } else {
        const digit = number % 10;
        return number - digit === digit * 10;
    }
}

/**
 * Get the hit location from a WS/BS roll.
 * @param {number} result
 * @returns {string}
 */
function _getLocation(result) {
    const toReverse = result < 10 ? `0${result}` : result.toString();
    const locationTarget = parseInt(toReverse.split("").reverse().join(""));
    if (locationTarget <= 10) {
        return "ARMOUR.HEAD";
    } else if (locationTarget <= 20) {
        return "ARMOUR.RIGHT_ARM";
    } else if (locationTarget <= 30) {
        return "ARMOUR.LEFT_ARM";
    } else if (locationTarget <= 70) {
        return "ARMOUR.BODY";
    } else if (locationTarget <= 85) {
        return "ARMOUR.RIGHT_LEG";
    } else if (locationTarget <= 100) {
        return "ARMOUR.LEFT_LEG";
    } else {
        return "ARMOUR.BODY";
    }
}

/**
 * Calculate modifiers/etc. from RoF type, and add them to the rollData.
 * @param {object} rollData
 */
function _computeRateOfFire(rollData) {
    switch (rollData.attackType.name) {
        case "standard":
            rollData.attackType.modifier = 10;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = 1;
            break;

        case "bolt":
        case "blast":
            rollData.attackType.modifier = 0;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = 1;
            break;

        case "swift":
        case "semi_auto":
        case "barrage":
            rollData.attackType.modifier = 0;
            rollData.attackType.hitMargin = 2;
            rollData.attackType.maxHits = rollData.weapon.rateOfFire.burst;
            break;

        // Psychic storm: a hit per degree of success up to the psy rating used, no test modifier (core p. 244)
        case "storm":
            rollData.attackType.modifier = 0;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = rollData.weapon.rateOfFire.full;
            break;

        // Psychic power that is not an attack
        case "none":
            rollData.attackType.modifier = 0;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = 0;
            break;

        case "lightning":
        case "full_auto":
            rollData.attackType.modifier = -10;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = rollData.weapon.rateOfFire.full;
            break;

        case "suppress_semi":
        case "suppress_full":
            // Suppressing fire: Hard (−20) test without the burst modifiers, one hit per two degrees
            rollData.attackType.modifier = SUPPRESSION_MODIFIER;
            rollData.attackType.hitMargin = 2;
            rollData.attackType.maxHits = rollData.weapon.rateOfFire[SUPPRESSION[rollData.attackType.name].rof];
            break;

        case "called_shot":
            rollData.attackType.modifier = -20;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = 1;
            break;

        case "charge":
            rollData.attackType.modifier = 20;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = 1;
            break;

        case "allOut":
            rollData.attackType.modifier = 30;
            rollData.attackType.hitMargin = 1;
            rollData.attackType.maxHits = 1;
            break;

        default:
            rollData.attackType.modifier = 0;
            rollData.attackType.hitMargin = 0;
            rollData.attackType.maxHits = 1;
            break;
    }
}

const additionalHit = {
    head: ["ARMOUR.HEAD", "ARMOUR.RIGHT_ARM", "ARMOUR.BODY", "ARMOUR.LEFT_ARM", "ARMOUR.BODY"],
    rightArm: ["ARMOUR.RIGHT_ARM", "ARMOUR.RIGHT_ARM", "ARMOUR.HEAD", "ARMOUR.BODY", "ARMOUR.RIGHT_ARM"],
    leftArm: ["ARMOUR.LEFT_ARM", "ARMOUR.LEFT_ARM", "ARMOUR.HEAD", "ARMOUR.BODY", "ARMOUR.LEFT_ARM"],
    body: ["ARMOUR.BODY", "ARMOUR.RIGHT_ARM", "ARMOUR.HEAD", "ARMOUR.LEFT_ARM", "ARMOUR.BODY"],
    rightLeg: ["ARMOUR.RIGHT_LEG", "ARMOUR.BODY", "ARMOUR.RIGHT_ARM", "ARMOUR.HEAD", "ARMOUR.BODY"],
    leftLeg: ["ARMOUR.LEFT_LEG", "ARMOUR.BODY", "ARMOUR.LEFT_ARM", "ARMOUR.HEAD", "ARMOUR.BODY"]
};

/**
 * Get successive hit locations for an attack which scored multiple hits.
 * @param {string} firstLocation
 * @param {number} numberOfHit
 * @returns {string}
 */
function _getAdditionalLocation(firstLocation, numberOfHit) {
    if (firstLocation === "ARMOUR.HEAD") {
        return _getLocationByIt(additionalHit.head, numberOfHit);
    } else if (firstLocation === "ARMOUR.RIGHT_ARM") {
        return _getLocationByIt(additionalHit.rightArm, numberOfHit);
    } else if (firstLocation === "ARMOUR.LEFT_ARM") {
        return _getLocationByIt(additionalHit.leftArm, numberOfHit);
    } else if (firstLocation === "ARMOUR.BODY") {
        return _getLocationByIt(additionalHit.body, numberOfHit);
    } else if (firstLocation === "ARMOUR.RIGHT_LEG") {
        return _getLocationByIt(additionalHit.rightLeg, numberOfHit);
    } else if (firstLocation === "ARMOUR.LEFT_LEG") {
        return _getLocationByIt(additionalHit.leftLeg, numberOfHit);
    } else {
        return _getLocationByIt(additionalHit.body, numberOfHit);
    }
}

/**
 * Lookup hit location from array.
 * @param {Array} part
 * @param {number} numberOfHit
 * @returns {string}
 */
function _getLocationByIt(part, numberOfHit) {
    const index = numberOfHit > (part.length - 1) ? part.length - 1 : numberOfHit;
    return part[index];
}


/**
 * Get degrees of success/failure from a target and a roll.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function _getDegree(a, b) {
    return Math.floor(a / 10) - Math.floor(b / 10);
}
/**
 * Replaces all Symbols in the given Formula with their Respective Values
 * The Symbols consist of Attribute Boni and Psyrating
 * @param {*} formula
 * @param {*} rollData
 * @returns {string}
 */
export function replaceSymbols(formula, rollData) {
    return _replaceSymbols(formula, rollData);
}

function _replaceSymbols(formula, rollData) {
    let actor = game.actors.get(rollData.ownerId);
    let attributeBoni = actor.attributeBoni;
    if (rollData.psy) {
        formula = formula.replaceAll(/PR/gi, rollData.psy.value);
    }
    for (let boni of attributeBoni) {
        formula = formula.replaceAll(boni.regex, boni.value);
    }
    return formula;
}

/**
 * Add a special weapon modifier value to a roll formula.
 * @param {string} formula
 * @param {string} modifier
 * @param {number} value
 * @returns {string}
 */
function _appendNumberedDiceModifier(formula, modifier, value) {
    let diceRegex = /\d+d\d+/;
    if (!formula.includes(modifier)) {
        let match = formula.match(diceRegex);
        if (match) {
            let dice = match[0];
            dice += `${modifier}${value}`;
            formula = formula.replace(diceRegex, dice);
        }
    }
    return formula;
}

/**
 * Add the "tearing" special weapon modifier to a roll formula.
 * @param {string} formula
 * @returns {string}
 */
function _appendTearing(formula) {
    let diceRegex = /\d+d\d+/;
    if (!formula.match(/dl|kh/gi, formula)) { // Already has drop lowest or keep highest
        let match = formula.match(/\d+/g, formula);
        let numDice = parseInt(match[0]) + 1;
        let faces = parseInt(match[1]);
        let diceTerm = `${numDice}d${faces}dl`;
        formula = formula.replace(diceRegex, diceTerm);
    }
    return formula;
}

/**
 * Add degrees of success to a successful test already in chat (Fate, core p. 357) and render the card again.
 * Attack rolls recompute their number of hits, evasions the hits they cancel.
 * @param {object} rollData the roll data from the chat message
 * @param {number} [degrees=1]
 * @returns {Promise<string>} the new card content
 */
export async function addDegreesOfSuccess(rollData, degrees = 1) {
    rollData.dos = (Number(rollData.dos) || 0) + degrees;
    rollData.fateDegrees = (Number(rollData.fateDegrees) || 0) + degrees;
    if (rollData.flags.isEvasion) {
        rollData.numberOfHits = _computeNumberOfHits(rollData.attackDos, rollData.dos, rollData.attackType,
            rollData.shotsFired, rollData.weapon.traits);
        return foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/evasion.hbs", rollData);
    }
    if (rollData.flags.isAttack && rollData.attackType?.hitMargin) {
        rollData.attackDos = rollData.dos;
        rollData.numberOfHits = _computeNumberOfHits(rollData.attackDos, 0, rollData.attackType,
            rollData.shotsFired, rollData.weapon.traits);
    }
    return foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/roll.hbs", rollData);
}

/**
 * Speaker of a roll: the selected token when it belongs to the roller, otherwise the roller. A roll from
 * a sheet while another token is selected must not speak as that token: the message's token and actor
 * decide whose actions are spent and who gets table results.
 * @param {object} rollData
 * @param {boolean} [evasion] the evading character rolls (an evasion carries the attack's owner)
 * @returns {object}
 */
function rollSpeaker(rollData, evasion = false) {
    const speaker = ChatMessage.getSpeaker();
    const uuid = evasion ? rollData.evaderUuid : rollData.actorUuid;
    const actor = (uuid ? fromUuidSync(uuid) : null) ?? game.actors.get(rollData.ownerId);
    if (!(actor instanceof Actor)) return speaker;
    if (canvas?.tokens?.get(speaker.token)?.actor?.uuid === actor.uuid) return speaker;
    return ChatMessage.getSpeaker({ actor, token: actor.token ?? undefined });
}

/**
 * Post a roll to chat.
 * @param {object} rollData
 */
async function _sendRollToChat(rollData) {
    // A test made for another token (opposed test of a power's target) speaks as that token
    let speaker = rollData.speaker ?? rollSpeaker(rollData, rollData.flags?.isEvasion);
    let chatData = {
        user: game.user.id,
        rollMode: game.settings.get("core", "rollMode"),
        speaker: speaker,
        flags: {
            "dark-heresy.rollData": rollData
        }
    };

    if (speaker.token) {
        rollData.tokenId = speaker.token;
    }

    if (rollData.rollObject) {
        rollData.render = await rollData.rollObject.render();
        chatData.rolls = [rollData.rollObject];
    }

    let html;
    if (rollData.flags.isEvasion) {
        html = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/evasion.hbs", rollData);
    } else {
        html = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/roll.hbs", rollData);
    }
    chatData.content = html;

    if (["gmroll", "blindroll"].includes(chatData.rollMode)) {
        chatData.whisper = ChatMessage.getWhisperRecipients("GM");
    } else if (chatData.rollMode === "selfroll") {
        chatData.whisper = [game.user];
    }

    ChatMessage.create(chatData);
}
/**
 * Post rolled damage to chat.
 * @param {object} rollData
 */
export async function sendDamageToChat(rollData) {
    let speaker = rollSpeaker(rollData);
    let chatData = {
        user: game.user.id,
        rollMode: game.settings.get("core", "rollMode"),
        speaker: speaker,
        flags: {
            "dark-heresy.rollData": rollData
        }
    };

    if (speaker.token) {
        rollData.tokenId = speaker.token;
    }

    chatData.rolls = rollData.damages.flatMap(r => r.damageRoll);

    const html = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/damage.hbs", rollData);
    chatData.content = html;

    if (["gmroll", "blindroll"].includes(chatData.rollMode)) {
        chatData.whisper = ChatMessage.getWhisperRecipients("GM");
    } else if (chatData.rollMode === "selfroll") {
        chatData.whisper = [game.user];
    }

    ChatMessage.create(chatData);
}

/**
 * Post a "you need to reload" message to chat.
 * @param {object} rollData
 */
async function _emptyClipToChat(rollData) {
    let chatData = {
        user: game.user.id,
        content: await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/emptyMag.hbs", rollData),
        flags: {
            "dark-heresy.rollData": rollData
        }
    };
    ChatMessage.create(chatData);
}
