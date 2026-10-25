import test from 'node:test';
import assert from 'node:assert/strict';
import {compileToIR,compileIR} from '../src/compiler.mjs';
import {validateScalarIR} from '../src/scalar-ir.mjs';

const ir=compileToIR('pub fnc main(int a): int {return helper(a);} fnc helper(int b): int {return b;}');
const clone=()=>structuredClone(ir);

test('scalar IR prevents custom array map methods from executing during validation',()=>{
  const variants=[
    x=>x.functions,x=>x.functions[0].params,x=>x.functions[0].body.args
  ];
  for(const selector of variants){
    const malformed=clone();const arr=selector(malformed);
    let executions=0;
    Object.setPrototypeOf(arr,Object.create(Array.prototype,{
      map:{value(){executions++;return [];},configurable:true}
    }));
    assert.throws(()=>validateScalarIR(malformed),/invalid array size/);
    assert.equal(executions,0);
  }
  const malformed=clone();
  class Forged extends Array{map(){throw Error('unsafe map call');}}
  malformed.functions=new Forged(...malformed.functions);
  assert.throws(()=>compileIR(malformed),/invalid array size/);
});

test('scalar IR rejects noncanonical additional array keys and accessor holes',()=>{
  for(const selector of [
    x=>x.functions,x=>x.functions[0].params,x=>x.functions[0].body.args
  ]){
    const malformed=clone();
    selector(malformed).unexpected=true;
    assert.throws(()=>validateScalarIR(malformed),/unexpected array properties/);
  }
  const malformed=clone();
  let getterExecuted=false;
  Object.defineProperty(malformed.functions[0].body.args,'0',{
    configurable:true,enumerable:true,get(){
      getterExecuted=true;throw Error('getter executed');
    }
  });
  assert.throws(()=>validateScalarIR(malformed),/sparse or accessor array/);
  assert.equal(getterExecuted,false);
});

test('scalar IR numeric indexes reject minus zero before JSON serialization',()=>{
  const badCall=clone();
  badCall.functions[0].body.target=-0;
  assert.ok(Object.is(badCall.functions[0].body.target,-0));
  assert.throws(()=>compileIR(badCall),/out-of-range index/);
  const badParam=clone();
  badParam.functions[1].body.index=-0;
  assert.throws(()=>validateScalarIR(badParam),/out-of-range index/);
  const json=JSON.stringify(ir).replace('"target":1','"target":-0');
  assert.notEqual(json,JSON.stringify(ir));
  assert.throws(()=>validateScalarIR(JSON.parse(json)),/out-of-range index/);
  assert.equal(compileIR(ir),compileIR(structuredClone(ir)));
});
