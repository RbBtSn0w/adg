import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { AdapterTarget } from "../adapters/index.ts";
import { pluginContents } from "../components.ts";
import type { PluginCandidate } from "../deps.ts";
import { readManifest } from "../manifest.ts";
import { pluginSourceCacheDir } from "../paths.ts";
import {
  COMPONENT_TYPES,
  resolveSelectionDependencies,
  type LockEntry,
  type PluginSelection,
  type SourceIntent,
} from "../types.ts";
import { executableInventory, type ExecutableEntry } from "../update-executables.ts";
import { contentHash } from "./install/install-one.ts";
import { requestedSelectionKnown, verifiedInstalledPayload } from "../source-history.ts";
import type { MigrationDecision, MigrationDecisionRequest } from "../upgrade-plan.ts";

export interface SourceReview {
  source: string;
  history: MigrationDecisionRequest[];
  executable: { key: string; label: string }[];
}
export interface ReviewAnswer {
  history: Record<string, MigrationDecision>;
  allow: string[];
}
export type ReviewUpdate = (review: SourceReview) => Promise<ReviewAnswer | undefined>;
export class UpdateCancelled extends Error {
  partial?: import("./marketplace.ts").PluginUpdateResult;
}

export function verifiedSource(pluginsDir: string, name: string, entry: LockEntry): string | undefined {
  const cached = pluginSourceCacheDir(pluginsDir, name);
  try {
    if (existsSync(cached) && contentHash(cached, readManifest(cached)) === entry.sourceHash) return cached;
  } catch { /* Damaged source metadata is unavailable evidence; the update can rebuild it. */ }
  return undefined;
}

interface CandidateReview {
  name: string;
  candidate: PluginCandidate;
  old?: LockEntry;
  selection?: PluginSelection;
}

interface Permission {
  key: string;
  label: string;
  name: string;
  component: "hooks" | "mcp";
  member: string;
  previouslyEnabled: boolean;
}

/** Selections are shared across projections. Ask once per effective service or hook file. */
export async function reviewExecutables(
  pluginsDir: string,
  intent: SourceIntent,
  candidates: CandidateReview[],
  targets?: AdapterTarget[],
  review?: ReviewUpdate,
): Promise<{ selections: Map<string, PluginSelection>; blockers: string[]; reviewed: boolean }> {
  const permissions: Permission[] = [];
  const selections = new Map<string, PluginSelection>();
  const blockers: string[] = [];
  for (const { name, candidate, selection, old } of candidates) {
    const effective = resolveSelectionDependencies(candidate.manifest, selection);
    const proposed = executableInventory(candidate.dir, candidate.manifest, effective, targets);
    if (!proposed.length) continue;
    const selectionKnown = old && requestedSelectionKnown(old);
    // Complete source bytes establish permission only with a known requested policy.
    const previous = old && ((selectionKnown ? verifiedSource(pluginsDir, name, old) : undefined)
      ?? verifiedInstalledPayload(pluginsDir, name, old));
    const prior = previous
      ? executableInventory(
          previous,
          readManifest(previous),
          selectionKnown ? resolveSelectionDependencies(readManifest(previous), old?.selection) : undefined,
          targets,
        )
      : [];
    const approved = new Set(prior.map((entry) => entry.id));
    const groups = new Map<string, ExecutableEntry[]>();
    for (const entry of proposed) {
      const group = entry.component + ":" + entry.member;
      const entries = groups.get(group) ?? [];
      entries.push(entry);
      groups.set(group, entries);
    }
    for (const entries of groups.values()) {
      if (entries.every((entry) => approved.has(entry.id))) continue;
      const first = entries[0]!;
      const hash = createHash("sha256")
        .update(JSON.stringify(entries.map((entry) => entry.id).sort()))
        .digest("hex");
      permissions.push({
        key: name + ":" + hash,
        name,
        component: first.component,
        member: first.member,
        label:
          name +
          " / " +
          [...new Set(entries.filter((entry) => !approved.has(entry.id)).map((entry) => entry.label))].join(", "),
        previouslyEnabled: prior.some(
          (entry) => entry.component === first.component && (first.component === "hooks" || entry.member === first.member),
        ),
      });
    }
  }
  const unknown = permissions.filter((item) => intent.executableDecisions?.[item.key] === undefined);
  if (unknown.length) {
    if (!review) return { selections, blockers: unknown.map((item) => "Approval required: " + item.label), reviewed: false };
    const answer = await review({ source: intent.source, history: [], executable: unknown });
    if (!answer) throw new UpdateCancelled();
    intent.executableDecisions ??= {};
    for (const item of unknown) intent.executableDecisions[item.key] = answer.allow.includes(item.key);
  }
  for (const { name, candidate, selection } of candidates) {
    const denied = permissions.filter((item) => item.name === name && !intent.executableDecisions?.[item.key]);
    if (!denied.length) continue;
    // Replacing an existing live handler/service with a denied revision would
    // remove a capability the user already relies on. Preserve the old group.
    if (denied.some((item) => item.previouslyEnabled)) {
      blockers.push(
        "The existing installation was kept because this update changes " +
          denied.map((item) => item.label).join(", ") +
          ".",
      );
      continue;
    }
    const denyHooks = denied.some((item) => item.component === "hooks");
    const servers = denied.filter((item) => item.component === "mcp").map((item) => item.member);
    const filtered: PluginSelection = {
      ...selection,
      components: (selection?.components ?? [...COMPONENT_TYPES]).filter((component) => component !== "hooks" || !denyHooks),
    };
    if (servers.length)
      filtered.mcp = (selection?.mcp ?? pluginContents(candidate.dir, candidate.manifest).mcp).filter(
        (server) => !servers.includes(server),
      );
    const checked = resolveSelectionDependencies(candidate.manifest, filtered);
    if (
      executableInventory(candidate.dir, candidate.manifest, checked, targets).some(
        (item) => (denyHooks && item.component === "hooks") || (item.component === "mcp" && servers.includes(item.member)),
      )
    ) {
      blockers.push(name + " requires a declined executable component. The current installation was kept.");
    } else {
      selections.set(name, filtered);
    }
  }
  return { selections, blockers, reviewed: permissions.length > 0 };
}
