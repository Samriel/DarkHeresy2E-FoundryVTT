/**
 * Effects of combat actions applied by the active GM.
 *
 * A chat card that changes documents the poster may not own (a condition on the target, fatigue,
 * damage, the combatant's action record) carries the flag «dark-heresy.ops»: a list of operations.
 * The active GM runs them once when the message is created, so players never need ownership of the
 * target and every change is announced by its card. The GM's own code calls runOps directly.
 *
 * Operations:
 * - {type: "status", uuid, id, active = true, rounds?, flags?} — turn a status effect on or off; rounds and flags
 *   are stored on the effect (flags «dark-heresy.*»).
 * - {type: "fatigue", uuid, delta} — add (or remove) levels of fatigue.
 * - {type: "damage", uuid, damages, attack} — Actor#applyDamage.
 * - {type: "spend", speaker: {token, actor}, halves} — half actions of the current combatant.
 * - {type: "record", speaker: {token, actor}, changes} — merge into the combatant's action record.
 */
import { combatantFor, updateRecord, spendHalves } from "./actions.js";

const isActiveGM = () => game.user === game.users.activeGM;

/**
 * The actor of a uuid of an Actor or a Token.
 * @param {string} uuid
 * @returns {Promise<Actor|null>}
 */
export async function actorFrom(uuid) {
    const doc = uuid ? await fromUuid(uuid) : null;
    return doc?.documentName === "Actor" ? doc : (doc?.actor ?? null);
}

/**
 * The effect of an actor carrying a status.
 * @param {Actor} actor
 * @param {string} id status id
 * @returns {ActiveEffect|undefined}
 */
export function statusEffectOf(actor, id) {
    return actor?.effects.find(e => e.statuses.has(id));
}

const OPS = {
    async status({ uuid, id, active = true, rounds, flags }) {
        const actor = await actorFrom(uuid);
        if (!actor) return;
        const has = actor.statuses.has(id);
        if (active && !has) await actor.toggleStatusEffect(id, { active: true, overlay: id === "dead" });
        else if (!active && has) await actor.toggleStatusEffect(id, { active: false });
        if (!active) return;
        const effect = statusEffectOf(actor, id);
        if (!effect) return;
        const changes = {};
        if (rounds !== undefined) {
            // A longer duration replaces a shorter one
            const current = effect.getFlag("dark-heresy", "rounds");
            if (!has || current === undefined || rounds > current) changes["flags.dark-heresy.rounds"] = rounds;
        }
        for (const [key, value] of Object.entries(flags ?? {})) changes[`flags.dark-heresy.${key}`] = value;
        if (Object.keys(changes).length) await effect.update(changes);
    },

    async fatigue({ uuid, delta }) {
        const actor = await actorFrom(uuid);
        if (!actor || !delta) return;
        const value = Math.max(0, (Number(actor.system.fatigue?.value) || 0) + Number(delta));
        await actor.update({ "system.fatigue.value": value });
    },

    async damage({ uuid, damages, attack }) {
        const actor = await actorFrom(uuid);
        if (actor && damages?.length) await actor.applyDamage(damages, attack ?? { psychic: false, special: "" });
    },

    async spend({ speaker, halves }) {
        const combatant = combatantFor(speaker ?? {});
        if (combatant && combatant === game.combat?.combatant && halves) await spendHalves(combatant, halves);
    },

    async record({ speaker, changes }) {
        const combatant = combatantFor(speaker ?? {});
        if (combatant && changes) await updateRecord(combatant, changes);
    }
};

/**
 * Run operations (active GM or owner of everything touched).
 * @param {object[]} ops
 */
export async function runOps(ops) {
    for (const op of ops ?? []) {
        try {
            await OPS[op?.type]?.(op);
        } catch (err) {
            console.error("dark-heresy | operation failed", op, err);
        }
    }
}

/**
 * Post a chat card whose operations the active GM applies.
 * @param {object} data ChatMessage data (content, speaker, rolls…)
 * @param {object[]} ops
 * @returns {Promise<ChatMessage>}
 */
export async function postWithOps(data, ops) {
    if (ops?.length && !game.users.activeGM) ui.notifications.warn(game.i18n.localize("COMBAT_ACTION.NO_GM"));
    return ChatMessage.create(foundry.utils.mergeObject(data, { "flags.dark-heresy.ops": ops ?? [] }));
}

/** createChatMessage: the active GM applies the message's operations. */
async function onChatMessage(message) {
    if (!isActiveGM()) return;
    const ops = message.getFlag("dark-heresy", "ops");
    if (ops?.length) await runOps(ops);
}

/** Register the hook; call during init. */
export function registerOps() {
    Hooks.on("createChatMessage", onChatMessage);
}
