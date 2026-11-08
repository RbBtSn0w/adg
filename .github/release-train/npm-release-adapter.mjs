import {recoveryTag,cleanRecoveryTag,reconcileLatest} from './npm-recovery-tag.mjs';
// Run after @semantic-release/npm prepare. Never rebuild the verified package.
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const digest=(path,algorithm='sha256')=>createHash(algorithm).update(readFileSync(path)).digest(algorithm==='sha512'?'base64':'hex');
const read=path=>JSON.parse(readFileSync(path,'utf8'));
function selected(cwd){
 const plan=read(join(cwd,'release-input/release-plan.json'));
 if(plan.schema_version!==1||plan.verification!=='passed'||plan.release_needed!==true)throw Error('Publication requires a verified release plan');
 return plan;
}
export function verifyRelease(_options,{cwd,env=process.env,nextRelease}){
 const plan=selected(cwd);
 if(nextRelease.gitHead!==plan.candidate_sha||nextRelease.version!==plan.version||nextRelease.gitTag!==plan.tag)throw Error('Semantic-release differs from the verified candidate/version/tag');
 if(env.RELEASE_ENABLED!=='true')throw Error('Publication remains disabled');
}
export function sealPlan({cwd=process.cwd(),env=process.env}={}){
 const plan=read(join(cwd,'release-plan.json'));
 if(plan.schema_version!==1||env.PRODUCT_CHECK_STATUS!=='success'||env.PACKAGE_STATUS!=='success'||plan.candidate_sha!==env.CANDIDATE_SHA||!plan.release_needed)throw Error('Seal requires successful exact-candidate product and package verification');
 plan.verification='passed';mkdirSync(join(cwd,'release-input'),{recursive:true});
 writeFileSync(join(cwd,'release-input/release-plan.json'),JSON.stringify(plan,null,2)+'\n');
 return plan;
}
function payload(archive){
 const names=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).split('\n').filter(name=>name&&!name.endsWith('/'));
 if(new Set(names).size!==names.length||names.some(name=>!name.startsWith('package/')||name.split('/').includes('..')))throw Error('Unsafe package archive');
 return Object.fromEntries(names.sort().map(name=>[name,execFileSync('tar',['-xOf',archive,name],{maxBuffer:100*1024*1024})]).filter(([name])=>name!=='package/package.json').map(([name,bytes])=>[name,createHash('sha256').update(bytes).digest('hex')]));
}
export function prepare(options,context){
 const {cwd,env=process.env,nextRelease}=context;verifyRelease(options,context);
 const plan=selected(cwd),output=join(cwd,'release-output');
 // Notes are generated after verifyRelease; compare them at the prepare boundary.
 if(nextRelease.notes!==plan.notes)throw Error('Generated release notes differ from the verified plan');
 const archives=readdirSync(output).filter(name=>name.endsWith('.tgz'));
 if(archives.length!==1)throw Error('Expected exactly one final npm prepare archive');
 const archive=join(output,archives[0]),original=join(cwd,'release-input/package.tgz');
 const manifest=JSON.parse(execFileSync('tar',['-xOf',archive,'package/package.json'],{encoding:'utf8'}));
 const before=JSON.parse(execFileSync('tar',['-xOf',original,'package/package.json'],{encoding:'utf8'}));
 if(JSON.stringify({...before,version:nextRelease.version})!==JSON.stringify(manifest)||JSON.stringify(payload(original))!==JSON.stringify(payload(archive)))throw Error('Final npm payload differs beyond the selected manifest version');
 const sealed=join(cwd,'release-sealed');mkdirSync(sealed,{recursive:true});copyFileSync(archive,join(sealed,'final.tgz'));
 const metadata={...plan,operation:'release',repository:env.GITHUB_REPOSITORY,source_run_id:env.GITHUB_RUN_ID,name:manifest.name,sha256:digest(archive),integrity:'sha512-'+digest(archive,'sha512')};
 if(!metadata.repository||!/^\d+$/.test(metadata.source_run_id||''))throw Error('Original release provenance is required');
 writeFileSync(join(sealed,'final.json'),JSON.stringify(metadata,null,2)+'\n');
 // semantic-release creates the tag only after every prepare hook has completed.
 const head=execFileSync('git',['rev-parse','HEAD'],{cwd,env,encoding:'utf8'}).trim();
 const live=execFileSync('gh',['api',`repos/${metadata.repository}/git/ref/heads/main`,'--jq','.object.sha'],{cwd,env,encoding:'utf8',timeout:10000}).trim();
 if(head!==plan.candidate_sha||live!==plan.candidate_sha)throw Error('Main changed or could not be read before tag creation');
}
export async function verifyNpm({cwd=process.cwd(),env=process.env,recover=false}={}){
 const input=join(cwd,'release-sealed'),metadata=read(join(input,'final.json')),archive=join(input,'final.tgz');
 if(metadata.sha256!==digest(archive)||metadata.integrity!=='sha512-'+digest(archive,'sha512'))throw Error('Sealed final npm archive differs');
 const registry='https://registry.npmjs.org';
 const tagOptions={cwd,env,registry};
 const distributionTag=recover?recoveryTag(metadata,tagOptions):'latest';
 const lookup=()=>spawnSync('npm',['view',`${metadata.name}@${metadata.version}`,'dist.integrity','--json','--registry',registry],{cwd,env,encoding:'utf8',timeout:120000});
 let observed=lookup();
 if(observed.status!==0&&recover){
  let error;try{error=JSON.parse(observed.stdout).error;}catch{/* fail closed */}
  if(error?.code!=='E404')throw Error(`npm registry lookup failed: ${observed.stderr}`);
  execFileSync('npm',['publish',resolve(archive),'--ignore-scripts','--access','public','--provenance','--tag',distributionTag,'--registry',registry],{cwd,env:{...env,NPM_CONFIG_IGNORE_SCRIPTS:'true'},stdio:'inherit',timeout:120000});
 }
 let matched=false;
 for(let attempt=0;attempt<3;attempt++){
  if(attempt||observed.status!==0)observed=lookup();
  try{matched=observed.status===0&&JSON.parse(observed.stdout)===metadata.integrity;}catch{/* unknown remains failed */}
  if(matched)break;
  if(observed.status===0)throw Error('Existing npm version differs from sealed original bytes');
  if(attempt<2)await new Promise(done=>setTimeout(done,1000*(attempt+1)));
 }
 if(!matched)throw Error(`npm integrity readback failed: ${observed.stderr||observed.stdout}`);
 let latestVersion;
 if(recover){latestVersion=reconcileLatest(metadata,tagOptions);cleanRecoveryTag(metadata,distributionTag,tagOptions);}
 const receipt={status:'completed',candidate_sha:metadata.candidate_sha,version:metadata.version,observed_at:new Date().toISOString(),remote_id:`${metadata.name}@${metadata.version}`,...(latestVersion?{latest_version:latestVersion}:{}),url:`https://www.npmjs.com/package/${metadata.name}/v/${metadata.version}`,sha256:metadata.sha256};
 mkdirSync(join(input,'receipts'),{recursive:true});writeFileSync(join(input,'receipts/npm.json'),JSON.stringify(receipt)+'\n');return receipt;
}
export async function publish(_options,{cwd,env}){await verifyNpm({cwd,env});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='seal-plan')sealPlan();
 else throw Error('Usage: npm-release-adapter.mjs seal-plan');
}
