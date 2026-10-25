import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERENCE_CASES, JAVA_FIXTURE_REVISION, JAVA_SEMANTIC_SUITE_SHA256,
  JAVA_GRAAL_MANIFEST, executeJsReferenceFixtures,
  compareJavaAndJsReports, compareJavaAndJsJsonReports
} from '../src/java-js-parity-v1.mjs';

// This integrates the adversarial acceptance obligations from PR #21 with
// #22's stronger bounded, parsed-JSON ingress. Synthetic reports only test
// the comparator. They NEVER constitute Java or CI execution evidence.
function fakeJavaReport(js) {
  const byId=new Map(js.results.map(x=>[x.id,x]));
  return {
    schema_version:'1.1.0', backend:'graal',
    source_revision:JAVA_FIXTURE_REVISION,
    suite_sha256:JAVA_SEMANTIC_SUITE_SHA256,
    results:JAVA_GRAAL_MANIFEST.map(({id,expected})=>{
      const ref=byId.get(id);
      return {id,status:'pass',
        ...(ref?.kind==='value'||typeof expected==='number'
          ?{observed_exit:Number(ref?.observed_int64??expected)}
          :{diagnostic_class:expected}),
        detail:''};
    })
  };
}
test('PR #21 contradictory-success cases remain excluded through #22 JSON ingress',async()=>{
  const js=await executeJsReferenceFixtures(),java=fakeJavaReport(js);
  const compare=(a,b)=>compareJavaAndJsJsonReports(JSON.stringify(a),JSON.stringify(b));
  assert.equal(compare(js,java).cases_compared.length,REFERENCE_CASES.length);
  const mutateJava=(id,fn)=>{const x=structuredClone(java);fn(x.results.find(c=>c.id===id));return x;};
  const mutateJs=(id,fn)=>{const x=structuredClone(js);fn(x.results.find(c=>c.id===id));return x;};
  const invalid=[
    [js,mutateJava('native.add',x=>{x.diagnostic_class='unknown_name';})],
    [js,mutateJava('diagnostic.unknown',x=>{x.observed_exit=42;})],
    [js,mutateJava('native.defer-lifo-cfg',x=>{x.detail='timeout';})],
    [js,mutateJava('diagnostic.arity',x=>{x.detail='host exception';})],
    [mutateJs('native.add',x=>{x.diagnostic_class='unknown_name';}),java],
    [mutateJs('diagnostic.comment',x=>{x.observed_int64='42';}),java],
    [mutateJs('native.add',x=>{delete x.observed_int64;}),java],
    [js,mutateJava('native.add',x=>{delete x.observed_exit;})],
  ];
  for(const [j,g] of invalid)assert.throws(()=>compare(j,g),/contradictory|successful case/);
});
test('the consolidated ingress stays size-bounded and never certifies external runtime provenance',async()=>{
  const js=await executeJsReferenceFixtures(),java=fakeJavaReport(js);
  const ok=compareJavaAndJsJsonReports(JSON.stringify(js),JSON.stringify(java));
  assert.equal(ok.structural_result,'MATCHING_FIXTURE_RESULTS_ONLY');
  assert.equal(ok.java_runner_authenticated,false);
  assert.equal(ok.source_to_binary_authenticated,false);
  assert.equal(ok.full_java_js_parity_certified,false);
  assert.throws(()=>compareJavaAndJsJsonReports(' '.repeat(65537),JSON.stringify(java)),/oversized/);
  assert.throws(()=>compareJavaAndJsJsonReports(JSON.stringify(js),' '.repeat(262145)),/oversized/);
  assert.throws(()=>compareJavaAndJsReports({...js,checkout_commit_sha:'a'.repeat(40)},java),
    /incomplete JS checkout identity/);
  let traps=0;
  const proxy=new Proxy({}, {get(){traps++;throw Error('getter invoked');},
    ownKeys(){traps++;throw Error('enumeration invoked');}});
  assert.throws(()=>compareJavaAndJsJsonReports(proxy,JSON.stringify(java)),/missing or oversized/);
  assert.equal(traps,0);
});


test('checkout provenance metadata must be all-or-nothing and Node 22+',async()=>{
  const js=await executeJsReferenceFixtures(),java=fakeJavaReport(js);
  const tagged={
    ...js,
    checkout_commit_sha:'a'.repeat(40),
    checkout_tree_sha:'b'.repeat(40),
    node_version:process.version,
    checked_fixture_count:REFERENCE_CASES.length,
    github_run_authenticated:false,
    java_js_semantic_parity_certified:false
  };
  const check=j=>compareJavaAndJsJsonReports(JSON.stringify(j),JSON.stringify(java));
  assert.equal(check(tagged).cases_compared.length,10);
  for(const field of [
    'checkout_commit_sha','checkout_tree_sha','node_version',
    'checked_fixture_count','github_run_authenticated',
    'java_js_semantic_parity_certified'
  ]){
    const incomplete={...tagged};
    delete incomplete[field];
    assert.throws(()=>check(incomplete),/incomplete JS checkout identity or execution metadata/,field);
  }
  for(const value of ['v0.0.0','v20.11.1','v21.9.0','v022.1.0','v22.invalid.0']){
    assert.throws(()=>check({...tagged,node_version:value}),/invalid Node runtime version/,value);
  }
  for(const change of [
    {github_run_authenticated:true},
    {java_js_semantic_parity_certified:true},
    {checked_fixture_count:9}
  ])assert.throws(()=>check({...tagged,...change}));
  const verdict=check(tagged);
  assert.equal(verdict.java_runner_authenticated,false);
  assert.equal(verdict.source_to_binary_authenticated,false);
  assert.equal(verdict.full_java_js_parity_certified,false);
});


test('externally received parity JSON rejects duplicate members at root and result depths',async()=>{
  const js=await executeJsReferenceFixtures(),java=fakeJavaReport(js);
  const originalJs=JSON.stringify(js),originalJava=JSON.stringify(java);
  const inject=(json,before,after)=>{
    const changed=json.replace(before,after);
    assert.notEqual(changed,json,'expected JSON fixture mutation must match');
    return changed;
  };
  const alias=String.raw`{"\u0062ackend":"forged",`;
  const invalid=[
    [inject(originalJs,'{','{"backend":"forged",'),originalJava],
    [inject(originalJs,'{',alias),originalJava],
    [inject(originalJs,'"observed_int64":"42"',
      '"observed_int64":"0","observed_int64":"42"'),originalJava],
    [originalJs,inject(originalJava,'{','{"backend":"forged",')],
    [originalJs,inject(originalJava,'"observed_exit":42',
      '"observed_exit":0,"observed_exit":42')]
  ];
  for(const [j,g] of invalid)
    assert.throws(()=>compareJavaAndJsJsonReports(j,g),/duplicate JSON member/);
});
