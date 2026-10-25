import test from 'node:test';
import assert from 'node:assert/strict';
import {compileToProgramIRV2,compileProgramIRV2,compileProgramV2} from '../src/program-v2.mjs';
import {validateProgramIRV2,stringifyProgramIRV2} from '../src/program-ir-v2.mjs';
import {compileProgramV2 as apiCompile} from '@oreslang/source-js/program-v2';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const src=[
 'namespace payments;',
 'define module root as',
 'pub fnc add(int a,int b): int {return a+b;}',
 'pub fnc classify(int n): int {return match n on 0 -> {42;} on _ -> {7;} end;}',
 'end',
 'pub fnc add(int n): int {return n+1;}',
 'pub fnc main(): int {return root.add(40,2)+add(0);}'
].join('\n');

const update=(ir,index,body)=>({...ir,functions:ir.functions.map((f,i)=>
  i===index?{...f,body}:f)});

test('source -> bounded resolved IR -> JSON -> ESM is canonical, separate runtime/type namespaces',async()=>{
 const ir=compileToProgramIRV2(src);
 assert.equal(ir.schemaVersion,2);
 assert.equal(ir.sourceNamespace,'payments');
 assert.deepEqual(ir.modules,['root']);
 assert.equal(ir.functions.length,4);
 assert.equal(stringifyProgramIRV2(ir),JSON.stringify(ir));
 const roundTrip=JSON.parse(stringifyProgramIRV2(ir));
 assert.deepEqual(validateProgramIRV2(roundTrip),roundTrip);
 assert.equal(compileProgramIRV2(roundTrip),compileProgramV2(src));
 assert.equal(apiCompile(src),compileProgramV2(src));
 const esm=compileProgramIRV2(roundTrip);
 const mod=await import('data:text/javascript,'+encodeURIComponent(esm));
 assert.deepEqual(Object.keys(mod).sort(),['add','main','root']);
 assert.equal(mod.root.add(40n,2n),42n);
 assert.equal(mod.add(41n),42n);
 assert.equal(mod.main(),43n);
 assert.equal(mod.root.classify(0n),42n);
 assert.equal(mod.root.classify(10n),7n);
 assert.equal(Object.hasOwn(mod,'payments'),false);
});

test('externally supplied program IR rejects unsupported version, forged shapes and host access',()=>{
 const ir=compileToProgramIRV2(src);
 const invalid=[
  {...ir,schemaVersion:3},
  {...ir,integerModel:'arbitrary-precision'},
  {...ir,extra:1},
  {...ir,functions:[...ir.functions,{...ir.functions[0],name:'malicious',pub:true,kind:'routine'}]},
  update(ir,0,{kind:'param',index:999}),
  update(ir,0,{kind:'int',value:'9223372036854775808'}),
  update(ir,0,{kind:'int',value:'01'}),
  update(ir,0,{kind:'call',target:999,args:[]}),
  update(ir,0,{kind:'call',target:2,args:[]}),
  update(ir,0,{kind:'host',value:'process'}),
  {...ir,modules:['root','root']},
  {...ir,modules:[]},
  {...ir,sourceNamespace:'foo.bar'}
 ];
 for(const item of invalid)assert.throws(()=>compileProgramIRV2(item),/error: program IR:/);
 const accessor={...ir};
 let invoked=false;
 Object.defineProperty(accessor,'modules',{get(){invoked=true;throw Error('getter invoked');}});
 assert.throws(()=>compileProgramIRV2(accessor),/accessor/);
 assert.equal(invoked,false);
 assert.throws(()=>compileProgramIRV2(Object.assign(Object.create({proto:true}),ir)),/non-plain/);
 assert.throws(()=>compileProgramIRV2({...ir,[Symbol('hidden')]:true}),/missing\/extra fields/);
 const tainted=[...ir.modules];tainted.evil='value';
 assert.throws(()=>compileProgramIRV2({...ir,modules:tainted}),/unexpected array properties/);
});

