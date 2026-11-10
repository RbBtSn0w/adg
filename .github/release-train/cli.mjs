// Entrypoints coordinate contracts; concrete existing operations live in bindings.
import {existsSync,readFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {optionValues} from './cli-options.mjs';
import {resolveOperations} from './operation-bindings.mjs';
import {configurationForOperation,assertOperationCompatibility,captureAnalysis} from './release-entrypoint.mjs';
import {writeCompatibleResult,withPipelineResult} from './pipeline-contract.mjs';
import * as writer from './release-result.mjs';
export async function main(args=process.argv.slice(2)) {
  args=[...args];
  const operation=args.shift();
  const value=optionValues(args,['--config','--profile','--output','--input','--mode','--directory']);
  if(!['analyze','seal','publish','recover','report'].includes(operation))throw Error('Unsupported release operation');
  const path=value('--config')||'.github/release-train.json';
  const config=configurationForOperation(existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{},value('--profile'));
  if(['publish','recover'].includes(operation)&&process.env.RELEASE_ENABLED!=='true')throw Error('Publication is disabled');
  const context={cwd:process.cwd(),env:process.env,args,config};
  if(operation==='report'&&value('--input')) {
    const input=JSON.parse(readFileSync(value('--input'),'utf8'));
    if(config.intended_targets!==undefined&&!Array.isArray(config.intended_targets))throw Error('Configured intended targets must be an array');
    const intended_targets=Array.isArray(input.intended_targets)&&Array.isArray(config.intended_targets)?[...new Set([...config.intended_targets,...input.intended_targets])]:input.intended_targets??config.intended_targets;
    return writeCompatibleResult(writer,value('--output')||'release-result.json',withPipelineResult(input.pipeline?input:{...input,intended_targets},{config}));
  }
  const adapter=await resolveOperations({...context,profile:value('--profile')||config.profile});
  assertOperationCompatibility(adapter,config);
  if(typeof adapter[operation]!=='function')throw Error(`Consumer adapter does not implement ${operation}`);
  const result=await adapter[operation](context);
  if(operation==='analyze') {
    captureAnalysis(adapter,context);
    if(result&&typeof result.release_needed==='boolean') {
      if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`release_needed=${result.release_needed}\nrelease=${result.release_needed}\n`);
      process.stdout.write(JSON.stringify(result)+'\n');
    }
  }
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=await main();
 if(process.argv[2]==='report'){
  const status=writer.reportExitCode(result);process.exitCode=Math.max(process.exitCode||0,status);
  if(status)process.stderr.write('::error::Release outcome requires attention; JSON and Summary have been retained.\n');
 }
}
