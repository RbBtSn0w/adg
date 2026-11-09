// npm pack JSON is command-specific: npm12 keys records by package name.
import {readFileSync,copyFileSync,unlinkSync,constants,existsSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function parseNpmPack(stdout,expectedName){
 if(typeof expectedName!=='string'||!expectedName)throw Error('Expected package name is required');
 const value=JSON.parse(stdout);
 let row;
 if(Array.isArray(value)){
  if(value.length!==1)throw Error('Expected exactly one packed package');
  row=value[0];
 }else if(value&&typeof value==='object'&&Object.keys(value).length===1&&Object.hasOwn(value,expectedName))row=value[expectedName];
 if(!row||typeof row!=='object'||Array.isArray(row)||row.name!==expectedName||typeof row.version!=='string'||!row.version
    ||typeof row.filename!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(row.filename))throw Error('Packed package identity or archive filename is unverifiable');
 return row;
}
export function retainPackedArchive(jsonPath,manifestPath,destination){
 const name=JSON.parse(readFileSync(manifestPath,'utf8')).name;
 const row=parseNpmPack(readFileSync(jsonPath,'utf8'),name);
 const archive=join(dirname(resolve(destination)),row.filename);
 if(existsSync(destination))throw Error('Packed destination already exists');
 if(!lstatSync(archive).isFile())throw Error('Packed archive is not a regular file');
 copyFileSync(archive,destination,constants.COPYFILE_EXCL);
 unlinkSync(archive);
 return row;
}
if(process.argv[1]&&process.argv[1]!=='-'&&realpathSync(resolve(process.argv[1]))===fileURLToPath(import.meta.url)){
 if(process.argv.length!==5)throw Error('Usage: npm-pack.mjs PACK_JSON PACKAGE_JSON DESTINATION');
 retainPackedArchive(...process.argv.slice(2));
}
