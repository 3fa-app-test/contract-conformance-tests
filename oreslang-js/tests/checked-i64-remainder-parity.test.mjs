import test from 'node:test';
import assert from 'node:assert/strict';
import {compileProgramV2} from '../src/program-v2.mjs';

// The generated module must execute, not merely pass an AST/IR comparison.
// Node 22+ is required; its native RangeError message is not evidence of an
// Oreslang diagnostic unless the generated code carries the explicit tag.
async function execute(source) {
  const esm=compileProgramV2(source);
  return import('data:text/javascript;charset=utf-8,'+encodeURIComponent(esm));
}
const HEADER='// oreslang:checked-i64-v1\n';
const expr=x=>HEADER+'pub fnc main(): int { return '+x+'; }\n';

test('identical checked-profile Oreslang source accepts signed remainders',async()=>{
  for(const [body,expected] of [
    ['-7 % 3','-1'],['7 % -3','1'],['-7 % -3','-1'],
    ['7 % 3','1'],['0 % -1','0'],
    ['-9223372036854775808 % -1','0'],
    ['9223372036854775807 % 43','41']
  ]){
    const ns=await execute(expr(body));
    assert.equal(ns.main(),BigInt(expected),body);
  }
});

test('direct and dynamic remainder by zero emit stable nonattesting error code',async()=>{
  for(const source of [
    expr('43 % 0'),
    HEADER+'pub fnc rem(int left,int right): int {return left % right;} '+
      'pub fnc main(): int {return rem(43,0);}'
  ]){
    const ns=await execute(source);
    assert.throws(()=>ns.main(),error=>
      error instanceof RangeError &&
      error.message.startsWith('ORES_I64_DIVISION_BY_ZERO:'),
      source);
  }
});

test('unevaluated remainder-by-zero branch stays lazy',async()=>{
  const ns=await execute(HEADER+
    'pub fnc main(): int {return match 1 on 1 -> {43;} else -> {1 % 0;} end;}');
  assert.equal(ns.main(),43n);
});

test('evaluated left operand overflow wins before zero-divisor check',async()=>{
  const ns=await execute(expr('(9223372036854775807 + 1) % 0'));
  assert.throws(()=>ns.main(),error=>
    error instanceof RangeError &&
    error.message.startsWith('ORES_I64_OVERFLOW:'));
});

test('foreign JS guest operands cannot bypass signed-i64 guards',async()=>{
  const ns=await execute(HEADER+
    'pub fnc rem(int a,int b): int { return a % b; }');
  assert.equal(ns.rem(-7n,3n),-1n);
  assert.throws(()=>ns.rem(7,3n),/signed i64 BigInt required/);
  assert.throws(()=>ns.rem(7n,0n),/ORES_I64_DIVISION_BY_ZERO/);
  assert.throws(()=>ns.rem(9223372036854775808n,3n),/ORES_I64_OVERFLOW/);
});


test('seeded 64-bit signed remainder differential vectors preserve exactness',async()=>{
  const ns=await execute(HEADER+
    'pub fnc rem(int a,int b): int {return a % b;}');
  let seed=0x4a37e91d;
  function next(){
    seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
    return seed>>>0;
  }
  for(let i=0;i<512;i++){
    const left=BigInt.asIntN(64,(BigInt(next())<<32n)|BigInt(next()));
    let right=BigInt.asIntN(64,(BigInt(next())<<32n)|BigInt(next()));
    if(right===0n)right=1n;
    assert.equal(ns.rem(left,right),left%right,'deterministic vector '+i);
  }
});
