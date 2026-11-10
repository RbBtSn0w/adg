// Compatibility composition for existing implementations, outside business coordination.
import {realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {analyzeRelease} from './release-analysis.mjs';
import {sealPlan as sealGitHub,reportStatus as reportGitHub} from './github-release-adapter.mjs';
import {sealPlan as sealNpm} from './npm-release-adapter.mjs';
import {publishVerified} from './github-publish.mjs';
import {optionValues} from './cli-options.mjs';

export async function resolveOperations({config,cwd=process.cwd(),profile=config.profile||'github'}) {
  if (profile === 'custom') {
    if (typeof config.adapter !== 'string' || isAbsolute(config.adapter)) throw Error('A consumer-relative trusted adapter is required');
    const root=realpathSync(cwd),adapter=realpathSync(resolve(root,config.adapter)),location=relative(root,adapter);
    if (location === '..' || location.startsWith('..'+(process.platform==='win32'?'\\':'/')) || isAbsolute(location)) throw Error('Consumer adapter must remain inside repository');
    return import(pathToFileURL(adapter).href);
  }
  if (!['github','npm'].includes(profile)) throw Error('Unsupported release profile');
  return {
    pipelineProtocolVersion:1,
    analysisFile:({args})=>optionValues(args,['--output'])('--output')||'release-plan.json',
    planIdentity:plan=>plan,
    analyze:async context=>{
      const outputPath=optionValues(context.args,['--output'])('--output')||'release-plan.json';
      return analyzeRelease({...context,outputPath});
    },
    seal:context=>profile==='npm'?sealNpm(context):sealGitHub(context),
    publish:context=>publishVerified({...context,profile}),
    recover:async context=>(await import(profile==='npm'?'./npm-recover.mjs':'./github-recover.mjs')).recover(context),
    report:async context=>{
      if (profile==='github') return reportGitHub(context);
      const status=await import('./npm-release-status.mjs');
      const mode=optionValues(context.args,['--mode'])('--mode');
      return mode==='final'?status.finalStatus(context):status.reportStatus({...context,mode:mode||'verify'});
    },
  };
}
