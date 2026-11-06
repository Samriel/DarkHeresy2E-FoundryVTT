import { commonRoll, combatRoll, damageRoll, addDegreesOfSuccess } from "./roll.js";
import { prepareCommonRoll } from "./dialog.js";
import DarkHeresyUtil from "./util.js";
import { onApplyToTargetsClick, applyToActors } from "./damage.js";
import { onFearClick } from "./traits.js";
import { onSprayDodgeClick } from "./area.js";
import { weaponChatListeners } from "./weapons.js";
import { onApplyConditionClick, onPhenomenaClick } from "./tables.js";
import { onPinningClick, onPinningRecoverClick } from "./pinning.js";
import { onBleedingClick } from "./medicae.js";
import { onMindTestClick } from "./corruption.js";
import { confirmEvasion } from "./conditions.js";
import { psychicChatListeners } from "./psychic.js";
import { spendFate, fateAddDegree, canSpendOn, onBurnFateClick, rollActor } from "./fate.js";
import { onMindTableClick, onMindAddClick } from "./mind.js";
import { onTalentRerollClick } from "./talents.js";


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
    weaponChatListeners(html);
    html.querySelectorAll(".dh-apply-condition")?.forEach(button => button.addEventListener("click", event => onApplyConditionClick(event)));
    const message = game.messages.get(html.dataset?.messageId);
    html.querySelectorAll(".roll-phenomena")?.forEach(button => {
        if (message?.getFlag("dark-heresy", "phenomenaRolled")) button.disabled = true;
        button.addEventListener("click", event => onPhenomenaClick(event));
    });
    html.querySelectorAll(".invoke-pinning")?.forEach(button => button.addEventListener("click", event => onPinningClick(event, prepareCommonRoll, DarkHeresyUtil)));
    html.querySelectorAll(".invoke-pinning-recover")?.forEach(button => button.addEventListener("click", event => onPinningRecoverClick(event, prepareCommonRoll, DarkHeresyUtil)));
    html.querySelectorAll(".invoke-bleeding")?.forEach(button => button.addEventListener("click", event => onBleedingClick(event)));
    html.querySelectorAll(".invoke-mind-test")?.forEach(button => button.addEventListener("click", event => onMindTestClick(event)));
    psychicChatListeners(html, prepareCommonRoll, DarkHeresyUtil);
    html.querySelectorAll(".dh-burn-fate")?.forEach(button => {
        if (message?.getFlag("dark-heresy", "fateBurned")) button.disabled = true;
        button.addEventListener("click", event => onBurnFateClick(event));
    });
    html.querySelectorAll(".roll-mind-table")?.forEach(button => {
        if (message?.getFlag("dark-heresy", "mindRolled")) button.disabled = true;
        button.addEventListener("click", event => onMindTableClick(event));
    });
    html.querySelectorAll(".dh-mind-add")?.forEach(button => {
        if (message?.getFlag("dark-heresy", "mindAdded")) button.disabled = true;
        button.addEventListener("click", event => onMindAddClick(event));
    });
    html.querySelectorAll(".dh-talent-reroll")?.forEach(button => button.addEventListener("click",
        event => onTalentRerollClick(event, { commonRoll, combatRoll, damageRoll })));
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

    // Fate (core p. 357): re-roll any test, +1 degree of success to a successful one
    const reroll = li => rerollTest(game.messages.get(li.dataset.messageId));
    const canReroll = li => canSpendOn(game.messages.get(li.dataset.messageId));
    const addDegree = li => fateAddDegree(game.messages.get(li.dataset.messageId), addDegreesOfSuccess);
    const canAddDegree = li => {
        const message = game.messages.get(li.dataset.messageId);
        return canSpendOn(message) && Boolean(message.getRollData()?.flags?.isSuccess);
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
        },
        {
            label: game.i18n.localize("CHAT.CONTEXT.FATE_DEGREE"),
            name: game.i18n.localize("CHAT.CONTEXT.FATE_DEGREE"),
            icon: '<i class="fa-solid fa-angles-up"></i>',
            visible: canAddDegree,
            condition: canAddDegree,
            onClick: (event, li) => addDegree(li),
            callback: li => addDegree(li)
        }
    );
    return options;
};

/**
 * Rerolls the Test using the same Data as the initial Roll while spending a Fate point of the actor
 * (an Unlucky character may waste the point, see fate.js)
 * @param {ChatMessage} message
 * @returns {Promise}
 */
async function rerollTest(message) {
    const rollData = message.getRollData();
    const actor = rollActor(rollData);
    const spent = await spendFate(actor, "reroll", { detail: rollData.name ?? "" });
    if (!spent?.effective) return;
    delete rollData.damages; // Reset so no old data is shown on failure
    delete rollData.fateDegrees;
    delete rollData.fateBonus;
    delete rollData.rerollBy;
    delete rollData.talentRerolls;

    rollData.flags.isReRoll = true;
    rollData.isReRoll = true;
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
async function onTestClick(ev) {
    let actor = game.macro.getActor();
    let id = $(ev.currentTarget).parents(".message").attr("data-message-id");
    let msg = game.messages.get(id);
    let rollData = msg.getRollData();

    if (!actor) {
        ui.notifications.warn(`${game.i18n.localize("NOTIFICATION.MACRO_ACTOR_NOT_FOUND")}`);
        return;
    }
    // Stunned, grappled, after an All Out Attack, reaction spent, feinted… (core pp. 269–270, 281, 289)
    if (!(await confirmEvasion(actor, rollData))) return;
    rollData.evaderUuid = actor.uuid;
    // The evasion is a new test: the attack's talents and re-roll state do not carry over
    rollData.isReRoll = false;
    rollData.flags.isReRoll = false;
    rollData.talents = [];
    delete rollData.talentRerolls;
    delete rollData.talentForce;
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
