import * as prompts from "@clack/prompts";
import type { ReviewAnswer, SourceReview } from "../commands/source-upgrade.ts";
import type { MigrationDecision } from "../upgrade-plan.ts";

interface PromptOptions {
  message: string;
  options?: { value: string; label: string; hint?: string }[];
  initialValue?: string | boolean;
  initialValues?: string[];
  required?: boolean;
}
export interface ReviewPrompts {
  select(options: PromptOptions): Promise<unknown>;
  multiselect(options: PromptOptions): Promise<unknown>;
  confirm(options: PromptOptions): Promise<unknown>;
  isCancel(value: unknown): boolean;
}

const labels: Record<MigrationDecision["action"], { label: string; hint: string }> = {
  restore: { label: "Restore all candidates", hint: "explicitly restore every listed candidate; future plugin subscriptions stay unchanged" },
  keep: { label: "Skip historical restoration", hint: "leave these historical skills unrestored and continue the remaining updates" },
  select: { label: "Choose individual skills", hint: "restore only the skills you select" },
  enabled: { label: "Enable the merged plugin", hint: "enable the combined selection in agent runtimes" },
  disabled: { label: "Keep the merged plugin disabled (Recommended)", hint: "preserve it in the store without activating its contents" },
  drop: { label: "Remove this skill permanently", hint: "no replacement is declared; the old skill will be removed" },
};

/** Returns undefined on cancellation; authorization is never implied by a prompt. */
export async function reviewUpdate(
  review: SourceReview,
  ui: ReviewPrompts = {
    select: options => prompts.select(options as Parameters<typeof prompts.select>[0]),
    multiselect: options => prompts.multiselect(options as Parameters<typeof prompts.multiselect>[0]),
    confirm: options => prompts.confirm(options as Parameters<typeof prompts.confirm>[0]),
    isCancel: prompts.isCancel,
  },
): Promise<ReviewAnswer | undefined> {
  const answer: ReviewAnswer = { history: {}, allow: [] };
  for (const item of review.history) {
    const uncertainSelection = item.uncertain || item.choices.includes("restore");
    const ordered = uncertainSelection
      ? ["keep", "select", "restore", "drop"].filter(action => item.choices.includes(action as MigrationDecision["action"]))
      : item.choices.includes("disabled") ? ["disabled", "enabled"] : item.choices;
    const message = item.id.startsWith("state:")
      ? `${review.source}: resolve enabled and disabled selections for ${item.id.slice(6)}`
      : item.id.startsWith("unmapped:")
        ? `${review.source}: no declared replacement for old plugin ${item.skills.join(", ")}`
      : item.id.startsWith("drop:")
        ? `${review.source}: no replacement for ${item.skills.join(", ")}`
      : item.id.startsWith("ownership:") && !uncertainSelection
        ? `${review.source}: choose a current owner for ${item.skills.join(", ")}`
        : `${review.source}: prior selection of these ${item.skills.length} skill candidates is unknown.\n${item.skills.join(", ")}`;
    const selected = await ui.select({
      message,
      options: ordered.map(action => ({
        value: action,
        ...(item.id.startsWith("unmapped:")
          ? action === "keep"
            ? { label: "Keep the old plugin (Recommended)", hint: "preserve its installed contents and runtime state" }
            : { label: "Remove the old plugin", hint: "explicitly retire this plugin without a declared replacement" }
          : uncertainSelection && action === "keep"
            ? { label: "Keep current selection (Recommended)", hint: "defer these candidates and continue the remaining updates" }
            : labels[action as MigrationDecision["action"]]),
      })),
      initialValue: ordered[0],
    });
    if (ui.isCancel(selected)) return undefined;
    const action = selected as MigrationDecision["action"];
    if (!item.choices.includes(action)) throw new Error(`Invalid migration decision: ${item.id}`);
    let skills: string[] | undefined;
    if (action === "select") {
      const ownerSelection = item.id.startsWith("ownership:");
      const chosen = await (ownerSelection ? ui.select({
        message: "Choose the current plugin that should own this skill",
        options: item.skills.map(address => ({ value: address, label: address })),
        initialValue: item.skills[0],
      }) : ui.multiselect({
        message: "Choose candidates to restore; their prior selection is unknown (space to toggle)",
        options: item.skills.map(skill => ({ value: skill, label: skill })),
        initialValues: [],
        required: false,
      }));
      if (ui.isCancel(chosen)) return undefined;
      skills = ownerSelection ? [chosen as string] : chosen as string[];
      if (!Array.isArray(skills) || skills.some(skill => !item.skills.includes(skill))) throw new Error("Invalid historical skill selection");
    }
    answer.history[item.id] = { action, ...(skills ? { skills } : {}) };
  }
  for (const executable of review.executable) {
    const allowed = await ui.confirm({ message: `Allow ${executable.label}?`, initialValue: false });
    if (ui.isCancel(allowed)) return undefined;
    if (allowed === true) answer.allow.push(executable.key);
  }
  return answer;
}
