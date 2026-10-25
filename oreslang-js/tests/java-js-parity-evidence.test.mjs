import test from 'node:test';
import assert from 'node:assert/strict';
import {compileProgramV2} from '../src/program-v2.mjs';
import {
  REFERENCE_CASES, JAVA_FIXTURE_REVISION, FIXTURE_AUTHORITY,
  JAVA_SEMANTIC_SUITE_SHA256, JAVA_GRAAL_MANIFEST,
  gitBlobSha1, fixtureSuiteSha256, executeJsReferenceFixtures,
  compareJavaAndJsReports, compareJavaAndJsJsonReports
} from '../src/java-js-parity-v1.mjs';

test('ten independent Java fixture bytes are pinned and executed using real JS guest modules',async()=>{
  assert.equal(JAVA_FIXTURE_REVISION.length,40);
  assert.equal(FIXTURE_AUTHORITY,'ores-truffle-oreslang/oreslang-source.java');
  const sha=fixtureSuiteSha256();
  assert.match(sha,/^[a-f0-9]{64}$/);
  for(const c of REFERENCE_CASES) assert.equal(gitBlobSha1(c.source),c.blob,c.id);
  const actual=await executeJsReferenceFixtures();
  assert.equal(actual.fixture_suite_sha256,sha);
  assert.equal(actual.results.length,10);
  assert.equal(actual.results.filter(x=>x.status==='pass').length,10);
  assert.equal(actual.provenance_authenticated,false);
  assert.equal(actual.java_execution_verified,false);
  assert.equal(actual.integer_model,'signed-i64-checked-provisional');
  assert.deepEqual(actual.results.filter(x=>x.kind==='value').map(x=>x.observed_int64),
    ['42','40','42','42','42']);
});

function syntheticGraal(js){
  return {
    schema_version:'1.1.0',
    backend:'graal',
    source_revision:JAVA_FIXTURE_REVISION,
    suite_sha256:JAVA_SEMANTIC_SUITE_SHA256,
    results:[
      ...js.results.map(r=>({
        id:r.id,status:'pass',
        ...(r.kind==='value'?{observed_exit:Number(r.observed_int64)}:
          {diagnostic_class:r.diagnostic_class})
      })),
      ...JAVA_GRAAL_MANIFEST.filter(x=>!js.results.some(y=>y.id===x.id))
        .map(x=>({id:x.id,status:'pass',
          ...(typeof x.expected==='number'?{observed_exit:x.expected}:
            {diagnostic_class:x.expected})}))
    ]
  };
}
test('external Graal comparison is structural only, never authentication or full parity',async()=>{
  const js=await executeJsReferenceFixtures();
  const fake=syntheticGraal(js);
  const verdict=compareJavaAndJsReports(js,fake);
  assert.equal(verdict.cases_compared.length,10);
  assert.equal(verdict.structural_result,'MATCHING_FIXTURE_RESULTS_ONLY');
  assert.equal(verdict.java_runner_authenticated,false);
  assert.equal(verdict.source_to_binary_authenticated,false);
  assert.equal(verdict.full_java_js_parity_certified,false);
});

