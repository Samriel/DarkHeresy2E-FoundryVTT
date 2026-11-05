/**
 * Psychic powers (DH2 core rulebook, Russian edition, chapter VI, pp. 238–244).
 *
 * - Range (p. 240, power format p. 245): the power's range field is parsed — «10 метров × пси-рейтинг»,
 *   «5*пси-рейтинг метров», «1 километр × ПР», «10 метров», «Сам», «касание», «радиус в 3 метра × ПР»,
 *   English «10m x PR», «Self», «Touch» — and multiplied by the psy rating used for the test. The focus
 *   dialog shows the range and, against a single target, the distance and a warning when the target is
 *   out of range. Range modifiers (point blank, short range…) never apply to powers.
 * - Sustaining (p. 241): a successful sustainable power can be marked as sustained from its chat card or
 *   on the sheet (flag «dark-heresy.sustained» on the power). The actor's «psy.sustained» counts the
 *   marked powers. While sustaining several powers the psy rating drops by their number (p. 241; table
 *   6-1), so the focus dialog starts from the reduced rating and anything above it is pushing. Phenomena
 *   get +10 per sustained power after the first (tables.js). At the start of the psyker's turn the most
 *   demanding sustain action (Half / Full; Free costs nothing) is charged in the action economy
 *   (actions.js). Unconscious or dead psykers drop all sustained powers (they can take no actions).
 * - Opposed focus tests (p. 240, opposed tests p. 28): the target tests the characteristic named in the
 *   power (usually Willpower); the power works if the psyker passes and wins: the side that passed wins,
 *   with both passing more degrees of success win, then the higher characteristic bonus, then the lower
 *   die roll; a full tie is left to the GM. A psyker resisting adds twice his psy rating (p. 240).
 * - Psychic blast (p. 244): every target within the radius of a point in range is hit; the radius comes
 *   from the power's Blast (X) quality with X evaluated with the psy rating («Взрыв (ПР)», «Blast (2xPR)»).
 *   The area is placed like a blast weapon (area.js), centred on the psyker for powers with range «Self».
 */

import { blastArea } from "./area.js";
import { tokenDistance } from "./situational.js";

const SOCKET = "system.dark-heresy";
const FLAG = "sustained";

const norm = s => String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
const stripHTML = s => String(s ?? "").replace(/<[^>]*>/g, " ");

/* -------------------------------------------- */
/*  Range                                       */
/* -------------------------------------------- */

/**
 * Parse a power's range field.
 * @param {string} text
 * @returns {{kind: string, base: number|null, perPR: boolean, text: string}}
 *   kind: "self", "touch", "distance", "radius" (area around the psyker) or "unknown"
 */
export function parseRange(text) {
    const t = norm(text);
    const result = { kind: "unknown", base: null, perPR: false, text: String(text ?? "") };
    if (!t) return result;
    // \b does not work with Cyrillic letters: word ends are spelled out
    const end = "(?=$|[^a-zа-я0-9])";
    const start = "(?:^|(?<=[^a-zа-я]))";
    if (new RegExp(`^(?:сам|на себя|себя|вы|self|you)${end}`).test(t)) return { ...result, kind: "self" };
    if (/касани|touch/.test(t)) return { ...result, kind: "touch" };
    const number = t.match(/(\d+(?:[.,]\d+)?)/);
    if (!number) return result;
    const unit = new RegExp(`километр|киломент|kilomet|${start}(?:км|km)${end}`).test(t) ? 1000 : 1;
    return {
        ...result,
        kind: /радиус|radius/.test(t) ? "radius" : "distance",
        base: Number(number[1].replace(",", ".")) * unit,
        perPR: new RegExp(`пси-?\\s?рейтинг|psy\\s?rating|${start}(?:пр|pr)${end}`).test(t)
    };
}

/**
 * Range in metres for a psy rating; null for self, touch or unparsed ranges.
 * @param {object} range parseRange result
 * @param {number} pr psy rating used
 * @returns {number|null}
 */
export function rangeMetres(range, pr) {
    if (!range || range.base === null) return null;
    return range.perPR ? range.base * Math.max(0, Number(pr) || 0) : range.base;
}

/**
 * Human readable range for the dialog and the card.
 * @param {object} range parseRange result
 * @param {number} pr
 * @returns {string}
 */
