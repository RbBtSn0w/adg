// Publish a nonempty owner directory atomically: an active lock is never empty.
import {existsSync,lstatSync,mkdtempSync,readdirSync,readFileSync,writeFileSync,renameSync,rmSync,rmdirSync,realpathSync} from 'node:fs';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {dirname,basename,join} from 'node:path';
const machine=hostname();
function location(destination){const parent=realpathSync(dirname(destination));return{parent,path:join(parent,`.${basename(destination)}.sync-lock`),destination:existsSync(destination)?realpathSync(destination):join(parent,basename(destination))};}
const busy=()=>Error('Runtime sync destination is locked by another owner');
function owner(lock){
 if(lstatSync(lock.path).isSymbolicLink()||!lstatSync(lock.path).isDirectory())throw Error('Unknown runtime sync lock ownership');
 const names=readdirSync(lock.path);
 if(names.length!==1||!/^owner-[a-f0-9-]+\.json$/.test(names[0]))throw Error('Unknown runtime sync lock ownership');
 const path=join(lock.path,names[0]);if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw Error('Unknown runtime sync lock ownership');
 const value=JSON.parse(readFileSync(path,'utf8'));
 if(value.schema_version!==1||value.host!==machine||!Number.isSafeInteger(value.pid)||value.pid<1||value.destination!==lock.destination||names[0]!==`owner-${value.token}.json`)throw Error('Unknown runtime sync lock ownership');
 return{...value,path};
}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw error;}}
function removeEmpty(path){try{rmdirSync(path);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;}}
function acquire(destination){
 const lock=location(destination),token=randomUUID(),name=`owner-${token}.json`,temporary=mkdtempSync(join(lock.parent,'.release-train-lock-owner-'));
 try{
  writeFileSync(join(temporary,name),JSON.stringify({schema_version:1,pid:process.pid,host:machine,token,destination:lock.destination})+'\n');
  try{renameSync(temporary,lock.path);return{...lock,name};}
  catch(error){if(!existsSync(lock.path))throw error;}
  const previous=owner(lock);if(alive(previous.pid))throw busy();
  // Delete only the unique dead owner's file. A fresh atomic nonempty owner
  // makes rmdir fail, so concurrent stale observers cannot remove a new lock.
  rmSync(previous.path,{force:true});removeEmpty(lock.path);
  try{renameSync(temporary,lock.path);return{...lock,name};}
  catch(error){if(existsSync(lock.path))throw busy();throw error;}
 }catch(error){
  try{rmSync(join(temporary,name),{force:true});rmdirSync(temporary);}
  catch(cleanupError){throw new AggregateError([error,cleanupError],`${error.message}; lock preparation cleanup failed: ${cleanupError.message}`,{cause:error});}
  throw error;
 }
}
function release(lock){
 const current=owner(lock);if(current.path!==join(lock.path,lock.name)||current.pid!==process.pid)throw Error('Runtime sync lock ownership changed');
 rmSync(current.path);removeEmpty(lock.path);
}
export function assertSyncUnlocked(destination){if(existsSync(dirname(destination))&&existsSync(location(destination).path))throw busy();}
export function withSyncLock(destination,action){
 const lock=acquire(destination);let result;
 try{result=action();}
 catch(error){try{release(lock);}catch(cleanupError){throw new AggregateError([error,cleanupError],`${error.message}; lock release failed: ${cleanupError.message}`,{cause:error});}throw error;}
 release(lock);return result;
}
