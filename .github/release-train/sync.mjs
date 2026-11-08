// Controlled vendoring: validate the complete old tree before making any changes.
import {optionValues} from './cli-options.mjs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,realpathSync,lstatSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const sourceDirectory=dirname(fileURLToPath(import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function files(directory){return readdirSync(directory).sort().map(name=>{if(!lstatSync(join(directory,name)).isFile())throw Error(`Unknown non-file entry: ${name}`);return name;});}
function provenance(source,revision,content){
 if(revision==='working-tree')return {source_kind:'working-tree',source_revision:revision};
 if(revision.startsWith('synthetic:')&&revision.length>10)return {source_kind:'synthetic',source_revision:revision};
 try{
  const git=(...args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const sha=git('rev-parse','--verify','--end-of-options',`${revision}^{commit}`),root=realpathSync(git('rev-parse','--show-toplevel'));
  const directory=relative(root,realpathSync(source)).split('\\').join('/');
  const tree=execFileSync('git',['-C',root,'ls-tree','-r','-z','--name-only',sha,'--',directory?directory+'/':'.'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).split('\0').filter(Boolean).filter(path=>path.endsWith('.mjs'));
  const expected=Object.fromEntries(tree.map(path=>[directory?path.slice(directory.length+1):path,execFileSync('git',['-C',root,'show',`${sha}:${path}`],{stdio:['ignore','pipe','pipe']})]));
  if(JSON.stringify(Object.keys(expected).sort())!==JSON.stringify(Object.keys(content).sort())||Object.keys(content).some(name=>hash(content[name])!==hash(expected[name])))throw Error('bytes differ');
  return {source_kind:'git',source_revision:sha};
 }catch{throw Error('Selected source revision does not match runtime files and bytes');}
}
export function syncRuntime({destination,source=sourceDirectory,revision='working-tree',check=false,compareSource=false}={}){
 if(!destination)throw Error('Destination is required');
 destination=resolve(destination);source=resolve(source);
 if(destination===source&&(!check||compareSource))throw Error('Source and destination must differ');
 const manifestPath=join(destination,'manifest.json');
 let previous=null;
 if(existsSync(destination)){
  if(lstatSync(destination).isSymbolicLink())throw Error('Generated destination cannot be a symlink');
  if(existsSync(manifestPath))previous=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(previous&&previous.content_hash!==hash(JSON.stringify(previous.files)))throw Error('Generated manifest content hash differs');
  if(previous&&(previous.schema_version!==1||!previous.files||typeof previous.files!=='object'))throw Error('Invalid generated manifest');
  for(const name of files(destination)){
   if(name==='manifest.json')continue;
   if(!previous?.files[name])throw Error(`Unknown generated file: ${name}`);
   if(hash(readFileSync(join(destination,name)))!==previous.files[name])throw Error(`Modified generated file: ${name}`);
  }
  for(const name of Object.keys(previous?.files||{})){
   if(name.includes('/')||name==='manifest.json'||!existsSync(join(destination,name)))throw Error(`Missing or unsafe generated file: ${name}`);
  }
 }
 if(check&&!previous)throw Error('Generated manifest is required');
 // Consumer-local check deliberately does not read or resolve any upstream source.
 if(check&&!compareSource)return previous;
 const names=files(source).filter(name=>name.endsWith('.mjs'));
 const content=Object.fromEntries(names.map(name=>[name,readFileSync(join(source,name))]));
 const digests=Object.fromEntries(names.map(name=>[name,hash(content[name])]));
 const manifest={schema_version:1,...provenance(source,revision,content),content_hash:hash(JSON.stringify(digests)),files:digests};
 if(check){if(JSON.stringify(previous.files)!==JSON.stringify(digests))throw Error('Generated runtime differs from selected source');return previous;}
 mkdirSync(destination,{recursive:true});
 for(const name of Object.keys(previous?.files||{}))if(!digests[name])rmSync(join(destination,name));
 for(const name of names)writeFileSync(join(destination,name),content[name]);
 writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),operation=args.shift();
 const value=optionValues(args,['--consumer','--destination','--source','--revision'],['--compare-source'],{allowUnknown:false});
 if(!['sync','check'].includes(operation))throw Error('Usage: sync.mjs sync|check --consumer ROOT [--source DIRECTORY --revision REVISION]');
 const consumer=value('--consumer');
 syncRuntime({destination:value('--destination')||(consumer?join(consumer,'.github/release-train'):undefined),source:value('--source'),revision:value('--revision'),check:operation==='check',compareSource:args.includes('--compare-source')});
}
