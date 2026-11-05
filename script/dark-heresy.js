import { DarkHeresyActor } from "./common/actor.js";
import { DarkHeresyItem } from "./common/item.js";
import { AcolyteSheet } from "./sheet/actor/acolyte.js";
import { NpcSheet } from "./sheet/actor/npc.js";
import { WeaponSheet } from "./sheet/weapon.js";
import { AmmunitionSheet } from "./sheet/ammunition.js";
import { WeaponModificationSheet } from "./sheet/weapon-modification.js";
import { ArmourSheet } from "./sheet/armour.js";
import { ForceFieldSheet } from "./sheet/force-field.js";
import { CyberneticSheet } from "./sheet/cybernetic.js";
import { DrugSheet } from "./sheet/drug.js";
import { GearSheet } from "./sheet/gear.js";
import { ToolSheet } from "./sheet/tool.js";
import { CriticalInjurySheet } from "./sheet/critical-injury.js";
import { MalignancySheet } from "./sheet/malignancy.js";
import { MentalDisorderSheet } from "./sheet/mental-disorder.js";
import { MutationSheet } from "./sheet/mutation.js";
import { PsychicPowerSheet } from "./sheet/psychic-power.js";
import { TalentSheet } from "./sheet/talent.js";
import { SpecialAbilitySheet } from "./sheet/special-ability.js";
import { TraitSheet } from "./sheet/trait.js";
import { AptitudeSheet } from "./sheet/aptitude.js";
import { initializeHandlebars } from "./common/handlebars.js";
import { migrateWorld } from "./common/migration.js";
import { prepareCommonRoll, prepareCombatRoll, preparePsychicPowerRoll } from "./common/dialog.js";
import { commonRoll, combatRoll } from "./common/roll.js";
import { chatListeners } from "./common/chat.js";
import { registerDamageSocket } from "./common/damage.js";
import { registerMovement } from "./common/movement.js";
import { registerActions } from "./common/actions.js";
import { registerTraits } from "./common/traits.js";
import { registerQualities } from "./common/qualities.js";
import { registerAreas } from "./common/area.js";
import { registerWeapons } from "./common/weapons.js";
import { replaceSymbols } from "./common/roll.js";
import DarkHeresyUtil from "./common/util.js";
import { registerTablesApi, registerTablesSocket } from "./common/tables.js";
import { registerPinning } from "./common/pinning.js";
import { registerMedicae, firstAid } from "./common/medicae.js";
import { registerRequisition, registerRequisitionSocket, requisition, subtletyPanel, subtletyTest } from "./common/requisition.js";
import DhMacroUtil from "./common/macro.js";
import Dh from "./common/config.js";

// Import Helpers
import * as chat from "./common/chat.js";
import { registerDataModels } from "./setup/registerDataModels.js";
import { registerAdditionalModuleSettings } from "./moduleSupport/moduleSupportSettings.js";

Hooks.once("init", function() {
    CONFIG.Combat.initiative = { formula: "@initiative.base + @initiative.bonus", decimals: 0 };
    CONFIG.Actor.documentClass = DarkHeresyActor;
    CONFIG.Item.documentClass = DarkHeresyItem;
    CONFIG.fontDefinitions["Caslon Antique"] = { editor: true, fonts: [] };
    CONFIG.ActiveEffect.legacyTransferral = false;
    registerMovement();
    registerActions();
    registerTraits();
    game.darkHeresy = {
        config: Dh,
        testInit: {
            prepareCommonRoll,
            prepareCombatRoll,
            preparePsychicPowerRoll
        },
        tests: {
            commonRoll,
            combatRoll
        },
        firstAid,
        requisition,
        subtletyPanel,
        subtletyTest
    };
    registerQualities();
    registerWeapons({ prepareCommonRoll, replaceSymbols,
        createCharacteristicRollData: (actor, key) => DarkHeresyUtil.createCharacteristicRollData(actor, key) });
    registerTablesApi();
    registerPinning();
    registerMedicae();
    registerRequisition();
    game.macro = DhMacroUtil;
    const sheets = foundry.applications.apps.DocumentSheetConfig;
    sheets.unregisterSheet(Actor, "core", foundry.appv1.sheets.ActorSheet);
    sheets.registerSheet(Actor, "dark-heresy", AcolyteSheet, { types: ["acolyte"], makeDefault: true });
    sheets.registerSheet(Actor, "dark-heresy", NpcSheet, { types: ["npc"], makeDefault: true });
    sheets.unregisterSheet(Item, "core", foundry.appv1.sheets.ItemSheet);
    sheets.registerSheet(Item, "dark-heresy", WeaponSheet, { types: ["weapon"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", AmmunitionSheet, { types: ["ammunition"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", WeaponModificationSheet, { types: ["weaponModification"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", ArmourSheet, { types: ["armour"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", ForceFieldSheet, { types: ["forceField"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", CyberneticSheet, { types: ["cybernetic"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", DrugSheet, { types: ["drug"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", GearSheet, { types: ["gear"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", ToolSheet, { types: ["tool"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", CriticalInjurySheet, { types: ["criticalInjury"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", MalignancySheet, { types: ["malignancy"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", MentalDisorderSheet, { types: ["mentalDisorder"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", MutationSheet, { types: ["mutation"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", PsychicPowerSheet, { types: ["psychicPower"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", TalentSheet, { types: ["talent"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", SpecialAbilitySheet, { types: ["specialAbility"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", TraitSheet, { types: ["trait"], makeDefault: true });
    sheets.registerSheet(Item, "dark-heresy", AptitudeSheet, { types: ["aptitude"], makeDefault: true });

    registerDataModels();

    initializeHandlebars();

    game.settings.register("dark-heresy", "worldSchemaVersion", {
        name: "World Version",
        hint: "Used to automatically upgrade worlds data when the system is upgraded.",
        scope: "world",
        config: true,
        default: 0,
        type: Number
    });
    game.settings.register("dark-heresy", "autoCalcXPCosts", {
        name: "Calculate XP Costs",
        hint: "If enabled, calculate XP costs automatically.",
        scope: "world",
        config: true,
        default: false,
        type: Boolean
    });
    // «useSpraytemplate» removed: spray cones are placed by script/common/area.js

    registerAdditionalModuleSettings();
});

Hooks.once("ready", function() {
    migrateWorld();
    registerDamageSocket();
    registerAreas();
    registerTablesSocket();
    registerRequisitionSocket();
    CONFIG.ChatMessage.documentClass.prototype.getRollData = function() {
        return this.getFlag("dark-heresy", "rollData");
    };
});


/* -------------------------------------------- */
/*  Other Hooks                                 */
/* -------------------------------------------- */

/** Add Event Listeners for Buttons on chat boxes */
Hooks.on("renderChatMessageHTML", (chat, html, context) => {
    chatListeners(html);
});

/** Add Options to context Menu of chatmessages */
Hooks.on("getChatMessageContextOptions", (html, options) => chat.addChatMessageContextOptions(html, options));

/**
 * Create a macro when dropping an entity on the hotbar
 * Item      - open roll dialog for item
 */
Hooks.on("hotbarDrop", (bar, data, slot) => {
    if (data.type === "Item" || data.type === "Actor") {
        DhMacroUtil.createMacro(data, slot);
        return false;
    }
});

Hooks.on("renderDarkHeresySheet", (sheet, html, data) => {
    html.find("input.cost").prop("disabled", game.settings.get("dark-heresy", "autoCalcXPCosts"));
    html.find(":not(.psychic-power) > input.item-cost").prop("disabled", game.settings.get("dark-heresy", "autoCalcXPCosts"));
});
