/**
 * Talents of tests: fear, pinning, psychic powers, skills (core rulebook chapter IV, Russian edition).
 */
import { signed } from "../talents.js";

const t = (key, data) => game.i18n.format(`TALENTS.EFFECT.${key}`, data);

export default [
    {
        // Resistance (p. 164): +10 to tests resisting the chosen effect; Fear and psychic powers apply
        // by themselves, the others are ticked on the test
        id: "resistance",
        match: /^(?:сопротивление|resistance)(?![\p{L}])/iu,
        test: ({ rollData, talent }) => {
            const spec = talent.spec;
            if (/страх|fear/i.test(spec)) return rollData.flags?.isFear ? { modifier: 10, text: "+10" } : null;
            if (/псих|psychic|psyker/i.test(spec)) return rollData.opposedTo ? { modifier: 10, text: "+10" } : null;
            if (rollData.flags?.isAttack || rollData.flags?.isEvasion || rollData.flags?.isFear || rollData.pinning) return null;
            return { toggle: true, modifier: 10, text: t("RESISTANCE", { what: spec || "?" }) };
        }
    },
    {
        // Strong Minded (p. 161): re-roll a failed Willpower test resisting a psychic power
        id: "strongMinded",
        match: /^(?:непреклонный|strong[-\s]?minded)/i,
        reroll: ({ rollData }) => (rollData.opposedTo && rollData.characteristicKey === "willpower" ? { text: "" } : null)
    },
    {
        // Keen Intuition (p. 165): re-roll a failed Awareness test at −10
        id: "keenIntuition",
        match: /^(?:чуткая\s+интуиция|keen\s+intuition)/i,
        reroll: ({ skill }) => (skill === "awareness" ? { modifier: -10, text: "-10" } : null)
    },
    {
        // Unshakeable Faith (p. 161): degrees of failure on a Fear or pinning test − Willpower bonus;
        // none left: passed with one degree of success
        id: "unshakeableFaith",
        match: /^(?:несокрушимая\s+вера|unshakeable\s+faith)/i,
        after: ({ rollData, bonus }) => {
            if (rollData.flags.isSuccess || !(rollData.flags?.isFear || (rollData.pinning && !rollData.pinning.recover))) return null;
            const wp = bonus("willpower");
            const left = (Number(rollData.dof) || 0) - wp;
            if (left > 0) {
                rollData.dof = left;
                return t("DOF_REDUCED", { value: wp });
            }
            rollData.flags.isSuccess = true;
            rollData.dof = 0;
            rollData.dos = 1;
            return t("PASSED", { value: wp });
        }
    }
];
