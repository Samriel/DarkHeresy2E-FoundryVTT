/**
 * Combat circumstances of the surroundings (core rulebook pp. 283, 285; Russian edition), in the attack dialog.
 *
 * - Darkness (p. 283): −20 to Weapon Skill, −30 to Ballistic Skill. «Auto» (default): the target stands in a
 *   darkness source, or where the darkness level is 0.5 or more and no light reaches; an attacker whose
 *   token sees with darkvision or light amplification ignores it. The GM can force it on or off per scene.
 * - Fog, mist, shadow or smoke (p. 283): −20 to Ballistic Skill against the target (scene switch); does not
 *   stack with darkness, the larger penalty counts.
 * - Bad weather or unusual conditions (p. 285): −20 to WS and BS (scene switch).
 * - Difficult terrain (p. 283): −10 to Weapon Skill and Evasion tests of a character standing on it, −30 on
 *   very difficult terrain (deep snow, ice). Scene-wide setting, or a Region with a «Modify Movement Cost»
 *   behaviour under the token: walking cost over 1 counts as difficult, 3 or more as very difficult.
 * - Higher ground (p. 283): +10 to melee attacks from a higher elevation than the target.
 * - Ganging up (p. 283): melee attackers outnumbering their opponents two to one get +10, three to one +20.
 *   Counted around the target: tokens of the attacker's side next to the target (the attacker included)
 *   against tokens of the target's side next to the attacker (the target included); the dead, unconscious
 *   and hidden do not count.
 * The GM sets the scene switches with the «Combat environment» button of the token controls.
 */
import { registerOwnModifierSource } from "./conditions.js";

const FLAG = "environment";
const DEFAULTS = { darkness: "auto", fog: false, weather: false, terrain: 0 };
const SEE_IN_DARK = ["darkvision", "lightAmplification"];
const OUT = ["dead", "unconscious"];

/**
 * Environment settings of a scene.
 * @param {Scene} [scene]
 * @returns {object}
 */
export function sceneEnvironment(scene = canvas.scene) {
    return { ...DEFAULTS, ...(scene?.getFlag("dark-heresy", FLAG) ?? {}) };
}

const signed = n => (n > 0 ? `+${n}` : `${n}`);

/**
 * Is a token in darkness (auto detection)?
 * @param {Token} token
 * @returns {boolean}
 */
function inDarkness(token) {
    if (!canvas.effects) return false;
    const point = { x: token.center.x, y: token.center.y, elevation: token.document.elevation ?? 0 };
    try {
        if (canvas.effects.testInsideDarkness(point)) return true;
        return canvas.effects.getDarknessLevel(point) >= 0.5 && !canvas.effects.testInsideLight(point);
    } catch (err) {
        console.warn("dark-heresy | darkness test failed", err);
        return false;
    }
}

/**
 * Difficult terrain penalty under a token: the scene setting or a Modify Movement Cost region.
 * @param {Token|null} token
 * @returns {number} 0, −10 or −30
 */
export function terrainPenalty(token) {
    let penalty = Number(sceneEnvironment(token?.document?.parent ?? canvas.scene).terrain) || 0;
    for (const region of token?.document?.regions ?? []) {
        for (const behavior of region.behaviors ?? []) {
            if (behavior.disabled || behavior.type !== "modifyMovementCost") continue;
            const cost = Number(behavior.system?.difficulties?.walk) || 1;
            if (cost >= 3) penalty = Math.min(penalty, -30);
            else if (cost > 1) penalty = Math.min(penalty, -10);
        }
    }
    return penalty;
}

/** Not counted for ganging up: hidden, dead, unconscious. */
const counts = t => !t.document.hidden && !OUT.some(s => t.actor?.statuses?.has(s));

/**
 * Environment modifiers of an attack against a target token.
 * @param {object} rollData
 * @param {Token|null} attacker
 * @param {Token} target
 * @param {Function} adjacent (a, b) → boolean
 * @returns {{modifier: number, notes: string[]}} the parts are also kept in rollData.situationalParts (darkness, fog,
 *   weather, higher, outnumber: {modifier, allies: ids of the attacker's allies next to the target}) for talents
 */