export function rangeLabel(range, pr) {
    if (!range) return "";
    if (range.kind === "self") return game.i18n.localize("PSY.RANGE_SELF");
    if (range.kind === "touch") return game.i18n.localize("PSY.RANGE_TOUCH");
    const metres = rangeMetres(range, pr);
    if (metres === null) return range.text;
    const key = range.kind === "radius" ? "PSY.RANGE_RADIUS" : "PSY.RANGE_DISTANCE";
    return game.i18n.format(key, { metres: metres.toNearest(0.1) })
        + (range.perPR ? ` (${range.base} × ${game.i18n.localize("PSY.PR")} ${pr})` : "");
}

/**
 * The psyker's token on the current scene.
 * @param {Actor} actor
 * @returns {Token|null}
 */
export function psykerToken(actor) {
    if (!canvas.ready || !actor) return null;
    return canvas.tokens.controlled.find(t => t.actor?.id === actor.id)
        ?? actor.getActiveTokens?.()[0] ?? null;
}

/* -------------------------------------------- */
/*  Opposed focus power tests                   */
/* -------------------------------------------- */

// Characteristic named after «Встречная проверка …» / «opposed … test» (longest stems first)
const CHARACTERISTIC_STEMS = [
    [/^сил\S* вол|^willpower/, "willpower"], [/^выносл|^toughness/, "toughness"], [/^восприят|^perception/, "perception"],
    [/^интеллект|^intelligence/, "intelligence"], [/^ловк|^agility/, "agility"], [/^общит|^fellowship/, "fellowship"],
    [/^навык\S* стрельб|^ballistic/, "ballisticSkill"], [/^навык\S* (?:рукопаш|ближн)|^weapon skill/, "weaponSkill"],
    [/^сил[аыу](?=$|\s)|^strength/, "strength"]
];

function characteristicFromText(words) {
    const t = norm(words);
    return CHARACTERISTIC_STEMS.find(([re]) => re.test(t))?.[1] ?? null;
}

/**
 * Characteristic the target tests against this power, or null when the focus test is not opposed.
 * The power's «focusPower.opposed» field decides: a characteristic key, «none», or empty for automatic
 * detection from the focus line of the description («Встречная проверка», «Opposed») with the
 * characteristic taken from the effect text («…пройти Встречную проверку Выносливости…»), Willpower
 * when the effect does not name one (p. 240).
 * @param {Item} power
 * @returns {string|null}
 */
export function opposedCharacteristic(power) {
    const system = power?.system ?? {};
    const set = system.focusPower?.opposed;
    if (set === "none") return null;
    if (set) return set;
    const description = String(system.description ?? "");
    const focusLine = description.match(/<th>[^<]*(?:фокусировк|focus)[^<]*<\/th>\s*<td>([^<]*)</i)?.[1]
        ?? String(system.focusPower?.test ?? "");
    if (!/встречн|opposed/i.test(focusLine)) return null;
    const effect = norm(stripHTML(system.effect));
    const named = effect.match(/встречн\S* проверк\S* (\S+(?: \S+)?)/)?.[1]
        ?? effect.match(/opposed (\S+(?: \S+)?) test/)?.[1];
    return (named && characteristicFromText(named)) || "willpower";
}

/**
 * Winner of an opposed test (core p. 28).
 * @param {{success: boolean, dos: number, bonus: number, result: number}} psyker
 * @param {{success: boolean, dos: number, bonus: number, result: number}} target
 * @returns {"psyker"|"target"|"tie"}
 */
export function opposedWinner(psyker, target) {
    if (!psyker.success) return target.success ? "target" : "tie";
    if (!target.success) return "psyker";
    if (psyker.dos !== target.dos) return psyker.dos > target.dos ? "psyker" : "target";
    if (psyker.bonus !== target.bonus) return psyker.bonus > target.bonus ? "psyker" : "target";
    if (psyker.result !== target.result) return psyker.result < target.result ? "psyker" : "target";
    return "tie";
}

/**
 * Outcome of an opposed test roll against a power card; set on the target's roll data in commonRoll.
 * @param {object} rollData the target's roll data (with opposedTo)
 */
export function resolveOpposed(rollData) {
    const o = rollData.opposedTo;
    const winner = opposedWinner(
        { success: true, dos: o.psykerDos, bonus: o.psykerBonus, result: o.psykerResult },
        { success: rollData.flags.isSuccess, dos: rollData.dos, bonus: o.targetBonus, result: rollData.result });
    rollData.opposedOutcome = {
        winner,
        text: game.i18n.format(`PSY.OPPOSED_${winner.toUpperCase()}`, { power: o.powerName, target: o.targetName,
            psykerDos: o.psykerDos, targetDos: rollData.dos })
    };
}

