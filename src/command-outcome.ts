export type CommandOutcomeKind = "success" | "partial" | "failure" | "cancelled";
export type ErrorCategory = "user" | "dependency" | "timeout" | "rate_limit" | "internal";

export interface CommandOutcome {
  kind: CommandOutcomeKind;
  exitCode: number;
  errorCategory?: ErrorCategory;
}

export function commandOutcome(
  kind: CommandOutcomeKind,
  errorCategory?: ErrorCategory,
): CommandOutcome {
  const exitCode = kind === "success" ? 0 : kind === "cancelled" ? 130 : 1;
  return errorCategory === undefined ? { kind, exitCode } : { kind, exitCode, errorCategory };
}

export function mergeCommandOutcomes(outcomes: readonly CommandOutcome[]): CommandOutcome {
  if (outcomes.length === 0 || outcomes.every((outcome) => outcome.kind === "success")) {
    return commandOutcome("success");
  }
  if (outcomes.every((outcome) => outcome.kind === "cancelled")) {
    return commandOutcome("cancelled");
  }
  const partiallySuccessful = outcomes.some(
    (outcome) => outcome.kind === "success" || outcome.kind === "partial",
  );
  const category = outcomes.find((outcome) => outcome.errorCategory)?.errorCategory;
  return commandOutcome(partiallySuccessful ? "partial" : "failure", category);
}
