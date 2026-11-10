// Shared tag identity validation never evaluates artifact templates.
export function sealedTagFormat(metadata){
 const {version,tag}=metadata;
 if(typeof version!=='string'||!version||typeof tag!=='string')throw Error('Original sealed tag format is unverifiable');
 let format=metadata.tag_format;
 if(format===undefined){
  // Legacy plans still bind an exact engine-produced tag and version. Infer only
  // a single literal version position; ambiguous evidence cannot authorize repair.
  const index=tag.indexOf(version);
  if(index<0||tag.indexOf(version,index+1)>=0)throw Error('Original sealed tag format is unverifiable');
  format=tag.slice(0,index)+'${version}'+tag.slice(index+version.length);
 }
 if(typeof format!=='string')throw Error('Original configured tag format differs from the sealed tag');
 // Normalize only direct version interpolation. Never evaluate a template from
 // an artifact; expressions, evaluation blocks and escaping are not executable evidence.
 const tokens=format.match(/\$\{\s*version\s*\}|<%=\s*version\s*%>/g)||[];
 const canonical=format.replace(/\$\{\s*version\s*\}|<%=\s*version\s*%>/g,'${version}');
 const literal=canonical.replace('${version}','');
 if(tokens.length!==1||literal.includes('${')||literal.includes('<%'))throw Error('Unsupported tag template: only direct version interpolation is accepted');
 if(canonical.replace('${version}',version)!==tag)throw Error('Original configured tag format differs from the sealed tag');
 return canonical;
}
