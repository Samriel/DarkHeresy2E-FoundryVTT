/**
 * Area attacks: Blast (X) circles and Spray cones (core rulebook, weapon qualities; scatter p. 284).
 *
 * The area is drawn as a Region visible to everyone and every token inside becomes the attacker's
 * target, so «Apply Damage to Targets» hits them all with one damage roll.
 * - Blast: centred on the single targeted token, or on a point the user clicks. A failed attack
 *   scatters 1d5 m in a 1d10 direction of the direction diagram («2» points away from the attacker).
 * - Spray: a 30° cone from the attacker to the weapon's range, towards the single target or a clicked
 *   point. Targets may test Agility (+0, or +20 if the attacker lacks the matching Weapon Training);
 *   who passes is left out of the damage. A 9 on any damage die jams the weapon.
 * - Suppressing fire (pinning.js): a 30° or 45° cone drawn by the same coneArea.
 * Area regions are removed when the damage from the card is applied, at the next turn change, or
 * when the same user makes the next area attack.
 */

import { isTrained } from "./weapons.js";
import { confirmEvasion } from "./conditions.js";

const SOCKET = "system.dark-heresy";

// Direction diagram (core p. 284): angle in degrees from the attacker→target line, clockwise
const SCATTER_ANGLE = { 1: -45, 2: 0, 3: 45, 4: -90, 5: 90, 6: -135, 7: -135, 8: 180, 9: 135, 10: 135 };

const metresToPixels = metres => metres * canvas.dimensions.size / canvas.dimensions.distance;

/**
 * Let the user click a point on the canvas; resolves null on right click / Escape.
 * @param {string} hint notification text
 * @returns {Promise<{x:number,y:number}|null>}
 */