test('report comparison fails closed on mismatched, missing, pending and counterfeit results',async()=>{
  const js=await executeJsReferenceFixtures();
  const graal=syntheticGraal(js);
  function clone(){return structuredClone(graal);}
  let invalid=clone();invalid.results[0].observed_exit=41;
  assert.throws(()=>compareJavaAndJsReports(js,invalid),/backend value divergence/);
  invalid=clone();invalid.results[0].status='pending';
  assert.throws(()=>compareJavaAndJsReports(js,invalid),/missing\/pending\/failed/);
  invalid=clone();invalid.results.pop();
  assert.throws(()=>compareJavaAndJsReports(js,invalid),/missing\/pending\/failed/);
  invalid=clone();invalid.results[6].diagnostic_class='integer_overflow';
  assert.throws(()=>compareJavaAndJsReports(js,invalid),/diagnostic-class divergence/);
  invalid=clone();invalid.results.push(invalid.results[0]);
  assert.throws(()=>compareJavaAndJsReports(js,invalid),/duplicate\/bad Java result/);
  invalid=clone();invalid.source_revision='unknown';
  assert.throws(()=>compareJavaAndJsReports(js,invalid),/unverified Java report shape/);
  invalid=clone();invalid.suite_sha256='not a sha';
  assert.throws(()=>compareJavaAndJsReports(js,invalid),/unverified Java report shape/);
  assert.throws(()=>compareJavaAndJsReports({...js,results:js.results.slice(1)},graal),
    /invalid or incomplete JS fixture report/);
  invalid=structuredClone(js);invalid.results[0].fixture_git_blob='0'.repeat(40);
  assert.throws(()=>compareJavaAndJsReports(invalid,graal),/missing\/pending\/failed required reference case/);
});

test('checked JS runtime overflow is visibly distinct from Java long wrapping model',async()=>{
  // This is a Java-source-inspection witness, not a Java runtime invocation.
  // Java OresEvalRootNode.numeric uses long x+y (unchecked Java long arithmetic).
  const source='pub fnc main(): int {return 9223372036854775807 + 1;}';
  const ns=await import('data:text/javascript,'+encodeURIComponent(compileProgramV2(source)));
  assert.throws(()=>ns.main(),/ORES_I64_OVERFLOW/);
  assert.equal(BigInt.asIntN(64,9223372036854775807n+1n),-9223372036854775808n);
});

test('JS parity report cannot spoof authority, execution metadata, duplicate IDs or result kinds',async()=>{
  const original=await executeJsReferenceFixtures();
  const graal=syntheticGraal(original);
  const copy=()=>structuredClone(original);
  for(const mutate of [
    x=>{x.fixture_authority='attacker/repo';},
    x=>{x.fixture_authority_revision='0'.repeat(40);},
    x=>{x.integer_model='signed-i64-wrap-provisional';},
    x=>{x.execution='synthetic';},
    x=>{x.provenance_authenticated=true;},
    x=>{x.java_execution_verified=true;},
    x=>{x.results[0].kind='diagnostic';},
    x=>{x.results[0].status='pending';},
    x=>{x.results[0].observed_int64=42;},
    x=>{x.results[0].observed_int64='042';},
    x=>{x.results[1].id=x.results[0].id;},
    x=>{x.results[0].id='unlisted.case';},
    x=>{x.results[5].kind='value';}
  ]){
    const altered=copy();
    mutate(altered);
    assert.throws(()=>compareJavaAndJsReports(altered,graal));
  }
  assert.equal(compareJavaAndJsReports(original,graal).cases_compared.length,10);
});

test('foreign report descriptors are rejected before getters execute',async()=>{
  const js=await executeJsReferenceFixtures();
  const graal=syntheticGraal(js);
  let invocations=0;
  const getter=()=>{invocations++;throw Error('malicious accessor executed');};
  for(const variant of [
    ()=>{const x=structuredClone(js);Object.defineProperty(x,'results',{get:getter,enumerable:true});return [x,graal];},
    ()=>{const x=structuredClone(js);Object.defineProperty(x.results[0],'id',{get:getter,enumerable:true});return [x,graal];},
    ()=>{const x=structuredClone(graal);Object.defineProperty(x.results[0],'observed_exit',{get:getter,enumerable:true});return [js,x];},
    ()=>{const x=structuredClone(graal);Object.defineProperty(x,'suite_sha256',{get:getter,enumerable:true});return [js,x];}
  ]) {
    const [a,b]=variant();
    assert.throws(()=>compareJavaAndJsReports(a,b),/accessor property rejected/);
  }
  assert.equal(invocations,0);
});

