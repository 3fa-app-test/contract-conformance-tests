import test from 'node:test';
import assert from 'node:assert/strict';
import {compileProgramIRV2,compileToProgramIRV2} from '../src/program-v2.mjs';
import {validateProgramIRV2} from '../src/program-ir-v2.mjs';

const input=[
 'define module math',
 'fnc secret(): int {return 1;}',
 'pub fnc add(int a,int b): int {return a+b;}',
 'end',
 'pub fnc main(): int {return math.add(40,2);}'
].join('\n');
const canonical=compileToProgramIRV2(input);
const lit=()=>({kind:'int',value:'1'});
const arm=value=>({value,body:lit()});
const cases=[
 x=>{x.schemaVersion=999;},
 x=>{x.sourceNamespace='bad.dotted';},
 x=>{x.modules.push('math');},
 x=>{x.modules[0]='bad.name';},
 x=>{x.badProperty=true;},
 x=>{x.functions[0].module='missing';},
 x=>{x.functions[0].kind='routine';x.functions[0].pub=true;},
 x=>{x.functions[2].body={kind:'call',target:0,args:[]};},
 x=>{x.functions[2].body={kind:'call',target:1,args:[]};},
 x=>{x.functions[2].body={kind:'param',index:0};},
 x=>{x.functions[2].body={kind:'int',value:'01'};},
 x=>{x.functions[2].body={kind:'int',value:'9223372036854775808'};},
 x=>{x.functions[2].body={kind:'binary',op:'/',left:lit(),right:lit()};},
 x=>{x.functions[2].body={kind:'call',target:2,args:[]};},
 x=>{x.functions[1].params=['a','a'];},
 x=>{x.functions.push({...x.functions[0]});},
 x=>{x.functions.push({...x.functions[2],kind:'routine',params:['a']});},
 x=>{x.functions[2].name='math';},
 x=>{x.functions[2].body={kind:'match',subject:lit(),arms:[arm('1')]};},
 x=>{x.functions[2].body={kind:'match',subject:lit(),arms:[arm('1'),arm('1'),arm(null)]};},
 x=>{x.functions[2].body={kind:'match',subject:lit(),arms:[arm(null),arm('2')]};},
 x=>{x.functions[2].body={kind:'call',target:999,args:[]};},
 x=>{x.functions[2].body={kind:'host',name:'process'};},
 x=>{x.functions[2].body.extra=true;},
 x=>{x.functions[2].body={kind:'int',value:'-0'};}
];

test('25 hostile serialized IR transformations rejected across 20 iterations',()=>{
 const source=JSON.stringify(canonical);
 let count=0;
 for(let repeat=0;repeat<20;repeat++)for(let i=0;i<cases.length;i++){
   const invalid=JSON.parse(source);
   cases[i](invalid);
   assert.throws(()=>compileProgramIRV2(invalid),/error: program IR:/,'mutation '+i);
   count++;
 }
 assert.equal(count,500);
 assert.equal(JSON.stringify(canonical),source);
});

test('IR rejects prototype/accessor/symbol/array extension without invoking getters',()=>{
 const copy=()=>JSON.parse(JSON.stringify(canonical));
 const getter=copy();let calls=0;
 Object.defineProperty(getter.functions[0].body,'value',
   {get(){calls++;throw Error('unexpected invocation');},enumerable:true});
 assert.throws(()=>validateProgramIRV2(getter),/accessor/);
 assert.equal(calls,0);
 const symbol=copy();symbol.functions[0].body[Symbol.for('extra')]=1;
 assert.throws(()=>validateProgramIRV2(symbol),/missing\/extra fields/);
 const array=copy();array.modules.hidden='extra';
 assert.throws(()=>validateProgramIRV2(array),/unexpected array properties/);
 const proto=Object.assign(Object.create({injected:true}),copy());
 assert.throws(()=>validateProgramIRV2(proto),/non-plain object/);
});

test('valid JSON IR emits byte-identical JavaScript after repeated revalidation',()=>{
 const expected=compileProgramIRV2(canonical);
 const serialized=JSON.stringify(canonical);
 for(let i=0;i<75;i++){
  const verified=validateProgramIRV2(JSON.parse(serialized));
  assert.equal(compileProgramIRV2(verified),expected);
  assert.equal(JSON.stringify(verified),serialized);
 }
});
