import { commonRoll, combatRoll, reportEmptyClip } from "./roll.js";
import { applySituationalModifiers } from "./situational.js";
import { weaponReady, weaponOf } from "./weapons.js";
import { SUPPRESSION, canSuppress, applyPinnedPenalty } from "./pinning.js";
import { applyOwnConditions, rollActor, feintTarget } from "./conditions.js";
import { twoWeaponOption, applyTwoWeapon } from "./two-weapon.js";
import { psychicDialogInfo } from "./psychic.js";
import { offerFateBonus, applyFateBonus } from "./fate.js";
import { talentDialogData, applyTalents, watchTalentBlock, hasTalent } from "./talents.js";

// Melee attack types that need a talent: Swift Attack (core p. 151), Lightning Attack (p. 159)
const TALENT_ATTACKS = { swift: "swiftAttack", lightning: "lightningAttack" };

/**
 * Show a generic roll dialog.
 * @param {object} rollData
 */
export async function prepareCommonRoll(rollData) {
    // Prone, pinned, guarded action… of the roller himself (re-rolls keep the modifier already applied)
    if (rollData.target && !rollData.flags?.isReRoll) rollData.autoNotes = applyOwnConditions(rollData, rollActor(rollData));
    offerFateBonus(rollData);
    // Talents that apply by themselves and the ones that can be activated (talents.js)
    rollData.talentDialog = rollData.isReRoll ? null : talentDialogData(rollData);
    const html = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/dialog/common-roll.hbs", rollData);
    delete rollData.talentDialog;
    let dialog = new Dialog({
        title: game.i18n.localize(rollData.name),
        content: html,
        buttons: {
            roll: {
                icon: '<i class="fas fa-check"></i>',
                label: game.i18n.localize("BUTTON.ROLL"),
                callback: async html => {
                    if (rollData.flags?.isEvasion) {
                        const skill = html.find("#selectedSkill")[0];
                        if (skill) {
                            rollData.name = game.i18n.localize(skill.options[skill.selectedIndex].text);
                            rollData.evasions.selected = skill.value;
                        }
                    } else {
                        rollData.name = game.i18n.localize(rollData.name);
                        rollData.target.base = parseInt(html.find("#target")[0].value, 10);
                        rollData.rolledWith = html.find("[name=characteristic] :selected").text();
                    }
                    rollData.target.modifier = parseInt(html.find("#modifier")[0].value, 10);
                    rollData.flags.isDamageRoll = false;
                    rollData.flags.isCombatRoll = false;
                    await applyTalents(rollData, html);
                    await applyFateBonus(rollData, html);
                    await commonRoll(rollData);
                }
            },
            cancel: {
                icon: '<i class="fas fa-times"></i>',
                label: game.i18n.localize("BUTTON.CANCEL"),
                callback: () => {}
            }

        },
        default: "roll",
        close: () => {},
        render: html => {
            const sel = html.find("select[name=characteristic");
            const target = html.find("#target");
            sel.change(() => {
                target.val(sel.val());
            });
            watchTalentBlock(html, rollData, (copy, h) => {
                if (copy.flags?.isEvasion) copy.evasions.selected = h.find("#selectedSkill").val() ?? copy.evasions.selected;
                else copy.target.base = parseInt(h.find("#target").val(), 10) || copy.target.base;
            });
        }
    }, {
        width: 200
    });
    dialog.render(true);
}

/**
 * Show a combat roll dialog.
 * @param {object} rollData
 * @param {DarkHeresyActor} actorRef
 */
