/**
 * Strict JSON-safe resolved IR contract for the experimental program-v2 backend.
 * This is a backend-local migration seam, NOT yet the shared canonical Oreslang IR.
 */
export const PROGRAM_IR_VERSION=2;
export const PROGRAM_IR_DIALECT='oreslang.program';
export const PROGRAM_IR_INT_MODEL='signed-i64-checked-provisional';
const ID=/^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const DEC=/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;
const MIN=-(1n<<63n), MAX=(1n<<63n)-1n;
const LIMIT_NODES=30000,LIMIT_DEPTH=192;
export class ProgramIRError extends Error {
  constructor(detail) {super('error: program IR: '+detail);this.name='ProgramIRError';}
}
const fail=s=>{throw new ProgramIRError(s);};
function record(v,keys,context) {
  if(v===null || typeof v!=='object' || Array.isArray(v))fail(context+': expected object');
  const proto=Object.getPrototypeOf(v);
  if(proto!==null && proto!==Object.prototype)fail(context+': non-plain object');
  const own=Reflect.ownKeys(v);
  if(own.length!==keys.length || own.some(k=>typeof k!=='string'||!keys.includes(k)))
    fail(context+': missing/extra fields');
  for(const key of keys){
    const desc=Object.getOwnPropertyDescriptor(v,key);
    if(!desc || !Object.hasOwn(desc,'value'))fail(context+': accessor/missing '+key);
  }
  return v;
}
function sequence(v,max,context){
  if(!Array.isArray(v)||Object.getPrototypeOf(v)!==Array.prototype||v.length>max)
    fail(context+': invalid array');
  const own=Reflect.ownKeys(v);
  if(own.length!==v.length+1 || own.some(k=>k!=='length'&&(!/^(?:0|[1-9][0-9]*)$/.test(k)||Number(k)>=v.length)))
    fail(context+': unexpected array properties');
  for(let i=0;i<v.length;i++) {
    const desc=Object.getOwnPropertyDescriptor(v,i);
    if(!desc||!Object.hasOwn(desc,'value'))fail(context+': accessor/sparse array');
  }
  return v;
}
function ident(s,where) {
  if(typeof s!=='string'||!ID.test(s))fail(where+': invalid identifier');
  return s;
}
function int(s){
  if(typeof s!=='string'||s.length>20||!DEC.test(s))fail('invalid canonical integer');
  const n=BigInt(s);
  if(n<MIN||n>MAX)fail('integer outside provisional signed i64');
  return s;
}
/**
 * Copy after validation, never return caller-owned IR references.
 * Direct object inputs are trusted data only, not a JavaScript sandbox.
 */
