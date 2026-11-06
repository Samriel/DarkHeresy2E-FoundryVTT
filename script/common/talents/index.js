/**
 * Talent definitions by group; see talents.js for the steps and the effect fields.
 */
import { registerTalents } from "../talents.js";
import COMBAT from "./combat.js";
import TESTS from "./tests.js";

/** Register all talent definitions; call during init. */
export function registerTalentDefinitions() {
    registerTalents([...COMBAT, ...TESTS]);
}