function pickPoint(hint) {
    ui.notifications.info(hint);
    return new Promise(resolve => {
        const done = point => {
            canvas.stage.off("pointerdown", onDown);
            document.removeEventListener("keydown", onKey);
            resolve(point);
        };
        const onDown = event => {
            if (event.button === 2) return done(null);
            const p = event.getLocalPosition(canvas.stage);
            done({ x: p.x, y: p.y });
        };
        const onKey = event => { if (event.key === "Escape") done(null); };
        canvas.stage.on("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
    });
}

function attackerToken(rollData) {
    if (rollData.tokenId) return canvas.tokens.get(rollData.tokenId) ?? null;
    return canvas.tokens.placeables.find(t => t.actor?.id === rollData.ownerId) ?? null;
}

function singleTargetCenter() {
    const targets = [...game.user.targets];
    return targets.length === 1 ? { ...targets[0].center } : null;
}

/**
 * Create the area region (removing this user's previous area regions) and target the tokens in it.
 * @param {object} shape region shape data
 * @param {Function} inside (token) => boolean
 * @param {string} label
 * @returns {Promise<string|null>} region id
 */
async function createArea(shape, inside, label) {
    await deleteAreas(r => r.getFlag("dark-heresy", "area")?.userId === game.user.id);
    const [region] = await canvas.scene.createEmbeddedDocuments("Region", [{
        name: label, color: game.user.color?.css ?? "#ff6400", shapes: [shape],
        visibility: CONST.REGION_VISIBILITY.ALWAYS, highlightMode: "shapes",
        flags: { "dark-heresy": { area: { userId: game.user.id } } }
    }]);
    const ids = canvas.tokens.placeables.filter(t => !t.document.hidden && inside(t)).map(t => t.id);
    canvas.tokens.setTargets(ids, { mode: "replace" });
    return region?.id ?? null;
}

/**
 * Blast (X) after an attack roll: circle at the target, scattered on a failed test.
 * @param {object} rollData
 * @param {number} radius metres
 * @param {object} [options]
 * @param {boolean} [options.self] centred on the attacker, who is left out (psychic blasts with range «Self»)
 * @returns {Promise<object|null>} {regionId, scatter, radius}
 */
export async function blastArea(rollData, radius, { self = false } = {}) {
    if (!canvas.ready || !(radius > 0)) return null;
    const own = attackerToken(rollData);
    let center = (self && own) ? { ...own.center }
        : singleTargetCenter() ?? await pickPoint(game.i18n.localize("AREA.PICK_BLAST"));
    if (!center) return null;
    let scatter = null;
    if (!rollData.flags.isSuccess) {
        const dir = (await new Roll("1d10").evaluate()).total;
        const dist = (await new Roll("1d5").evaluate()).total;
        const from = attackerToken(rollData)?.center;
        const base = from ? Math.atan2(center.y - from.y, center.x - from.x) : -Math.PI / 2;
        const angle = base + SCATTER_ANGLE[dir] * Math.PI / 180;
        center = { x: center.x + Math.cos(angle) * metresToPixels(dist), y: center.y + Math.sin(angle) * metresToPixels(dist) };
        scatter = { direction: dir, distance: dist };
    }
    const r = metresToPixels(radius);
    const regionId = await createArea({ type: "circle", x: center.x, y: center.y, radius: r },
        t => !(self && t === own) && Math.hypot(t.center.x - center.x, t.center.y - center.y) <= r + t.w / 2 - 1,
        `${rollData.itemName ?? rollData.name}: ${game.i18n.localize("AREA.BLAST")} (${radius})`);
    return { regionId, scatter, radius };
}

/**
 * A cone from the attacker towards the single target or a clicked point; tokens inside become targets.
 * @param {object} rollData
 * @param {object} options
 * @param {number} options.angle full opening angle in degrees
 * @param {number} options.length cone length in metres
 * @param {string} options.label region name
 * @param {string} [options.pickHint] notification shown when the user has to click the direction
 * @returns {Promise<object|null>} {regionId, tokenIds}
 */
export async function coneArea(rollData, { angle, length, label, pickHint }) {
    if (!canvas.ready) return null;
    const origin = attackerToken(rollData)?.center ?? await pickPoint(game.i18n.localize("AREA.PICK_ORIGIN"));
    if (!origin) return null;
    const aim = singleTargetCenter() ?? await pickPoint(pickHint ?? game.i18n.localize("AREA.PICK_SPRAY"));
    if (!aim) return null;
    const pixels = metresToPixels(Number(length) || 0);
    if (!(pixels > 0)) return null;
    const dir = Math.atan2(aim.y - origin.y, aim.x - origin.x);
    const half = angle / 2 * Math.PI / 180;
    const points = [origin.x, origin.y];
    for (let i = 0; i <= 12; i++) {
        const a = dir - half + (2 * half * i / 12);
        points.push(origin.x + Math.cos(a) * pixels, origin.y + Math.sin(a) * pixels);
    }
    const self = attackerToken(rollData);
    const regionId = await createArea({ type: "polygon", points }, t => {
        if (t === self) return false;
        const dx = t.center.x - origin.x, dy = t.center.y - origin.y;
        const d = Math.hypot(dx, dy);
        if (d > pixels + t.w / 2) return false;
        let delta = Math.atan2(dy, dx) - dir;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        return Math.abs(delta) <= half + Math.atan2(t.w / 2, Math.max(d, 1));
    }, label);
    return { regionId, tokenIds: [...game.user.targets].map(t => t.id) };
}

/**
 * Spray: 30° cone from the attacker to the weapon's range.
 * @param {object} rollData
 * @returns {Promise<object|null>} {regionId}
 */
export async function sprayArea(rollData) {
    const area = await coneArea(rollData, { angle: 30, length: Number(rollData.weapon.range) || 0,
        label: `${rollData.itemName ?? rollData.name}: ${game.i18n.localize("AREA.SPRAY")}` });
    return area ? { regionId: area.regionId } : null;
}

/**
 * Agility bonus for dodging a spray: +20 if the attacker lacks Weapon Training for the weapon type.
 * @param {object} rollData
 * @returns {number}
 */
export function sprayDodgeBonus(rollData) {
    const attacker = game.actors.get(rollData.ownerId);
    const weapon = attacker?.items.get(rollData.itemId);
    if (!attacker || weapon?.type !== "weapon") return 0;
    return isTrained(attacker, weapon) ? 0 : 20;
}

/**
 * Did any damage die show 9 before modifiers (spray jam)?
 * @param {object[]} damages rollData.damages with damageRoll Roll objects
 * @returns {boolean}
 */
export function sprayJammed(damages) {
    return damages.some(d => (d.damageRoll?.dice ?? []).some(die => die.results.some(r => r.result === 9)));
}

/**
 * Delete area regions matching a filter; non-GM users ask the active GM.
 * @param {Function} filter (region) => boolean
 */
export async function deleteAreas(filter) {
    const scene = canvas.scene;
    if (!scene) return;
    const ids = scene.regions.filter(r => r.getFlag("dark-heresy", "area") && filter(r)).map(r => r.id);
    if (!ids.length) return;
    if (game.user.isGM) await scene.deleteEmbeddedDocuments("Region", ids);
    else game.socket.emit(SOCKET, { type: "deleteRegions", sceneId: scene.id, ids });
}

/** Spray dodge button: Agility test for the user's token, linked to the damage card. */
export async function onSprayDodgeClick(event, prepareCommonRoll, DarkHeresyUtil) {
    event.preventDefault();
    const id = event.currentTarget.closest(".message")?.dataset.messageId;
    const message = game.messages.get(id);
    const rollData = message?.getRollData();
    const actor = game.macro.getActor();
    if (!rollData) return;
    if (!actor) {
        ui.notifications.warn(game.i18n.localize("NOTIFICATION.MACRO_ACTOR_NOT_FOUND"));
        return;
    }
    if (!(await confirmEvasion(actor, rollData))) return;
    const token = canvas.tokens.controlled.find(t => t.actor === actor) ?? canvas.tokens.placeables.find(t => t.actor === actor);
    const dodge = DarkHeresyUtil.createCharacteristicRollData(actor, "agility");
    dodge.target.modifier = sprayDodgeBonus(rollData);
    dodge.name = game.i18n.format("AREA.SPRAY_DODGE_NAME", { weapon: rollData.itemName ?? "" });
    dodge.sprayDodge = { messageId: message.id, tokenId: token?.id ?? null, actorId: actor.id };
    prepareCommonRoll(dodge);
}

async function onDodgeResult(message) {
    if (game.user !== game.users.activeGM) return;
    const rollData = message.getFlag("dark-heresy", "rollData");
    const link = rollData?.sprayDodge;
    if (!link || !rollData.flags?.isSuccess) return;
    const card = game.messages.get(link.messageId);
    if (!card) return;
    const evaded = new Set(card.getFlag("dark-heresy", "evaded") ?? []);
    evaded.add(link.tokenId ?? link.actorId);
    await card.setFlag("dark-heresy", "evaded", [...evaded]);
}

/** Register socket, cleanup and dodge hooks; call during ready. */
export function registerAreas() {
    game.socket.on(SOCKET, async data => {
        if (data?.type !== "deleteRegions" || game.user !== game.users.activeGM) return;
        const scene = game.scenes.get(data.sceneId);
        const ids = (data.ids ?? []).filter(id => scene?.regions.get(id)?.getFlag("dark-heresy", "area"));
        if (ids.length) await scene.deleteEmbeddedDocuments("Region", ids);
    });
    Hooks.on("combatTurnChange", () => {
        if (game.user === game.users.activeGM) deleteAreas(() => true);
    });
    Hooks.on("createChatMessage", onDodgeResult);
}
