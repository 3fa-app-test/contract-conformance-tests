import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileFreestandingCore,checkFreestandingCore} from '../src/freestanding-core.mjs';
import {compileToProgramIRV2,compileProgramIRV2} from '../src/program-v2.mjs';

const fixture=resolve('tests/fixtures/freestanding-core-java.ores');
// Unmodified oreslang-source.java/stdlib/core.ores, source blob:
// d2cd9b8e0cd3e3bb3ee6a5f9cebf9ab3312c44f4
async function moduleFrom(source) {
  const esm=compileFreestandingCore(source);
  assert.doesNotMatch(esm,/\b(?:process|require|import|fetch|eval|Function|Worker|window|document)\b/);
  return import('data:text/javascript,'+encodeURIComponent(esm));
}

test('real Java core library compiles unchanged to a browser/Node safe ESM',async()=>{
  const source=await readFile(fixture,'utf8');
  assert.equal(checkFreestandingCore(source),true);
  const mod=await moduleFrom(source);
  assert.deepEqual(Object.keys(mod),['core']);
  const {core}=mod;
  assert.equal(Object.getPrototypeOf(core),null);
  assert.equal(Object.isFrozen(core),true);
  for(const [a,b,expectedMin,expectedMax] of [
    [1n,2n,1n,2n],[9n,0n,0n,9n],[-9n,-2n,-9n,-2n],
    [0n,0n,0n,0n],[(1n<<63n)-1n,-(1n<<63n),-(1n<<63n),(1n<<63n)-1n],
    [9007199254740993n,9007199254740992n,9007199254740992n,9007199254740993n]
  ]) {
    assert.equal(core.min_int(a,b),expectedMin);
    assert.equal(core.max_int(a,b),expectedMax);
  }
  for(const [value,low,high,expected] of [
    [5n,0n,10n,5n],[-1n,0n,10n,0n],[100n,0n,10n,10n],
    [5n,10n,0n,10n],[-(1n<<63n),-(1n<<63n),0n,-(1n<<63n)],
    [9007199254740993n,9007199254740992n,9007199254740994n,9007199254740993n]
  ]) assert.equal(core.clamp_int(value,low,high),expected);
  assert.throws(()=>core.min_int(1,2n),/BigInt/);
  assert.throws(()=>core.max_int(1n<<63n,0n),/OVERFLOW/);
  assert.throws(()=>core.clamp_int(1n,0,9n),/BigInt/);
  assert.throws(()=>core.min_int(1n),/arity/);
});

test('conditional source -> validated JSON IR -> ESM roundtrip is deterministic',async()=>{
  const source=await readFile(fixture,'utf8');
  const ir=compileToProgramIRV2(source);
  assert.deepEqual(ir.modules,['core']);
  assert.deepEqual(ir.functions.map(f=>f.body.kind),['if','if','if']);
  const roundtrip=JSON.parse(JSON.stringify(ir));
  assert.equal(compileProgramIRV2(roundtrip),compileFreestandingCore(source));
  assert.equal(await (await moduleFrom(source)).core.min_int(2n,1n),1n);
});

test('core pure-source profile rejects hosted and noncore code',()=>{
  for(const source of [
    'import module fs from "std/fs"; define module core pub fnc foo(): int {return 1;} end',
    'define module std pub fnc foo(): int {return 1;} end',
    'pub fnc foo(): int {return 1;}',
    'define module core pub fnc answer(): int {return stdio.stdout.write(42);} end',
    'define module core pub fnc main(): int {return process.exit(0);} end',
    'define module core pub fnc main(): int {return await something();} end',
    'define module core pub fnc main(): int {return rt.share(1);} end',
    'define module core pub fnc main(): int {return new Array();} end',
    'define module core pub fnc main(): int {return missing();} end',
    'define module core pub fnc main(): int {return 1;} end define module other pub fnc run(): int {return 2;} end'
  ]) assert.throws(()=>compileFreestandingCore(source),/error:/,source);
});

