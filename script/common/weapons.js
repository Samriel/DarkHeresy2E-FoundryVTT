/**
 * Weapons on the attack roll (core rulebook): Weapon Training, jams, overheating.
 *
 * - Weapon Training (p. 153; table 7-5, p. 285): attacking with a weapon without the talent of its
 *   group gives −20. Heavy weapons need both Weapon Training (Heavy) and the group of the weapon;
 *   exotic weapons need Exotic Weapon Training for the particular weapon (and Heavy if heavy).
 *   Grenades need no training (p. 191). Force weapons count as low-tech (p. 180).
 * - Jams (p. 277): an unmodified 96–100 on a ranged attack, 94–100 on Semi-Auto / Full Auto bursts
 *   (pp. 272, 275). Reliable jams only on 100 and never with Spray or without an attack roll;
 *   Unreliable jams on 91+ even on bursts (p. 179). A jam is an automatic miss and the weapon cannot
 *   fire until cleared: a Full Action Ballistic Skill test; on success the weapon is cleared but
 *   must be reloaded (the ammunition in it is lost). Grenades and launchers misfire instead (p. 191):
 *   1d10, on a 10 the explosive detonates on the attacker (in the barrel of a launcher, which is
 *   destroyed).
 * - Overheats (p. 180): on 91+ the weapon overheats instead of ever jamming. The wielder suffers
 *   the weapon's damage with penetration 0 to the arm holding it (a random arm for two-handed
 *   weapons) unless he drops it as a Free Action; the weapon cannot be used until the second round
 *   after overheating.
 * State lives on the weapon item: flags «dark-heresy.jammed» and «dark-heresy.overheated» {combatId, round}.
 */
import { qualityValue } from "./qualities.js";

/** Forced deletion of a key in an update (v14 operator). */
const del = () => new foundry.data.operators.ForcedDeletion();

// Weapon Training specialisation (text in the talent's brackets) by weapon type, Russian and English
export const TRAINING = {
    bolt: /^(?:болт|bolt)/i, chain: /^(?:цепн|chain)/i, flame: /^(?:зажиг|огн|flame)/i, heavy: /^(?:тяж|heavy)/i,
    las: /^(?:лазер|las(?:er)?\b)/i, launcher: /^(?:пусков|launcher)/i, melta: /^(?:мельт|melta)/i,
    plasma: /^(?:плазм|plasma)/i, power: /^(?:силов|power)/i, lowtech: /^(?:низкотех|low.?tech)/i,
    shock: /^(?:шоков|shock)/i, solidprojectile: /^(?:тв[её]рдотел|solid)/i
};

// Weapon types that use the training of another group or need none
const TYPE_TRAINING = { force: "lowtech", explosive: null };

const WEAPON_TRAINING = /(?:выучка с оружием|weapon training)/i;
const EXOTIC_TRAINING = /(?:выучка с экзотическим оружием|exotic weapon training)/i;
const UNARMED = /(?:безоружн|unarmed)/i;

