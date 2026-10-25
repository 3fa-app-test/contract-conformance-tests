import test from 'node:test';
import assert from 'node:assert/strict';
import {compileProgramV2} from '../src/program-v2.mjs';
import {planMultipleInheritance,materializeMethodOnlyClass} from '../src/multiple-inheritance.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

async function execute(source) {
  const dir=await mkdtemp(join(tmpdir(),'ores-program-v2-'));
  try {
    const file=join(dir,'compiled.mjs');
    await writeFile(file,compileProgramV2(source));
    return await import(pathToFileURL(file).href);
  } finally {await rm(dir,{recursive:true,force:true});}
}
const method=(name,arity,impl,pub=true)=>({name,arity,impl,pub});

test('flat modules are frozen, null-prototype namespaces; private declarations do not leak',async()=>{
  const src=[
    'define module math as',
    'pub fnc add(int a,int b): int {return a+b;}',
    'fnc secret(): int {return 999;}',
    'end',
    'define module app as pub fnc run(): int {return math.add(40,2);} end',
    'pub fnc main(): int {return app.run();}'
  ].join('\n');
  const ns=await execute(src);
  assert.deepEqual(Object.keys(ns).sort(),['app','main','math']);
  assert.deepEqual(Object.keys(ns.math),['add']);
  assert.equal(Object.getPrototypeOf(ns.math),null);
  assert.ok(Object.isFrozen(ns.math));
  assert.equal(ns.math.add(40n,2n),42n);
  assert.equal(ns.app.run(),42n);
  assert.equal(ns.main(),42n);
  assert.equal(Object.hasOwn(ns.math,'secret'),false);
  assert.throws(()=>ns.math.add(40,2n),/signed i64 BigInt/);
});
test('module export reserved identifiers do not change prototype',async()=>{
  const ns=await execute('define module m pub fnc __proto__(): int {return 7;} pub fnc default(): int {return 42;} end');
  assert.equal(ns.m.__proto__(),7n);
  assert.equal(ns.m.default(),42n);
  assert.equal(Object.getPrototypeOf(ns.m),null);
});
test('fail closed: private module members, nested modules, namespacing and imports',()=>{
  for(const source of [
    'define module a fnc hidden(): int {return 7;} end define module b pub fnc bad(): int {return a.hidden();} end',
    'define module m define module nested end end',
    'define namespace Types as end',
    'import module other from "./other";',
    'define module m pub routine first(): int {return 2;} end',
    'define module m pub fnc bad(): int {return absent.fn();} end',
    'define module m pub fnc bad(): int {return absent();} end',
    'pub fnc m(): int {return 1;} define module m pub fnc f(): int {return 2;} end'
  ]) assert.throws(()=>compileProgramV2(source),/error: program v2:/,source);
});
test('match literals, no fallthrough, exhaustive wildcard and subject evaluated once',async()=>{
  const code='pub fnc classify(int n): int {return match n over on -1 -> {11;} on 0 -> {22;} on _ -> {33;} end;}';
  const ns=await execute(code);
  assert.equal(ns.classify(-1n),11n);
  assert.equal(ns.classify(0n),22n);
  assert.equal(ns.classify(100n),33n);
  assert.equal((compileProgramV2(code).match(/const _subject=/g)||[]).length,1);
});
test('match else, lazy branches, and negative validations',async()=>{
  const ns=await execute('pub fnc pick(int n): int {return match n on 1 -> {42;} else -> {1 % 0;} end;}');
  assert.equal(ns.pick(1n),42n);
  assert.throws(()=>ns.pick(2n),RangeError);
  for(const source of [
    'pub fnc f(int x): int {return match x over on 0 -> {1;} end;}',
    'pub fnc f(int x): int {return match x over on 1 -> {1;} on 1 -> {2;} on _ -> {3;} end;}',
    'pub fnc f(int x): int {return match x over on _ -> {1;} on 2 -> {2;} end;}',
    'pub fnc f(int x): int {return match x over on _ -> {return 1;} end;}',
    'pub fnc f(int x): int {return match x over on 9223372036854775808 -> {1;} on _ -> {2;} end;}'
  ])assert.throws(()=>compileProgramV2(source),/error: program v2:/,source);
});
test('conditional recursive call graphs fail closed pending fuel control',()=>{
  assert.throws(()=>compileProgramV2('pub fnc f(int n): int {return match n on 0 -> {0;} on _ -> {f(n-1);} end;}'),/recursive call graph unsupported/);
});
test('CLI --program-v2 is opt in',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ores-v2-cli-'));
  try {
    const path=join(dir,'sample.ores'),dest=join(dir,'sample.mjs'),cli=resolve('bin/oreslang-jsc.mjs');
    await writeFile(path,'define module m pub fnc answer(): int {return match 0 on 0 -> {42;} on _ -> {0;} end;} end');
    assert.notEqual(spawnSync(process.execPath,[cli,'--check',path]).status,0);
    const ck=spawnSync(process.execPath,[cli,'--program-v2','--check',path],{encoding:'utf8'});
    assert.equal(ck.status,0,ck.stderr);
    const build=spawnSync(process.execPath,[cli,'--program-v2',path,'--out='+dest],{encoding:'utf8'});
    assert.equal(build.status,0,build.stderr);
    const ns=await import(pathToFileURL(dest).href);
    assert.equal(ns.m.answer(),42n);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('genuine diamond keeps one original method and nominal ancestry',()=>{
  const A={name:'A',parents:[],fields:[],methods:[method('value',0,function(){return 42;})]};
  const B={name:'B',parents:['A'],fields:[],methods:[]};
  const C={name:'C',parents:['A'],fields:[],methods:[]};
  const D={name:'D',parents:['B','C'],fields:[],methods:[]};
  const model=materializeMethodOnlyClass([A,B,C,D],'D'),instance=model.newInstance();
  assert.deepEqual(model.plan.methods.map(x=>x.slot),['value/0']);
  assert.equal(instance.value(),42);
  for(const type of ['A','B','C','D'])assert.ok(model.isA(instance,type));
  assert.equal(model.isA(instance,'X'),false);
  assert.throws(()=>instance.value.call({}),/invalid Oreslang receiver/);
});
test('independent parent conflict cannot use parent order, explicit public override required',()=>{
  const A={name:'A',parents:[],fields:[],methods:[method('same',0,()=>1)]};
  const B={name:'B',parents:[],fields:[],methods:[method('same',0,()=>2)]};
  const D={name:'D',parents:['A','B'],fields:[],methods:[]};
  assert.throws(()=>planMultipleInheritance([A,B,D],'D'),/explicit child override/);
  assert.throws(()=>planMultipleInheritance([A,B,{...D,parents:['B','A']}],'D'),/explicit child override/);
  assert.equal(materializeMethodOnlyClass([A,B,{...D,methods:[method('same',0,()=>3)]}],'D').newInstance().same(),3);
  assert.throws(()=>planMultipleInheritance([A,B,{...D,methods:[method('same',0,()=>3,false)]}],'D'),/cannot hide public/);
});
test('arity-dispatched methods and invalid field graphs',()=>{
  const A={name:'A',parents:[],fields:[],methods:[method('compute',0,()=>10),method('compute',1,x=>Number(x)+1)]};
  const obj=materializeMethodOnlyClass([A],'A').newInstance();
  assert.equal(obj.compute(),10);
  assert.equal(obj.compute(41n),42);
  assert.throws(()=>obj.compute(1,2),/arity mismatch/);
  const F={name:'F',parents:[],fields:['value'],methods:[]};
  const G={name:'G',parents:[],fields:['value'],methods:[]};
  const H={name:'H',parents:['F','G'],fields:[],methods:[]};
  assert.throws(()=>planMultipleInheritance([F,G,H],'H'),/colliding field/);
  assert.throws(()=>materializeMethodOnlyClass([F],'F'),/field initialization requires/);
  assert.throws(()=>planMultipleInheritance([{...F,parents:['G']},{...G,parents:['F']}],'F'),/inheritance cycle/);
});

test('file namespace is compile-time only and never a runtime export',async()=>{
  const src='namespace payments; define module math pub fnc answer(): int {return 42;} end pub fnc main(): int {return math.answer();}';
  const js=compileProgramV2(src);
  const ns=await execute(src);
  assert.deepEqual(Object.keys(ns).sort(),['main','math']);
  assert.equal(Object.hasOwn(ns,'payments'),false);
  assert.equal(ns.main(),42n);
  assert.doesNotMatch(js,/Object\.defineProperty\([^,]+,"payments"/);
  for(const invalid of [
    'namespace a.b; pub fnc main(): int {return 1;}',
    'namespace a; namespace b; pub fnc main(): int {return 1;}',
    'pub fnc main(): int {return 1;} namespace a;'
  ]) assert.throws(()=>compileProgramV2(invalid),/error: program v2:/);
});

test('separately materialized classes with identical names do not share nominal identity',()=>{
  const def={name:'A',parents:[],fields:[],methods:[method('f',0,()=>1)]};
  const first=materializeMethodOnlyClass([def],'A');
  const second=materializeMethodOnlyClass([def],'A');
  const a=first.newInstance(),b=second.newInstance();
  assert.equal(first.isA(a,'A'),true);
  assert.equal(first.isA(b,'A'),false);
  assert.equal(second.isA(a,'A'),false);
  assert.throws(()=>a.f.call(b),/invalid Oreslang receiver/);
});

test('method-only materializer rejects private method escape',()=>{
  const privateClass={name:'A',parents:[],fields:[],methods:[method('secret',0,()=>1,false)]};
  assert.deepEqual(planMultipleInheritance([privateClass],'A').methods.map(x=>x.slot),['secret/0']);
  assert.throws(()=>materializeMethodOnlyClass([privateClass],'A'),/private method dispatch requires/);
});

test('inheritance descriptor validation fails closed before touching getter content',()=>{
  let used=false;
  const attack={name:'A',parents:[],fields:[],methods:[]};
  Object.defineProperty(attack,'methods',{enumerable:true,get(){used=true;throw Error('getter fired');}});
  assert.throws(()=>planMultipleInheritance([attack],'A'),/accessor or missing field/);
  assert.equal(used,false);
  const extra={name:'B',parents:[],fields:[],methods:[],jsPrototype:'unsafe'};
  assert.throws(()=>planMultipleInheritance([extra],'B'),/unexpected fields/);
  const callback={name:'ok',arity:0,pub:true,impl:()=>42};
  Object.defineProperty(callback,'impl',{enumerable:true,get(){used=true;throw Error('getter fired');}});
  assert.throws(()=>planMultipleInheritance([{name:'C',parents:[],fields:[],methods:[callback]}],'C'),/accessor or missing field/);
  assert.equal(used,false);
});

test('runtime module function overloads select by caller-visible arity',async()=>{
  const src=[
    'define module math',
    'pub fnc add(int x): int {return x+1;}',
    'pub fnc add(int x,int y): int {return x+y;}',
    'end',
    'pub fnc main(): int {return math.add(40,2);}',
    'pub fnc main(int x): int {return math.add(x);}'
  ].join('\n');
  const ns=await execute(src);
  assert.equal(ns.math.add(41n),42n);
  assert.equal(ns.math.add(40n,2n),42n);
  assert.equal(ns.main(),42n);
  assert.equal(ns.main(41n),42n);
  assert.throws(()=>ns.math.add(),/overload arity mismatch/);
  assert.throws(()=>ns.main(1n,2n),/overload arity mismatch/);
  assert.deepEqual(Object.keys(ns.math),['add']);
  for(const bad of [
    'pub fnc f(): int {return 1;} pub fnc f(): int {return 2;}',
    'pub fnc f(): int {return 1;} pub routine f(int x): int {return x;}'
  ])assert.throws(()=>compileProgramV2(bad),/error: program v2:/);
});

test('empty named module still emits an empty runtime namespace object',async()=>{
  const ns=await execute('namespace types; define module empty as end');
  assert.deepEqual(Object.keys(ns),['empty']);
  assert.deepEqual(Object.keys(ns.empty),[]);
  assert.equal(Object.getPrototypeOf(ns.empty),null);
  assert.equal(Object.isFrozen(ns.empty),true);
});