test('if condition type checking and total-return control flow fail closed',()=>{
  const invalid=[
    'define module core pub fnc x(int n): int {if n; do return 1; else return 0; fi} end',
    'define module core pub fnc x(int n): int {if n < 1; do return n; fi} end',
    'define module core pub fnc x(int n): int {if n == 1; do return 0; fi return 3; return 4;} end',
    'define module core pub fnc x(int n): int {return n; return 0;} end',
    'define module core pub fnc x(int n): int {if n < 1; do return 1; else return 2; fi return 3;} end',
    'define module core pub fnc x(int n): int {return n < 1;} end',
    'define module core pub fnc x(int n): int {return n + (n < 1);} end',
    'define module core pub fnc x(int n): int {if n < 1; do return 1; else return false; fi} end'
  ];
  for(const s of invalid) assert.throws(()=>compileFreestandingCore(s),/error:/s);
  const good='define module core pub fnc x(int n): int {if n <= 0; do return 0; fi if n >= 10; do return 10; else if n != 5; do return 1; else return 2; fi fi} end';
  return moduleFrom(good).then(mod=>{
    assert.equal(mod.core.x(-1n),0n);assert.equal(mod.core.x(12n),10n);
    assert.equal(mod.core.x(5n),2n);assert.equal(mod.core.x(4n),1n);
  });
});

test('external IR cannot forge JS truthiness, bad comparisons or hosted calls',()=>{
  const valid=compileToProgramIRV2('define module core pub fnc f(int x): int {return x;} end');
  const replaceBody=body=>({...valid,functions:[{...valid.functions[0],body}]});
  const integer={kind:'int',value:'1'};
  const cmp={kind:'compare',op:'<',left:{kind:'param',index:0},right:integer};
  for(const body of [
    cmp,
    {kind:'if',condition:integer,yes:integer,no:integer},
    {kind:'if',condition:{...cmp,op:'>>>; process.exit(0)'},yes:integer,no:integer},
    {kind:'if',condition:cmp,yes:cmp,no:integer},
    {kind:'binary',op:'+',left:integer,right:cmp},
    {kind:'host',method:'fetch'}
  ]) assert.throws(()=>compileProgramIRV2(replaceBody(body)),/error: program IR:/);
});

test('CLI --freestanding-core emits executable Node ESM; legacy compiler fails closed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ores-core-node-'));
  try {
    const out=join(dir,'core.mjs'),cli=resolve('bin/oreslang-jsc.mjs');
    const ck=spawnSync(process.execPath,[cli,'--freestanding-core','--check',fixture],{encoding:'utf8'});
    assert.equal(ck.status,0,ck.stderr);
    const generated=spawnSync(process.execPath,[cli,'--freestanding-core',fixture,'--out='+out],{encoding:'utf8'});
    assert.equal(generated.status,0,generated.stderr);
    assert.equal((await import(pathToFileURL(out).href)).core.clamp_int(12n,0n,10n),10n);
    const rejected=spawnSync(process.execPath,[cli,'--check',fixture],{encoding:'utf8'});
    assert.notEqual(rejected.status,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('conditional fall-through cannot exponentially amplify IR trees',async()=>{
  const source=n=>'define module core pub fnc f(int x): int {'+
    'if x < 1; do fi '.repeat(n)+'return x;} end';
  const valid=await moduleFrom(source(8));
  assert.equal(valid.core.f(7n),7n);
  // An attacker can express an exponentially large lowered tree using only
  // a short sequence of empty ifs. Refuse it before resolve/JSON/codegen.
  for(const n of [14,20,40])
    assert.throws(()=>compileFreestandingCore(source(n)),
      /expanded conditional IR node budget exceeded/,String(n));
});

test('deterministic signed-i64 min/max/clamp property vectors',async()=>{
  const source=await readFile(fixture,'utf8');
  const {core}=await moduleFrom(source);
  // Non-randomized test vector generation stays reproducible across runners.
  // Compose full-width 64-bit inputs, including negative signed values.
  let state=0x7a11d57d>>>0;
  const step=()=>{
    state^=state<<13;state^=state>>>17;state^=state<<5;
    return state>>>0;
  };
  const int64=()=>BigInt.asIntN(64,(BigInt(step())<<32n)|BigInt(step()));
  for(let i=0;i<1024;i++){
    const left=int64(),right=int64(),value=int64();
    assert.equal(core.min_int(left,right),left<right?left:right);
    assert.equal(core.max_int(left,right),left>right?left:right);
    const want=left>right?left:value<left?left:value>right?right:value;
    assert.equal(core.clamp_int(value,left,right),want);
  }
});