export function environmentModifiers(rollData, attacker, target, adjacent) {
    const env = sceneEnvironment();
    const melee = Boolean(rollData.weapon?.isMelee);
    const ranged = Boolean(rollData.weapon?.isRange);
    const notes = [];
    const parts = rollData.situationalParts ??= {};
    let modifier = 0;
    const add = (part, mod, key, data = {}) => {
        modifier += mod;
        parts[part] = mod;
        notes.push(game.i18n.format(key, { ...data, modifier: signed(mod) }));
    };

    // Darkness and fog
    let dark = env.darkness === "on" || (env.darkness === "auto" && inDarkness(target));
    if (dark && attacker && SEE_IN_DARK.includes(attacker.document.sight?.visionMode)) {
        dark = false;
        notes.push(game.i18n.localize("ENVIRONMENT.DARKVISION_NOTE"));
    }
    if (dark && melee) add("darkness", -20, "ENVIRONMENT.DARKNESS_NOTE");
    else if (dark && ranged) add("darkness", -30, "ENVIRONMENT.DARKNESS_NOTE");
    else if (env.fog && ranged) add("fog", -20, "ENVIRONMENT.FOG_NOTE");
    if (env.weather && (melee || ranged)) add("weather", -20, "ENVIRONMENT.WEATHER_NOTE");

    if (melee && attacker && attacker !== target) {
        // Higher ground
        if ((attacker.document.elevation ?? 0) > (target.document.elevation ?? 0)) add("higher", 10, "ENVIRONMENT.HIGHER_NOTE");
        // Ganging up
        const allies = canvas.tokens.placeables.filter(t => t !== target && counts(t)
            && t.document.disposition === attacker.document.disposition && (t === attacker || adjacent(t, target)));
        const foes = canvas.tokens.placeables.filter(t => t !== attacker && counts(t)
            && t.document.disposition === target.document.disposition && (t === target || adjacent(t, attacker)));
        const ratio = allies.length / Math.max(1, foes.length);
        const bonus = ratio >= 3 ? 20 : ratio >= 2 ? 10 : 0;
        if (bonus) {
            add("outnumber", bonus, "ENVIRONMENT.OUTNUMBER_NOTE", { allies: allies.length, foes: Math.max(1, foes.length) });
            parts.outnumber = { modifier: bonus, allies: allies.filter(t => t !== attacker).map(t => t.id) };
        }
    }
    return { modifier, notes };
}

/* -------------------------------------------- */
/*  Scene settings                              */
/* -------------------------------------------- */

/** Dialog for the GM: environment switches of the viewed scene. */
export async function environmentDialog(scene = canvas.scene) {
    if (!scene || !game.user.isGM) return;
    const env = sceneEnvironment(scene);
    const option = (value, key, current) => `<option value="${value}"${String(current) === String(value) ? " selected" : ""}>${game.i18n.localize(key)}</option>`;
    const data = await foundry.applications.api.DialogV2.input({
        window: { title: `${game.i18n.localize("ENVIRONMENT.TITLE")}: ${scene.name}` },
        content: `<div class="dh-combat-action-dialog">
            <div class="form-group"><label>${game.i18n.localize("ENVIRONMENT.DARKNESS")}</label><select name="darkness">
                ${option("auto", "ENVIRONMENT.DARKNESS_AUTO", env.darkness)}${option("on", "ENVIRONMENT.ON", env.darkness)}${option("off", "ENVIRONMENT.OFF", env.darkness)}</select></div>
            <div class="form-group"><label>${game.i18n.localize("ENVIRONMENT.FOG")}</label><input type="checkbox" name="fog"${env.fog ? " checked" : ""}></div>
            <div class="form-group"><label>${game.i18n.localize("ENVIRONMENT.WEATHER")}</label><input type="checkbox" name="weather"${env.weather ? " checked" : ""}></div>
            <div class="form-group"><label>${game.i18n.localize("ENVIRONMENT.TERRAIN")}</label><select name="terrain">
                ${option(0, "ENVIRONMENT.TERRAIN_NONE", env.terrain)}${option(-10, "ENVIRONMENT.TERRAIN_DIFFICULT", env.terrain)}${option(-30, "ENVIRONMENT.TERRAIN_SEVERE", env.terrain)}</select></div>
            <p class="hint">${game.i18n.localize("ENVIRONMENT.HINT")}</p></div>`,
        rejectClose: false
    });
    if (!data) return;
    await scene.setFlag("dark-heresy", FLAG, { darkness: data.darkness, fog: Boolean(data.fog), weather: Boolean(data.weather),
        terrain: Number(data.terrain) || 0 });
}

/** Register hooks; call during init. */
export function registerEnvironment() {
    Hooks.on("getSceneControlButtons", controls => {
        const tokens = controls.tokens ?? controls.token;
        if (!tokens?.tools) return;
        tokens.tools.dhEnvironment = {
            name: "dhEnvironment",
            order: Object.keys(tokens.tools).length + 1,
            title: "ENVIRONMENT.TITLE",
            icon: "fa-solid fa-cloud-moon",
            visible: game.user.isGM,
            button: true,
            onChange: () => environmentDialog()
        };
    });
    // Difficult terrain under the character: −10/−30 to his WS and Evasion tests
    registerOwnModifierSource((actor, kind) => {
        if (!["melee", "ws", "evasion"].includes(kind) || !canvas.ready) return [];
        const token = actor.isToken ? actor.token?.object : (canvas.tokens.controlled.find(t => t.actor === actor) ?? actor.getActiveTokens()[0]);
        const penalty = terrainPenalty(token ?? null);
        return penalty ? [{ modifier: penalty, note: game.i18n.format("ENVIRONMENT.TERRAIN_NOTE", { modifier: signed(penalty) }) }] : [];
    });
    game.darkHeresy.environmentDialog = environmentDialog;
}
