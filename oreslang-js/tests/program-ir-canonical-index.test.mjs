import test from 'node:test';
import assert from 'node:assert/strict';
import {compileToProgramIRV2, compileProgramIRV2} from '../src/program-v2.mjs';
import {validateProgramIRV2} from '../src/program-ir-v2.mjs';

test('external numeric IR indices reject negative zero rather than silently canonicalizing it',()=>{
  const src='pub fnc id(int n): int {return n;} pub fnc main(): int {return id(42);}';
  const reference=compileToProgramIRV2(src);
  assert.equal(reference.functions[0].body.kind,'param');
  assert.equal(reference.functions[1].body.kind,'call');

  const badParam=structuredClone(reference);
  badParam.functions[0].body.index=-0;
  assert.ok(Object.is(badParam.functions[0].body.index,-0));
  assert.throws(()=>validateProgramIRV2(badParam),/out-of-bounds parameter/);

  const badTarget=structuredClone(reference);
  badTarget.functions[1].body.target=-0;
  assert.ok(Object.is(badTarget.functions[1].body.target,-0));
  assert.throws(()=>compileProgramIRV2(badTarget),/invalid call target/);

  // A JSON parser can preserve -0 although JSON.stringify rewrites it to 0.
  const raw=JSON.stringify(reference).replace('"target":0','"target":-0');
  assert.notEqual(raw,JSON.stringify(reference));
  assert.throws(()=>validateProgramIRV2(JSON.parse(raw)),/invalid call target/);

  assert.equal(compileProgramIRV2(reference),compileProgramIRV2(JSON.parse(JSON.stringify(reference))));
});
