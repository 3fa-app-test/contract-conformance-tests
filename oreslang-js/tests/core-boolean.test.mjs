import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileToProgramIRV2,compileProgramV2,compileProgramIRV2} from '../src/program-v2.mjs';
import {compileFreestandingCore} from '../src/freestanding-core.mjs';
import {compileLinkedFreestandingCore} from '../src/freestanding-core-link.mjs';
import {validateProgramIRV2} from '../src/program-ir-v2.mjs';

const sourcePath=new URL('./fixtures/core-boolean.ores',import.meta.url);
const appPath=new URL('./fixtures/core-boolean-linked-app.ores',import.meta.url);
const corePath=new URL('./fixtures/freestanding-core-java.ores',import.meta.url);
const moduleOf=esm=>import('data:text/javascript,'+encodeURIComponent(esm));
const source=()=>readFile(sourcePath,'utf8');
const app=()=>readFile(appPath,'utf8');

test('pure core bool functions compile to browser-neutral ESM with strict boolean ABI',async()=>{
  const ores=await source();
  const output=compileFreestandingCore(ores);
  assert.doesNotMatch(output,/^\s*import\b/m);
  const {core}=await moduleOf(output);
  assert.equal(core.is_positive(3n),true);
  assert.equal(core.is_positive(0n),false);
  assert.equal(core.is_positive(-(1n<<63n)),false);
  assert.equal(core.invert(true),false);
  assert.equal(core.invert(false),true);
  assert.equal(core.invert_twice(true),true);
  assert.equal(core.invert_twice(false),false);
  assert.equal(core.choose(true,40n,2n),40n);
  assert.equal(core.choose(false,40n,2n),2n);
  assert.equal(core.both_positive(2n,3n),true);
  assert.equal(core.both_positive(2n,0n),false);
  assert.equal(core.both_positive(-1n,3n),false);
  assert.equal(core.positive_or_zero(-9n),0n);
  assert.equal(core.positive_or_zero(9n),9n);
  assert.throws(()=>core.choose(1n,40n,2n),/bool required/);
  assert.throws(()=>core.choose(1,40n,2n),/bool required/);
  assert.throws(()=>core.invert(0),/bool required/);
  assert.throws(()=>core.is_positive(true),/BigInt/);
  assert.throws(()=>core.choose(true,1,2n),/BigInt/);
  assert.throws(()=>core.choose(),/arity/);
});

test('bool signatures and expression kinds retain legacy int-only IR exactly',async()=>{
  const booleans=compileToProgramIRV2(await source());
  const typed=booleans.functions.find(f=>f.name==='choose');
  assert.deepEqual(typed.paramTypes,['bool','int','int']);
  assert.equal(typed.returnType,'int');
  assert.equal(booleans.functions.find(f=>f.name==='invert').returnType,'bool');
  const round=JSON.parse(JSON.stringify(booleans));
  assert.deepEqual(validateProgramIRV2(round),round);
  assert.equal(compileProgramIRV2(round),compileProgramV2(await source()));
  const legacy=compileToProgramIRV2(await readFile(corePath,'utf8'));
  for(const f of legacy.functions) {
    assert.equal(Object.hasOwn(f,'returnType'),false);
    assert.equal(Object.hasOwn(f,'paramTypes'),false);
  }
  const oldModule=await moduleOf(compileFreestandingCore(await readFile(corePath,'utf8')));
  assert.equal(oldModule.core.clamp_int(99n,0n,10n),10n);
});

test('bool-safe closed-world application can call core boolean functions',async()=>{
  const out=compileLinkedFreestandingCore({coreSource:await source(),appSource:await app()});
  assert.doesNotMatch(out,/^\s*import\b/m);
  const m=await moduleOf(out);
  assert.equal(m.sample(true,9n),9n);
  assert.equal(m.sample(false,9n),0n);
  assert.equal(m.sample(true,-9n),0n);
  assert.equal(m.predicate(4n,2n),true);
  assert.equal(m.predicate(0n,2n),false);
  assert.equal(m.toggled(true),true);
  assert.equal(m.toggled(false),false);
  assert.throws(()=>m.sample(1n,9n),/bool required/);
});

