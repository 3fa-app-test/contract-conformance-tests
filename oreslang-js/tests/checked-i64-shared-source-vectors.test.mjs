import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compileProgramV2} from '../src/program-v2.mjs';

// Independent source-mapped vectors from conformance fixture Git blob:
// 44224caf6f6c76dedff429a47d51edc926830fdc
// No abstract div_trunc cases: Oreslang source '/' retains separate semantics.
// These are real JS guest compiler tests, NOT Java/Graal/LLVM attestations.
const SOURCE_HEADER='// oreslang:checked-i64-v1\n';
const PINNED_SOURCE_DIGEST='b83276db9e770025291dd09b0837a55cd8fadc2a7f9fff4c2a78a2ea836c3044';
const CASES=[
  ["literal-zero","0","value","0","none"],
  ["literal-max","9223372036854775807","value","9223372036854775807","none"],
  ["literal-min","-9223372036854775808","value","-9223372036854775808","none"],
  ["literal-over-max","9223372036854775808","error","integer_overflow","compile"],
  ["literal-under-min","-9223372036854775809","error","integer_overflow","compile"],
  ["add-basic","(40 + 2)","value","42","none"],
  ["add-max-zero","(9223372036854775807 + 0)","value","9223372036854775807","none"],
  ["add-max-one","(9223372036854775807 + 1)","error","integer_overflow","runtime"],
  ["add-min-neg-one","(-9223372036854775808 + -1)","error","integer_overflow","runtime"],
  ["add-min-one","(-9223372036854775808 + 1)","value","-9223372036854775807","none"],
  ["add-cancel","(1 + -1)","value","0","none"],
  ["sub-basic","(50 - 8)","value","42","none"],
  ["sub-min-zero","(-9223372036854775808 - 0)","value","-9223372036854775808","none"],
  ["sub-min-one","(-9223372036854775808 - 1)","error","integer_overflow","runtime"],
  ["sub-max-negative-one","(9223372036854775807 - -1)","error","integer_overflow","runtime"],
  ["sub-zero-negative-one","(0 - -1)","value","1","none"],
  ["mul-basic","(6 * 7)","value","42","none"],
  ["mul-max-one","(9223372036854775807 * 1)","value","9223372036854775807","none"],
  ["mul-max-two","(9223372036854775807 * 2)","error","integer_overflow","runtime"],
  ["mul-min-negative-one","(-9223372036854775808 * -1)","error","integer_overflow","runtime"],
  ["mul-min-zero","(-9223372036854775808 * 0)","value","0","none"],
  ["mul-neg-seven-three","(-7 * 3)","value","-21","none"],
  ["mul-root-square-valid","(3037000499 * 3037000499)","value","9223372030926249001","none"],
  ["mul-root-square-overflow","(3037000500 * 3037000500)","error","integer_overflow","runtime"],
  ["neg-zero","(-0)","value","0","none"],
  ["neg-max","(-9223372036854775807)","value","-9223372036854775807","none"],
  ["neg-min","(--9223372036854775808)","error","integer_overflow","runtime"],
  ["rem-positive","(7 % 3)","value","1","none"],
  ["rem-negative","(-7 % 3)","value","-1","none"],
  ["rem-negative-divisor","(7 % -3)","value","1","none"],
  ["rem-both-negative","(-7 % -3)","value","-1","none"],
  ["rem-min-minus-one","(-9223372036854775808 % -1)","value","0","none"],
  ["rem-zero-divisor","(7 % 0)","error","division_by_zero","runtime"],
  ["rem-zero-zero","(0 % 0)","error","division_by_zero","runtime"],
  ["intermediate-add-overflow","((9223372036854775807 + 1) - 1)","error","integer_overflow","runtime"],
  ["intermediate-sub-overflow","((-9223372036854775808 - 1) + 1)","error","integer_overflow","runtime"],
  ["intermediate-mul-overflow","((9223372036854775807 * 2) - 9223372036854775807)","error","integer_overflow","runtime"],
  ["precedence-tree","(1 + (2 * 3))","value","7","none"]
];
const source=expr=>SOURCE_HEADER+'pub fnc main(): int { return '+expr+'; }\n';

test('shared 38-source checked-i64 case text, kind and phase are pinned',()=>{
  assert.equal(CASES.length,38);
  assert.equal(CASES.filter(x=>x[2]==='value').length,23);
  assert.equal(CASES.filter(x=>x[4]==='compile').length,2);
  assert.equal(CASES.filter(x=>x[4]==='runtime').length,13);
  assert.equal(new Set(CASES.map(x=>x[0])).size,38);
  const h=createHash('sha256');
  for(const row of CASES){
    assert.equal(row.length,5);
    row.forEach((value,index)=>{
      h.update(value,'utf8');
      h.update(index===4?'\n':'\0','utf8');
    });
  }
  assert.equal(h.digest('hex'),PINNED_SOURCE_DIGEST);
});

test('real JS guest/compiler matches 38 shared checked-i64 source vectors',async(t)=>{
  for(const [id,expr,kind,expected,phase] of CASES){
    await t.test(id,async()=>{
      const exactSource=source(expr);
      assert.ok(exactSource.startsWith('// oreslang:checked-i64-v1\n'));
      if(phase==='compile'){
        assert.equal(kind,'error');
        assert.equal(expected,'integer_overflow');
        assert.throws(()=>compileProgramV2(exactSource),err=>
          /int literal outside provisional signed i64/.test(String(err)));
        return;
      }
      // Any compilation error for a runtime failure is phase drift, not a
      // successful rejection; the Java contract explicitly distinguishes it.
      const esm=compileProgramV2(exactSource);
      const module=await import('data:text/javascript;charset=utf-8,'+encodeURIComponent(esm));
      if(kind==='value'){
        assert.equal(phase,'none');
        assert.equal(module.main(),BigInt(expected),'exact signed-64 guest result');
      }else{
        assert.equal(phase,'runtime');
        const errorCode=expected==='division_by_zero'?'ORES_I64_DIVISION_BY_ZERO:'
          :expected==='integer_overflow'?'ORES_I64_OVERFLOW:':null;
        assert.ok(errorCode,'unsupported shared runtime failure category');
        assert.throws(()=>module.main(),err=>
          err instanceof RangeError&&err.message.startsWith(errorCode));
      }
    });
  }
});
