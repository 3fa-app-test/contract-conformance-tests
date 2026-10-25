import test from 'node:test';
import assert from 'node:assert/strict';
import {compileProgramV2} from '../src/program-v2.mjs';

const DIRECTIVE='// oreslang:checked-i64-v1\n';
const MAIN='pub fnc main(): int {return 43;}\n';
function rejected(src){
  assert.throws(()=>compileProgramV2(src),/checked-i64-v1:/,
    'A requested checked profile must never silently fall back or be ignored');
}

test('JS and Java accept the same exact first-line checked header',()=>{
  assert.doesNotThrow(()=>compileProgramV2(DIRECTIVE+MAIN));
  assert.doesNotThrow(()=>compileProgramV2(MAIN));
  assert.doesNotThrow(()=>compileProgramV2('// unrelated\n'+MAIN));
});
test('explicit checked source profile rejects malformed, duplicate and displaced markers',()=>{
  for(const src of [
    '\n'+DIRECTIVE+MAIN,' '+DIRECTIVE+MAIN,
    '\t'+DIRECTIVE+MAIN,'\ufeff'+DIRECTIVE+MAIN,
    '// oreslang:checked-i64-v1\r\n'+MAIN,
    '//oreslang:checked-i64-v1\n'+MAIN,
    '//  oreslang:checked-i64-v1\n'+MAIN,
    '//\toreslang:checked-i64-v1\n'+MAIN,
    '// oreslang:checked-i64-v2\n'+MAIN,
    '// oreslang:checked-i64-v1 trailing\n'+MAIN,
    DIRECTIVE+DIRECTIVE+MAIN,
    MAIN+DIRECTIVE,
    DIRECTIVE+'   // oreslang:checked-i64-v1\n'+MAIN,
    '// oreslang:checked-i64-v1'
  ])rejected(src);
});
test('quoted and block-comment lookalikes never select or invalidate checked profile',()=>{
  const nested='/* outer /* nested\n// oreslang:checked-i64-v2\n*/ outer */\n';
  assert.doesNotThrow(()=>compileProgramV2(nested+MAIN));
  assert.doesNotThrow(()=>compileProgramV2(DIRECTIVE+nested+MAIN));
  const ordinary='/*\n// oreslang:checked-i64-v1\n*/\n';
  assert.doesNotThrow(()=>compileProgramV2(ordinary+MAIN));
  assert.doesNotThrow(()=>compileProgramV2(DIRECTIVE+ordinary+MAIN));
  // Quoted token lookalikes are still invalid Oreslang source because this
  // experimental JS grammar has no string expressions, but they must never
  // be mistaken for an authentic header by the pre-tokenization scanner.
  assert.throws(()=>compileProgramV2('"// oreslang:checked-i64-v1"\n'+MAIN),
    /unsupported character/);
});
test('seeded adversarial spacing never upgrades a displaced marker',()=>{
  for(let i=0;i<128;i++){
    const gap=i%3===0?' '.repeat(i%5+2):i%3===1?'\t':' \t';
    const malformed='//'+gap+'oreslang:checked-i64-v1\n';
    rejected(malformed+MAIN);
    rejected(DIRECTIVE+malformed+MAIN);
    const nested='/* outer /* nested\n'+malformed+'*/ outer */\n';
    assert.doesNotThrow(()=>compileProgramV2(nested+MAIN));
    assert.doesNotThrow(()=>compileProgramV2(DIRECTIVE+nested+MAIN));
  }
});
