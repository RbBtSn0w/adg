import { MultiSelectPrompt } from "@clack/core";
import pc from "picocolors";

/**
 * A skills multiselect with an on-demand description toggle. `@clack/prompts`'
 * `multiselect` can't intercept extra keys, so this builds directly on
 * `@clack/core`'s `MultiSelectPrompt` and replicates clack's chrome, adding a
 * `d` key that lazily loads and inlines each skill's description as a hint.
 *
 * Descriptions are read only while the toggle is on (and cached by the loader),
 * so a list of many skills costs nothing until the user actually asks for them.
 */

// Match @clack/prompts' unicode-aware glyphs so the picker is visually seamless.
const unicode =
  process.platform !== "win32" ||
  Boolean(process.env.WT_SESSION) ||
  process.env.TERM_PROGRAM === "vscode" ||
  process.env.TERM === "xterm-256color";
const g = (a: string, b: string) => (unicode ? a : b);
const S_BAR = g("│", "|");
const S_BAR_END = g("└", "—");
const S_STEP_ACTIVE = g("◆", "*");
const S_STEP_SUBMIT = g("◇", "o");
const S_STEP_CANCEL = g("■", "x");
const S_CHECK_ACTIVE = g("◻", "[•]");
const S_CHECK_SELECTED = g("◼", "[+]");
const S_CHECK_INACTIVE = g("◻", "[ ]");

export interface SkillOption {
  value: string;
  label: string;
}

export type RowKind = "active" | "selected" | "active-selected" | "inactive";

/** Format one option row, appending the description as a dim hint when present. */
export function formatSkillRow(label: string, hint: string | undefined, kind: RowKind): string {
  const tail = hint ? `  ${pc.dim(hint)}` : "";
  switch (kind) {
    case "active":
      return `${pc.cyan(S_CHECK_ACTIVE)} ${label}${tail}`;
    case "active-selected":
      return `${pc.green(S_CHECK_SELECTED)} ${label}${tail}`;
    case "selected":
      return `${pc.green(S_CHECK_SELECTED)} ${pc.dim(label)}${tail}`;
    default:
      return `${pc.dim(S_CHECK_INACTIVE)} ${pc.dim(label)}`;
  }
}

export interface BuildRowsState {
  cursor: number;
  selected: string[];
  /** When false, `loadDescription` is never called — this is the lazy gate. */
  showDesc: boolean;
  loadDescription: (value: string) => string | undefined;
}

/**
 * Build the rendered option rows. Descriptions are resolved only when
 * `showDesc` is true, so the picker performs zero SKILL.md reads until the user
 * presses `d`. Exported as the pure core of the picker for direct testing.
 */
export function buildSkillRows(options: SkillOption[], state: BuildRowsState): string[] {
  return options.map((o, i) => {
    const sel = state.selected.includes(o.value);
    const active = i === state.cursor;
    const hint = state.showDesc ? state.loadDescription(o.value) : undefined;
    const kind: RowKind = active && sel ? "active-selected" : sel ? "selected" : active ? "active" : "inactive";
    return formatSkillRow(o.label, hint, kind);
  });
}

export interface MultiselectSkillsOptions {
  message: string;
  options: SkillOption[];
  initialValues: string[];
  /** Lazy, cached description lookup; invoked only while the toggle is on. */
  loadDescription: (value: string) => string | undefined;
  /** Injection seams for tests; default to process.stdin/stdout. */
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/** Resolves to the chosen values, or a cancel symbol (use `isCancel` to detect). */
export function multiselectSkills(opts: MultiselectSkillsOptions): Promise<string[] | symbol> {
  let showDesc = false;

  const symbol = (state: string): string => {
    if (state === "submit") return pc.green(S_STEP_SUBMIT);
    if (state === "cancel") return pc.red(S_STEP_CANCEL);
    return pc.cyan(S_STEP_ACTIVE);
  };
  const footer = () =>
    pc.dim(`space ${pc.gray("toggle")} · a ${pc.gray("all")} · d ${pc.gray(showDesc ? "hide" : "show")} descriptions`);

  const prompt = new MultiSelectPrompt({
    input: opts.input,
    output: opts.output,
    options: opts.options,
    initialValues: opts.initialValues,
    required: true,
    validate(this: { required?: boolean }, value: unknown) {
      if (this.required && Array.isArray(value) && value.length === 0) {
        return "Please select at least one option.";
      }
      return undefined;
    },
    render(this: { state: string; value: string[]; cursor: number; options: SkillOption[] }) {
      const head = `${pc.gray(S_BAR)}\n${symbol(this.state)}  ${opts.message}\n`;
      if (this.state === "submit" || this.state === "cancel") {
        const chosen = this.options
          .filter((o) => this.value.includes(o.value))
          .map((o) => pc.dim(o.label))
          .join(pc.dim(", "));
        return `${head}${pc.gray(S_BAR)}  ${chosen || pc.dim("none")}`;
      }
      const rows = buildSkillRows(this.options, {
        cursor: this.cursor,
        selected: this.value,
        showDesc,
        loadDescription: opts.loadDescription,
      }).join(`\n${pc.cyan(S_BAR)}  `);
      return `${head}${pc.cyan(S_BAR)}  ${rows}\n${pc.cyan(S_BAR)}  ${footer()}\n${pc.cyan(S_BAR_END)}\n`;
    },
  });

  // `a` (toggle-all) is bound by MultiSelectPrompt itself; `d` is free for us.
  // Touching showDesc here re-renders on the same keypress (onKeypress renders
  // after emitting "key"), so the first `d` press shows descriptions at once.
  (prompt as unknown as { on(e: string, cb: (c: string) => void): void }).on("key", (c) => {
    if (c === "d") showDesc = !showDesc;
  });

  return (prompt as unknown as { prompt(): Promise<string[] | symbol> }).prompt();
}