test('IR validator rejects duplicate/non-exhaustive matches and unbounded calls',()=>{
 const ir=compileToProgramIRV2(src);
 const original=ir.functions[1].body;
 assert.equal(original.kind,'match');
 for(const arms of [
  original.arms.slice(0,1),
  [{value:'0',body:{kind:'int',value:'1'}},{value:'0',body:{kind:'int',value:'2'}},{value:null,body:{kind:'int',value:'3'}}],
  [{value:null,body:{kind:'int',value:'1'}},{value:'0',body:{kind:'int',value:'2'}}]
 ])assert.throws(()=>compileProgramIRV2(update(ir,1,{...original,arms})),/error: program IR:/);
 assert.throws(()=>compileProgramIRV2(update(ir,3,{kind:'call',target:3,args:[]})),/recursive call graph/);
});

test('IR cannot bypass private cross-module visibility',()=>{
 const source='define module m fnc secret(): int {return 2;} pub fnc expose(): int {return secret();} end pub fnc main(): int {return m.expose();}';
 const ir=compileToProgramIRV2(source);
 assert.throws(()=>compileProgramIRV2(update(ir,2,{kind:'call',target:0,args:[]})),/cross-module private call/);
});

test('bounded checked-int property vectors exercise validated ESM, not only source compiler',async()=>{
 const source='define module math pub fnc add(int a,int b): int {return a+b;} end';
 const ir=compileToProgramIRV2(source);
 const ns=await import('data:text/javascript,'+encodeURIComponent(compileProgramIRV2(JSON.parse(JSON.stringify(ir)))));
 let seed=0x7ac43e19;
 const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
 for(let i=0;i<500;i++){
  const a=BigInt.asIntN(64,(BigInt(rand())<<32n)|BigInt(rand()));
  const b=BigInt.asIntN(64,(BigInt(rand())<<32n)|BigInt(rand()));
  const expected=a+b;
  if(expected>=-(1n<<63n) && expected<=(1n<<63n)-1n)
    assert.equal(ns.math.add(a,b),expected);
  else
    assert.throws(()=>ns.math.add(a,b),/ORES_I64_OVERFLOW/);
 }
});

test('CLI program-v2 rejects public routines and accepts module named root',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ores-js-ir-'));
 try {
  const source=join(dir,'input.ores'),cli=resolve('bin/oreslang-jsc.mjs');
  await writeFile(source,'pub routine main(): int {return 42;}');
  const failure=spawnSync(process.execPath,[cli,'--program-v2','--check',source],{encoding:'utf8'});
  assert.notEqual(failure.status,0);
  assert.match(failure.stderr,/public routine/);
  await writeFile(source,src);
  const success=spawnSync(process.execPath,[cli,'--program-v2','--check',source],{encoding:'utf8'});
  assert.equal(success.status,0,success.stderr);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('external IR cannot mix fnc/routine overload kinds even with distinct arities',()=>{
 const ir=compileToProgramIRV2('pub fnc main(): int {return 42;}');
 const fnc={module:null,name:'compute',kind:'fnc',pub:false,params:[],body:{kind:'int',value:'1'}};
 const routine={...fnc,kind:'routine',params:['a']};
 for(const entries of [[fnc,routine],[routine,fnc]]) {
   assert.throws(()=>validateProgramIRV2({...ir,functions:[...ir.functions,...entries]}),
     /fnc\/routine overload kind conflict/);
 }
 for(const kind of ['fnc','routine']) {
   const valid=validateProgramIRV2({...ir,functions:[
     ...ir.functions,{...fnc,kind},{...fnc,kind,params:['a']}
   ]});
   assert.equal(valid.functions.length,3);
 }
});

test('module namespace scope keeps overload-family identity separate from file root',()=>{
 const ir=compileToProgramIRV2('define module root pub fnc compute(): int {return 1;} end pub fnc compute(int a): int {return a;}');
 assert.equal(ir.functions.length,2);
 assert.deepEqual(ir.functions.map(f=>f.module),['root',null]);
 assert.equal(validateProgramIRV2(ir).functions.length,2);
});
