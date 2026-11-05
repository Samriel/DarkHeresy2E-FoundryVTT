/**
 * Cover (core rulebook p. 282, table 7-4 p. 283; Russian edition).
 *
 * The «cover» condition marks a character behind cover; its effect stores the cover's armour points and
 * the hit locations it hides (flag «dark-heresy.cover» = {ap, locations}). By default the legs and the body
 * are hidden, as for a character firing from cover. When the condition is switched on from the token HUD
 * the user picks the cover type (table 7-4: 4, 8, 12, 16 or 32 armour points) and the locations; the
 * «Cover» entry of the action menu does the same through the active GM.
 *
 * A hit on a hidden location adds the cover's armour points to the location's armour (penetration
 * applies once, to both). A hit that deals more damage than the cover's armour points wears it down by
 * one point; at 0 the cover is destroyed and the condition removed (p. 282). If several covers protect a
 * location the character uses one of them — the condition holds one cover.
 * Evading while in (partial) cover against the attacker: +10 (table 7-5, p. 285).
 */
import { registerOwnModifierSource, card } from "./conditions.js";
import { postWithOps, statusEffectOf } from "./ops.js";

const STATUS = "cover";
export const COVER_TYPES = [4, 8, 12, 16, 32];
const DEFAULT_LOCATIONS = ["body", "leftLeg", "rightLeg"];

/**
 * Cover data of an actor.
 * @param {Actor} actor
 * @returns {{ap: number, locations: string[], effect: ActiveEffect}|null}
 */
export function coverOf(actor) {
    const effect = statusEffectOf(actor, STATUS);
    if (!effect) return null;
    const flag = effect.getFlag("dark-heresy", "cover") ?? {};
    return { ap: Number(flag.ap) || 0, locations: flag.locations ?? DEFAULT_LOCATIONS, effect };
}

/**
 * Hit location key of a localisation key («ARMOUR.BODY» → «body»).
 * @param {string} label
 * @returns {string|undefined}
 */
function locationKey(label) {
    return Object.entries(game.darkHeresy.config.hitLocations).find(([, v]) => v === label)?.[0];
}

/**
 * Armour points of the cover protecting a hit location.
 * @param {Actor} actor
 * @param {string} location localisation key of the location (damage.location)
 * @returns {number}
 */
export function coverArmour(actor, location) {
    const cover = coverOf(actor);
    if (!cover?.ap) return 0;
    return cover.locations.includes(locationKey(location)) ? cover.ap : 0;
}

/**
 * Wear the cover down after the hits that went through it; announce it (called by Actor#applyDamage).
 * @param {Actor} actor
 * @param {number} worn points lost
 * @param {number} absorbed hits that hit the cover
 */
export async function wearCover(actor, worn, absorbed) {
    const cover = coverOf(actor);
    if (!cover || !absorbed) return;
    const ap = Math.max(0, cover.ap - worn);
    const name = foundry.utils.escapeHTML(actor.name);
    let text = game.i18n.format("COVER.ABSORBED", { name, hits: absorbed, ap: cover.ap });
    if (worn && ap > 0) {
        await cover.effect.update({ "flags.dark-heresy.cover.ap": ap, name: coverName(ap) });
        text += ` ${game.i18n.format("COVER.WORN", { ap })}`;
    } else if (worn) {
        await actor.toggleStatusEffect(STATUS, { active: false });
        text += ` ${game.i18n.localize("COVER.DESTROYED")}`;
    }
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: card(game.i18n.localize("COVER.TITLE"), `<p>${text}</p>`) });
}

/** Effect name with the armour points. */
function coverName(ap) {
    return `${game.i18n.localize("CONDITION.COVER")} (${ap})`;
}

/**
 * Ask for the cover type and the hidden locations.
 * @param {object} [current] {ap, locations}
 * @returns {Promise<{ap: number, locations: string[]}|null>}
 */
async function askCover(current = {}) {
    const ap = Number(current.ap) || 8;
    const locations = current.locations ?? DEFAULT_LOCATIONS;
    const types = COVER_TYPES.map(v => `<option value="${v}"${v === ap ? " selected" : ""}>${game.i18n.localize(`COVER.TYPE_${v}`)}</option>`).join("");
    const boxes = Object.entries(game.darkHeresy.config.hitLocations).map(([key, label]) => `<label class="checkbox">
        <input type="checkbox" name="loc.${key}"${locations.includes(key) ? " checked" : ""}> ${game.i18n.localize(label)}</label>`).join("");
    const data = await foundry.applications.api.DialogV2.input({
        window: { title: game.i18n.localize("COVER.TITLE") },
        content: `<div class="dh-combat-action-dialog">
            <div class="form-group"><label>${game.i18n.localize("COVER.TYPE")}</label><select name="type">${types}
                <option value="custom"${COVER_TYPES.includes(ap) ? "" : " selected"}>${game.i18n.localize("COVER.CUSTOM")}</option></select></div>
            <div class="form-group"><label>${game.i18n.localize("COVER.CUSTOM_AP")}</label><input type="number" name="custom" value="${ap}" min="1"></div>
            <p class="hint">${game.i18n.localize("COVER.LOCATIONS_HINT")}</p><div class="dh-cover-locations">${boxes}</div></div>`,
        rejectClose: false
    });
    if (!data) return null;
    const chosen = data.type === "custom" ? Number(data.custom) : Number(data.type);
    const locs = Object.keys(game.darkHeresy.config.hitLocations).filter(key => data[`loc.${key}`] ?? data.loc?.[key]);
    return { ap: Math.max(1, chosen || 1), locations: locs.length ? locs : DEFAULT_LOCATIONS };
}

/** createActiveEffect (creating user): a cover condition switched on without data asks for the type. */
async function onCreateEffect(effect, options, userId) {
    if (userId !== game.user.id || !effect.statuses?.has(STATUS) || effect.getFlag("dark-heresy", "cover")) return;
    const cover = await askCover();
    if (!cover) return effect.parent && effect.delete();
    await effect.update({ "flags.dark-heresy.cover": cover, name: coverName(cover.ap) });
}

/**
 * Take or change cover from the action menu (through the active GM).
 * @param {Actor} actor
 */
export async function takeCover(actor) {
    const current = coverOf(actor);
    const cover = await askCover(current ?? {});
    if (!cover) return;
    const names = cover.locations.map(k => game.i18n.localize(game.darkHeresy.config.hitLocations[k])).join(", ");
    await postWithOps({ speaker: ChatMessage.getSpeaker({ actor }),
        content: card(game.i18n.localize("COVER.TITLE"), `<p>${game.i18n.format("COVER.TAKEN", { name: foundry.utils.escapeHTML(actor.name), ap: cover.ap, locations: names })}</p>`) },
    [{ type: "status", uuid: actor.uuid, id: STATUS, flags: { cover }, name: coverName(cover.ap) }]);
}

/** Register hooks; call during init. */
export function registerCover() {
    Hooks.on("createActiveEffect", onCreateEffect);
    // Evading in cover: +10 (table 7-5)
    registerOwnModifierSource((actor, kind) => {
        if (kind !== "evasion" || !coverOf(actor)) return [];
        return [{ modifier: 10, note: game.i18n.format("COVER.EVASION_NOTE", { modifier: "+10" }) }];
    });
}
