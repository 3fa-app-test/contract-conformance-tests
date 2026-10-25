import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileToProgramIRV2, compileProgramV2, compileProgramIRV2} from '../src/program-v2.mjs';
import {validateProgramIRV2, PROGRAM_IR_INT_MODEL} from '../src/program-ir-v2.mjs';

const MIN=-(1n<<63n), MAX=(1n<<63n)-1n;
const model='signed-i64-checked-provisional';
const source=[
  'define module math as',
  'pub fnc add(int a,int b): int {return a+b;}',
  'pub fnc sub(int a,int b): int {return a-b;}',
  'pub fnc mul(int a,int b): int {return a*b;}',
  'pub fnc rem(int a,int b): int {return a%b;}',
  'pub fnc neg(int a): int {return -a;}',
  'pub fnc cancel(int a,int b): int {return a+b-b;}',
  'end'
].join('\n');

test('IR, JSON Schema, generated code and documentary model name agree',async()=>{
  assert.equal(PROGRAM_IR_INT_MODEL,model);
  const ir=compileToProgramIRV2(source);
  assert.equal(ir.integerModel,model);
  assert.equal(validateProgramIRV2(JSON.parse(JSON.stringify(ir))).integerModel,model);
  const schema=JSON.parse(await readFile(new URL('../schemas/program-ir-v2.schema.json',import.meta.url),'utf8'));
  assert.equal(schema.properties.integerModel.const,model);
  const old={...ir,integerModel:'signed-i64-wrap-provisional'};
  assert.throws(()=>validateProgramIRV2(old),/unsupported IR version\/dialect\/model/);
  assert.throws(()=>compileProgramIRV2(old),/unsupported IR version\/dialect\/model/);
  assert.equal(compileProgramIRV2(JSON.parse(JSON.stringify(ir))),compileProgramV2(source));
});

test('checked i64 ops reject actual overflows including cancelled intermediate overflow',async()=>{
  const ns=await import('data:text/javascript,'+encodeURIComponent(compileProgramV2(source)));
  assert.equal(ns.math.add(40n,2n),42n);
  assert.equal(ns.math.sub(MIN,0n),MIN);
  assert.equal(ns.math.mul(-1n,MAX),-MAX);
  assert.equal(ns.math.rem(MIN,-1n),0n);
  assert.throws(()=>ns.math.add(MAX,1n),/ORES_I64_OVERFLOW/);
  assert.throws(()=>ns.math.sub(MIN,1n),/ORES_I64_OVERFLOW/);
  assert.throws(()=>ns.math.mul(MAX,2n),/ORES_I64_OVERFLOW/);
  assert.throws(()=>ns.math.neg(MIN),/ORES_I64_OVERFLOW/);
  assert.throws(()=>ns.math.cancel(MAX,1n),/ORES_I64_OVERFLOW/);
  assert.throws(()=>ns.math.rem(1n,0n),RangeError);
  assert.throws(()=>ns.math.add(Number.MAX_SAFE_INTEGER,1n),/signed i64 BigInt required/);
});

test('deterministic i64 operation oracle rejects rather than wraps 1200 random vectors',async()=>{
  const ns=await import('data:text/javascript,'+encodeURIComponent(compileProgramV2(source)));
  let state=0x349b14ed;
  const rng=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
  const number=()=>BigInt.asIntN(64,(BigInt(rng())<<32n)|BigInt(rng()));
  const within=v=>v>=MIN&&v<=MAX;
  const ops=[
    {name:'add',expected:(a,b)=>a+b},
    {name:'sub',expected:(a,b)=>a-b},
    {name:'mul',expected:(a,b)=>a*b}
  ];
  let assertions=0;
  for(let i=0;i<400;i++){
    const a=number(),b=number();
    for(const op of ops){
      const result=op.expected(a,b);
      if(within(result)) assert.equal(ns.math[op.name](a,b),result);
      else assert.throws(()=>ns.math[op.name](a,b),/ORES_I64_OVERFLOW/);
      assertions++;
    }
  }
  assert.equal(assertions,1200);
});
