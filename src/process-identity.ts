import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { runSubprocessSync } from "./subprocess.ts";

export interface ProcessIdentity { kind: string; version: 1; birthToken: string }
let ownIdentity: ProcessIdentity | undefined;

/** Return only OS birth evidence. Failure is uncertainty, never proof of death. */
export function queryProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid && ownIdentity) return ownIdentity;
  try {
    if (process.platform === "linux") {
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(boot)) return undefined;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm may contain spaces and parentheses. Field 22 follows the final ')'.
      const end = stat.lastIndexOf(")");
      if (!stat.startsWith(`${pid} (`) || end < 0) return undefined;
      const start = stat.slice(end + 1).trim().split(/\s+/)[19];
      if (!start || !/^\d+$/.test(start)) return undefined;
      return { kind: "linux-proc", version: 1, birthToken: `${boot}:${start}` };
    }
    if (process.platform === "darwin") {
      const result = runSubprocessSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8", timeout: 2000, maxBuffer: 1024,
        env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
      });
      if (result.error || result.status !== 0) return undefined;
      const token = result.stdout.trim();
      if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(token)) return undefined;
      // ps has second precision: a same-second reuse remains conservatively live.
      return { kind: "darwin-ps-lstart", version: 1, birthToken: token };
    }
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot || !win32.isAbsolute(systemRoot)) return undefined;
      const executable = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      // Capture self identity before publishing a contender, allowing a cold shell start.
      const result = runSubprocessSync(executable, ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)`], {
        encoding: "utf8", timeout: pid === process.pid ? 10_000 : 2000, maxBuffer: 1024, windowsHide: true,
      });
      if (result.error || result.status !== 0) return undefined;
      const token = result.stdout.trim();
      if (!/^[1-9]\d*$/.test(token)) return undefined;
      return { kind: "windows-start-filetime", version: 1, birthToken: token };
    }
  } catch { /* Access failures do not establish process identity. */ }
  return undefined;
}

export function getCurrentProcessIdentity(): ProcessIdentity {
  ownIdentity ??= queryProcessIdentity(process.pid);
  if (!ownIdentity) throw new Error("Cannot establish ADG mutation process identity; restore access to OS process information and retry.");
  return ownIdentity;
}
