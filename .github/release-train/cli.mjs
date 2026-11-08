// Stable operations, with product commands kept in consumer-owned workflow steps.
import {existsSync,readFileSync,appendFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {analyzeRelease} from './release-analysis.mjs';
import {sealPlan as sealGitHub,reportStatus as reportGitHub} from './github-release-adapter.mjs';
import {sealPlan as sealNpm} from './npm-release-adapter.mjs';
import {publishVerified} from './github-publish.mjs';
import {writeResult,reportExitCode} from './release-result.mjs';
export async function main(args=process.argv.slice(2)){
 const operation=args.shift();const value=flag=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
 const path=value('--config')||'.github/release-train.json';
 const config=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
 if(config.schema_version!==undefined&&config.schema_version!==1)throw Error('Unsupported runtime config');
 const profile=value('--profile')||config.profile||'github';
 if(profile==='custom'){
  if(!['analyze','seal','publish','recover','report'].includes(operation))throw Error('Unsupported release operation');
  if(typeof config.adapter!=='string'||isAbsolute(config.adapter))throw Error('A consumer-relative trusted adapter is required');
  const cwd=realpathSync(process.cwd()),adapter=realpathSync(resolve(cwd,config.adapter)),location=relative(cwd,adapter);
  if(location.startsWith('..')||isAbsolute(location))throw Error('Consumer adapter must remain inside repository');
  const module=await import(pathToFileURL(adapter).href);if(typeof module[operation]!=='function')throw Error(`Consumer adapter does not implement ${operation}`);
  return module[operation]({cwd,env:process.env,args,config});
 }
 if(!['github','npm'].includes(profile))throw Error('Unsupported release profile');
 if(operation==='analyze'){const plan=await analyzeRelease({outputPath:value('--output')||'release-plan.json'});if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`release_needed=${plan.release_needed}\nrelease=${plan.release_needed}\n`);process.stdout.write(JSON.stringify(plan)+'\n');return plan;}
 if(operation==='seal')return profile==='npm'?sealNpm():sealGitHub();
 if(operation==='publish')return publishVerified({profile});
 if(operation==='recover'){const module=await import(profile==='npm'?'./npm-recover.mjs':'./github-recover.mjs');return module.recover();}
 if(operation==='report'){
  if(value('--input')){
   const input=JSON.parse(readFileSync(value('--input'),'utf8'));
   if(config.intended_targets!==undefined&&!Array.isArray(config.intended_targets))throw Error('Configured intended targets must be an array');
   const intended_targets=Array.isArray(input.intended_targets)&&Array.isArray(config.intended_targets)?[...new Set([...config.intended_targets,...input.intended_targets])]:input.intended_targets??config.intended_targets;
   return writeResult(value('--output')||'release-result.json',{...input,intended_targets});
  }
  if(profile==='github')return reportGitHub();
  const module=await import('./npm-release-status.mjs');return value('--mode')==='final'?module.finalStatus():module.reportStatus({mode:value('--mode')||'verify'});
 }
 throw Error('Usage: cli.mjs analyze|seal|publish|recover|report [--profile github|npm] [--config FILE] [--input FILE --output FILE]');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=await main();
 if(process.argv[2]==='report'){
  const status=reportExitCode(result);process.exitCode=Math.max(process.exitCode||0,status);
  if(status)process.stderr.write('::error::Release outcome requires attention; JSON and Summary have been retained.\n');
 }
}
