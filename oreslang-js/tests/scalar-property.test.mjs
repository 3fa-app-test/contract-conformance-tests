import test from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.mjs';

const wrap=v=>BigInt.asIntN(64,v);
function random(seed){
  let s=seed>>>0;
  return ()=>{
    s^=s<<13;s^=s>>>17;s^=s<<5;
    return (s>>>0);
  };
}
const edges=[
  0n,1n,-1n,2n,-2n,42n,-42n,
  (1n<<63n)-1n,-(1n<<63n),
  1234567890123456789n,-1234567890123456789n
];

test('250 deterministic property vectors: arithmetic, precedence, calls and signed i64 wrap',async()=>{
  const source=`
    pub fnc add(int a,int b): int { return a + b; }
    pub fnc sub(int a,int b): int { return a - b; }
    pub fnc mul(int a,int b): int { return a * b; }
    pub fnc rem(int a,int b): int { return a % b; }
    pub fnc nested(int a,int b): int { return add(mul(a,b), sub(a,b)); }
    pub fnc precedence(int a,int b): int { return a + b * a - b; }
  `;
  const moduleCode=compile(source);
  const ns=await import('data:text/javascript;base64,'+Buffer.from(moduleCode).toString('base64'));
  const next=random(0xc0ffee);
  function value(){
    if(next()%3===0)return edges[next()%edges.length];
    const high=BigInt(next()),low=BigInt(next());
    return BigInt.asIntN(64,(high<<32n)|low);
  }
  for(let i=0;i<250;i++){
    const a=value(),b=value();
    assert.equal(ns.add(a,b),wrap(a+b),'add iteration '+i);
    assert.equal(ns.sub(a,b),wrap(a-b),'sub iteration '+i);
    assert.equal(ns.mul(a,b),wrap(a*b),'mul iteration '+i);
    if(b!==0n) assert.equal(ns.rem(a,b),a%b,'rem iteration '+i);
    assert.equal(ns.nested(a,b),wrap(wrap(a*b)+wrap(a-b)),'nested iteration '+i);
    assert.equal(ns.precedence(a,b),wrap(wrap(a+wrap(b*a))-b),'precedence iteration '+i);
  }
});

test('compiler rejects disabled operations instead of silently changing numeric contracts',()=>{
  for(const snippet of [
    'pub fnc main(int a): int {return a / 2;}',
    'pub fnc main(): int {return 9223372036854775808;}',
    'pub fnc main(): int {return -9223372036854775809;}'
  ]) assert.throws(()=>compile(snippet),/error:/);
});