test('report admission rejects unexpected fields, symbols, inherited records and array tricks',async()=>{
  const js=await executeJsReferenceFixtures();
  const graal=syntheticGraal(js);
  const bad=[
    [Object.assign(Object.create({injected:true}),js),graal],
    [{...js,unexpected_authority:'true'},graal],
    [{...js,[Symbol.for('secret')]:true},graal],
    [{...js,results:Object.assign([...js.results],{extra:1})},graal],
    [{...js,results:[...js.results].map((v,i)=>i===0?
      Object.assign(Object.create({bad:true}),v):v)},graal],
    [js,{...graal,spoofed_status:'pass'}],
    [js,{...graal,results:Object.assign([...graal.results],{tampered:true})}],
    [js,{...graal,results:[...graal.results,undefined]}]
  ];
  for(const [a,b] of bad)
    assert.throws(()=>compareJavaAndJsReports(a,b),/report|result|array|record/i);
  const sparse=Array.from(js.results);
  delete sparse[2];
  assert.throws(()=>compareJavaAndJsReports({...js,results:sparse},graal),/sparse/);
});

test('noncanonical metadata and counterfeit success flags fail closed',async()=>{
  const js=await executeJsReferenceFixtures();
  const graal=syntheticGraal(js);
  for(const variant of [
    {github_run_authenticated:true},
    {java_js_semantic_parity_certified:true},
    {checkout_tree_sha:'0'.repeat(39)},
    {checkout_commit_sha:'z'.repeat(40)},
    {checked_fixture_count:11},
    {node_version:Symbol.for('bad')}
  ])assert.throws(()=>compareJavaAndJsReports({...js,...variant},graal));
  const wrongExit=structuredClone(graal);
  wrongExit.results[0].observed_exit=-0;
  assert.throws(()=>compareJavaAndJsReports(js,wrongExit),/noncanonical number/);
  const incomplete=structuredClone(js);
  incomplete.results[0].status=undefined;
  assert.throws(()=>compareJavaAndJsReports(incomplete,graal));
  assert.equal(compareJavaAndJsReports(js,graal).cases_compared.length,10);
});


test('Java report must match pinned 19-file suite digest, revision and full 15-case inventory',async()=>{
 const js=await executeJsReferenceFixtures();
 const valid=syntheticGraal(js); // synthetic report validates structural admission ONLY
 assert.equal(JAVA_SEMANTIC_SUITE_SHA256,
   '6f1b0303b609a400d3ea1b6809a95bcf0d43061bacb4db2c1b8a9233f4528ec1');
 assert.equal(JAVA_GRAAL_MANIFEST.length,15);
 assert.equal(new Set(JAVA_GRAAL_MANIFEST.map(x=>x.id)).size,15);
 assert.equal(valid.results.length,15);
 assert.equal(compareJavaAndJsReports(js,valid).cases_compared.length,10);
 const other=()=>structuredClone(valid);
 let r=other();r.suite_sha256='a'.repeat(64);
 assert.throws(()=>compareJavaAndJsReports(js,r),/unverified Java report shape/);
 r=other();r.source_revision='a'.repeat(40);
 assert.throws(()=>compareJavaAndJsReports(js,r),/unverified Java report shape/);
 r=other();r.results=r.results.filter(x=>x.id!=='native.defer-field-return');
 assert.throws(()=>compareJavaAndJsReports(js,r),/required Java suite inventory/);
 r=other();r.results.find(x=>x.id==='native.defer-lifo-cfg').observed_exit=110;
 assert.throws(()=>compareJavaAndJsReports(js,r),/backend value divergence/);
 r=other();r.results.find(x=>x.id==='ownership.mutable-borrow').status='pending';
 assert.throws(()=>compareJavaAndJsReports(js,r),/missing\/pending\/failed Java suite case/);
 r=other();r.results.push({id:'forged.extra',status:'pass',observed_exit:42});
 assert.throws(()=>compareJavaAndJsReports(js,r),/required Java suite inventory/);
});


