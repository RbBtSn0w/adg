import {validateOriginalPlan} from './release-entrypoint.mjs';
// Reconcile original GitHub effects; never retag, rebuild, or replace notes.
import {assertPublicationEnabled} from './publication-guard.mjs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyRecoverySource} from './recovery-source.mjs';
import {observeGitHub} from './observe-github.mjs';
const gh=(...args)=>execFileSync('gh',args,{timeout:120000,maxBuffer:32*1024*1024});
const api=path=>JSON.parse(gh('api',path));
export function validatePlan(plan,candidate){
 validateOriginalPlan(plan);
 if(!/^[a-f0-9]{40}$/.test(candidate||'')||plan.schema_version!==1||plan.candidate_sha!==candidate||typeof plan.notes!=='string'||plan.verification!=='passed'||plan.release_needed!==true||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(plan.version||'')||plan.tag!==`v${plan.version}`)throw Error('Recovery requires original verified stable plan identity and notes');
 return plan;
}
export function validateArtifactName(name,attempt){
 const match=/^release-plan-([1-9]\d*)$/.exec(name||'');
 if(name!=='release-plan'&&(!match||!Number.isInteger(attempt)||Number(match[1])>attempt))throw Error('Recovery requires original sealed artifact from completed source attempt');
}
export function readPlanArchive(raw){
 // Parse one ZIP central-directory record. Never extract paths or execute content.
 let end=-1;for(let i=raw.length-22;i>=Math.max(0,raw.length-65557);i--)if(raw.readUInt32LE(i)===0x06054b50){end=i;break;}
 if(end<0||raw.readUInt16LE(end+8)!==1||raw.readUInt16LE(end+10)!==1||raw.readUInt16LE(end+4)!==0||raw.readUInt16LE(end+6)!==0)throw Error('Recovery archive must contain exactly one allowlisted plan');
 const central=raw.readUInt32LE(end+16);
 if(raw.readUInt32LE(central)!==0x02014b50)throw Error('Invalid recovery archive central directory');
 const size=raw.readUInt32LE(central+24),compressed=raw.readUInt32LE(central+20),method=raw.readUInt16LE(central+10),nameLength=raw.readUInt16LE(central+28),name=raw.subarray(central+46,central+46+nameLength).toString();
 const mode=raw.readUInt32LE(central+38)>>>16,local=raw.readUInt32LE(central+42);
 if(name!=='release-plan.json'||(mode&0xf000)===0xa000||(mode&0xf000)===0x4000||size>16*1024*1024||raw.readUInt16LE(central+8)&1||raw.readUInt32LE(local)!==0x04034b50)throw Error('Recovery plan must be one bounded regular data file');
 const start=local+30+raw.readUInt16LE(local+26)+raw.readUInt16LE(local+28);
 const bytes=raw.subarray(start,start+compressed);
 const content=method===0?bytes:method===8?inflateRawSync(bytes,{maxOutputLength:16*1024*1024}):null;
 if(!content||content.length!==size||start+compressed>central)throw Error('Invalid recovery archive payload');
 return JSON.parse(content.toString('utf8'));
}
export async function recover({env=process.env,cwd=process.cwd(),read=api,command=gh}={}){
 assertPublicationEnabled(env);
 const repository=env.GITHUB_REPOSITORY,sourceRunId=env.SOURCE_RUN_ID,artifactId=env.ARTIFACT_ID;
 const run=read(`repos/${repository}/actions/runs/${sourceRunId}`),artifact=read(`repos/${repository}/actions/artifacts/${artifactId}`);
 const identity=verifyRecoverySource({run,artifact,repository,sourceRunId,artifactId});
 validateArtifactName(artifact.name,run.run_attempt);
 const raw=command('api',`repos/${repository}/actions/artifacts/${artifactId}/zip`);
 if(artifact.digest!==`sha256:${createHash('sha256').update(raw).digest('hex')}`)throw Error('Recovery artifact digest mismatch');
 const plan=validatePlan(readPlanArchive(raw),identity.candidate_sha);
 writeFileSync(join(cwd,'release-plan.json'),JSON.stringify(plan,null,2)+'\n');
 const observed=observeGitHub({plan,repository,read});
 if(observed.targets.stable_tag.status!=='completed')throw Error('missing-tag or conflicting original stable tag; recovery cannot create or move tags');
 if(observed.recovery.state!=='repairable')throw Error(`GitHub recovery preflight blocked: ${observed.recovery.reason}`);
 const pages=JSON.parse(command('api',`repos/${repository}/releases`,'--paginate','--slurp'));
 if(!Array.isArray(pages)||pages.some(page=>!Array.isArray(page)))throw Error('Invalid paginated release listing');
 const matches=pages.flat().filter(item=>item.tag_name===plan.tag);
 if(matches.length>1)throw Error('Ambiguous original GitHub Release identity');
 const existing=matches[0];
 if(existing&&(existing.prerelease!==false||existing.body!==plan.notes))throw Error('Existing release notes or channel differ from original');
 const temporary=mkdtempSync(join(tmpdir(),'github-recovery-'));
 try{
  const notes=join(temporary,'notes.md');writeFileSync(notes,plan.notes);
  if(!existing)command('release','create',plan.tag,'--repo',repository,'--verify-tag','--latest=false','--title',plan.tag,'--notes-file',notes);
  else if(existing.draft)command('release','edit',plan.tag,'--repo',repository,'--latest=false','--draft=false');
  const completed=observeGitHub({plan,repository,read});
  if(completed.targets.github.status!=='completed')throw Error('Completed GitHub Release readback differs from original sealed plan');
  writeFileSync(join(cwd,'github-receipts.json'),JSON.stringify(completed,null,2)+'\n');
  return completed;
 }finally{rmSync(temporary,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await recover();
