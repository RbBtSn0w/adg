// Validate known options before configuration reads or any release side effects.
export function optionValues(args,valueFlags,switchFlags=[],{allowUnknown=true}={}){
 const values=new Map(),known=new Set([...valueFlags,...switchFlags]);
 for(let index=0;index<args.length;index++){
  const flag=args[index];
  if(!valueFlags.includes(flag)){if(!allowUnknown&&!known.has(flag))throw Error(`Unknown option: ${flag}`);continue;}
  const operand=args[index+1];
  if(operand===undefined||operand===''||known.has(operand))throw Error(`${flag} requires a value`);
  if(!values.has(flag))values.set(flag,operand);
  index++;
 }
 return flag=>values.get(flag);
}
