import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compileProgramV2} from '../src/program-v2.mjs';

// Shared platform-conformance scalar fixtures; these tests exercise the JS
// backend only, not a Java/GraalVM or LLVM compiler.
const fixtures=[
 {kind:'accept',source:'pub fnc main(): int {\n  return 20 + 22;\n}\n',
  blob:'d5408d2e3364254e2661e6850e2455c77d404b5e'},
 {kind:'reject',source:'pub fnc main(): int {\n  return nonexistent_symbol;\n}\n',
  blob:'e65dd35a794dad4d27f853f4231ba9f7e76b0ece'}
];

function gitBlob(source){
 const bytes=Buffer.from(source,'utf8');
 return createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
}

test('conformance fixture bytes are pinned to independent Git blob identities',()=>{
 for(const fixture of fixtures)assert.equal(gitBlob(fixture.source),fixture.blob);
});

test('canonical shared arithmetic fixture returns a typed Oreslang integer 42',async()=>{
 const code=compileProgramV2(fixtures[0].source);
 const namespace=await import('data:text/javascript,'+encodeURIComponent(code));
 assert.equal(namespace.main(),42n);
 assert.throws(()=>namespace.main(1n),/overload arity mismatch/);
});

test('shared unknown-symbol fixture is rejected as a compiler diagnostic',()=>{
 assert.throws(()=>compileProgramV2(fixtures[1].source),
  /error: program v2: unresolved identifier nonexistent_symbol/);
});
