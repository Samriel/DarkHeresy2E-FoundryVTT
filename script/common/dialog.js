import { commonRoll, combatRoll, reportEmptyClip } from "./roll.js";
import { applySituationalModifiers } from "./situational.js";
import { weaponReady } from "./weapons.js";
import { SUPPRESSION, canSuppress, applyPinnedPenalty } from "./pinning.js";

/**
 * Show a generic roll dialog.
 * @param {object} rollData
 */
export async function prepareCommonRoll(rollData) {
    const html = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/dialog/common-roll.hbs", rollData);
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
        const plain = { modifier: rollData.target.modifier };
        // Range band, size, shooting into melee and prone target of the single targeted token
        rollData.autoNotes = [...pinnedNotes, ...applySituationalModifiers(rollData, attacker)];
        const situational = { modifier: rollData.target.modifier, range: rollData.rangeMod };
        // Suppressing fire only with a weapon that fires the matching burst
        const attackTypes = Object.fromEntries(Object.entries(game.darkHeresy.config.attackTypeRanged)
            .filter(([key]) => !SUPPRESSION[key] || canSuppress(rollData, key)));
        const html = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/dialog/combat-roll.hbs",
            { ...rollData, attackTypesRanged: attackTypes });
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
    const html = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/dialog/psychic-power-roll.hbs", rollData);
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
                    rollData.flags.isDamageRoll = false;
                    rollData.flags.isCombatRoll = true;
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
        close: () => {}
    }, {width: 200});
    dialog.render(true);
}
