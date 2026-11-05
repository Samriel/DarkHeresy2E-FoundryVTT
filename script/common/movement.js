/**
 * Movement by the DH2 rates (half / full / charge / run, see DarkHeresyActor#_computeMovement).
 *
 * The token ruler colours the path by the rate it falls into and names the rate in the label.
 * In a started combat Foundry records the movement history of combatants and clears it at every
 * turn start, so the measured distance is everything the token moved this turn. Non-GM users
 * cannot end a move beyond the run distance during combat (setting «limitMovement»).
 */

export const MOVEMENT_BANDS = [
    { key: "half", label: "MOVEMENT.HALF", color: 0x2e9e44 },
    { key: "full", label: "MOVEMENT.FULL", color: 0xd8b21e },
    { key: "charge", label: "MOVEMENT.CHARGE", color: 0xe0761b },
    { key: "run", label: "MOVEMENT.RUN", color: 0xc4291c }
];
const BEYOND = { key: "beyond", label: "MOVEMENT.BEYOND", color: 0x555555 };

/**
 * The movement band for a distance moved by an actor.
 * @param {Actor} actor
 * @param {number} distance
 * @returns {object|null} band, or null when the actor has no movement rates
 */
export function movementBand(actor, distance) {
    const rates = actor?.system?.movement;
    if (!rates || !(rates.run > 0)) return null;
    return MOVEMENT_BANDS.find(b => distance <= rates[b.key] + 1e-6) ?? BEYOND;
}

export class DarkHeresyTokenRuler extends foundry.canvas.placeables.tokens.TokenRuler {

    /** @override */
    _getSegmentStyle(waypoint) {
        const style = super._getSegmentStyle(waypoint);
        const band = movementBand(this.token.actor, waypoint.measurement.distance);
        if (band && style.width > 0) style.color = band.color;
        return style;
    }

    /** @override */
    _getGridHighlightStyle(waypoint, offset) {
        const style = super._getGridHighlightStyle(waypoint, offset);
        const band = movementBand(this.token.actor, waypoint.measurement.distance);
        if (band && (style.alpha ?? 0.5) > 0) style.color = band.color;
        return style;
    }

    /** @override */
    _getWaypointLabelContext(waypoint, state) {
        const context = super._getWaypointLabelContext(waypoint, state);
        const band = context && movementBand(this.token.actor, waypoint.measurement.distance);
        if (band) {
            const name = game.i18n.localize(band.label);
            if (context.cost) context.cost.units = `${context.cost.units} · ${name}`;
            else context.units = `${context.units} · ${name}`;
        }
        return context;
    }
}

/**
 * preMoveToken: during a started combat a non-GM user cannot move a token past its run distance this turn.
 * @param {TokenDocument} token
 * @param {object} move
 * @returns {boolean|void}
 */
function limitMovement(token, move) {
    if (game.user.isGM || !game.settings.get("dark-heresy", "limitMovement")) return;
    if (!token.combatant?.parent?.started) return;
    const run = token.actor?.system?.movement?.run;
    if (!(run > 0)) return;
    const total = (move.history?.distance ?? 0) + (move.passed?.distance ?? 0) + (move.pending?.distance ?? 0);
    if (total > run + 1e-6) {
        ui.notifications.warn(game.i18n.format("MOVEMENT.TOO_FAR", { name: token.name, run, total: total.toNearest(0.1) }));
        return false;
    }
}

/** Register the ruler, the setting and the movement limit; call during init. */
export function registerMovement() {
    CONFIG.Token.rulerClass = DarkHeresyTokenRuler;
    game.settings.register("dark-heresy", "limitMovement", {
        name: "MOVEMENT.SETTING_LIMIT",
        hint: "MOVEMENT.SETTING_LIMIT_HINT",
        scope: "world",
        config: true,
        default: true,
        type: Boolean
    });
    Hooks.on("preMoveToken", limitMovement);
}
