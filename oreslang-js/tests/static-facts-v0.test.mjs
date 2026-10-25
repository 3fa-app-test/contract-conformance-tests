import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {staticFactsV0} from '../src/static-facts-v0.node.mjs';

const src = 'pub fnc main():int{return add(40,2);} fnc add(int a,int b):int{return a+b;}';
test('actual validated scalar IR produces canonical unproved-call facts', () => {
  const d = staticFactsV0(src);
  assert.equal(d.version,'ores-static-facts/v0');
  assert.equal(d.unit,'sha256:'+createHash('sha256').update(Buffer.from(src)).digest('hex'));
  assert.deepEqual(d.procedures.map(p=>p.id),['__root__.add/2','__root__.main/0']);
  assert.deepEqual(d.edges,[{from:'__root__.main/0',to:'__root__.add/2',
    kind:'call',fanout:1,guard:'unproved'}]);
  for(const p of d.procedures) assert.deepEqual(p.loops,[]);
  for(const key of ['taint_sources','flows','sinks','permission_checks']) assert.deepEqual(d[key],[]);
});
test('fail closed on duplicated static callsites and unsupported source', () => {
  assert.throws(()=>staticFactsV0('fnc main():int{return f()+f();} fnc f():int{return 1;}'),
    /multiple callsites/);
  assert.throws(()=>staticFactsV0('fnc main():int{return missing(1);}'));
  assert.throws(()=>staticFactsV0('define actor Foo as end'));
  assert.throws(()=>staticFactsV0('define module demo as pub fnc main():int{return 1;} end'),
    /module namespace/);
  assert.throws(()=>staticFactsV0('\uFEFF'+src),/BOM/);
  assert.throws(()=>staticFactsV0(src+'\uD800'),/surrogate/);
  assert.throws(()=>staticFactsV0(src+'\0'),/NUL/);
});
test('real CLI uses exact admitted disk bytes and rejects BOM', async () => {
  const dir=await mkdtemp(join(tmpdir(),'ores-static-facts-'));
  try {
    const input=join(dir,'main.ores');
    await writeFile(input,src);
    const result=spawnSync(process.execPath,['bin/oreslang-jsc.mjs','--static-facts',input],
      {encoding:'utf8',cwd:new URL('..',import.meta.url).pathname});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),staticFactsV0(src));
    await writeFile(input,Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(src)]));
    const refused=spawnSync(process.execPath,['bin/oreslang-jsc.mjs','--static-facts',input],
      {encoding:'utf8',cwd:new URL('..',import.meta.url).pathname});
    assert.notEqual(refused.status,0);
    assert.match(refused.stderr,/BOM/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
