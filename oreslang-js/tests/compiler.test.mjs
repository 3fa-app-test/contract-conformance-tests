import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {compile} from '../src/compiler.mjs';
const fixture = name => resolve('tests/fixtures',name);
const cli = resolve('bin/oreslang-jsc.mjs');

async function moduleFrom(source) {
  const dir=await mkdtemp(join(tmpdir(),'ores-js-test-'));
  const path=join(dir,'generated.mjs');
  await writeFile(path, compile(source),{mode:0o600});
  try { return await import(pathToFileURL(path).href); }
  finally { await rm(dir,{recursive:true,force:true}); }
}

test('shared arithmetic fixture executes', async () => {
 const mod=await moduleFrom(await readFile(fixture('arithmetic.ores'),'utf8'));
 assert.equal(mod.main(),42n);
});
test('LLVM forward-call fixture executes', async () => {
 const mod=await moduleFrom(await readFile(fixture('forward-call.ores'),'utf8'));
 assert.equal(mod.main(),42n);
});
test('module wrappers, parameter checking, precedence and wrapping',async()=>{
 const source='define module A as\n pub fnc f(int a, int b): int { return a * (b + 1); }\n end';
 const mod=await moduleFrom(source);
 assert.equal(mod.f(3n,4n),15n);
 assert.throws(()=>mod.f(3,4n),/requires a signed i64 BigInt/);
 const signed=await moduleFrom('pub fnc main(): int { return 9223372036854775807 + 1; }');
 assert.equal(signed.main(), -(1n<<63n));
});
test('signed-i64 remainder follows Java long remainder semantics',async()=>{
 const mod=await moduleFrom('pub fnc rem(int a, int b): int { return a % b; }');
 assert.equal(mod.rem(7n,3n),1n);
 assert.equal(mod.rem(-7n,3n),-1n);
 assert.equal(mod.rem(-(1n<<63n),-1n),0n);
 assert.throws(()=>mod.rem(1n,0n));
});
test('rejects unknown symbols with conformance-friendly diagnostic',()=>{
 assert.throws(()=>compile('pub fnc main(): int { return nonexistent_symbol; }'),/error: unresolved identifier nonexistent_symbol/);
});
test('fail-closed: unsupported language features and syntax',()=>{
 const invalid=[
  'pub fnc main(): int { return 1 / 2; }',
  'pub fnc main(): int { return host(); }',
  'pub fnc main(): int { return 1; } import bad;',
  'define actor A as end',
  'pub fnc main(): int { await 1; }',
  'pub fnc main(): int { return 2 + ; }',
  'pub fnc main(): int { return 9223372036854775808; }',
  'pub fnc main(): int { return 1; } pub fnc main(): int { return 1; }',
  'pub fnc main(): int { return missing(1); }',
  'pub fnc main(): int { return /* unclosed',
  'pub fnc main(): int { return 0; }\n__proto__.pollute()'
 ];
 for (const source of invalid) assert.throws(()=>compile(source),/error:/,source);
});
test('pointer-style source syntax and legacy mutable borrow fail closed',()=>{
 assert.throws(()=>compile('pub fnc main(): int { return rt ref value; }'),/pointer-style runtime operation/);
 assert.throws(()=>compile('pub fnc main(): int { return rt deref value; }'),/pointer-style runtime operation/);
 assert.throws(()=>compile('pub fnc main(): int { return rt borrow mut value; }'),/legacy 'rt borrow mut'/);
 assert.throws(()=>compile('pub fnc main(): int { return rt mut borrow value; }'),/runtime ownership operation requires typed lowering/);
 for(const source of [
  'pub fnc main(): int { return &value; }',
  'pub fnc main(): int { return &mut value; }',
  'pub fnc main(): int { return *value; }',
  'pub fnc main(): Pointer<int> { return value; }'
 ]) assert.throws(()=>compile(source),/error:/,source);
});

test('source cannot inject arbitrary JS or host API access',async()=>{
 const value=await moduleFrom('pub fnc constructor(): int { return 7; }');
 assert.equal(value.constructor(),7n);
 assert.throws(()=>compile('pub fnc main(): int { return process.exit(0); }'),/error:/);
});
test('bounded input rejects oversized program',()=>{
 assert.throws(()=>compile(' '.repeat(262145)),/error:/);
});
test('CLI check works and emits no compiled JS on reject',()=>{
 const ok=spawnSync(process.execPath,[cli,'--check',fixture('arithmetic.ores')],{encoding:'utf8'});
 assert.equal(ok.status,0); assert.equal(ok.stdout.trim(),'OK');
 const bad=spawnSync(process.execPath,[cli,'--check',fixture('arithmetic.ores'),'--out=/tmp/reject'],{encoding:'utf8'});
 assert.notEqual(bad.status,0);
 const negative='pub fnc main(): int { return nonexistent_symbol; }';
 assert.throws(()=>compile(negative),/unresolved identifier nonexistent_symbol/);
});


test('scalar call graph accepts forward DAGs but rejects unconditionally infinite cycles', async () => {
 const acyclic='pub fnc main(): int { return a(40); } fnc a(int x): int { return b(x,2); } fnc b(int x,int y): int { return x+y; }';
 const mod=await moduleFrom(acyclic);
 assert.equal(mod.main(),42n);
 for(const bad of [
  'pub fnc main(): int { return main(); }',
  'pub fnc main(): int { return a(); } fnc a(): int { return main(); }',
  'pub fnc main(): int { return 1; } fnc unused(): int { return unused(); }',
  'pub fnc main(): int { return a(); } fnc a(): int { return b(); } fnc b(): int { return a(); }'
 ])assert.throws(()=>compile(bad),/error: unconditional recursive call cycle/);
});
