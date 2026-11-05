/**
 * Situational attack modifiers against a single targeted token (core rulebook chapter VII, pp. 283–284).
 *
 * - Range band of ranged weapons by the distance between the tokens: point blank (2 m or less, not
 *   when engaged in melee with the target) +30; short (under half the range) +10; normal (up to
 *   twice the range) 0; long (over twice) −10; extreme (over three times) −30. Preselected in the
 *   attack dialog, the user can change it.
 * - Shooting into melee: −20 when another token of a different disposition stands next to the target.
 * - Prone target: +10 to melee attacks, −10 to ranged attacks except at point blank.
 * - Target size (table 4-6), see traits.js.
 */
import { sizeHitModifier } from "./traits.js";

const BANDS = [
    { mod: 30, key: "RANGE.POINT_BLANK" },
    { mod: 10, key: "RANGE.SHORT" },
    { mod: 0, key: "RANGE.NONE" },
    { mod: -10, key: "RANGE.LONG" },
    { mod: -30, key: "RANGE.EXTREME" }
];

/** Distance between two tokens in scene units, edge to edge on the grid (adjacent = 1 square). */
function distance(a, b) {
    const d = canvas.grid.measurePath([a.center, b.center]).distance;
    // measure between token edges for tokens bigger than one square
    const sizeAdjust = ((a.document.width - 1) + (b.document.width - 1)) / 2 * canvas.dimensions.distance;
    return Math.max(d - sizeAdjust, 0);
}

function adjacent(a, b) {
    return distance(a, b) <= canvas.dimensions.distance + 1e-6;
}

function signed(n) {
    return n > 0 ? `+${n}` : `${n}`;
}

/**
 * Range band for a distance and weapon range.
 * @param {number} dist
 * @param {number} range
 * @param {boolean} engaged attacker and target in melee
 * @returns {object|null} band
 */
export function rangeBand(dist, range, engaged) {
    if (!(range > 0)) return null;
    if (dist <= 2 && !engaged) return BANDS[0];
    if (dist < range / 2) return BANDS[1];
    if (dist <= range * 2) return BANDS[2];
    if (dist <= range * 3) return BANDS[3];
    return BANDS[4];
}

/**
 * Apply situational modifiers to combat roll data (mutates rollData).
 * @param {object} rollData
 * @param {Actor} actor attacker
 * @returns {string[]} notes for the dialog
 */
export function applySituationalModifiers(rollData, actor) {
    const notes = [];
    const target = game.user.targets.size === 1 ? [...game.user.targets][0] : null;
    if (!target?.actor || !canvas.ready) return notes;
    const attacker = canvas.tokens.controlled.find(t => t.actor?.id === actor?.id)
        ?? actor?.getActiveTokens?.()[0] ?? null;
    let modifier = 0;

    const size = sizeHitModifier(target.actor);
    if (size) {
        modifier += size;
        notes.push(game.i18n.format("SIZE.HIT_NOTE", { name: target.name, modifier: signed(size) }));
    }

    const prone = target.actor.statuses?.has("prone");
    if (attacker && attacker !== target) {
        const dist = distance(attacker, target);
        const engaged = adjacent(attacker, target);
        if (rollData.weapon.isRange) {
            const band = rangeBand(dist, Number(rollData.weapon.range) || 0, engaged);
            if (band) {
                rollData.rangeMod = band.mod;
                notes.push(game.i18n.format("RANGE.AUTO_NOTE", { distance: dist.toNearest(0.1),
                    band: game.i18n.localize(band.key), modifier: signed(band.mod) }));
            }
            // Another token of a different side next to the target (the attacker does not count)
            const melee = canvas.tokens.placeables.some(t => t !== target && t !== attacker && !t.document.hidden
                && t.document.disposition !== target.document.disposition && adjacent(t, target));
            if (melee) {
                modifier -= 20;
                notes.push(game.i18n.localize("RANGE.INTO_MELEE_NOTE"));
            }
            if (prone && band?.mod !== 30) {
                modifier -= 10;
                notes.push(game.i18n.format("RANGE.PRONE_NOTE", { modifier: "-10" }));
            }
        } else if (prone) {
            modifier += 10;
            notes.push(game.i18n.format("RANGE.PRONE_NOTE", { modifier: "+10" }));
        }
    }
    rollData.target.modifier = (Number(rollData.target.modifier) || 0) + modifier;
    return notes;
}