export async function prepareCombatRoll(rollData, actorRef) {
    actorRef ??= game.actors.get(rollData.ownerId);
    // A jammed weapon offers to clear the jam instead, an overheated one is cooling down
    if (!weaponReady(rollData, actorRef)) return;
    if (rollData.weapon.isRange && rollData.weapon.clip.value <= 0) {
        reportEmptyClip(rollData);
    } else {
        const attacker = actorRef ?? game.actors.get(rollData.ownerId);
        const pinnedNotes = applyPinnedPenalty(rollData, attacker);
        // Conditions of the attacker himself (prone, guarded action…)
        const ownNotes = applyOwnConditions(rollData, rollActor(rollData) ?? attacker);
        const plain = { modifier: rollData.target.modifier };
        // Range band, size, shooting into melee and prone target of the single targeted token
        rollData.autoNotes = [...pinnedNotes, ...ownNotes, ...applySituationalModifiers(rollData, attacker)];
        const situational = { modifier: rollData.target.modifier, range: rollData.rangeMod };
        // Only the attack types the weapon's rate of fire allows (S/B/F); suppressing fire likewise
        // roll data carries only burst/full; the single-shot rate is on the weapon item
        const rof = attacker?.items.get(rollData.itemId)?.system?.rateOfFire ?? rollData.weapon.rateOfFire ?? {};
        const needs = { standard: "single", called_shot: "single", semi_auto: "burst", full_auto: "full" };
        let attackTypes = Object.fromEntries(Object.entries(game.darkHeresy.config.attackTypeRanged)
            .filter(([key]) => (SUPPRESSION[key] ? canSuppress(rollData, key)
                : !needs[key] || Number(rof[needs[key]]) > 0)));
        // A weapon without any rate of fire keeps the full list rather than an empty one
        if (!Object.keys(attackTypes).some(key => key !== "none")) attackTypes = game.darkHeresy.config.attackTypeRanged;
        if (rollData.weapon.isRange && !(rollData.attackType?.name in attackTypes)) {
            rollData.attackType = { ...rollData.attackType, name: Object.keys(attackTypes).find(key => key !== "none") };
        }
        const attacking = rollActor(rollData) ?? attacker;
        const attackTypesMelee = Object.fromEntries(Object.entries(game.darkHeresy.config.attackTypeMelee)
            .filter(([key]) => !TALENT_ATTACKS[key] || hasTalent(attacking, TALENT_ATTACKS[key])));
        if (rollData.weapon.isMelee && !(rollData.attackType?.name in attackTypesMelee)) {
            rollData.attackType = { ...rollData.attackType, name: "standard" };
        }
        offerFateBonus(rollData);
        // Two-Weapon Wielder: offer the second-weapon attack (core p. 281)
        rollData.twoWeaponOption = twoWeaponOption(rollActor(rollData) ?? attacker, rollData);
        const html = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/dialog/combat-roll.hbs",
            { ...rollData, attackTypesRanged: attackTypes, attackTypesMelee, talentDialog: talentDialogData(rollData) });
        let dialog = new Dialog({
            title: rollData.name,
            content: html,
            buttons: {
                roll: {
                    icon: '<i class="fas fa-check"></i>',
                    label: game.i18n.localize("BUTTON.ROLL"),
                    callback: async html => {
                        rollData.name = game.i18n.localize(rollData.name);
                        rollData.target.base = parseInt(html.find("#target")[0]?.value, 10);
                        rollData.target.modifier = parseInt(html.find("#modifier")[0]?.value, 10);
                        const range = html.find("#range")[0];
                        if (range) {
                            rollData.rangeMod = parseInt(range.value, 10);
                            rollData.rangeModText = range.options[range.selectedIndex].text;
                        }

                        const attackType = html.find("#attackType")[0];
                        rollData.attackType = {
                            name: attackType?.value,
                            text: attackType?.options[attackType.selectedIndex].text,
                            modifier: 0
                        };
                        // Standard Attack after a won Feint: the target cannot evade it (core p. 270)
                        const feint = rollData.attackType.name === "standard" ? feintTarget(rollActor(rollData) ?? actorRef) : null;
                        if (feint && game.user.targets.size === 1 && [...game.user.targets][0].id === feint) rollData.feint = feint;
                        else delete rollData.feint;
                        const twoWeaponWarnings = applyTwoWeapon(rollData, html.find("#twoWeapon")[0]?.checked, weaponOf(rollData));
                        twoWeaponWarnings.forEach(w => ui.notifications.warn(w));
                        const calledShot = html.find("#calledShot")[0];
                        rollData.calledShot = attackType?.value === "called_shot" && calledShot
                            ? game.darkHeresy.config.hitLocations[calledShot.value] : null;

                        const aim = html.find("#aim")[0];
                        rollData.aim = {
                            val: parseInt(aim?.value, 10),
                            base: parseInt(aim?.value, 10), // chosen aim before Accurate/Inaccurate, for the action cost
                            isAiming: aim?.value !== "0",
                            text: aim?.options[aim.selectedIndex].text
                        };

                        if (rollData.weapon.traits.inaccurate) {
                            rollData.aim.val=0;
                        } else if (rollData.weapon.traits.accurate && rollData.aim.isAiming) {
                            rollData.aim.val += 10;
                        }

                        let ammo = actorRef.items.get(html.find("#ammo")[0]?.value);

                        rollData.weapon.damageFormula = `${html.find("#damageFormula")[0].value.replace(" ", "")}${ammo?.system.effect.damage.modifier ? `+${ammo?.system.effect.damage.modifier}`: ""}`;
                        rollData.weapon.damageType = html.find("#damageType")[0].value;
                        rollData.weapon.damageBonus = parseInt(html.find("#damageBonus")[0].value, 10);
                        rollData.weapon.penetrationFormula = `${html.find("#penetration")[0].value}${ammo?.system.effect.penetration ? `+${ammo?.system.effect.penetration}`: ""}`;
                        rollData.flags.isDamageRoll = false;
                        rollData.flags.isCombatRoll = true;

                        if (rollData.weapon.traits.skipAttackRoll) {
                            rollData.attackType.name = "standard";
                        }

                        await applyTalents(rollData, html);
                        await applyFateBonus(rollData, html);
                        await combatRoll(rollData);
                    }
                },
                cancel: {
                    icon: '<i class="fas fa-times"></i>',
                    label: game.i18n.localize("BUTTON.CANCEL"),
                    callback: () => {}
                }
            },
            default: "roll",
            close: () => {},
            render: html => {
                // Called shot: show the hit location choice
                const type = html.find("#attackType");
                const location = html.find(".called-shot-location");
                const toggle = () => location.toggle(type.val() === "called_shot");
                type.on("change", toggle);
                toggle();
                // Suppressing fire ignores the single-target modifiers: random targets in the zone
                type.on("change", () => {
                    const suppressing = Boolean(SUPPRESSION[type.val()]);
                    html.find("#modifier").val(suppressing ? plain.modifier : situational.modifier);
                    html.find("#range").val(suppressing ? "0" : String(situational.range ?? 0));
                });
                watchTalentBlock(html, rollData, (copy, h) => {
                    copy.attackType = { ...copy.attackType, name: h.find("#attackType").val() ?? copy.attackType?.name };
                    const range = h.find("#range").val();
                    if (range !== undefined) copy.rangeMod = parseInt(range, 10);
                    const aim = h.find("#aim").val();
                    copy.aim = { val: parseInt(aim, 10) || 0, isAiming: aim !== undefined && aim !== "0" };
                });
            }
        }, {width: 200});
        dialog.render(true);
    }
}

