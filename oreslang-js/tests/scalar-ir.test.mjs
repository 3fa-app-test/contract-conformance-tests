import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compile, compileToIR, compileIR} from '../src/compiler.mjs';
import {buildPackage} from '../src/build-package.mjs';
import {
  validateScalarIR, stringifyScalarIR, SCALAR_IR_VERSION, SCALAR_IR_INT_MODEL
} from '../src/scalar-ir.mjs';

const source = [
  'pub fnc main(): int { return add(40, 2); }',
  'fnc add(int x, int y): int { return x + y; }'
].join('\n');

async function runESM(js) {
  const dir = await mkdtemp(join(tmpdir(), 'ores-ir-'));
  try {
    const file = join(dir, 'module.mjs');
    await writeFile(file, js);
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}
const clone = value => JSON.parse(JSON.stringify(value));

test('source -> resolved JSON scalar IR -> ESM roundtrips exactly', async () => {
  const ir = compileToIR(source);
  assert.equal(ir.schemaVersion, SCALAR_IR_VERSION);
  assert.equal(ir.integerModel, SCALAR_IR_INT_MODEL);
  assert.deepEqual(ir.functions[0].body, {
    kind: 'call', target: 1, args: [
      {kind: 'int', value: '40'}, {kind: 'int', value: '2'}
    ]
  });
  assert.deepEqual(ir.functions[1].body, {
    kind: 'binary', op: '+',
    left: {kind: 'param', index: 0},
    right: {kind: 'param', index: 1}
  });
  assert.deepEqual(validateScalarIR(clone(ir)), ir);
  assert.equal(stringifyScalarIR(ir), JSON.stringify(ir));
  assert.equal(compileIR(clone(ir)), compile(source));
  const mod = await runESM(compileIR(clone(ir)));
  assert.equal(mod.main(), 42n);
  assert.equal(Object.hasOwn(mod, 'add'), false);
});

test('canonical int boundaries and reserved export names', async () => {
  const ir = compileToIR('pub fnc default(): int { return -9223372036854775808; }');
  assert.equal(ir.functions[0].body.value, '-9223372036854775808');
  const mod = await runESM(compileIR(ir));
  assert.equal(mod.default(), -(1n << 63n));
  assert.throws(
    () => compileIR({...ir, functions: [{...ir.functions[0], body: {kind:'int', value:'-0'}}]}),
    /invalid canonical int literal/
  );
});

test('IR validator rejects malformed and hostile expression inputs', () => {
  const ir = compileToIR(source);
  const replaceBody = body => ({
    ...ir, functions: [{...ir.functions[0], body}, ir.functions[1]]
  });
  for (const expr of [
    {kind: 'param', index: 0},
    {kind: 'call', target: 99, args: []},
    {kind: 'call', target: 1, args: []},
    {kind: 'binary', op: '/', left: {kind:'int',value:'1'}, right:{kind:'int',value:'2'}},
    {kind: 'int', value: '9223372036854775808'},
    {kind: 'int', value: '01'},
    {kind: 'int', value: '1n'},
    {kind: 'int', value: '1', emittedJS: 'process.exit(1)'},
    {kind: 'eval', source: 'process.exit(1)'}
  ]) {
    assert.throws(() => compileIR(replaceBody(expr)), /error: scalar IR:/);
  }
});

test('IR validator rejects duplicate names, wrong model and unsupported versions', () => {
  const ir = compileToIR(source);
  assert.throws(() => compileIR({...ir, schemaVersion: 2}), /unsupported IR version/);
  assert.throws(() => compileIR({...ir, integerModel: 'arbitrary-precision'}), /unsupported IR version/);
  assert.throws(
    () => compileIR({...ir, functions: [{...ir.functions[0], name:'add'}, ir.functions[1]]}),
    /duplicate function/
  );
  assert.throws(() => compileIR({...ir, functions: []}), /no functions/);
  assert.throws(
    () => compileIR({...ir, functions: [{...ir.functions[0], resultType:'void'}, ir.functions[1]]}),
    /invalid function signature/
  );
});

test('IR rejects call cycles, including cycles hidden in unexported code', () => {
  const ir = compileToIR(source);
  const cycle = {...ir, functions:[
    {...ir.functions[0], body:{kind:'call',target:1,args:[{kind:'int',value:'1'},{kind:'int',value:'2'}]}},
    {...ir.functions[1], body:{kind:'call',target:0,args:[]}}
  ]};
  assert.throws(() => compileIR(cycle), /unconditional recursive call cycle/);
});

test('IR object format excludes accessors, symbols and prototype trickery', () => {
  const ir = compileToIR(source);
  let accessed = false;
  const forged = {...ir};
  Object.defineProperty(forged, 'functions', {
    enumerable: true,
    get() { accessed = true; throw Error('getter should not execute'); }
  });
  assert.throws(() => compileIR(forged), /accessor or missing field/);
  assert.equal(accessed, false);
  const accessorKind = {};
  Object.defineProperty(accessorKind, 'kind', {enumerable: true, get() {
    accessed = true; throw Error('expression getter should not execute');
  }});
  assert.throws(() => compileIR({
    ...ir, functions:[{...ir.functions[0], body:accessorKind}, ir.functions[1]]
  }), /missing or accessor kind/);
  assert.equal(accessed, false);
  assert.throws(() => compileIR({...ir, [Symbol.for('evil')]: 'payload'}), /unexpected or missing field/);
  assert.throws(() => compileIR(Object.assign(Object.create({foreign:true}),ir)), /non-plain object/);
});

test('IR enforces bounded depth and forbids non-terminating recursive objects', () => {
  const ir = compileToIR(source);
  const expr = {kind:'neg'};
  expr.inner = expr;
  assert.throws(
    () => compileIR({...ir, functions:[{...ir.functions[0], body:expr},ir.functions[1]]}),
    /expression limit exceeded/
  );
});

test('trusted package manifest takes public exports from IR, including keyword names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ores-ir-package-'));
  try {
    const input = join(dir, 'input.ores');
    const output = join(dir, 'output');
    await writeFile(input, [
      'pub fnc default(): int {return 42;}',
      'pub fnc alternate(): int {return 7;}',
      'fnc hidden(): int {return 0;}'
    ].join('\n'));
    const manifest = await buildPackage({
      sourceFile: input, outputDir: output, target: 'browser',
      declaredCompilerSha: 'a'.repeat(40)
    });
    assert.deepEqual(manifest.publicEntrypoints, ['default', 'alternate']);
    const emitted = await readFile(join(output, 'module.mjs'), 'utf8');
    assert.match(emitted, /export \{ _f0 as "default" \};/);
    assert.match(emitted, /export \{ _f1 as "alternate" \};/);
    assert.doesNotMatch(emitted, /hidden/);
  } finally {
    await rm(dir, {recursive:true, force:true});
  }
});
