/**
 * Weapon qualities: tooltips, on-hit reminders and the qualities applied with damage.
 *
 * The system ships no rule texts. A world module registers them with
 * game.darkHeresy.registerQualityTexts([{name, aliases, text, source, page}]); qualities without a
 * registered text are shown as plain text. Mechanics are keyed by quality names (Russian or English):
 * - Graviton: extra damage equal to the target's armour at the location.
 * - Felling (X): the target's unnatural toughness is reduced by X for this damage.
 * - Daemonbane: against a Daemonic target damage is not reduced by toughness bonus.
 * - Melta: penetration doubled at short range or closer.
 * - Tainted: extra damage equal to the wielder's corruption bonus or Daemonic (X), whichever is larger.
 * Qualities that make the target test or suffer an effect on hit are listed as reminders on the
 * applied-damage card.
 */

const KEYS = {
    graviton: /^(?:гравитонн|graviton)/i,
    blast: /^(?:взрыв|blast)/i,
    spray: /^(?:распыля|spray)/i,
    felling: /^(?:разящ|подрубающ|felling)/i,
    daemonbane: /^(?:погибель демонов|daemonbane)/i,
    sanctified: /^(?:освящ[её]нн|освещ[её]нн|sanctified)/i,
    melta: /^(?:мельта|melta)/i,
    tainted: /^(?:порчен|tainted)/i,
    hallucinogenic: /^(?:галлюцин|hallucinogenic)/i,
    flame: /^(?:зажиг|огнен|flame)/i,
    crippling: /^(?:калечащ|crippling)/i,
    corrosive: /^(?:коррози|корози|corrosive)/i,
    snare: /^(?:обездв|snare)/i,
    concussive: /^(?:оглуш|concussive)/i,
    toxic: /^(?:токсичн|toxic)/i,
    shocking: /^(?:шоков|shocking)/i,
    haywire: /^(?:эми|haywire)/i
};

const REMINDERS = ["hallucinogenic", "flame", "crippling", "corrosive", "snare", "concussive", "toxic", "shocking", "haywire"];

const texts = new Map();

const norm = s => String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

/**
 * Register rule texts of weapon qualities (called by a world module).
 * @param {{name: string, aliases?: string[], text: string, source?: string, page?: number}[]} list
 */
export function registerQualityTexts(list) {
    for (const q of list ?? []) {
        for (const name of [q.name, ...(q.aliases ?? [])]) texts.set(norm(name), q);
    }
}

/**
 * Split a «special» string into qualities.
 * «Разрывное [Tearing], Оглушающее (2)†» → [{raw, name: "Разрывное", x: null, key}, {…, name: "Оглушающее", x: 2, key: "concussive"}]
 * @param {string} special
 * @returns {object[]}
 */
export function parseQualities(special) {
    return String(special ?? "").split(/\s*,\s*/).map(raw => raw.trim()).filter(raw => raw && !/^[—–-]$|^†+$/.test(raw))
        .map(raw => {
            const clean = raw.replace(/\[[^\]]*\]/g, "").replace(/†/g, "").trim();
            const m = clean.match(/^(.*?)\s*(?:\((\d+)\))?$/);
            const name = m[1].trim();
            const key = Object.keys(KEYS).find(k => KEYS[k].test(name)) ?? null;
            return { raw, name, x: m[2] ? Number(m[2]) : null, key };
        });
}

/**
 * Value of a quality in a «special» string: X for rated ones, true for plain ones, null if absent.
 * @param {string} special
 * @param {string} key
 * @returns {number|boolean|null}
 */
export function qualityValue(special, key) {
    const q = parseQualities(special).find(p => p.key === key);
    return q ? (q.x ?? true) : null;
}

function tooltip(q) {
    const def = texts.get(norm(q.name));
    if (!def) return null;
    const esc = foundry.utils.escapeHTML;
    const body = String(def.text).split(/\n\s*\n/).map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
    const where = def.page ? `<p><em>${esc(def.sourceLabel ?? def.source ?? "")}${def.sourceLabel || def.source ? ", " : ""}${game.i18n.localize("QUALITY.PAGE")} ${def.page}</em></p>` : "";
    return `<div class="dh-quality-tooltip"><strong>${esc(def.name)}</strong>${body}${where}</div>`;
}

/**
 * HTML of a «special» string with a rule tooltip on every quality that has a registered text.
 * @param {string} special
 * @param {object} [options]
 * @param {string[]} [options.only] keep only qualities with these keys
 * @returns {string}
 */
export function qualitiesHTML(special, { only } = {}) {
    const esc = foundry.utils.escapeHTML;
    return parseQualities(special).filter(q => !only || only.includes(q.key)).map(q => {
        const tip = tooltip(q);
        return tip ? `<span class="dh-quality" data-tooltip-html="${esc(tip)}" data-tooltip-direction="UP">${esc(q.raw)}</span>`
            : esc(q.raw);
    }).join(", ");
}

/**
 * Reminder qualities (target tests or suffers an effect on hit) as HTML, or "" if none.
 * @param {string} special
 * @returns {string}
 */
export function reminderHTML(special) {
    return qualitiesHTML(special, { only: REMINDERS });
}

/**
 * Attack-side adjustments of a damage payload: Melta penetration and Tainted damage.
 * @param {object} rollData damage roll data
 * @param {object[]} damages payload damages (mutated)
 * @param {Actor|null} attacker
 * @param {Function} daemonicRating (actor) => number
 */
export function applyAttackQualities(rollData, damages, attacker, daemonicRating) {
    const special = rollData.weapon?.special ?? "";
    if (qualityValue(special, "melta") && Number(rollData.rangeMod) >= 10) {
        damages.forEach(d => d.penetration *= 2);
    }
    if (qualityValue(special, "tainted") && attacker) {
        const extra = Math.max(Number(attacker.system?.corruptionBonus) || 0, daemonicRating(attacker));
        damages.forEach(d => d.amount += extra);
    }
}

/** Register the Handlebars helpers and the public API; call during init. */
export function registerQualities() {
    game.darkHeresy.registerQualityTexts = registerQualityTexts;
    game.darkHeresy.parseQualities = parseQualities;
    Handlebars.registerHelper("dhQualities", special => new Handlebars.SafeString(qualitiesHTML(special)));
    Handlebars.registerHelper("dhReminders", special => new Handlebars.SafeString(reminderHTML(special)));
}
