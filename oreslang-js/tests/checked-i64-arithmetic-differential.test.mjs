import test from 'node:test';
import assert from 'node:assert/strict';
import {compileProgramV2} from '../src/program-v2.mjs';

const MIN=-(1n<<63n), MAX=(1n<<63n)-1n;
const DIRECTIVE='// oreslang:checked-i64-v1\n';
const SOURCE=DIRECTIVE+
  'pub fnc plus(int a,int b): int {return a+b;}\n'+
  'pub fnc minus(int a,int b): int {return a-b;}\n'+
  'pub fnc times(int a,int b): int {return a*b;}\n'+
  'pub fnc opposite(int a): int {return -a;}\n'+
  'pub fnc remainder(int a,int b): int {return a%b;}\n';

// Real backend codegen and real exported guest function invocations; the
// independent BigInt oracle below does not itself certify Java/LLVM parity.
async function guest(){
  const compiled=compileProgramV2(SOURCE);
  return import('data:text/javascript;charset=utf-8,'+encodeURIComponent(compiled));
}
function checked(n){return n>=MIN&&n<=MAX;}
function compareOperation(fn,label,expected,args){
  if(checked(expected))assert.equal(fn(...args),expected,label+' '+args);
  else assert.throws(()=>fn(...args),error=>
    error instanceof RangeError&&
    error.message.startsWith('ORES_I64_OVERFLOW:'),
    label+' overflow '+args);
}
function seededI64(){
  let state=0x19a57c42;
  const next=()=>{
    state^=state<<13;state^=state>>>17;state^=state<<5;
    return BigInt(state>>>0);
  };
  return ()=>BigInt.asIntN(64,(next()<<32n)|next());
}
test('linked JS checked-i64 add/sub/mul/neg agree with independent BigInt range oracle',async()=>{
  const ns=await guest();
  const next=seededI64();
  const boundaries=[MIN,MIN+1n,-3037000500n,-2n,-1n,0n,1n,2n,
    3037000499n,3037000500n,MAX-1n,MAX];
  let comparisons=0;
  // Entire Cartesian boundary grid: overflow and in-range neighbors.
  for(const a of boundaries)for(const b of boundaries){
    compareOperation(ns.plus,'add',a+b,[a,b]);
    compareOperation(ns.minus,'sub',a-b,[a,b]);
    compareOperation(ns.times,'mul',a*b,[a,b]);
    comparisons+=3;
  }
  for(const a of boundaries){
    compareOperation(ns.opposite,'neg',-a,[a]);
    comparisons++;
  }
  // Fresh full-domain values, deterministic regardless of runtime platform.
  for(let i=0;i<2048;i++){
    const a=next(),b=next();
    compareOperation(ns.plus,'add',a+b,[a,b]);
    compareOperation(ns.minus,'sub',a-b,[a,b]);
    compareOperation(ns.times,'mul',a*b,[a,b]);
    compareOperation(ns.opposite,'neg',-a,[a]);
    comparisons+=4;
  }
  assert.equal(comparisons,8636);
});
test('linked JS remainder honors signed-i64 boundaries and zero-denominator category',async()=>{
  const ns=await guest();
  for(const [a,b] of [[MIN,-1n],[MIN,1n],[MAX,MIN],[-7n,3n],
    [7n,-3n],[-7n,-3n],[0n,1n],[MAX,MAX]]){
    assert.equal(ns.remainder(a,b),a%b,'remainder '+a+' / '+b);
  }
  for(const left of [MIN,-1n,0n,1n,MAX]){
    assert.throws(()=>ns.remainder(left,0n),error=>
      error instanceof RangeError&&
      error.message.startsWith('ORES_I64_DIVISION_BY_ZERO:'),
      'zero denominator '+left);
  }
});
test('linked JS per-node failures cannot be masked by cancellation or modulo',async()=>{
  const ns=await guest();
  // Evaluation of a failing first argument must precede the later argument
  // and the callee; both overflow and zero-denominator must remain observable.
  const inline=compileProgramV2(DIRECTIVE+
    'pub fnc main(): int {return (9223372036854775807 + 1) - 1;}\n');
  const overflow=await import('data:text/javascript;charset=utf-8,'+encodeURIComponent(inline));
  assert.throws(()=>overflow.main(),/ORES_I64_OVERFLOW/);
  const mod=compileProgramV2(DIRECTIVE+
    'pub fnc main(): int {return (9223372036854775807 + 1) % 0;}\n');
  const modOverflow=await import('data:text/javascript;charset=utf-8,'+encodeURIComponent(mod));
  assert.throws(()=>modOverflow.main(),error=>
    error instanceof RangeError&&error.message.startsWith('ORES_I64_OVERFLOW:'));
  // Foreign values cannot evade operand checking on any exported function.
  assert.throws(()=>ns.plus(Number.MAX_SAFE_INTEGER,1n),error=>
    error instanceof TypeError&&
    error.message==='Oreslang signed i64 BigInt required');
  assert.throws(()=>ns.remainder(7,0n),error=>
    error instanceof TypeError&&
    error.message==='Oreslang signed i64 BigInt required');
  assert.throws(()=>ns.plus(MAX+1n,0n),error=>
    error instanceof RangeError&&
    error.message.startsWith('ORES_I64_OVERFLOW:'));
  assert.throws(()=>ns.times(MAX+1n,0n),/ORES_I64_OVERFLOW/);
});
