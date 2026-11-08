// Controlled vendoring with an interruption journal; no generated file is hand-owned.
import {withSyncLock,assertSyncUnlocked} from './sync-lock.mjs';
import {optionValues} from './cli-options.mjs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,realpathSync,lstatSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,rmdirSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,basename,join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const sourceDirectory=dirname(fileURLToPath(import.meta.url));
const journalName='.sync-journal.json';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function files(directory){return readdirSync(directory).sort().map(name=>{if(!lstatSync(join(directory,name)).isFile())throw Error(`Unknown non-file entry: ${name}`);return name;});}
function inside(root,path){const delta=relative(root,path);return delta===''||(!isAbsolute(delta)&&delta!=='..'&&!delta.startsWith('..'+(process.platform==='win32'?'\\':'/')));}
function confined(destination,consumer){
 const logical=consumer?resolve(consumer):basename(dirname(destination))==='.github'&&basename(destination)==='release-train'?dirname(dirname(destination)):dirname(destination);
 if(!inside(logical,destination))throw Error('Generated destination must remain inside the consumer');
 let boundary=logical;while(!existsSync(boundary))boundary=dirname(boundary);
 const canonical=resolve(realpathSync(boundary),relative(boundary,logical));
 if(!inside(boundary,destination))throw Error('Generated destination must remain inside the consumer');
 let cursor=boundary;
 for(const part of relative(boundary,destination).split(/[\\/]/).filter(Boolean)){
  cursor=join(cursor,part);const info=lstatSync(cursor,{throwIfNoEntry:false});
  if(info?.isSymbolicLink())throw Error('Generated consumer path cannot follow a symlink');
  if(info&&inside(logical,cursor)&&!inside(canonical,realpathSync(cursor)))throw Error('Generated destination escaped the canonical consumer');
 }
}
function manifestValid(manifest){
 if(!manifest||manifest.schema_version!==1||!manifest.files||typeof manifest.files!=='object'||manifest.content_hash!==hash(JSON.stringify(manifest.files)))throw Error('Invalid generated manifest');
 for(const [name,digest]of Object.entries(manifest.files))if(name.includes('/')||name.includes('\\')||!name.endsWith('.mjs')||!/^([a-f0-9]{64})$/.test(digest))throw Error('Unsafe generated manifest entry');
 return manifest;
}
function validateTree(destination,previous){
 for(const name of files(destination)){
  if(name==='manifest.json')continue;
  if(!previous?.files[name])throw Error(`Unknown generated file: ${name}`);
  if(hash(readFileSync(join(destination,name)))!==previous.files[name])throw Error(`Modified generated file: ${name}`);
 }
 for(const name of Object.keys(previous?.files||{}))if(!existsSync(join(destination,name)))throw Error(`Missing generated file: ${name}`);
}
function journalState(destination,journal){
 const previous=journal.previous?manifestValid(journal.previous):null,target=manifestValid(journal.target);
 if(journal.schema_version!==1||!/^\.release-train-stage-[A-Za-z0-9]+$/.test(journal.stage||''))throw Error('Invalid interrupted update journal');
 const stage=join(dirname(destination),journal.stage),manifestPath=join(destination,'manifest.json');
 const current=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,'utf8')):null;
 if(!equal(current,previous)&&!equal(current,target))throw Error('Manifest drift during interrupted update');
 for(const name of files(destination)){
  if(name==='manifest.json'||name===journalName)continue;
  const digest=hash(readFileSync(join(destination,name)));
  if(digest!==previous?.files[name]&&digest!==target.files[name])throw Error(`Modified or unknown file during interrupted update: ${name}`);
 }
 for(const name of Object.keys(previous?.files||{}))if(target.files[name]&&!existsSync(join(destination,name)))throw Error(`Missing recorded file during interrupted update: ${name}`);
 if(existsSync(stage)){
  if(lstatSync(stage).isSymbolicLink()||!lstatSync(stage).isDirectory())throw Error('Invalid interrupted staging directory');
  for(const name of files(stage)){
   const expected=name==='manifest.json'?hash(json(target)):target.files[name];
   if(!expected||hash(readFileSync(join(stage,name)))!==expected)throw Error(`Modified or unknown staged file: ${name}`);
  }
 }
 for(const [name,digest]of Object.entries(target.files))if(!existsSync(join(destination,name))||hash(readFileSync(join(destination,name)))!==digest){if(!existsSync(join(stage,name)))throw Error(`Missing recorded staged file: ${name}`);}
 if(!equal(current,target)&&!existsSync(join(stage,'manifest.json')))throw Error('Missing staged manifest');
 return {previous,target,stage,current};
}
function completeJournal(destination,journal){
 const {previous,target,stage,current}=journalState(destination,journal);
 for(const name of Object.keys(previous?.files||{}))if(!target.files[name])rmSync(join(destination,name),{force:true});
 for(const [name,digest]of Object.entries(target.files))if(!existsSync(join(destination,name))||hash(readFileSync(join(destination,name)))!==digest)renameSync(join(stage,name),join(destination,name));
 if(!equal(current,target))renameSync(join(stage,'manifest.json'),join(destination,'manifest.json'));
 // Only recorded matching stage files may be removed. rmdir refuses intruders.
 if(existsSync(stage)){for(const name of files(stage)){const expected=name==='manifest.json'?hash(json(target)):target.files[name];if(!expected||hash(readFileSync(join(stage,name)))!==expected)throw Error(`Staging drift: ${name}`);rmSync(join(stage,name));}rmdirSync(stage);}
 rmSync(join(destination,journalName));
 return target;
}
function provenance(source,revision,content){
 if(revision==='working-tree')return {source_kind:'working-tree',source_revision:revision};
 if(revision.startsWith('synthetic:')&&revision.length>10)return {source_kind:'synthetic',source_revision:revision};
 let sha,expected;
 try{
  const git=(...args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  sha=git('rev-parse','--verify','--end-of-options',`${revision}^{commit}`);const root=realpathSync(git('rev-parse','--show-toplevel'));
  const directory=relative(root,realpathSync(source)).split('\\').join('/');
  const tree=execFileSync('git',['-C',root,'ls-tree','-r','-z','--name-only',sha,'--',directory?directory+'/':'.'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).split('\0').filter(Boolean).filter(path=>path.endsWith('.mjs'));
  expected=Object.fromEntries(tree.map(path=>[directory?path.slice(directory.length+1):path,execFileSync('git',['-C',root,'show',`${sha}:${path}`],{stdio:['ignore','pipe','pipe']})]));
 }catch(error){throw new Error(`Cannot read selected Git source revision: ${error.stderr?.toString().trim()||error.message}`,{cause:error});}
 if(JSON.stringify(Object.keys(expected).sort())!==JSON.stringify(Object.keys(content).sort())||Object.keys(content).some(name=>hash(content[name])!==hash(expected[name])))throw Error('Selected source revision does not match runtime files and bytes');
 return {source_kind:'git',source_revision:sha};
}
function syncUnlocked({destination,source=sourceDirectory,revision='working-tree',check=false,compareSource=false,consumer}={}){
 if(!destination)throw Error('Destination is required');
 destination=resolve(destination);source=resolve(source);confined(destination,consumer);
 if(destination===source&&(!check||compareSource))throw Error('Source and destination must differ');
 if(existsSync(destination))files(destination); // Reject metadata symlinks before reading them.
 const manifestPath=join(destination,'manifest.json'),journalPath=join(destination,journalName);
 let previous=null;
 if(existsSync(journalPath)){
  const journal=JSON.parse(readFileSync(journalPath,'utf8'));journalState(destination,journal);
  if(check)throw Error('An interrupted runtime update is pending; rerun the authoritative sync');
  completeJournal(destination,journal);
 }
 if(existsSync(destination)){
  if(existsSync(manifestPath))previous=manifestValid(JSON.parse(readFileSync(manifestPath,'utf8')));
  validateTree(destination,previous);
 }
 if(check&&!previous)throw Error('Generated manifest is required');
 if(check&&!compareSource)return previous; // No upstream access for consumer-local checks.
 const names=files(source).filter(name=>name.endsWith('.mjs'));
 const content=Object.fromEntries(names.map(name=>[name,readFileSync(join(source,name))]));
 const digests=Object.fromEntries(names.map(name=>[name,hash(content[name])]));
 const manifest={schema_version:1,...provenance(source,revision,content),content_hash:hash(JSON.stringify(digests)),files:digests};
 if(check){if(!equal(previous.files,digests))throw Error('Generated runtime differs from selected source');return previous;}
 if(equal(previous,manifest))return previous;
 confined(destination,consumer);mkdirSync(destination,{recursive:true});
 const stage=mkdtempSync(join(dirname(destination),'.release-train-stage-'));let recorded=false;
 try{
  for(const name of names)writeFileSync(join(stage,name),content[name]);
  writeFileSync(join(stage,'manifest.json'),json(manifest));
  const journal={schema_version:1,previous,target:manifest,stage:basename(stage)};
  writeFileSync(join(stage,'journal.json'),json(journal));
  renameSync(join(stage,'journal.json'),journalPath);recorded=true;
  return completeJournal(destination,journal);
 }catch(error){
  if(!recorded){
   try{for(const name of files(stage)){if(![...names,'manifest.json','journal.json'].includes(name))throw Error('Unknown staged file');rmSync(join(stage,name));}rmdirSync(stage);}
   catch(cleanupError){
    throw new AggregateError([error,cleanupError],`${error.message}; staging cleanup failed: ${cleanupError.message}`,{cause:error});
   }
  }
  throw error;
 }
}
export function syncRuntime(options={}){
 if(!options.destination)throw Error('Destination is required');
 const destination=resolve(options.destination);confined(destination,options.consumer);
 if(options.check){assertSyncUnlocked(destination);return syncUnlocked({...options,destination});}
 mkdirSync(dirname(destination),{recursive:true});confined(destination,options.consumer);
 return withSyncLock(destination,()=>syncUnlocked({...options,destination}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),operation=args.shift();
 const value=optionValues(args,['--consumer','--destination','--source','--revision'],['--compare-source'],{allowUnknown:false});
 if(!['sync','check'].includes(operation))throw Error('Usage: sync.mjs sync|check --consumer ROOT [--source DIRECTORY --revision REVISION]');
 const consumer=value('--consumer');
 syncRuntime({consumer,destination:value('--destination')||(consumer?join(consumer,'.github/release-train'):undefined),source:value('--source'),revision:value('--revision'),check:operation==='check',compareSource:args.includes('--compare-source')});
}
