import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,compileToIR} from '../src/compiler.mjs';
import {compileIR} from '../src/compiler.mjs';

test('source diagnostics retain stable language-facing prefix across scalar IR',()=>{
  assert.throws(()=>compile('pub fnc main(): int {return unknown_symbol;}'),{
    name:'CompileError',message:/^error: unresolved identifier unknown_symbol/
  });
  assert.throws(()=>compile('pub fnc cycle(): int {return cycle();}'),{
    name:'CompileError',message:/^error: unconditional recursive call cycle/
  });
  assert.throws(()=>compileToIR('pub fnc main(): int {return unknown_symbol;}'),/error: unresolved identifier/);
});
test('directly supplied scalar IR keeps strict IR-specific error prefix',()=>{
  const value=compileToIR('pub fnc main(): int {return 42;}');
  assert.throws(()=>compileIR({...value,schemaVersion:404}),/error: scalar IR: unsupported IR version/);
});
