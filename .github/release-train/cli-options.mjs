// Validate known options before configuration reads or any release side effects.
export function optionValues(args,valueFlags,switchFlags=[],{allowUnknown=true}={}){
 const values=new Map(),known=new Set([...valueFlags,...switchFlags]);
 for(let index=0;index<args.length;index++){
  const token=args[index],equals=token.indexOf('=');
  const explicit=equals>0,flag=explicit?token.slice(0,equals):token;
  if(!valueFlags.includes(flag)){if(!allowUnknown&&explicit&&switchFlags.includes(flag))throw Error(`Switch ${flag} does not accept a value`);if(!allowUnknown&&!known.has(flag))throw Error(`Unknown option: ${flag}`);continue;}
  const operand=explicit?token.slice(equals+1):args[index+1];
  if(operand===undefined||operand===''||(!explicit&&(known.has(operand)||(!allowUnknown&&operand.startsWith('--')))))throw Error(`${flag} requires a value`);
  if(!values.has(flag))values.set(flag,operand);
  if(!explicit)index++;
 }
 return flag=>values.get(flag);
}
