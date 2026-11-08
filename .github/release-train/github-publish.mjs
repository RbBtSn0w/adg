// Publication succeeds only when semantic-release returns the original verified release.
import {readFileSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
export async function publishVerified({cwd=process.cwd(),env=process.env,engine,profile='github'}={}) {
  const plan=JSON.parse(readFileSync(join(cwd,profile==='npm'?'release-input/release-plan.json':'release-plan.json'),'utf8'));
  if(plan.schema_version!==1||plan.verification!=='passed'||plan.release_needed!==true||plan.candidate_sha!==env.CANDIDATE_SHA)
    throw new Error('Publication requires the sealed verified candidate');
  const config=JSON.parse(readFileSync(join(cwd,'.releaserc.json'),'utf8'));
  const requireTool=createRequire(join(resolve(env.RELEASE_TOOLS||cwd),'package.json'));
  if(!engine)({default:engine}=await import(pathToFileURL(requireTool.resolve('semantic-release')).href));
  const plugins=config.plugins.map(plugin=>{
    const [name,options={}]=Array.isArray(plugin)?plugin:[plugin,{}];
    return [name.startsWith('.')||isAbsolute(name)?resolve(cwd,name):requireTool.resolve(name),options];
  });
  const result=await engine({...config,plugins},{cwd,env:{...env,RELEASE_PLAN_REQUIRED:'true'}});
  if(!result||!result.nextRelease)throw new Error('semantic-release returned no release; publication was not completed');
  const actual=result.nextRelease;
  if(actual.gitHead!==plan.candidate_sha||actual.version!==plan.version||actual.gitTag!==plan.tag||actual.notes!==plan.notes)
    throw new Error('Actual publication differs from the sealed SHA/version/tag/notes');
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await publishVerified();
