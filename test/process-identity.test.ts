import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getCurrentProcessIdentity, queryProcessIdentity } from "../src/process-identity.ts";

const moduleUrl = pathToFileURL(join(import.meta.dirname, "../src/process-identity.ts")).href;
function probe(platform: string, body: string, result: string): void {
  const program = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', {value:${JSON.stringify(platform)}});
    process.env.SystemRoot = ${JSON.stringify('C:\\Windows')};
    process.env.PATH = '';
    const originalRead = fs.readFileSync;
    ${body}
    const { queryProcessIdentity, getCurrentProcessIdentity } = await import(${JSON.stringify(moduleUrl)});
    const identity = queryProcessIdentity(123);
    ${result}
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8", timeout: 5000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
}
function commandMock(body: string): string {
  return `registerHooks({resolve(specifier, context, next) {
    if(specifier === './subprocess.ts') return {url:'data:text/javascript,' + encodeURIComponent(${JSON.stringify(`export function runSubprocessSync(command,args,options) { ${body} }`)}),shortCircuit:true};
    return next(specifier,context);
  }});`;
}
test("native self birth identity is stable and invalid PIDs are uncertain", () => {
  assert.ok(getCurrentProcessIdentity().birthToken);
  assert.strictEqual(getCurrentProcessIdentity(), getCurrentProcessIdentity());
  for (const pid of [0, -1, 1.5, NaN]) assert.equal(queryProcessIdentity(pid), undefined);
});
test("Linux stat parser preserves full start ticks despite parentheses in comm", () => {
  probe('linux', `fs.readFileSync = (path,...args) => typeof path !== 'string' || !path.startsWith('/proc/') ? originalRead(path,...args) : path.endsWith('boot_id') ? '12345678-1234-1234-1234-123456789abc\\n' : '123 (name with ) parens) S ' + Array(18).fill('0').join(' ') + ' 9007199254740993 0'; syncBuiltinESMExports();`,
    `assert.deepEqual(identity,{kind:'linux-proc',version:1,birthToken:'12345678-1234-1234-1234-123456789abc:9007199254740993'});`);
});
for (const content of ['bad boot id', '12345678-1234-1234-1234-123456789abc']) {
  test(`Linux malformed ${content.startsWith('bad') ? 'boot ID' : 'stat'} fails closed`, () => probe('linux',
    `fs.readFileSync = (path,...args) => typeof path !== 'string' || !path.startsWith('/proc/') ? originalRead(path,...args) : path.endsWith('boot_id') ? ${JSON.stringify(content)} : '123 (broken) S'; syncBuiltinESMExports();`, `assert.equal(identity,undefined);`));
}
test("macOS ps uses absolute command and deterministic date environment", () => probe('darwin', commandMock(`
  if(command !== '/bin/ps' || args.join(' ') !== '-p 123 -o lstart=' || options.env.LC_ALL !== 'C' || options.env.TZ !== 'UTC0') throw Error('Invalid command');
  return {status:0,stdout:'Wed Nov 11 09:10:11 2026\\n'};`), `assert.equal(identity.birthToken,'Wed Nov 11 09:10:11 2026');`));
test("Windows birth query uses absolute PowerShell even with an empty PATH", () => probe('win32', commandMock(`
  if(command.replaceAll(String.fromCharCode(92), '/') !== 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' || args[0] !== '-NoProfile' || args[1] !== '-NonInteractive' || !args[3].includes('Get-Process -Id 123 ') || !args[3].includes('ToFileTimeUtc')) throw Error('Invalid command');
  return {status:0,stdout:'133700000000000001\\r\\n'};`), `assert.equal(identity.birthToken,'133700000000000001');`));
for (const platform of ['darwin', 'win32']) {
  for (const outcome of [`{status:1,stdout:''}`, `{status:null,error:new Error('timeout'),stdout:''}`, `{status:0,stdout:'malformed'}`]) {
    test(`${platform} uncertain command result never establishes identity: ${outcome}`, () => probe(platform,
      commandMock(`return ${outcome};`), `assert.equal(identity,undefined); assert.throws(getCurrentProcessIdentity,/Cannot establish ADG mutation process identity/);`));
  }
}