/**
 * Chat button: opposed test of one target (or of the user's selected actor) against the power card.
 * @param {Event} event
 * @param {Function} prepareCommonRoll
 * @param {object} DarkHeresyUtil
 */
async function onOpposedClick(event, prepareCommonRoll, DarkHeresyUtil) {
    event.preventDefault();
    const button = event.currentTarget;
    const message = game.messages.get(button.closest(".message")?.dataset.messageId);
    const power = message?.getRollData();
    if (!power?.psy?.opposed) return;
    let token = null;
    let actor = null;
    if (button.dataset.tokenId) {
        const scene = game.scenes.get(button.dataset.sceneId) ?? canvas.scene;
        const doc = scene?.tokens.get(button.dataset.tokenId);
        token = doc?.object ?? null;
        actor = doc?.actor ?? null;
    } else {
        actor = game.macro.getActor();
        token = actor ? (canvas.tokens.controlled.find(t => t.actor === actor) ?? actor.getActiveTokens?.()[0] ?? null) : null;
    }
    if (!actor) {
        ui.notifications.warn(game.i18n.localize("NOTIFICATION.MACRO_ACTOR_NOT_FOUND"));
        return;
    }
    if (!actor.isOwner) {
        ui.notifications.warn(game.i18n.format("PSY.OPPOSED_NOT_OWNER", { name: actor.name }));
        return;
    }
    const key = power.psy.opposed;
    const characteristic = actor.characteristics[key] ?? actor.characteristics.willpower;
    const rollData = DarkHeresyUtil.createCharacteristicRollData(actor, actor.characteristics[key] ? key : "willpower");
    // A psyker resisting a psychic attack adds twice his psy rating (p. 240)
    if (key === "willpower" && Number(actor.psy?.rating) > 0) rollData.target.modifier += 2 * Number(actor.psy.rating);
    rollData.name = game.i18n.format("PSY.OPPOSED_NAME", { characteristic: game.i18n.localize(characteristic.label),
        power: power.itemName ?? power.name });
    rollData.opposedTo = {
        messageId: message.id,
        key: token?.id ?? actor.id,
        powerName: power.itemName ?? power.name,
        targetName: token?.name ?? actor.name,
        psykerDos: power.dos,
        psykerResult: power.result,
        psykerBonus: Number(power.psy.focusBonus) || 0,
        targetBonus: Number(characteristic.bonus) || 0
    };
    if (token) rollData.speaker = ChatMessage.getSpeaker({ token: token.document ?? token });
    prepareCommonRoll(rollData);
}

/** createChatMessage (active GM): record an opposed test result on the power card. */
async function onOpposedResult(message) {
    if (game.user !== game.users.activeGM) return;
    const rollData = message.getFlag("dark-heresy", "rollData");
    const link = rollData?.opposedTo;
    if (!link || !rollData.opposedOutcome) return;
    const card = game.messages.get(link.messageId);
    if (!card) return;
    const results = { ...(card.getFlag("dark-heresy", "opposed") ?? {}) };
    results[link.key] = { name: link.targetName, winner: rollData.opposedOutcome.winner,
        text: rollData.opposedOutcome.text, dos: rollData.dos, dof: rollData.dof };
    await card.setFlag("dark-heresy", "opposed", results);
}

/* -------------------------------------------- */
/*  Sustained powers                            */
/* -------------------------------------------- */

/**
 * Can the power be sustained (its sustain field is not empty / «Нет» / «No»)?
 * @param {Item|object} power item or its system data
 * @returns {boolean}
 */
export function isSustainable(power) {
    const text = norm((power?.system ?? power)?.sustained);
    return Boolean(text) && !/^(?:нет|no|none|n\/a|[—–-])$/.test(text);
}

/**
 * Half actions of an action text: «Полное»/«Full» 2, «Полудействие»/«Half» 1, anything else 0.
 * @param {string} text
 * @returns {number}
 */
export function actionHalves(text) {
    const t = norm(text);
    if (/полн|full/.test(t)) return 2;
    if (/полу|half/.test(t)) return 1;
    return 0;
}

/**
 * The actor's sustained powers.
 * @param {Actor} actor
 * @returns {Item[]}
 */
export function sustainedPowers(actor) {
    return (actor?.items ?? []).filter(i => i.type === "psychicPower" && i.getFlag("dark-heresy", FLAG));
}

/**
 * Half actions spent each turn on sustaining: the most demanding sustain action (p. 241).
 * @param {Item[]} powers
 * @returns {number}
 */
export function sustainHalves(powers) {
    return powers.reduce((max, p) => Math.max(max, actionHalves(p.system.sustained)), 0);
}