export function validateProgramIRV2(input) {
  record(input,['schemaVersion','dialect','integerModel','sourceNamespace','modules','functions'],'program');
  if(input.schemaVersion!==PROGRAM_IR_VERSION||input.dialect!==PROGRAM_IR_DIALECT||
     input.integerModel!==PROGRAM_IR_INT_MODEL)fail('unsupported IR version/dialect/model');
  const namespace=input.sourceNamespace===null?null:ident(input.sourceNamespace,'file namespace');
  const seenModules=new Set(),moduleNames=sequence(input.modules,512,'modules').map(m=>{
    const name=ident(m,'module name');
    if(seenModules.has(name))fail('duplicate module '+name);
    seenModules.add(name);
    return name;
  });
  const sourceFunctions=sequence(input.functions,512,'functions');
  if(!moduleNames.length && !sourceFunctions.length)fail('empty program');
  const slots=new Set(),symbolKinds=new Map(),exportNames=new Set(moduleNames);
  const headers=sourceFunctions.map(f=>{
    // Reject nulls and non-records before any optional-key introspection.
    // The full record(...) admission below checks plain prototypes and every
    // exact own-data field before reading function metadata.
    if(f===null||typeof f!=='object'||Array.isArray(f))
      fail('function: expected plain data object');
    const keys=Reflect.ownKeys(f);
    const typed=keys.includes('paramTypes')||keys.includes('returnType');
    record(f,typed?['module','name','kind','pub','params','body','paramTypes','returnType']:
      ['module','name','kind','pub','params','body'],'function');
    const module=f.module===null?null:ident(f.module,'owner module');
    if(module!==null && !seenModules.has(module))fail('missing owner module '+module);
    const name=ident(f.name,'function name');
    if(f.kind!=='fnc'&&f.kind!=='routine')fail('unknown function kind');
    if(typeof f.pub!=='boolean')fail('invalid visibility');
    if(f.kind==='routine'&&f.pub)fail('public routine cannot be exported');
    const params=sequence(f.params,128,'parameters').map(p=>ident(p,'parameter'));
    if(new Set(params).size!==params.length)fail('duplicate parameters');
    const paramTypes=typed?sequence(f.paramTypes,128,'paramTypes'):params.map(()=>'int');
    if(paramTypes.length!==params.length||
       paramTypes.some(t=>t!=='int'&&t!=='bool'))fail('unsupported function parameter type');
    const returnType=typed?f.returnType:'int';
    if(returnType!=='int'&&returnType!=='bool')fail('unsupported function return type');
    if(typed&&returnType!=='bool'&&!paramTypes.includes('bool'))
      fail('redundant typed metadata on int-only function');
    const slot=(module===null?'@file/':'@module/'+module+'/')+name+'/'+params.length;
    if(slots.has(slot))fail('duplicate caller-visible method arity '+slot);
    const family=slot.slice(0,slot.lastIndexOf('/'));
    if(symbolKinds.has(family)&&symbolKinds.get(family)!==f.kind)
      fail('fnc/routine overload kind conflict '+family);
    symbolKinds.set(family,f.kind);
    slots.add(slot);
    if(module===null&&f.pub)exportNames.add(name);
    return {module,name,kind:f.kind,pub:f.pub,params,
      ...(typed?{paramTypes:[...paramTypes],returnType}: {})};
  });
  // Export-name collisions are legal only for overloads of the same root
  // function, and NEVER between a runtime module object and a root function.
  for(const header of headers)if(header.module===null&&header.pub&&seenModules.has(header.name))
    fail('file export conflicts with runtime module '+header.name);
  const graph=headers.map(()=>new Set());
  let nodes=0;
  function node(expr,owner,depth=0,expected='int'){
    if(++nodes>LIMIT_NODES||depth>LIMIT_DEPTH)fail('expression complexity exceeded');
    if(!expr||typeof expr!=='object'||Array.isArray(expr))fail('invalid expression');
    const desc=Object.getOwnPropertyDescriptor(expr,'kind');
    if(!desc||!Object.hasOwn(desc,'value'))fail('invalid expression kind');
    // No implicit truthiness or numeric coercions, including in supplied IR.
    if(expected==='bool'&&['int','neg','binary'].includes(desc.value))
      fail('boolean expression required');
    if(expected==='int'&&['bool','compare','not'].includes(desc.value))
      fail('boolean value cannot be used as int');
    switch(desc.value) {
      case 'int':
        record(expr,['kind','value'],'int');
        if(expected!=='int')fail('boolean expected, got int');
        return {kind:'int',value:int(expr.value)};
      case 'bool':
        record(expr,['kind','value'],'bool');
        if(expected!=='bool'||typeof expr.value!=='boolean')fail('invalid bool literal/type');
        return {kind:'bool',value:expr.value};
      case 'param':
        record(expr,['kind','index'],'param');
        if(!Number.isSafeInteger(expr.index)||Object.is(expr.index,-0)||expr.index<0||expr.index>=headers[owner].params.length)
          fail('out-of-bounds parameter');
        if((headers[owner].paramTypes?.[expr.index]??'int')!==expected)
          fail('parameter type mismatch');
        return {kind:'param',index:expr.index};
      case 'neg':
        record(expr,['kind','inner'],'neg');
        if(expected!=='int')fail('int negation in boolean context');
        return {kind:'neg',inner:node(expr.inner,owner,depth+1,'int')};
      case 'not':
        record(expr,['kind','inner'],'not');
        if(expected!=='bool')fail('boolean negation in integer context');
        return {kind:'not',inner:node(expr.inner,owner,depth+1,'bool')};
      case 'binary':
        record(expr,['kind','op','left','right'],'binary');
        if(expected!=='int')fail('arithmetic in boolean context');
        if(!['+','-','*','%'].includes(expr.op))fail('unsupported binary operator');
        return {kind:'binary',op:expr.op,
          left:node(expr.left,owner,depth+1),right:node(expr.right,owner,depth+1)};
      case 'compare':
        record(expr,['kind','op','left','right'],'compare');
        if(expected!=='bool')fail('comparison in integer context');
        if(!['<','>','<=','>=','==','!='].includes(expr.op))fail('unsupported comparator');
        return {kind:'compare',op:expr.op,left:node(expr.left,owner,depth+1),
          right:node(expr.right,owner,depth+1)};
      case 'if':
        record(expr,['kind','condition','yes','no'],'if');
        return {kind:'if',condition:node(expr.condition,owner,depth+1,'bool'),
          yes:node(expr.yes,owner,depth+1,expected),
          no:node(expr.no,owner,depth+1,expected)};
      case 'call': {
        record(expr,['kind','target','args'],'call');
        if(!Number.isSafeInteger(expr.target)||Object.is(expr.target,-0)||expr.target<0||expr.target>=headers.length)
          fail('invalid call target');
        const target=headers[expr.target];
        if((target.returnType??'int')!==expected)fail('call return type mismatch');
        const args=sequence(expr.args,128,'call args');
        if(args.length!==target.params.length)fail('call arity mismatch');
        if(target.module!==headers[owner].module && !target.pub)fail('cross-module private call');
        graph[owner].add(expr.target);
        return {kind:'call',target:expr.target,args:args.map((a,i)=>
          node(a,owner,depth+1,target.paramTypes?.[i]??'int'))};
      }
      case 'match': {
        record(expr,['kind','subject','arms'],'match');
        const subject=node(expr.subject,owner,depth+1);
        const arms=sequence(expr.arms,256,'match arms');
        if(!arms.length)fail('empty match');
        let wildcard=false;
        const literals=new Set();
        const checked=arms.map(arm=>{
          record(arm,['value','body'],'match arm');
          let value;
          if(arm.value===null) {
            if(wildcard)fail('duplicate wildcard');
            wildcard=true;value=null;
          } else {
            if(wildcard)fail('unreachable arm after wildcard');
            value=int(arm.value);
            if(literals.has(value))fail('duplicate scalar pattern');
            literals.add(value);
          }
          return {value,body:node(arm.body,owner,depth+1,expected)};
        });
        if(!wildcard)fail('non-exhaustive int match');
        return {kind:'match',subject,arms:checked};
      }
      default:fail('unsupported expression kind');
    }
  }
  const functions=headers.map((f,i)=>({...f,body:node(sourceFunctions[i].body,i,0,f.returnType??'int')}));
  const color=new Uint8Array(headers.length);
  function visit(i) {
    if(color[i]===1)fail('recursive call graph unsupported pending fuel');
    if(color[i]===2)return;
    color[i]=1;for(const j of graph[i])visit(j);color[i]=2;
  }
  functions.forEach((_,i)=>visit(i));
  return {schemaVersion:PROGRAM_IR_VERSION,dialect:PROGRAM_IR_DIALECT,
    integerModel:PROGRAM_IR_INT_MODEL,sourceNamespace:namespace,
    modules:moduleNames,functions};
}
export function stringifyProgramIRV2(ir){
  return JSON.stringify(validateProgramIRV2(ir));
}

