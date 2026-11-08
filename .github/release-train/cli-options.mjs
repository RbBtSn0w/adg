// Validate known options before configuration reads or any release side effects.
export function optionValues(args,valueFlags,switchFlags=[]){
 const values=new Map(),known=new Set([...valueFlags,...switchFlags]);
 for(let index=0;index<args.length;index++){
  const flag=args[index];
  if(!valueFlags.includes(flag))continue;
  const operand=args[index+1];
  if(operand===undefined||operand===''||known.has(operand))throw Error(`${flag} requires a value`);
  if(!values.has(flag))values.set(flag,operand);
 }
 return flag=>values.get(flag);
}