/** Specialisations named by a training talent: «Выучка с Оружием (Лазерное, Болтерное)» → ["лазерное", "болтерное"]. */
function specialisations(name, phrase) {
    const inBrackets = String(name).match(/\(([^)]*)\)/)?.[1];
    const text = inBrackets ?? String(name).replace(phrase, "").replace(/^[\s:–—-]+/, "");
    return text.split(/\s*[,/;]\s*/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

function hasTraining(actor, group) {
    const re = TRAINING[group];
    return actor.items.some(i => i.type === "talent" && WEAPON_TRAINING.test(i.name) && !EXOTIC_TRAINING.test(i.name)
        && specialisations(i.name, WEAPON_TRAINING).some(s => re.test(s)));
}

function hasExoticTraining(actor, weaponName) {
    const weapon = String(weaponName).toLowerCase().replace(/ё/g, "е");
    return actor.items.some(i => i.type === "talent" && EXOTIC_TRAINING.test(i.name)
        && specialisations(i.name, EXOTIC_TRAINING).some(spec => {
            const stems = spec.replace(/ё/g, "е").split(/\s+/).filter(w => w.length >= 4).map(w => w.slice(0, 4));
            return stems.length > 0 && stems.every(stem => weapon.includes(stem));
        }));
}

/**
 * Does the actor track Weapon Training at all? Acolytes always; NPCs only when they have some
 * training talent (many NPC profiles list no talents, they should not get −20 on everything).
 * @param {Actor} actor
 * @returns {boolean}
 */
function tracksTraining(actor) {
    if (actor.type !== "npc") return true;
    return actor.items.some(i => i.type === "talent" && (WEAPON_TRAINING.test(i.name) || EXOTIC_TRAINING.test(i.name)));
}

/**
 * Weapon Training check for a weapon.
 * @param {Actor} actor
 * @param {Item} weapon
 * @returns {{trained: boolean, missing: string[]}} missing: localised group names
 */
export function weaponTraining(actor, weapon) {
    const result = { trained: true, missing: [] };
    if (!actor || weapon?.type !== "weapon" || !tracksTraining(actor)) return result;
    // Unarmed attacks are not a weapon group
    if (UNARMED.test(weapon.system.special ?? "") || UNARMED.test(weapon.name)) return result;
    const type = weapon.system.type;
    const group = type in TYPE_TRAINING ? TYPE_TRAINING[type] : type;
    const label = key => game.i18n.localize(game.darkHeresy.config.weaponType[key] ?? game.darkHeresy.config.weaponClass[key] ?? key);
    if (group === "exotic") {
        if (!hasExoticTraining(actor, weapon.name)) result.missing.push(`${label("exotic")} (${weapon.name})`);
    } else if (group && TRAINING[group] && !hasTraining(actor, group)) {
        result.missing.push(label(group));
    }
    if (weapon.system.class === "heavy" && !hasTraining(actor, "heavy")) result.missing.push(label("heavy"));
    result.trained = result.missing.length === 0;
    return result;
}

/**
 * Has the actor Weapon Training for the weapon? (Spray dodge bonus, untrained penalty.)
 * @param {Actor} actor
 * @param {Item} weapon
 * @returns {boolean}
 */
export function isTrained(actor, weapon) {
    return weaponTraining(actor, weapon).trained;
}

/**
 * The weapon item of combat roll data: by uuid (token actors), otherwise the owner's item.
 * @param {object} rollData
 * @returns {Item|null}
 */
export function weaponOf(rollData) {
    const byUuid = rollData?.weaponUuid ? fromUuidSync(rollData.weaponUuid) : null;
    const item = byUuid ?? game.actors.get(rollData?.ownerId)?.items.get(rollData?.itemId) ?? null;
    return item?.type === "weapon" ? item : null;
}

/**
 * Untrained penalty for the attack dialog (mutates rollData.target.modifier).
 * @param {object} rollData
 * @param {Actor} actor
 * @returns {string[]} notes
 */
export function applyTrainingModifier(rollData, actor) {
    const weapon = weaponOf(rollData);
    if (!weapon || rollData.psy?.display) return [];
    const { trained, missing } = weaponTraining(actor ?? weapon.parent, weapon);
    if (trained) return [];
    rollData.target.modifier = (Number(rollData.target.modifier) || 0) - 20;
    rollData.untrained = true;
    return [game.i18n.format("WEAPON_TRAINING.NOTE", { training: missing.join(", ") })];
}

function isExplosive(weapon) {
    return weapon.system.type === "explosive";
}

/**
 * Lowest unmodified roll that jams the weapon, or null if it cannot jam on this attack.
 * @param {object} rollData
 * @param {Item} weapon
 * @returns {number|null}
 */
export function jamThreshold(rollData, weapon) {
    if (!rollData.weapon?.isRange || rollData.psy?.display || rollData.weapon.traits?.skipAttackRoll) return null;
    // Thrown blades and rocks do not jam; thrown grenades misfire
    if (weapon.system.class === "thrown" && !isExplosive(weapon)) return null;
    const special = rollData.weapon.special ?? "";
    if (qualityValue(special, "reliable")) return 100;
    if (qualityValue(special, "unreliable")) return 91;
    return ["semi_auto", "full_auto"].includes(rollData.attackType?.name) ? 94 : 96;
}

/**
 * Check the attack roll for a jam or overheating; updates the weapon and rollData.weaponJam.
 * A jam turns the attack into a miss. Call after the attack roll.
 * @param {object} rollData
 */
export async function checkWeaponJam(rollData) {
    const weapon = weaponOf(rollData);
    if (!weapon || rollData.psy?.display) return;
    const result = rollData.result;
    const special = rollData.weapon.special ?? "";
    const state = { jammed: false, overheated: false, misfire: null };
    if (qualityValue(special, "overheats")) {
        state.overheated = result >= 91;
    } else {
        const threshold = jamThreshold(rollData, weapon);
        state.jammed = threshold !== null && result >= threshold;
    }
    if (state.jammed) {
        rollData.flags.isSuccess = false;
        rollData.dos = 0;
        rollData.dof = Math.max(1, rollData.dof || 0);
        if (isExplosive(weapon) || weapon.system.type === "launcher") {
            const roll = await new Roll("1d10").evaluate();
            state.misfire = { result: roll.total, detonated: roll.total === 10, launcher: !isExplosive(weapon) };
        }
    }
    rollData.weaponJam = state.jammed || state.overheated ? state : null;
    const changes = {};
    // A spent grenade stays unjammed; a launcher that blew up is destroyed (left to the GM)
    const jamFlag = state.jammed && !isExplosive(weapon) && !state.misfire?.detonated;
    state.canUnjam = jamFlag;
    if (jamFlag) changes["flags.dark-heresy.jammed"] = true;
    else if (weapon.getFlag("dark-heresy", "jammed")) changes["flags.dark-heresy.jammed"] = del();
    if (state.overheated) {
        const combat = game.combat?.started ? game.combat : null;
        changes["flags.dark-heresy.overheated"] = { combatId: combat?.id ?? null, round: combat?.round ?? 0 };
    } else if (weapon.getFlag("dark-heresy", "overheated")) {
        changes["flags.dark-heresy.overheated"] = del();
    }
    if (Object.keys(changes).length && weapon.isOwner) await weapon.update(changes);
}

/**
 * Mark a weapon jammed after a spray jam (9 on a damage die, see area.js).
 * @param {object} rollData
 */
export async function setSprayJam(rollData) {
    const weapon = weaponOf(rollData);
    if (weapon?.isOwner) await weapon.setFlag("dark-heresy", "jammed", true);
}

/**
 * Round from which an overheated weapon can be used again, or null if it is usable now.
 * @param {Item} weapon
 * @returns {number|null}
 */
export function overheatedUntil(weapon) {
    const flag = weapon?.getFlag("dark-heresy", "overheated");
    const combat = game.combat;
    if (!flag?.combatId || !combat?.started || combat.id !== flag.combatId) return null;
    return combat.round < flag.round + 2 ? flag.round + 2 : null;
}

/**
 * Before the attack dialog: a jammed weapon offers to clear the jam, an overheated one refuses.
 * @param {object} rollData
 * @param {Actor} actor
 * @returns {boolean} true if the attack may go on
 */
export function weaponReady(rollData, actor) {
    const weapon = weaponOf(rollData);
    if (!weapon) return true;
    if (weapon.getFlag("dark-heresy", "jammed")) {
        Dialog.confirm({
            title: weapon.name,
            content: `<p>${game.i18n.format("WEAPON_JAM.IS_JAMMED", { weapon: weapon.name })}</p>`,
            yes: () => unjamWeapon(weapon, actor),
            no: () => {}
        });
        return false;
    }
    const until = overheatedUntil(weapon);
    if (until) {
        ui.notifications.warn(game.i18n.format("WEAPON_JAM.COOLING", { weapon: weapon.name, round: until }));
        return false;
    }
    return true;
}

let prepareCommonRollRef = null;
let createCharacteristicRollDataRef = null;
let replaceSymbolsRef = null;

/**
 * Clear a jam: Full Action Ballistic Skill test (untrained −20 applies, it is a test with the weapon).
 * @param {Item} weapon
 * @param {Actor} [actor]
 */
export function unjamWeapon(weapon, actor) {
    actor ??= weapon.parent;
    if (!actor || !weapon.getFlag("dark-heresy", "jammed")) return;
    const rollData = createCharacteristicRollDataRef(actor, "ballisticSkill");
    rollData.name = game.i18n.format("WEAPON_JAM.UNJAM_NAME", { weapon: weapon.name });
    rollData.target.modifier = isTrained(actor, weapon) ? 0 : -20;
    rollData.unjam = { weaponUuid: weapon.uuid, weapon: weapon.name };
    rollData.halfActions = 2;
    prepareCommonRollRef(rollData);
}

/** createChatMessage on the roller's client: a successful unjam test clears the jam and empties the clip. */
async function onUnjamResult(message) {
    if (message.author?.id !== game.user.id) return;
    const rollData = message.getFlag("dark-heresy", "rollData");
    if (!rollData?.unjam || !rollData.flags?.isSuccess) return;
    const weapon = fromUuidSync(rollData.unjam.weaponUuid);
    if (!weapon?.isOwner) return;
    await weapon.update({ "flags.dark-heresy.jammed": del(), "system.clip.value": 0 });
}

function messageOf(event) {
    return game.messages.get(event.currentTarget.closest(".message")?.dataset.messageId);
}

/** Chat button: clear the jam of the card's weapon. */
function onUnjamClick(event) {
    event.preventDefault();
    const weapon = weaponOf(messageOf(event)?.getRollData());
    if (!weapon?.isOwner) return ui.notifications.warn(game.i18n.localize("WEAPON_JAM.NOT_OWNER"));
    if (!weapon.getFlag("dark-heresy", "jammed")) return ui.notifications.info(game.i18n.format("WEAPON_JAM.NOT_JAMMED", { weapon: weapon.name }));
    unjamWeapon(weapon);
}

/** Chat button: the wielder of an overheated weapon suffers its damage, penetration 0, to an arm. */
async function onOverheatDamageClick(event) {
    event.preventDefault();
    const message = messageOf(event);
    const rollData = message?.getRollData();
    const weapon = weaponOf(rollData);
    const actor = weapon?.parent;
    if (!actor?.isOwner) return ui.notifications.warn(game.i18n.localize("WEAPON_JAM.NOT_OWNER"));
    if (message.getFlag("dark-heresy", "overheatApplied")) {
        return ui.notifications.info(game.i18n.localize("WEAPON_JAM.OVERHEAT_DONE"));
    }
    const formula = replaceSymbolsRef(`${rollData.weapon.damageFormula || "0"}+${Number(rollData.weapon.damageBonus) || 0}`, rollData);
    const roll = await new Roll(formula).evaluate();
    // Pistols are held in one hand (the right one by default); other weapons in both
    let location = "ARMOUR.RIGHT_ARM";
    if (weapon.system.class !== "pistol") {
        location = (await new Roll("1d2").evaluate()).total === 1 ? "ARMOUR.RIGHT_ARM" : "ARMOUR.LEFT_ARM";
    }
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        rolls: [roll],
        content: `<div class="dark-heresy chat roll"><div class="background border"><h1>${foundry.utils.escapeHTML(weapon.name)}</h1>
            <p>${game.i18n.format("WEAPON_JAM.OVERHEAT_DAMAGE_TEXT", { name: foundry.utils.escapeHTML(actor.name),
        damage: roll.total, location: game.i18n.localize(location) })}</p>${await roll.render()}</div></div>`
    });
    const type = { energy: "E", impact: "I", rending: "R", explosive: "X" }[rollData.weapon.damageType] ?? "E";
    await actor.applyDamage([{ amount: roll.total, location, penetration: 0, type, righteousFury: 0 }],
        { psychic: false, special: "", attackerId: actor.id });
    if (message.isOwner) await message.setFlag("dark-heresy", "overheatApplied", true);
}

