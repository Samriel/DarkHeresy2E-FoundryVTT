import { commonRoll, combatRoll, damageRoll } from "./roll.js";
import { prepareCommonRoll } from "./dialog.js";
import DarkHeresyUtil from "./util.js";
import { onApplyToTargetsClick, applyToActors } from "./damage.js";
import { onFearClick } from "./traits.js";
import { onSprayDodgeClick } from "./area.js";


/**
 * Listeners for Chatmessages
 * @param {HTMLElement} html
 */
export function chatListeners(html) {
    if (!(html instanceof HTMLElement)) return;
    html.querySelectorAll(".invoke-test")?.forEach(button => button.addEventListener("click", event => onTestClick(event)));
    html.querySelectorAll(".invoke-damage")?.forEach(button => button.addEventListener("click", event => onDamageClick(event)));
    html.querySelectorAll(".apply-damage-targets")?.forEach(button => button.addEventListener("click", event => onApplyToTargetsClick(event)));
    html.querySelectorAll(".invoke-fear")?.forEach(button => button.addEventListener("click", event => onFearClick(event, prepareCommonRoll, DarkHeresyUtil)));
    html.querySelectorAll(".spray-dodge")?.forEach(button => button.addEventListener("click", event => onSprayDodgeClick(event, prepareCommonRoll, DarkHeresyUtil)));
    html.querySelectorAll(".reload-Weapon")?.forEach(button => button.addEventListener("click", event => onReloadClick(event)));
    html.querySelectorAll(".dark-heresy.chat.roll>.background.border")?.forEach(button => button.addEventListener("dblclick", event => onChatRollClick(event)));
}

/**
 * This function is used to hook into the Chat Log context menu to add additional options to each message
 * These options make it easy to conveniently apply damage to controlled tokens based on the value of a Roll
 *
 * @param {HTMLElement} html    The Chat Message being rendered
 * @param {Array} options       The Array of Context Menu options
 *
 * @returns {Array}              The extended options Array including new context choices
 */
export const addChatMessageContextOptions = function(html, options) {
    const applyDamage = li => applyToActors(game.messages.get(li.dataset.messageId), canvas.tokens.controlled);
    let canApply = li => {
        const message = game.messages.get(li.dataset.messageId);
        return message.getRollData()?.flags.isDamageRoll
            && message.isContentVisible
            && canvas.tokens.controlled.length;
    };
    options.unshift(
        {
            // v14 keys (label/visible/onClick); name/condition/callback keep v13 working
            label: game.i18n.localize("CHAT.CONTEXT.APPLY_DAMAGE"),
            name: game.i18n.localize("CHAT.CONTEXT.APPLY_DAMAGE"),
            icon: '<i class="fas fa-user-minus"></i>',
            visible: canApply,
            condition: canApply,
            onClick: (event, li) => applyDamage(li),
            callback: li => applyDamage(li)
        }
    );

    const reroll = li => rerollTest(game.messages.get(li.dataset.messageId).getRollData());
    let canReroll = li => {
        const message = game.messages.get(li.dataset.messageId);
        let actor = game.actors.get(message.getRollData()?.ownerId);
        return message.isRoll
            && !message.getRollData()?.flags.isDamageRoll
            && message.isContentVisible
            && actor?.fate.value > 0;
    };

    options.unshift(
        {
            label: game.i18n.localize("CHAT.CONTEXT.REROLL"),
            name: game.i18n.localize("CHAT.CONTEXT.REROLL"),
            icon: '<i class="fa-solid fa-repeat"></i>',
            visible: canReroll,
            condition: canReroll,
            onClick: (event, li) => reroll(li),
            callback: li => reroll(li)
        }
    );
    return options;
};

/**
 * Rerolls the Test using the same Data as the initial Roll while reducing an actors fate
 * @param {object} rollData
 * @returns {Promise}
 */
function rerollTest(rollData) {
    let actor = game.actors.get(rollData.ownerId);
    actor.update({ "system.fate.value": actor.fate.value -1 });
    delete rollData.damages; // Reset so no old data is shown on failure

    rollData.flags.isReRoll = true;
    if (rollData.flags.isCombatRoll) {
    // All the regexes in this are broken once retrieved from the chatmessage
    // No idea why this happens so we need to fetch them again so the roll works correctly
        rollData.attributeBoni = actor.attributeBoni;
        return combatRoll(rollData);
    } else {
        return commonRoll(rollData);
    }
}

/**
 * Rolls a Test for the Selected Actor
 * @param {Event} ev
 */
function onTestClick(ev) {
    let actor = game.macro.getActor();
    let id = $(ev.currentTarget).parents(".message").attr("data-message-id");
    let msg = game.messages.get(id);
    let rollData = msg.getRollData();

    if (!actor) {
        ui.notifications.warn(`${game.i18n.localize("NOTIFICATION.MACRO_ACTOR_NOT_FOUND")}`);
        return;
    }
    let evasions = {
        dodge: DarkHeresyUtil.createSkillRollData(actor, "dodge"),
        parry: DarkHeresyUtil.createSkillRollData(actor, "parry"),
        deny: DarkHeresyUtil.createCharacteristicRollData(actor, "willpower"),
        selected: "dodge"
    };
    rollData.evasions = evasions;
    rollData.target.modifier = 0;
    rollData.flags.isEvasion = true;
    rollData.flags.isAttack = false;
    rollData.flags.isDamageRoll = false;
    rollData.flags.isCombatRoll = false;
    if (rollData.psy) rollData.psy.display = false;
    rollData.name = game.i18n.localize("DIALOG.EVASION");
    prepareCommonRoll(rollData);
}

/**
 * Rolls an Evasion chat for the currently selected character from the chatcard
 * @param {Event} ev
 * @returns {Promise}
 */
function onDamageClick(ev) {
    let id = $(ev.currentTarget).parents(".message").attr("data-message-id");
    let msg = game.messages.get(id);
    let rollData = msg.getRollData();
    rollData.flags.isEvasion = false;
    rollData.flags.isCombatRoll = false;
    rollData.flags.isDamageRoll = true;
    return damageRoll(rollData);
}

/**
 * Reloads the associated weapon who is empty Without considering ammo in the users inventory
 * @param {Event} ev
 */
async function onReloadClick(ev) {
    let id = $(ev.currentTarget).parents(".message").attr("data-message-id");
    let msg = game.messages.get(id);
    let rollData = msg.getRollData();
    let weapon = game.actors.get(rollData.ownerId)?.items?.get(rollData.itemId);
    await weapon.update({"system.clip.value": rollData.weapon.clip.max});
}

/**
 * Show/hide dice rolls when a chat message is clicked.
 * @param {Event} event
 */
function onChatRollClick(event) {
    event.preventDefault();
    let roll = $(event.currentTarget.parentElement);
    let tip = roll.find(".dice-rolls");
    if ( !tip.is(":visible") ) tip.slideDown(200);
    else tip.slideUp(200);
}
