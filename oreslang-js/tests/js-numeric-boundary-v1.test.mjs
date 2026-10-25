import test from 'node:test';
import assert from 'node:assert/strict';
import {
 NUMERIC_PROBES,CHECKED_I64_SOURCE_DIRECTIVE,numericProbeGuestSource,
 numericProbeSuiteSha256,executeJsNumericBoundaryProbes
} from '../src/js-numeric-boundary-v1.mjs';
import {createHash} from 'node:crypto';
import {compileProgramV2} from '../src/program-v2.mjs';

test('numeric evidence source bytes require the exact checked Java-compatible first line',()=>{
 const header='// oreslang:checked-i64-v1\n';
 assert.equal(CHECKED_I64_SOURCE_DIRECTIVE,header);
 const h=createHash('sha256').update('oreslang-js-numeric-boundary-v1\0');
 for(const p of NUMERIC_PROBES) {
  const expected=header+'pub fnc main(): int {return '+p.expression+';}\n';
  assert.equal(numericProbeGuestSource(p.expression),expected,p.id);
  assert.match(expected,/^\/\/ oreslang:checked-i64-v1\npub fnc main\(\): int \{return /);
  // Independently reconstruct the length-prefixed source-binding digest:
  // an unmarked numeric source must never retain the checked witness SHA.
  for(const field of [p.id,p.expression,p.expected_kind,p.expected_value??'',expected]){
   const bytes=Buffer.from(field,'utf8');
   const size=Buffer.alloc(8);size.writeBigUInt64BE(BigInt(bytes.length));
   h.update(size).update(bytes);
  }
 }
 assert.equal(numericProbeSuiteSha256(),h.digest('hex'));
 assert.equal(numericProbeSuiteSha256(),
  '2400f20207799bf824342747d711249be612df7ed81266878e1f24b46dc130c0',
  'reviewed numeric source suite must not drift without updating this pin');
 // Arbitrary injected source, even without a newline, is not an eligible witness.
 for(const forged of ['43','43;} pub fnc evil(): int {return 1',
                       '\n',null,{},NUMERIC_PROBES[0].expression+'\r\n']){
  assert.throws(()=>numericProbeGuestSource(forged),
   /unlisted checked-i64 numeric witness expression/);
 }
 // A real compiler must accept the explicitly negotiated profile, not
 // silently consume unmarked legacy wrapping source as a checked receipt.
 assert.match(compileProgramV2(numericProbeGuestSource(NUMERIC_PROBES[0].expression)),
              /main/);
});

test('sixteen real Node guest numeric probes pin checked-i64 and remainder outcomes',async()=>{
 const r=await executeJsNumericBoundaryProbes();
 assert.equal(r.format,'oreslang-js-numeric-boundary-v1');
 assert.equal(r.results.length,16);
 assert.equal(r.results.filter(x=>x.observed_kind==='checked-overflow').length,7);
 assert.equal(r.results.filter(x=>x.observed_kind==='division-by-zero').length,1);
 assert.equal(r.results.filter(x=>x.observed_kind==='value').length,8);
 assert.equal(r.suite_sha256,numericProbeSuiteSha256());
 assert.match(r.suite_sha256,/^[a-f0-9]{64}$/);
 assert.equal(r.integer_model,'signed-i64-checked-provisional');
 assert.equal(r.java_graal_execution_verified,false);
 assert.equal(r.cross_backend_arithmetic_parity_certified,false);
 assert.equal(r.execution,'real-node-guest');
 for(const {id} of r.results)assert.equal(typeof id,'string');
});
test('numeric witness identifiers and oracle data have no duplicates or gaps',()=>{
 const seen=new Set();
 for(const p of NUMERIC_PROBES){
  assert.ok(!seen.has(p.id),p.id);
  seen.add(p.id);
  assert.ok(p.expression.length>0);
  assert.ok(['value','checked-overflow','division-by-zero'].includes(p.expected_kind));
 }
 assert.equal(seen.size,16);
});
test('overflow is checked before a subsequent expression can cancel it',async()=>{
 const source='pub fnc main(): int {return (9223372036854775807 + 1)-1;}';
 const m=await import('data:text/javascript,'+encodeURIComponent(compileProgramV2(source)));
 assert.throws(()=>m.main(),/ORES_I64_OVERFLOW/);
});
test('Java long arithmetic asIntN is a non-runtime explanatory oracle only',()=>{
 // This is NOT a Java Oreslang guest invocation. The divergent wrap
 // expectations must not be promoted to verified Java/GraalVM results.
 const wrap=(v)=>BigInt.asIntN(64,v);
 assert.equal(wrap(9223372036854775807n+1n),-9223372036854775808n);
 assert.equal(wrap((-9223372036854775807n-1n)-1n),9223372036854775807n);
 assert.equal(wrap(9223372036854775807n*2n),-2n);
});
