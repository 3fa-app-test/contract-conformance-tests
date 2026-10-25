import test from 'node:test';
import assert from 'node:assert/strict';
import {compileToProgramIRV2} from '../src/program-v2.mjs';
import {validateProgramIRV2} from '../src/program-ir-v2.mjs';
import {
  executeJsReferenceFixtures,compareJavaAndJsReports,
  JAVA_FIXTURE_REVISION,JAVA_SEMANTIC_SUITE_SHA256,JAVA_GRAAL_MANIFEST
} from '../src/java-js-parity-v1.mjs';

const source='pub fnc id(int a): int {return a;} pub fnc main(): int {return id(42);}';
const base=compileToProgramIRV2(source);
const copy=()=>structuredClone(base);

test('external IR rejects Array subclasses and prototype-changed arrays before map/filter can execute',()=>{
  const mutation=[
    x=>x.functions,
    x=>x.modules,
    x=>x.functions[0].params,
    x=>x.functions[1].body.args
  ];
  for(const get of mutation){
    const ir=copy();
    let mapperCalled=0;
    const input=get(ir);
    Object.setPrototypeOf(input,Object.create(Array.prototype,{
      map:{value(){mapperCalled++;return [];},configurable:true}
    }));
    assert.throws(()=>validateProgramIRV2(ir),/invalid array/);
    assert.equal(mapperCalled,0,'untrusted Array.prototype.map must never run');
  }
  const ir=copy();
  class Hijack extends Array{map(){throw Error('custom map executed');}}
  ir.functions=new Hijack(...ir.functions);
  assert.throws(()=>validateProgramIRV2(ir),/invalid array/);
});

const fakeJava=js=>({
  schema_version:'1.1.0',backend:'graal',
  source_revision:JAVA_FIXTURE_REVISION,
  suite_sha256:JAVA_SEMANTIC_SUITE_SHA256,
  results:[...js.results.map(r=>({
    id:r.id,status:'pass',
    ...(r.kind==='value'?{observed_exit:Number(r.observed_int64)}:
      {diagnostic_class:r.diagnostic_class})
  })),...JAVA_GRAAL_MANIFEST.filter(x=>!js.results.some(r=>r.id===x.id)).map(x=>({id:x.id,status:'pass',...(typeof x.expected==='number'?{observed_exit:x.expected}:{diagnostic_class:x.expected})}))]
});

test('structural comparator rejects tampered JS identity/metadata and all fixture-result aliases',async()=>{
  const js=await executeJsReferenceFixtures(), java=fakeJava(js);
  assert.equal(compareJavaAndJsReports(js,java).cases_compared.length,10);
  const mutations=[
    v=>{v.fixture_authority='untrusted';},
    v=>{v.fixture_authority_revision='f'.repeat(40);},
    v=>{v.integer_model='signed-i64-wrap-provisional';},
    v=>{v.execution='synthetic';},
    v=>{v.provenance_authenticated=true;},
    v=>{v.java_execution_verified=true;},
    v=>{v.results[0].kind='diagnostic';},
    v=>{v.results[0].status='pending';},
    v=>{v.results[0].observed_int64='041';},
    v=>{v.results[5].diagnostic_class='unknown_wrong';},
    v=>{v.results[1].id=v.results[0].id;},
    v=>{v.results.reverse();v.results[0].fixture_git_blob='0'.repeat(40);},
    v=>{v.results[0].diagnostic_class='unexpected';},
    v=>{v.results[5].observed_int64='42';},
    v=>{v.results[0].fixture_git_blob='0'.repeat(40);}
  ];
  for(const [i,mutate] of mutations.entries()){
    const invalid=structuredClone(js);
    mutate(invalid);
    assert.throws(()=>compareJavaAndJsReports(invalid,java),Error,
      'mutation '+i+' must reject rather than compare');
  }
});

test('comparator refuses exotic prototypes/getters without invoking untrusted accessors',async()=>{
  const js=await executeJsReferenceFixtures(),java=fakeJava(js);
  for(const base of [js,java]){
    let invocations=0;
    const invalid=structuredClone(base);
    Object.defineProperty(invalid.results[0],'id',{enumerable:true,
      get(){invocations++;throw Error('untrusted getter executed');}});
    if(base===js) assert.throws(()=>compareJavaAndJsReports(invalid,java),/JS report result 0: accessor property rejected/);
    else assert.throws(()=>compareJavaAndJsReports(js,invalid),/Java report result 0: accessor property rejected/);
    assert.equal(invocations,0);
  }
  const fake=structuredClone(js);
  Object.setPrototypeOf(fake.results,Object.create(Array.prototype));
  assert.throws(()=>compareJavaAndJsReports(fake,java),/JS report results: invalid array/);
  const wrongJava=structuredClone(java);
  Object.setPrototypeOf(wrongJava.results,Object.create(Array.prototype));
  assert.throws(()=>compareJavaAndJsReports(js,wrongJava),/Java report results: invalid array/);
});

test('Java suite revision is pinned, and comparison never certifies provenance',async()=>{
  const js=await executeJsReferenceFixtures(),java=fakeJava(js);
  for(const rev of ['b'.repeat(40),'0'.repeat(40),'not-a-revision']){
    const mutant=structuredClone(java);mutant.source_revision=rev;
    assert.throws(()=>compareJavaAndJsReports(js,mutant),/unverified Java report shape/);
  }
  const verdict=compareJavaAndJsReports(js,java);
  assert.equal(verdict.java_runner_authenticated,false);
  assert.equal(verdict.source_to_binary_authenticated,false);
  assert.equal(verdict.full_java_js_parity_certified,false);
});