/**
 * Psy rating reduction while sustaining: the number of sustained powers when there are several (p. 241).
 * @param {number} count
 * @returns {number}
 */
export function sustainPenalty(count) {
    return count >= 2 ? count : 0;
}

/**
 * Mark a power as sustained or drop it; non-owners go through the active GM.
 * @param {Item} power
 * @param {boolean} active
 * @param {object} [data] {psyRating, messageId}
 */
export async function setSustained(power, active, data = {}) {
    if (!power) return;
    if (power.isOwner) {
        if (active) await power.setFlag("dark-heresy", FLAG, { psyRating: data.psyRating ?? null,
            messageId: data.messageId ?? null, round: game.combat?.round ?? null });
        else if (power.getFlag("dark-heresy", FLAG)) await power.unsetFlag("dark-heresy", FLAG);
    } else if (game.users.activeGM) {
        game.socket.emit(SOCKET, { type: "sustainPower", uuid: power.uuid, active, data });
    }
}

/**
 * Chat button: sustain the power of the card.
 * @param {Event} event
 */
async function onSustainClick(event) {
    event.preventDefault();
    const button = event.currentTarget;
    const message = game.messages.get(button.closest(".message")?.dataset.messageId);
    const rollData = message?.getRollData();
    const power = rollData?.powerUuid ? await fromUuid(rollData.powerUuid) : null;
    if (!power) return;
    button.disabled = true;
    await setSustained(power, true, { psyRating: rollData.psy?.value, messageId: message.id });
    ui.notifications.info(game.i18n.format("PSY.SUSTAIN_STARTED", { power: power.name }));
}

/** createActiveEffect (active GM): an unconscious or dead psyker drops all sustained powers. */
async function onStatusEffect(effect) {
    if (game.user !== game.users.activeGM) return;
    const actor = effect.parent;
    if (!(actor instanceof Actor)) return;
    if (!["unconscious", "dead"].some(id => effect.statuses?.has(id))) return;
    const powers = sustainedPowers(actor);
    if (!powers.length) return;
    for (const power of powers) await power.unsetFlag("dark-heresy", FLAG);
    ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }),
        content: `<p>${game.i18n.format("PSY.SUSTAIN_DROPPED_STATUS", { name: actor.name,
            powers: powers.map(p => p.name).join(", ") })}</p>` });
}

/* -------------------------------------------- */
/*  Psychic blast                               */
/* -------------------------------------------- */

/**
 * Radius of a psychic blast in metres: X of the Blast (X) quality evaluated with the psy rating.
 * @param {string} special «Взрыв (ПР), Зажигательное», «Blast (2xPR)»…
 * @param {number} pr psy rating used
 * @returns {number} 0 when the power has no Blast quality or X does not evaluate
 */
export function psychicBlastRadius(special, pr) {
    for (const raw of String(special ?? "").split(/,(?![^(]*\))/)) {
        const m = raw.replace(/\[[^\]]*\]/g, "").trim().match(/^(?:взрыв|blast)\s*\(([^)]*)\)/i);
        if (!m) continue;
        const expr = m[1].replace(/пр|pr/gi, String(Number(pr) || 0)).replace(/[×хx]/gi, "*").replace(/\s+/g, "");
        if (!/^[\d+\-*/().]+$/.test(expr)) return 0;
        try {
            return Math.max(0, Number(Roll.safeEval(expr)) || 0);
        } catch {
            return 0;
        }
    }
    return 0;
}

/**
 * Place the area of a successful psychic blast (mutates nothing; returns area info for the card).
 * @param {object} rollData
 * @returns {Promise<object|null>}
 */
export async function psychicBlast(rollData) {
    if (rollData.attackType?.name !== "blast" || !rollData.flags.isSuccess) return null;
    const radius = psychicBlastRadius(rollData.weapon?.special, rollData.psy?.value);
    if (!(radius > 0)) return null;
    const self = rollData.powerRange?.kind === "self";
    return blastArea(rollData, radius, { self });
}

/* -------------------------------------------- */
/*  Chat cards                                  */
/* -------------------------------------------- */

/**
 * Wire the power card buttons and show recorded opposed results.
 * @param {HTMLElement} html
 * @param {Function} prepareCommonRoll
 * @param {object} DarkHeresyUtil
 */
