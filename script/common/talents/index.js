/**
 * Talent definitions by group; see talents.js for the steps and the effect fields.
 */
import { registerTalents } from "../talents.js";
import COMBAT from "./combat.js";
import TESTS from "./tests.js";
import STATES from "./states.js";

/** Register all talent definitions; call during init. */
export function registerTalentDefinitions() {
    // States before tests: «Непреклонный Крестоносец» would otherwise match Strong Minded («непреклонный»)
    registerTalents([...COMBAT, ...STATES, ...TESTS]);
}