/**
 * Show a psychic power roll dialog.
 * @param {object} rollData
 */
export async function preparePsychicPowerRoll(rollData) {
    // Sustained powers, opposed test, range and distance to a single target (psychic.js)
    const info = psychicDialogInfo(rollData);
    rollData.autoNotes = info.notes;
    offerFateBonus(rollData);
    rollData.talentDialog = talentDialogData(rollData);
    const html = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/dialog/psychic-power-roll.hbs", rollData);
    delete rollData.talentDialog;
    let dialog = new Dialog({
        title: rollData.name,
        content: html,
        buttons: {
            roll: {
                icon: '<i class="fas fa-check"></i>',
                label: game.i18n.localize("BUTTON.ROLL"),
                callback: async html => {
                    rollData.name = game.i18n.localize(rollData.name);
                    rollData.target.base = parseInt(html.find("#target")[0]?.value, 10);
                    rollData.target.modifier = parseInt(html.find("#modifier")[0]?.value, 10);
                    rollData.psy.value = parseInt(html.find("#psy")[0].value, 10);
                    rollData.psy.warpConduit = html.find("#warpConduit")[0].checked;
                    rollData.weapon.damageFormula = html.find("#damageFormula")[0].value;
                    rollData.weapon.damageType = html.find("#damageType")[0].value;
                    rollData.weapon.damageBonus = parseInt(html.find("#damageBonus")[0].value, 10);
                    rollData.weapon.penetrationFormula = html.find("#penetration")[0].value;
                    rollData.weapon.rateOfFire = { burst: rollData.psy.value, full: rollData.psy.value };
                    const attackType = html.find("#attackType")[0];
                    rollData.attackType.name = attackType.value;
                    rollData.attackType.text = attackType.options[attackType.selectedIndex].text;
                    rollData.psy.useModifier = true;
                    rollData.flags.isAttack = attackType.value !== "none";
                    rollData.flags.isDamageRoll = false;
                    rollData.flags.isCombatRoll = true;
                    // Targets of an opposed power, for the opposed test buttons on the card
                    if (rollData.psy.opposed) {
                        rollData.psy.targets = [...game.user.targets].filter(t => t.actor).map(t => ({
                            tokenId: t.id, sceneId: t.scene?.id ?? canvas.scene?.id, name: t.name }));
                    }
                    await applyTalents(rollData, html);
                    await applyFateBonus(rollData, html);
                    await combatRoll(rollData);
                }
            },
            cancel: {
                icon: '<i class="fas fa-times"></i>',
                label: game.i18n.localize("BUTTON.CANCEL"),
                callback: () => {}
            }
        },
        default: "roll",
        close: () => {},
        render: html => {
            watchTalentBlock(html, rollData, (copy, h) => {
                copy.psy = { ...copy.psy, value: parseInt(h.find("#psy").val(), 10) || copy.psy?.value };
                const type = h.find("#attackType").val();
                if (type) copy.attackType = { ...copy.attackType, name: type };
            });
            const text = html.find(".psy-range-text");
            const warning = html.find(".psy-range-warning");
            const refresh = event => {
                const source = event?.target?.id === "rating" ? event.target : html.find("#psy")[0];
                const pr = parseInt(source?.value, 10) || 0;
                const { text: line, warning: warn } = info.update(pr);
                text.text(line);
                warning.find("strong").text(warn);
                warning.toggle(Boolean(warn));
            };
            html.find("#rating, #psy").on("input change", refresh);
            refresh();
        }
    }, {width: 200});
    dialog.render(true);
}