test('successful reports reject contradictory values, diagnostic classes and error details',async()=>{
  const js=await executeJsReferenceFixtures();
  const java=syntheticGraal(js);
  const copyJs=()=>structuredClone(js);
  const copyJava=()=>structuredClone(java);
  const cases=[
    [()=>{const x=copyJs();x.results[0].diagnostic_class='unknown_name';return [x,java];}],
    [()=>{const x=copyJs();delete x.results[0].observed_int64;return [x,java];}],
    [()=>{const x=copyJs();x.results[5].observed_int64='42';return [x,java];}],
    [()=>{const x=copyJs();delete x.results[5].diagnostic_class;return [x,java];}],
    [()=>{const x=copyJava();x.results[0].diagnostic_class='unknown_name';return [js,x];}],
    [()=>{const x=copyJava();delete x.results[0].observed_exit;return [js,x];}],
    [()=>{const x=copyJava();x.results[5].observed_exit=42;return [js,x];}],
    [()=>{const x=copyJava();delete x.results[5].diagnostic_class;return [js,x];}],
    [()=>{const x=copyJava();x.results[0].detail='ERROR: guest never ran';return [js,x];}],
    [()=>{const x=copyJava();x.results[10].detail='error: unknown parse';return [js,x];}]
  ];
  for(const [factory] of cases) {
    const [a,b]=factory();
    assert.throws(()=>compareJavaAndJsReports(a,b),/contradictory|success.*detail/);
  }
  assert.equal(compareJavaAndJsReports(js,java).cases_compared.length,10);
});

test('bounded text-only JSON ingress rejects hostile inputs and preserves non-attestation',async()=>{
  const js=await executeJsReferenceFixtures();
  const graal=syntheticGraal(js);
  const verified=compareJavaAndJsJsonReports(JSON.stringify(js),JSON.stringify(graal));
  assert.equal(verified.cases_compared.length,10);
  assert.equal(verified.java_runner_authenticated,false);
  assert.equal(verified.full_java_js_parity_certified,false);
  assert.throws(()=>compareJavaAndJsJsonReports(js,JSON.stringify(graal)),
    /missing or oversized JSON report/);
  assert.throws(()=>compareJavaAndJsJsonReports('{invalid',JSON.stringify(graal)),
    /invalid JSON report/);
  assert.throws(()=>compareJavaAndJsJsonReports(' '.repeat(65537),JSON.stringify(graal)),
    /missing or oversized JSON report/);
  assert.throws(()=>compareJavaAndJsJsonReports(JSON.stringify(js),' '.repeat(262145)),
    /missing or oversized JSON report/);
  assert.throws(()=>compareJavaAndJsJsonReports(JSON.stringify(js),'null'),
    /expected plain record/);
  let traps=0;
  const hostile=new Proxy({},{
    get(){traps++;throw Error('foreign proxy trap');},
    ownKeys(){traps++;throw Error('foreign proxy trap');}
  });
  assert.throws(()=>compareJavaAndJsJsonReports(hostile,JSON.stringify(graal)),
    /missing or oversized JSON report/);
  assert.equal(traps,0);
});

test('JSON report checkout commit and tree are an all-or-nothing pair',async()=>{
  const js=await executeJsReferenceFixtures();
  const graal=syntheticGraal(js);
  assert.throws(()=>compareJavaAndJsReports({...js,checkout_commit_sha:'a'.repeat(40)},graal),
    /incomplete JS checkout identity/);
  assert.throws(()=>compareJavaAndJsReports({...js,checkout_tree_sha:'b'.repeat(40)},graal),
    /incomplete JS checkout identity/);
  assert.throws(()=>compareJavaAndJsReports({...js,node_version:'vNOTNODE'},graal),
    /invalid Node runtime version/);
  const tagged={...js,checkout_commit_sha:'a'.repeat(40),
    checkout_tree_sha:'b'.repeat(40),node_version:process.version,
    checked_fixture_count:10,github_run_authenticated:false,
    java_js_semantic_parity_certified:false};
  assert.equal(compareJavaAndJsJsonReports(JSON.stringify(tagged),
    JSON.stringify(graal)).cases_compared.length,10);
});
