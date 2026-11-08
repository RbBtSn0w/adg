// Confirm the pushed formula against current remote main before writing evidence.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const git=(...args)=>execFileSync('git',['-C','homebrew-tap',...args],{encoding:'utf8',timeout:30000}).trim();
const metadata=JSON.parse(readFileSync('release-input/final.json'));
git('fetch','origin','main');
const commit=git('rev-parse','FETCH_HEAD');
const formula=git('show',`${commit}:Formula/adg.rb`);
const expected=readFileSync('homebrew-tap/Formula/adg.rb','utf8').trim();
if(formula!==expected || !formula.includes(metadata.sha256) || !formula.includes(metadata.version))throw Error('Remote Homebrew formula does not match the verified release');
writeFileSync('release-input/receipts/homebrew.json',JSON.stringify({status:'completed',candidate_sha:metadata.candidate_sha,version:metadata.version,observed_at:new Date().toISOString(),remote_id:commit,url:`https://github.com/rbbtsn0w/homebrew-tap/blob/${commit}/Formula/adg.rb`,sha256:createHash('sha256').update(formula).digest('hex'),source_sha256:metadata.sha256}));
