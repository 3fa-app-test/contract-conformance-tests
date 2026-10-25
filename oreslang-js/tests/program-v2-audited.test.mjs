import test from 'node:test';
import assert from 'node:assert/strict';
import {compileProgramV2} from '../src/program-v2.mjs';

test('public routines cannot become first-class ESM values',()=>{
  for(const source of [
    'pub routine main(): int {return 42;}',
    'pub /*comment*/ routine main(): int {return 42;}',
    'pub /* nesting /* nested */ done */ routine main(): int {return 42;}',
    'define module math pub routine expose(): int {return 2;} end'
  ]) assert.throws(()=>compileProgramV2(source),/public routine/);
});

test('file-root symbols and named module root have separate identities',async()=>{
  const src=[
    'define module root',
    'pub fnc calculate(int n): int {return n+1;}',
    'end',
    'pub fnc calculate(int n): int {return n+2;}',
    'pub fnc main(): int {return root.calculate(40)+calculate(0);}'
  ].join('\n');
  const js=compileProgramV2(src);
  const ns=await import('data:text/javascript,'+encodeURIComponent(js));
  assert.equal(ns.root.calculate(40n),41n);
  assert.equal(ns.calculate(40n),42n);
  assert.equal(ns.main(),43n);
});

test('comment text cannot masquerade as a public routine',()=>{
  const code=compileProgramV2('// pub routine ignored\npub fnc main(): int {return 42;}');
  assert.match(code,/export/);
});

test('flat source namespaces remain metadata without an ESM export',()=>{
  const generated=compileProgramV2('namespace payments; define module math pub fnc get(): int {return 42;} end');
  assert.match(generated,/Object.create\(null\)/);
  assert.doesNotMatch(generated,/as "payments"/);
});