export function psychicChatListeners(html, prepareCommonRoll, DarkHeresyUtil) {
    const message = game.messages.get(html.dataset?.messageId);
    const rollData = message?.getRollData();
    html.querySelectorAll(".psy-sustain").forEach(button => {
        const power = rollData?.powerUuid ? fromUuidSync(rollData.powerUuid) : null;
        if (!power || power.getFlag?.("dark-heresy", FLAG) || !power.isOwner) button.disabled = true;
        button.addEventListener("click", onSustainClick);
    });
    const results = message?.getFlag("dark-heresy", "opposed") ?? {};
    html.querySelectorAll(".psy-opposed").forEach(button => {
        const key = button.dataset.tokenId;
        if (key && results[key]) button.disabled = true;
        button.addEventListener("click", event => onOpposedClick(event, prepareCommonRoll, DarkHeresyUtil));
    });
    const list = html.querySelector(".psy-opposed-results");
    if (list && Object.keys(results).length) {
        list.innerHTML = Object.values(results).map(r => {
            const color = r.winner === "psyker" ? "var(--color-success)" : r.winner === "target" ? "var(--color-failure)" : "inherit";
            return `<p style="color:${color}">${foundry.utils.escapeHTML(r.text)}</p>`;
        }).join("");
    }
}

/**
 * Data the focus power roll needs from the power and the scene (called from createPsychicRollData).
 * @param {object} rollData
 * @param {Actor} actor
 * @param {Item} power
 */
export function addPsychicRollData(rollData, actor, power) {
    rollData.powerUuid = power.uuid;
    rollData.powerRange = parseRange(power.system.range);
    rollData.psy.sustainable = isSustainable(power);
    rollData.psy.opposed = opposedCharacteristic(power);
    rollData.psy.sustained = Number(actor.psy.sustained) || 0;
    rollData.psy.sustainPenalty = sustainPenalty(rollData.psy.sustained);
    rollData.psy.baseRating = Number(actor.psy.rating) || 0;
}

/**
 * Dialog notes and the live range / distance line of the focus power dialog.
 * @param {object} rollData
 * @returns {{notes: string[], update: Function}} update(pr) returns {text, warning}
 */
export function psychicDialogInfo(rollData) {
    const notes = [];
    if (rollData.psy.sustainPenalty) {
        notes.push(game.i18n.format("PSY.SUSTAIN_PENALTY_NOTE", { count: rollData.psy.sustained,
            base: rollData.psy.baseRating, rating: rollData.psy.rating }));
    }
    if (rollData.psy.opposed) {
        const label = game.darkHeresy.config.opposedTests?.[rollData.psy.opposed];
        notes.push(game.i18n.format("PSY.OPPOSED_NOTE", { characteristic: label ? game.i18n.localize(label) : rollData.psy.opposed }));
    }
    const actor = game.actors.get(rollData.ownerId);
    const self = psykerToken(actor);
    const targets = [...game.user.targets];
    const target = targets.length === 1 ? targets[0] : null;
    const update = pr => {
        const range = rollData.powerRange;
        let text = range?.text ? `${game.i18n.localize("PSY.RANGE")}: ${rangeLabel(range, pr)}` : "";
        let warning = "";
        if (target && self && target !== self && range) {
            const dist = tokenDistance(self, target);
            text += ` · ${game.i18n.format("PSY.DISTANCE", { name: target.name, distance: dist.toNearest(0.1) })}`;
            const limit = range.kind === "touch" ? canvas.dimensions.distance : rangeMetres(range, pr);
            // A blast with range «Self» is centred on the psyker and may hit the target
            if (range.kind === "self") warning = rollData.attackType?.name === "blast" ? "" : game.i18n.localize("PSY.SELF_ONLY");
            else if (limit !== null && range.kind !== "radius" && dist > limit + 1e-6) {
                warning = game.i18n.format("PSY.OUT_OF_RANGE", { name: target.name, distance: dist.toNearest(0.1),
                    range: limit.toNearest(0.1) });
            } else if (limit !== null && range.kind === "radius" && dist > limit + 1e-6) {
                warning = game.i18n.format("PSY.OUT_OF_RADIUS", { name: target.name, range: limit.toNearest(0.1) });
            }
        }
        return { text, warning };
    };
    return { notes, update };
}

/** Register the socket and hooks; call during ready. */
export function registerPsychic() {
    game.socket.on(SOCKET, async data => {
        if (data?.type !== "sustainPower" || game.user !== game.users.activeGM) return;
        const power = await fromUuid(data.uuid);
        if (power) await setSustained(power, data.active, data.data);
    });
    Hooks.on("createChatMessage", onOpposedResult);
    Hooks.on("createActiveEffect", onStatusEffect);
}
