/**
 * Creature traits with mechanical effects (core rulebook, chapter IV «Черты»).
 *
 * Traits are plain items; their rating is taken from the name: «Природная броня (4)», «Fear (2)».
 * Russian and English names are recognised.
 * - Unnatural Characteristic (X): +X to the characteristic bonus (the larger of trait and the Unnatural field).
 * - Natural Armour (X) / Machine (X): +X armour on all locations; the two do not stack (the larger counts).
 * - Size (X): replaces the actor's size (movement); attacks against it get the table 4-6 modifier.
 * - Daemonic (X): +X toughness bonus against damage, except force weapons, psychic powers, holy
 *   (Sanctified) attacks and attacks by other daemonic creatures.
 * - Fear (X): when the creature is in a started combat, players get a chat card with a Willpower test
 *   at the table 4-5 penalty. A character whose Insanity bonus is at least twice the rating is immune
 *   (core p. 353); a Daemonic or Warp-unstable source marks the test for Warp Shock.
 */

const RATED = {
    naturalArmour: /^(?:природная броня|natural armou?r)\s*\((\d+)\)/i,
    machine: /^(?:машина|machine)\s*\((\d+)\)/i,
    daemonic: /^(?:демоническ[а-яё]*|daemonic)\s*\((\d+)\)/i,
    size: /^(?:размер|size)\s*\((\d+)\)/i,
    fear: /^(?:страх|fear)\s*\((\d+)\)/i
};

// Longer names first: «Сила Воли» before «Сила». JS \w and \b do not know Cyrillic, hence explicit classes
const CHARACTERISTICS = [
    ["willpower", /сил[аыуе]\s+вол|willpower/i],
    ["weaponSkill", /навык[а-яё]*\s+(?:рукопаш|ближн)|weapon\s*skill/i],
    ["ballisticSkill", /навык[а-яё]*\s+стрельб|ballistic\s*skill/i],
    ["strength", /сил[аыуе](?![а-яё])|strength/i],
    ["toughness", /выносливост|toughness/i],
    ["agility", /ловкост|agility/i],
    ["intelligence", /интеллект|intelligence/i],
    ["perception", /восприяти|perception/i],
    ["fellowship", /общительност|fellowship/i]
];
const UNNATURAL = /^(?:сверхъестественн[а-яё]*|unnatural)\s+(.+)$/i;

export const FEAR_MODIFIER = { 1: 0, 2: -10, 3: -20, 4: -30 };

/**
 * The rating of a rated trait on an actor (0 if absent; the highest if repeated).
 * @param {Actor} actor
 * @param {string} key one of RATED
 * @returns {number}
 */
export function traitRating(actor, key) {
    let best = 0;
    for (const item of actor.items) {
        if (item.type !== "trait") continue;
        const m = item.name.trim().match(RATED[key]);
        if (m) best = Math.max(best, Number(m[1]));
    }
    return best;
}

/**
 * Unnatural characteristic ratings from traits: {strength: 3, ...}.
 * Accepts «Сверхъестественная Сила (3)», «Unnatural Strength (3)» and «Сверхъестественная характеристика (Сила 3)».
 * @param {Actor} actor
 * @returns {object}
 */
export function unnaturalRatings(actor) {
    const out = {};
    for (const item of actor.items) {
        if (item.type !== "trait") continue;
        const m = item.name.trim().match(UNNATURAL);
        if (!m) continue;
        const rest = m[1];
        const rating = Number((rest.match(/(\d+)\D*$/) ?? [])[1]);
        const found = CHARACTERISTICS.find(([, re]) => re.test(rest));
        if (found && rating > 0) out[found[0]] = Math.max(out[found[0]] ?? 0, rating);
    }
    return out;
}

/**
 * Armour all locations get from Natural Armour or Machine (they do not stack).
 * @param {Actor} actor
 * @returns {number}
 */
export function traitArmour(actor) {
    return Math.max(traitRating(actor, "naturalArmour"), traitRating(actor, "machine"));
}

/**
 * Hit modifier for attacks against an actor by its size (table 4-6): +10 per step above Average (4).
 * @param {Actor} actor
 * @returns {number}
 */
export function sizeHitModifier(actor) {
    const size = Number(actor?.size) || 4;
    return (size - 4) * 10;
}

/**
 * Does the Daemonic trait add to toughness against this attack?
 * @param {object} attack {psychic, special, attackerId}
 * @returns {boolean}
 */
export function daemonicApplies(attack) {
    if (!attack) return true;
    if (attack.psychic) return false;
    const special = String(attack.special ?? "");
    if (/психосилов|\bforce\b/i.test(special)) return false;
    if (/освящ[её]нн|sanctified/i.test(special)) return false;
    const attacker = attack.attackerId ? game.actors.get(attack.attackerId) : null;
    if (attacker && traitRating(attacker, "daemonic") > 0) return false;
    return true;
}

