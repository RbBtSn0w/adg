import { getAgent, agentsForComponents, type Agent, type AgentContext, type AgentPluginRecord, type AgentSyncResult, type AgentInspectionResult } from "../agents/index.ts";
import { selectInstalled, rematerializeInstalled } from "./projection.ts";
import { dependencyOrder } from "./dependency-order.ts";
import { readLock } from "../lock.ts";
import { lockPath } from "../paths.ts";
import { pluginState, type ComponentType } from "../types.ts";
import { getTracer, recordTelemetryEvent } from "../telemetry.ts";

/** Both status and planning interpret records from an already-scoped snapshot. */
export function runtimeDifference(names: string[], records: AgentPluginRecord[]) {
  const byName = new Map(records.map((record) => [record.name, record]));
  return {
    runtimeMissing: names.filter((name) => !byName.get(name)?.installed),
    runtimeDisabled: names.filter((name) => byName.get(name)?.installed && !byName.get(name)?.enabled),
  };
}

export function registrationPlan(names: string[], records: AgentPluginRecord[], enableDisabled: boolean, changed: readonly string[] = []) {
  const difference = runtimeDifference(names, records);
  const missing = new Set(difference.runtimeMissing);
  const disabled = new Set(difference.runtimeDisabled);
  const changedSet = new Set(changed);
  return {
    targets: names.filter((name) => missing.has(name) || (disabled.has(name) ? enableDisabled : changedSet.has(name))),
    preservedDisabled: enableDisabled ? [] : difference.runtimeDisabled,
  };
}

/** Preserve execution facts while recording whether the runtime confirmed them. */
export function verifyRegistrations(result: AgentSyncResult, snapshot: AgentInspectionResult): AgentSyncResult {
  const valid = Array.isArray(snapshot)
    ? new Set(snapshot.filter((record) => record.installed && record.enabled).map((record) => record.name))
    : undefined;
  const verified = result.affected.filter((name) => valid?.has(name));
  const unverified = result.affected.filter((name) => !valid?.has(name));
  const failures = unverified.map((plugin) => ({
    plugin, stage: "verify" as const,
    errorType: valid ? "REGISTRATION_MISSING" : "STATE_UNAVAILABLE",
    message: Array.isArray(snapshot)
      ? "Codex did not report the plugin installed and enabled after execution."
      : snapshot?.error ?? "Installation finished, but Codex state could not be verified.",
  }));
  return { ...result, verified, unverified, ...(failures.length ? { failures: [...(result.failures ?? []), ...failures] } : {}) };
}

export interface RepairOptions {
  /** Update captures this before any Codex mutation; enable captures it locally. */
  initial?: AgentInspectionResult;
  observed?: boolean;
  changed?: string[];
  removed?: string[];
}

