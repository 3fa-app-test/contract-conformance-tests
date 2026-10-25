import test from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.mjs';
import {compileProgramV2} from '../src/program-v2.mjs';

// Generated modules are trusted compiler test artifacts, not sandboxed guests.
async function run(compileFn,source) {
  const esm=compileFn(source);
  return import('data:text/javascript;charset=utf-8,'+encodeURIComponent(esm));
}

const spellings=[
  ['legacy braces', 'pub fnc answer(): int { return 40+2; }'],
  ['arrow and end', 'pub fnc answer() -> int return 40+2; end'],
  ['arrow as/end', 'pub fnc answer() -> int as return 40+2; end'],
  ['arrow double-colon/end', 'pub fnc answer() -> int :: return 40+2; end'],
  ['arrow with braces', 'pub fnc answer() -> int { return 40+2; }']
];

for(const [backend,compileFn] of [['scalar-v1',compile],['program-v2',compileProgramV2]]) {
  for(const [spelling,source] of spellings) {
    test(backend+': function spelling '+spelling,async()=>{
      const mod=await run(compileFn,source);
      assert.equal(mod.answer(),42n);
    });
  }

  test(backend+': comments and whitespace cannot turn :: into a JS token',async()=>{
    const source=['pub fnc answer()',' -> int /* syntax */ ::',' return 42;','end'].join('\n');
    const mod=await run(compileFn,source);
    assert.equal(mod.answer(),42n);
    assert.throws(()=>compileFn('pub fnc f() -> int :: :: return 1; end'),/error:/);
    assert.throws(()=>compileFn('pub fnc f(): int :: return 1; end'),/error:/);
  });

  test(backend+': function end is required and malformed forms fail closed',()=>{
    for(const bad of [
      'pub fnc f() -> int :: return 1;',
      'pub fnc f() -> int as return 1; }',
      'pub fnc f() -> int return 1; }',
      'pub fnc f() -> int :: return 1; end end',
      'pub fnc f() -> int :: return 1; end process.exit(0);',
      'pub fnc f() -> int :: await timer(1); end',
      'pub fnc f() -> int :: return nb { return 1; }; end',
      'define actor Worker as end'
    ]) assert.throws(()=>compileFn(bad),/error:/,bad);
  });
}

test('program-v2: lexical function end does not consume nested match end',async()=>{
  const ns=await run(compileProgramV2,[
    'pub fnc classify(int x) -> int ::',
    ' return match x over',
    ' on 1 -> {42;}',
    ' on _ -> {0;}',
    ' end;',
    'end'
  ].join('\n'));
  assert.equal(ns.classify(1n),42n);
  assert.equal(ns.classify(2n),0n);
});

test('program-v2: mixed syntaxes preserve private calls and module exports',async()=>{
  const ns=await run(compileProgramV2,[
    'namespace example;',
    'define module math as',
    ' fnc inc(int x): int { return x+1; }',
    ' pub fnc answer() -> int as',
    ' return inc(41);',
    ' end',
    'end',
    'pub fnc main() -> int ::',
    ' return math.answer();',
    'end'
  ].join('\n'));
  assert.equal(ns.main(),42n);
  assert.equal(ns.math.answer(),42n);
  assert.deepEqual(Object.keys(ns.math),['answer']);
  assert.equal(Object.getPrototypeOf(ns.math),null);
});

test('syntax compatibility does not imply numeric parity or async/actor support',async()=>{
  const src='pub fnc f() -> int :: return 9223372036854775807 + 1; end';
  const scalar=await run(compile,src);
  const checked=await run(compileProgramV2,src);
  assert.equal(scalar.f(),-(1n<<63n)); // existing provisional wrapping profile
  assert.throws(()=>checked.f(),/ORES_I64_OVERFLOW/); // existing checked profile
});