/* -------------------------------------------- */
/*  Fear                                        */
/* -------------------------------------------- */

/**
 * Post a fear card for combatants with Fear that have not been announced in this combat (active GM only).
 * @param {Combat} combat
 */
async function announceFear(combat) {
    if (game.user !== game.users.activeGM || !combat?.started) return;
    const announced = new Set(combat.getFlag("dark-heresy", "fearAnnounced") ?? []);
    const fresh = [];
    for (const c of combat.combatants) {
        if (announced.has(c.id) || c.token?.hidden || !c.actor) continue;
        const rating = traitRating(c.actor, "fear");
        if (!rating) continue;
        fresh.push(c.id);
        const modifier = FEAR_MODIFIER[Math.min(rating, 4)] ?? -30;
        const content = await foundry.applications.handlebars.renderTemplate("systems/dark-heresy/template/chat/fear.hbs",
            { name: c.token?.name ?? c.actor.name, rating, modifier, modifierText: modifier >= 0 ? `+${modifier}` : `${modifier}` });
        await ChatMessage.create({ content, flags: { "dark-heresy.fear": { rating, modifier, name: c.token?.name ?? c.actor.name,
            warp: isWarpEntity(c.actor) } } });
    }
    if (fresh.length) await combat.setFlag("dark-heresy", "fearAnnounced", [...announced, ...fresh]);
}

/**
 * Fear card button: Willpower test with the fear modifier for the user's selected token or character.
 * @param {Event} event
 * @param {Function} prepareCommonRoll
 * @param {object} DarkHeresyUtil
 */
export function onFearClick(event, prepareCommonRoll, DarkHeresyUtil) {
    event.preventDefault();
    const id = event.currentTarget.closest(".message")?.dataset.messageId;
    const fear = game.messages.get(id)?.getFlag("dark-heresy", "fear");
    const actor = game.macro.getActor();
    if (!fear) return;
    if (!actor) {
        ui.notifications.warn(game.i18n.localize("NOTIFICATION.MACRO_ACTOR_NOT_FOUND"));
        return;
    }
    // Insanity bonus (core p. 353): twice the Fear rating or more and the source no longer frightens
    const bonus = fearInsanityBonus(actor);
    if (bonus >= 2 * fear.rating) {
        ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div class="dark-heresy chat roll"><div class="background border"><p>${foundry.utils.escapeHTML(
                game.i18n.format("FEAR.IMMUNE", { name: actor.name, source: fear.name, rating: fear.rating, bonus }))}</p></div></div>` });
        return;
    }
    const rollData = DarkHeresyUtil.createFearTestRolldata(actor);
    rollData.target.modifier = fear.modifier;
    rollData.name = game.i18n.format("FEAR.TEST_NAME", { name: fear.name, rating: fear.rating });
    // fear cards are posted only in a started combat; warp: Warp Shock corruption (p. 353)
    rollData.fear = { rating: fear.rating, combat: true, warp: Boolean(fear.warp) };
    prepareCommonRoll(rollData);
}

/**
 * Insanity bonus against Fear (core p. 353): tens of Insanity points; the Exorcised background counts it
 * 2 higher (Enemies Beyond p. 30, «Затронутый Демоном»).
 * @param {Actor} actor
 * @returns {number}
 */
export function fearInsanityBonus(actor) {
    const bonus = Math.floor((Number(actor.system?.insanity) || 0) / 10);
    const exorcised = /вычищенн|exorcised/i.test(actor.system?.bio?.background ?? "");
    return bonus + (exorcised ? 2 : 0);
}

/**
 * Is the actor an entity of the Warp (Daemonic or Warp Instability trait)?
 * @param {Actor} actor
 * @returns {boolean}
 */
export function isWarpEntity(actor) {
    return traitRating(actor, "daemonic") > 0
        || Boolean(actor?.items?.some(i => i.type === "trait" && /варп-?\s*нестабильн|warp\s+instability/i.test(i.name)));
}

/** Register fear announcements; call during init. */
export function registerTraits() {
    // combatStart fires before the combat is marked started; the round/turn update comes right after
    Hooks.on("updateCombat", (combat, changes) => {
        if ("round" in changes || "turn" in changes) announceFear(combat);
    });
    Hooks.on("createCombatant", combatant => announceFear(combatant.parent));
    Hooks.on("updateToken", (token, changes) => {
        if (changes.hidden === false && token.combatant) announceFear(token.combatant.parent);
    });
}
