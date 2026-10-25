import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStrictJsonReport} from '../src/parity-json-strict.mjs';

const parse=text=>parseStrictJsonReport(text,262144,'Java');

test('accepts pretty reports, escaped strings, arrays and distinct nested keys',()=>{
  const source=' {"backend":"graal", "results":[ {"id":"a\\\"b", "observed_exit":42}, {"id":"a\\\"b", "observed_exit":43} ], "meta":{"id":"independent"}} ';
  assert.deepEqual(parse(source),JSON.parse(source));
});

test('rejects duplicate names anywhere, including escaped key aliases',()=>{
  for(const source of [
    '{"backend":"js","backend":"graal"}',
    '{"backend":"js","\\u0062ackend":"graal"}',
    '{"results":[{"id":"one","id":"two"}]}',
    '{"results":[{"meta":{"x":1,"x":2}}]}',
    '{"results":[{"meta":{"a\\u0022b":1,"a\\\"b":2}}]}',
    '{"results":[{"meta":{"\\uD83D\\uDE00":1,"😀":2}}]}'
  ])assert.throws(()=>parse(source),/duplicate JSON member/,source);
});

test('preserves size, invalid JSON, and depth/complexity budgets',()=>{
  assert.throws(()=>parseStrictJsonReport(3,10,'JS'),/missing or oversized/);
  assert.throws(()=>parseStrictJsonReport(' '.repeat(10),9,'JS'),/missing or oversized/);
  for(const source of ['{"a":}', '{"a":1,}', '[1,]','{'])
    assert.throws(()=>parse(source),/invalid JSON report/);
  assert.throws(()=>parse('['.repeat(65)+'0'+']'.repeat(65)),/depth or complexity exceeded/);
  const many='['+Array.from({length:20001},()=> '0').join(',')+']';
  assert.throws(()=>parse(many),/depth or complexity exceeded/);
});

test('accepts exact depth and value-count limits and rejects the next value',()=>{
  const depth64='['.repeat(64)+'0'+']'.repeat(64);
  assert.deepEqual(parse(depth64),JSON.parse(depth64));
  const maximum='['+Array(19999).fill('0').join(',')+']';
  assert.equal(parse(maximum).length,19999); // array itself is value 1
  assert.throws(()=>parse('['+Array(20000).fill('0').join(',')+']'),
    /depth or complexity exceeded/);
});

test('resource limits reject before full object-graph JSON parsing',()=>{
  const original=JSON.parse;
  let calls=0;
  const oversized=[
    '['.repeat(65)+'0'+']'.repeat(65),
    '['+Array(20000).fill('0').join(',')+']'
  ];
  try {
    JSON.parse=function(text,...rest){calls++;return original(text,...rest);};
    for(const source of oversized)
      assert.throws(()=>parse(source),/depth or complexity exceeded/);
    assert.equal(calls,0,'oversized arrays must not be materialized before admission');
  } finally {JSON.parse=original;}
});

test('rejects nonfinite numeric materialization and non-JSON lexical shortcuts',()=>{
  for(const source of ['1e999','-1e999','{"result":1e309}'])
    assert.throws(()=>parse(source),/non-finite JSON number/);
  for(const source of ['01','+1','.5','1.','[truefalse]','[1\u00a0]','[null:]'])
    assert.throws(()=>parse(source),/invalid JSON report/);
  for(const source of ['0','-0','1.25','-2.5e-10','true','false','null'])
    assert.deepEqual(parse(source),JSON.parse(source));
  for(const maximum of [NaN,Infinity,-1,1.5])
    assert.throws(()=>parseStrictJsonReport('{}',maximum,'JS'),/missing or oversized/);
});

test('byte admission counts UTF-8 bytes for Unicode and unpaired surrogates',()=>{
  for(const source of ['"😀"','"é"','"\ud800"']) {
    const bytes=Buffer.byteLength(source,'utf8');
    assert.deepEqual(parseStrictJsonReport(source,bytes,'JS'),JSON.parse(source));
    assert.throws(()=>parseStrictJsonReport(source,bytes-1,'JS'),/missing or oversized/);
  }
});

test('bounded seeded JSON round trips agree with the platform parser',()=>{
  let seed=0x5917c0de;
  const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  const strings=['','quote"','slash\\','line\nend','😀','é','\\u0061','__proto__'];
  const make=depth=>{
    const choice=next()%(depth?6:4);
    if(choice===0)return null;
    if(choice===1)return (next()&1)!==0;
    if(choice===2)return ((next()%20001)-10000)/8;
    if(choice===3)return strings[next()%strings.length];
    if(choice===4)return Array.from({length:next()%5},()=>make(depth-1));
    const result=Object.create(null);
    const length=next()%5;
    for(let i=0;i<length;i++)result['key-'+i+'-'+strings[next()%strings.length]]=make(depth-1);
    return result;
  };
  for(let i=0;i<512;i++) {
    const source=JSON.stringify(make(5));
    assert.deepEqual(parse(source),JSON.parse(source));
  }
});