test('typed source errors reject int/bool conflation and illegal operations',()=>{
  const prog=body=>'define module core as pub fnc bad(int x): int {'+body+'} end';
  const bool=body=>'define module core as pub fnc bad(int x): bool {'+body+'} end';
  const failures=[
    prog('return true;'),
    prog('return x > 1;'),
    prog('return !false;'),
    prog('return x + true;'),
    prog('if x; do return 1; else return 2; fi'),
    prog('if !x; do return 1; else return 2; fi'),
    bool('return x;'),
    bool('return 1;'),
    bool('return !x;'),
    bool('return true + 1;'),
    bool('return x + 1;'),
    bool('return false < x;'),
    'define module core as pub fnc a(bool flag): int {return flag;} end',
    'define module core as pub fnc a(bool flag): bool {return flag + 1;} end',
    'define module core as pub fnc a(bool flag): bool {return flag < true;} end',
    'define module core as pub fnc a(bool flag): bool {return flag == true;} end',
    'define module core as pub fnc a(int x): bool {return true;} pub fnc b(int y): int {return a(y);} end',
    'define module core as pub fnc a(bool x): int {return 1;} pub fnc b(int y): int {return a(y);} end'
  ];
  for(const src of failures) assert.throws(()=>compileFreestandingCore(src),/error:/,src);
});

test('forged external IR cannot bypass boolean type checks or JS truthiness',async()=>{
  const good=compileToProgramIRV2(await source());
  const idx=good.functions.findIndex(f=>f.name==='invert');
  const fresh=fn=>({...good,functions:good.functions.map((f,i)=>i===idx?fn:f)});
  const example=good.functions[idx];
  const validParam={kind:'param',index:0};
  const attacks=[
    {...example,returnType:'int'},
    {...example,paramTypes:['int']},
    {...example,paramTypes:[]},
    {...example,paramTypes:['bool'],returnType:'float'},
    {...example,paramTypes:['bool'],returnType:'bool',body:{kind:'int',value:'1'}},
    {...example,body:{kind:'bool',value:1}},
    {...example,body:{kind:'bool',value:'true'}},
    {...example,body:{kind:'not',inner:{kind:'int',value:'1'}}},
    {...example,body:{kind:'compare',op:'!=',left:validParam,right:{kind:'bool',value:false}}},
    {...example,body:{kind:'not',inner:{kind:'param',index:9}}},
    {...example,body:{kind:'host',name:'fetch'}}
  ];
  for(const candidate of attacks)
    assert.throws(()=>compileProgramIRV2(fresh(candidate)),/error: program IR:/);
  const missing={...example};
  delete missing.returnType;
  assert.throws(()=>compileProgramIRV2(fresh(missing)),/error: program IR:/);
  const oldIR=compileToProgramIRV2('pub fnc answer(): int {return 42;}');
  const redundant={...oldIR.functions[0],returnType:'int',paramTypes:[]};
  assert.throws(()=>compileProgramIRV2({...oldIR,functions:[redundant]}),/error: program IR:/);
});

test('1024 deterministic boolean/integer boundary vectors',async()=>{
  const {core}=await moduleOf(compileFreestandingCore(await source()));
  for(let i=-512n;i<512n;i++){
    assert.equal(core.is_positive(i),i>0n);
    assert.equal(core.positive_or_zero(i),i>0n?i:0n);
    assert.equal(core.invert_twice(i>0n),i>0n);
  }
});

test('IR headers with null, primitive, missing or malformed bool metadata fail closed',async()=>{
  const valid=compileToProgramIRV2(await source());
  const altered=value=>({...valid,functions:[value,...valid.functions.slice(1)]});
  const first=valid.functions[0];
  for(const v of [
    null,undefined,42,[],true,'bad',
    {...first,paramTypes:undefined},
    {...first,paramTypes:'int'},
    {...first,paramTypes:['int','bool']},
    {...first,returnType:undefined},
    {...first,returnType:'string'},
    {...first,paramTypes:['bool']},
    (({returnType,...rest})=>rest)(first),
    (({paramTypes,...rest})=>rest)(first)
  ])assert.throws(()=>compileProgramIRV2(altered(v)),/error: program IR:/);
});
