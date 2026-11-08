import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
test('actual recovery entrypoint in a checkout with spaces rejects disabled publication',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'release checkout with spaces '));mkdirSync(join(cwd,'scripts'));mkdirSync(join(cwd,'.github'));
 for(const name of ['release-recover.mjs','release-payload.mjs','release-observe.mjs'])cpSync(join('scripts',name),join(cwd,'scripts',name));
 cpSync('.github/release-train',join(cwd,'.github/release-train'),{recursive:true});
 const run=spawnSync(process.execPath,[join(cwd,'scripts/release-recover.mjs')],{cwd,env:{...process.env,RELEASE_ENABLED:'false'},encoding:'utf8'});
 assert.notEqual(run.status,0);assert.match(run.stderr,/Publication remains disabled/);
});
