// Credential-free exact-candidate semantic-release analysis, including non-Node repositories.
import {sealedTagFormat} from './npm-channel.mjs';
import {optionValues} from './cli-options.mjs';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,appendFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,isAbsolute,basename} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';

async function analyzeIsolated({cwd=process.cwd(),configPath='.releaserc.json',outputPath='release-plan.json',tools=process.env.RELEASE_TOOLS,env=process.env}={}) {
  const requireTool=createRequire(join(resolve(tools||cwd),'package.json'));
  const {default:semanticRelease}=await import(pathToFileURL(requireTool.resolve('semantic-release')).href);
  const config=JSON.parse(readFileSync(resolve(cwd,configPath),'utf8'));
  const scratch=mkdtempSync(join(tmpdir(),'release-analysis-'));
  const clean={};
  for(const key of ['PATH','TMPDIR','TMP','TEMP','SYSTEMROOT','SystemRoot','TZ'])if(env[key])clean[key]=env[key];
  clean.HOME=join(scratch,'home');mkdirSync(clean.HOME);
  clean.GIT_CONFIG_NOSYSTEM='1';clean.GIT_CONFIG_GLOBAL='/dev/null';clean.GIT_LFS_SKIP_SMUDGE='1';
  clean.RELEASE_TOOLS=resolve(tools||cwd);
  const git=(...args)=>execFileSync('git',args,{cwd,env:clean,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  let baselineTag=null;
  try{
    const candidate=git('rev-parse','HEAD');
    if(env.CANDIDATE_SHA&&env.CANDIDATE_SHA!==candidate)throw new Error('Release candidate checkout mismatch');
    let repositoryUrl=env.GITHUB_REPOSITORY?`https://github.com/${env.GITHUB_REPOSITORY}.git`:(config.repositoryUrl||git('config','--get','remote.origin.url'));
    try {const url=new URL(repositoryUrl);url.username='';url.password='';repositoryUrl=url.href;}catch{}
    const remote=join(scratch,'source.git'),checkout=join(scratch,'checkout');
    execFileSync('git',['clone','--no-hardlinks','--bare','--quiet',cwd,remote],{env:clean});
    execFileSync('git',['--git-dir',remote,'update-ref','refs/heads/main',candidate],{env:clean});
    execFileSync('git',['clone','--no-hardlinks','--quiet','--branch','main',remote,checkout],{env:clean});
    const plugins=[{analyzeCommits:(_,{lastRelease})=>{baselineTag=lastRelease.gitTag??null;}}];
    for(const plugin of config.plugins){
      const [name,options={}]=Array.isArray(plugin)?plugin:[plugin,{}];
      const pure=name==='@semantic-release/commit-analyzer'||name==='@semantic-release/release-notes-generator'||basename(name)==='commit-semantics.mjs'||(config.releaseAnalysisPlugins||[]).includes(name);
      if(!pure)continue;
      const location=name.startsWith('.')||isAbsolute(name)?resolve(cwd,name):requireTool.resolve(name);
      const module=await import(pathToFileURL(location).href);
      const semantic={};
      // Publication/credential checks are intentionally not part of this local analysis.
      if(module.analyzeCommits)semantic.analyzeCommits=(_unused,context)=>module.analyzeCommits(options,context);
      if(module.generateNotes)semantic.generateNotes=(_unused,context)=>module.generateNotes(options,{...context,options:{...context.options,repositoryUrl}});
      if(Object.keys(semantic).length)plugins.push(semantic);
    }
    const result=await semanticRelease({...config,extends:[],verifyConditions:undefined,verifyRelease:undefined,prepare:undefined,publish:undefined,addChannel:undefined,success:undefined,fail:undefined,analyzeCommits:undefined,generateNotes:undefined,plugins,dryRun:true,ci:false,repositoryUrl:pathToFileURL(remote).href},
      {cwd:checkout,env:clean,stdout:{write(){}},stderr:{write(){}}});
    const plan={schema_version:1,candidate_sha:candidate,baseline_tag:baselineTag,version:result?.nextRelease?.version??null,
      tag:result?.nextRelease?.gitTag??null,tag_format:config.tagFormat??'v${version}',notes:result?.nextRelease?.notes??'',release_needed:Boolean(result),verification:'not-run'};
    if(plan.release_needed)sealedTagFormat(plan);
    if(outputPath)writeFileSync(resolve(cwd,outputPath),JSON.stringify(plan,null,2)+'\n');
    return plan;
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
// execa inside semantic-release extends process.env. A separate process is required;
// context.env alone cannot prevent ambient credentials reaching its internal Git calls.
export async function analyzeRelease({cwd=process.cwd(),configPath='.releaserc.json',outputPath='release-plan.json',tools=process.env.RELEASE_TOOLS,env=process.env}={}) {
  if(Number(env.GITHUB_RUN_ATTEMPT||1)>1)throw new Error(`Re-analysis of an original release run is blocked: recover original publication identity, or start a new release dispatch after inspecting https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`);
  const scratch=mkdtempSync(join(tmpdir(),'release-analysis-worker-'));
  try {
    const clean={};
    for(const key of ['PATH','TMPDIR','TMP','TEMP','SYSTEMROOT','SystemRoot','TZ'])if(env[key])clean[key]=env[key];
    clean.HOME=join(scratch,'home');mkdirSync(clean.HOME);
    clean.GIT_CONFIG_NOSYSTEM='1';clean.GIT_CONFIG_GLOBAL='/dev/null';clean.GIT_LFS_SKIP_SMUDGE='1';
    clean.RELEASE_TOOLS=resolve(tools||cwd);
    const request=join(scratch,'request.json');
    writeFileSync(request,JSON.stringify({cwd:resolve(cwd),configPath,outputPath,tools:clean.RELEASE_TOOLS,
      candidate:env.CANDIDATE_SHA,repository:env.GITHUB_REPOSITORY}));
    const output=execFileSync(process.execPath,[fileURLToPath(import.meta.url),'--worker',request],
      {cwd,env:clean,encoding:'utf8',maxBuffer:10*1024*1024});
    return JSON.parse(output);
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=optionValues(args,['--worker','--config','--output']);
 if(process.argv[2]==='--worker'){
   const request=JSON.parse(readFileSync(value('--worker'),'utf8'));
   const plan=await analyzeIsolated({...request,env:{...process.env,CANDIDATE_SHA:request.candidate,GITHUB_REPOSITORY:request.repository}});
   process.stdout.write(JSON.stringify(plan)+'\n');
 }else{
   const plan=await analyzeRelease({configPath:value('--config'),outputPath:value('--output')});
   if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`release_needed=${plan.release_needed}\n`);
   process.stdout.write(JSON.stringify(plan)+'\n');
 }
}