/** Execute one scoped plan, preserving runtime overrides and dependency boundaries. */
export function repairCodex(ctx: AgentContext, enableDisabled: boolean, agent: Agent | null | undefined = getAgent("codex"), options: RepairOptions = {}): AgentSyncResult {
  return getTracer().startActiveSpan("adg.codex.registration_repair", (span) => {
    const result: AgentSyncResult = { agent: "codex", affected: [], skipped: false, verified: [], unverified: [] };
    const fail = (stage: "inspect" | "install" | "verify", errorType: string, message: string, plugin?: string) => {
      (result.failures ??= []).push({ stage, errorType, message, ...(plugin ? { plugin } : {}) });
    };
    try {
      if (!ctx.plugins.length && !options.removed?.length) return result;
      const plugins = ctx.plugins.length ? selectInstalled(ctx.pluginsDir, ctx.plugins).filter((plugin) =>
        pluginState(plugin) === "enabled" && agentsForComponents(Object.entries(plugin.contents ?? {})
          .filter(([, members]) => members.length > 0).map(([type]) => type as ComponentType)).some((a) => a.id === "codex")) : [];
      const names = plugins.map((plugin) => plugin.name);
      const inspect = () => agent?.inspectPlugins?.({ ...ctx, plugins: names });
      const first = options.observed ? options.initial : inspect();
      if (!Array.isArray(first)) { fail("inspect", "STATE_UNAVAILABLE", first?.error ?? "Codex detailed state is unavailable; install a supported CLI."); return result; }
      const planned = registrationPlan(names, first, enableDisabled, options.changed);
      result.preservedDisabled = planned.preservedDisabled;
      const removals = options.removed?.filter((name) => first.some((record) => record.name === name && record.installed)) ?? [];
      if (!planned.targets.length && !removals.length) return result;
      const current = inspect();
      if (!Array.isArray(current)) { fail("inspect", "STATE_UNAVAILABLE", current?.error ?? "Codex state became unavailable before repair."); return result; }
      const latest = registrationPlan(planned.targets, current, enableDisabled, options.changed);
      result.preservedDisabled = [...new Set([...planned.preservedDisabled, ...latest.preservedDisabled])];
      const selected = new Set(latest.targets);
      const lock = readLock(lockPath(ctx.pluginsDir));
      const ordered: string[] = [];
      const blocked = new Set<string>();
      for (const name of latest.targets) {
        try {
          for (const dependency of dependencyOrder(lock, [name])) if (selected.has(dependency) && !ordered.includes(dependency)) ordered.push(dependency);
        } catch (error) {
          blocked.add(name);
          fail("install", "DEPENDENCY_INVALID", error instanceof Error ? error.message : String(error), name);
        }
      }
      const byName = new Map(plugins.map((plugin) => [plugin.name, plugin]));
      const available = new Set(current.filter((record) => record.installed && record.enabled).map((record) => record.name));
      for (const name of ordered) {
        if (blocked.has(name)) continue;
        const dependency = Object.keys(lock.plugins[name]?.dependencies ?? {}).find((dep) => blocked.has(dep) || !available.has(dep));
        if (dependency) {
          blocked.add(name);
          fail("install", "DEPENDENCY_UNAVAILABLE", `Required dependency ${dependency} is unavailable; no installation was attempted.`, name);
          continue;
        }
        try {
          rematerializeInstalled(ctx.pluginsDir, [byName.get(name)!]);
          const installed = agent!.activate({ ...ctx, plugins: [name] });
          result.affected.push(...installed.affected);
          if (installed.failures?.length) (result.failures ??= []).push(...installed.failures);
          if (!installed.affected.includes(name) || installed.failures?.length || installed.skipped) {
            blocked.add(name);
            if (!installed.failures?.length) fail("install", "INSTALLATION_INCOMPLETE", "Codex did not complete installation.", name);
          } else available.add(name);
        } catch (error) {
          blocked.add(name);
          fail("install", "PROJECTION_FAILED", error instanceof Error ? error.message : String(error), name);
        }
      }
      const removeNow = removals.filter((name) => current.some((record) => record.name === name && record.installed));
      if (removeNow.length) {
        const removed = agent!.deactivate({ ...ctx, plugins: removeNow });
        if (removed.failures?.length) (result.failures ??= []).push(...removed.failures);
      }
      if (!result.affected.length && !removeNow.length) return result;
      const verified = inspect();
      Object.assign(result, verifyRegistrations(result, verified));
      if (Array.isArray(verified)) {
        for (const name of removeNow) if (verified.some((record) => record.name === name && record.installed)) fail("verify", "REMOVAL_UNVERIFIED", "Codex still reports the removed plugin installed.", name);
      } else if (removeNow.length && !result.affected.length) {
        fail("verify", "STATE_UNAVAILABLE", verified?.error ?? "Codex removal could not be verified.");
      }
      return result;
    } finally {
      recordTelemetryEvent("adg.codex.registration_repair", {
        "repair.affected_count": result.affected.length,
        "repair.verified_count": result.verified?.length ?? 0,
        "repair.failure_count": result.failures?.length ?? 0,
        "repair.preserved_disabled_count": result.preservedDisabled?.length ?? 0,
      }, span);
      span.end();
    }
  });
}
