import test from 'node:test';
import assert from 'node:assert/strict';
import {compileProgramV2,compileToProgramIRV2,compileProgramIRV2} from '../src/program-v2.mjs';

const source=[
  'define module math as',
  'pub fnc zero(): int {return 9;}',
  'pub fnc identity(int n): int {return n;}',
  'pub fnc sum(int a,int b): int {return a+b;}',
  'pub fnc overloaded(): int {return 11;}',
  'pub fnc overloaded(int n): int {return n;}',
  'end',
  'pub fnc main(): int {return math.zero();}',
  'pub fnc one(int n): int {return n;}'
].join('\n');

test('singleton exports reject extra and missing arguments rather than relying on JS permissive arity',async()=>{
 const ns=await import('data:text/javascript,'+encodeURIComponent(compileProgramV2(source)));
 const fns=[[ns.math.zero,[]],[ns.math.identity,[42n]],[ns.math.sum,[20n,22n]],[ns.main,[]],[ns.one,[42n]]];
 for(const [f,args] of fns){
  assert.equal(typeof f,'function');
  const value=f(...args);
  assert.equal(typeof value,'bigint');
  assert.throws(()=>f(...args,7n),/overload arity mismatch/);
  if(args.length)assert.throws(()=>f(...args.slice(0,-1)),/overload arity mismatch/);
  else assert.throws(()=>f(7n),/overload arity mismatch/);
 }
 assert.equal(ns.math.zero(),9n);
 assert.equal(ns.math.sum(20n,22n),42n);
 assert.throws(()=>ns.math.identity(42),/signed i64 BigInt/);
});

test('multi-arity dispatch rejects invalid arity, while 0- and 1-arity branches work',async()=>{
 const ns=await import('data:text/javascript,'+encodeURIComponent(compileProgramV2(source)));
 assert.equal(ns.math.overloaded(),11n);
 assert.equal(ns.math.overloaded(42n),42n);
 assert.throws(()=>ns.math.overloaded(1n,2n),/overload arity mismatch/);
});

test('direct source compiler and serialized IR emitter produce identical safe exports',async()=>{
 const direct=compileProgramV2(source);
 const fromIR=compileProgramIRV2(JSON.parse(JSON.stringify(compileToProgramIRV2(source))));
 assert.equal(direct,fromIR);
 const ns=await import('data:text/javascript,'+encodeURIComponent(fromIR));
 assert.throws(()=>ns.one(1n,2n),/overload arity mismatch/);
});

test('exported checked i64 arithmetic rejects overflow instead of silently wrapping',async()=>{
 const checked=[
  'pub fnc add(): int {return 9223372036854775807+1;}',
  'pub fnc subtract(): int {return -9223372036854775807-2;}',
  'pub fnc multiply(): int {return 4611686018427387904*2;}',
  'pub fnc negate(): int {return -(-9223372036854775807-1);}'
 ].join('\n');
 const ns=await import('data:text/javascript,'+encodeURIComponent(compileProgramV2(checked)));
 for(const name of ['add','subtract','multiply','negate']){
  assert.throws(
   ()=>ns[name](),
   (error)=>error instanceof RangeError &&
     error.message==='ORES_I64_OVERFLOW: checked signed 64-bit overflow',
   name
  );
 }
 assert.equal((await import('data:text/javascript,'+encodeURIComponent(
  compileProgramV2('pub fnc safe(): int {return 9223372036854775807-1;}')))).safe(),
  9223372036854775806n);
});