/** Sheet button: clear the jam of a weapon row. */
function onSheetUnjam(event, actor) {
    event.preventDefault();
    event.stopPropagation();
    const weapon = actor.items.get(event.currentTarget.closest(".item")?.dataset.itemId);
    if (weapon) unjamWeapon(weapon, actor);
}

/**
 * Chat card listeners.
 * @param {HTMLElement} html
 */
export function weaponChatListeners(html) {
    html.querySelectorAll(".weapon-unjam")?.forEach(b => b.addEventListener("click", onUnjamClick));
    html.querySelectorAll(".weapon-overheat-damage")?.forEach(b => b.addEventListener("click", onOverheatDamageClick));
}

/**
 * Register hooks; call during init.
 * @param {object} deps {prepareCommonRoll, createCharacteristicRollData, replaceSymbols}
 */
export function registerWeapons({ prepareCommonRoll, createCharacteristicRollData, replaceSymbols }) {
    prepareCommonRollRef = prepareCommonRoll;
    createCharacteristicRollDataRef = createCharacteristicRollData;
    replaceSymbolsRef = replaceSymbols;
    Hooks.on("createChatMessage", onUnjamResult);
    Hooks.on("renderDarkHeresySheet", (sheet, html) => {
        const root = html instanceof HTMLElement ? html : html[0];
        root?.querySelectorAll(".weapon .sheet-unjam").forEach(b => b.addEventListener("click", ev => onSheetUnjam(ev, sheet.actor)));
    });
    game.darkHeresy.weaponTraining = weaponTraining;
    game.darkHeresy.unjamWeapon = unjamWeapon;
}
