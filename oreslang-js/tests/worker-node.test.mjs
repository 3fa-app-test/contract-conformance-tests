import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnNodeActor} from '../src/actor-host.node.mjs';
import {compileProgramV2} from '../src/program-v2.mjs';

const moduleUrl = new URL('./fixtures/worker-handler.mjs',import.meta.url).href;
test('Node worker: explicit response and one-way delivery',async()=>{
  const actor=spawnNodeActor({moduleUrl});
  try {
    await actor.ready;
    assert.equal(await actor.request({type:'add',x:40n,y:2n}),42n);
    assert.equal(await actor.tell({type:'tell'}),undefined);
    assert.equal(actor.pending,0);
  } finally {await actor.close();}
});
test('Node worker: bounded FIFO and handler error recovery',async()=>{
  const actor=spawnNodeActor({moduleUrl,maxPending:2});
  try {
    const first=actor.request({type:'sleep',ms:60,n:1n});
    const next=actor.request({type:'add',x:40n,y:2n});
    await assert.rejects(actor.request({type:'add',x:1n,y:1n}),/capacity exceeded/);
    assert.deepEqual(await Promise.all([first,next]),[1n,42n]);
    await assert.rejects(actor.request({type:'missing-done'}),/self.done/);
    await assert.rejects(actor.request({type:'no-reply'}),/self.respond/);
    await assert.rejects(actor.request({type:'crash'}),/intentional handler error/);
    assert.equal(await actor.request({type:'add',x:1n,y:2n}),3n);
  } finally {await actor.close();}
});
test('Node worker: reject bad entrypoint and close pending',async()=>{
  const actor=spawnNodeActor({moduleUrl,exportName:'absent'});
  await assert.rejects(actor.ready,/entrypoint not found/);
  await assert.rejects(actor.request({type:'tell'}),/actor closed/);
  await actor.close();
  const other=spawnNodeActor({moduleUrl});
  const request=other.request({type:'sleep',ms:1000,n:0n});
  const expected=assert.rejects(request,/actor closed/);
  await other.close();
  await expected;
});
test('Oreslang program-v2 transpiles to a Node Worker callable ESM',async()=>{
  const source='pub fnc add(int x, int y) -> int :: return x+y; end';
  const dir=await mkdtemp(join(tmpdir(),'ores-js-actor-'));
  let actor;
  try {
    const output=join(dir,'generated.mjs');
    await writeFile(output,compileProgramV2(source),{mode:0o600});
    actor=spawnNodeActor({moduleUrl:pathToFileURL(output).href,exportName:'add',mode:'call'});
    await actor.ready;
    assert.equal(await actor.request({args:[40n,2n]}),42n);
    await assert.rejects(actor.request({args:[40,2n]}),/BigInt/);
    await assert.rejects(actor.request({args:[1n]}),/arity/);
    await assert.rejects(actor.request({args:[(1n<<63n)-1n,1n]}),/OVERFLOW/);
  } finally {if(actor)await actor.close();await rm(dir,{recursive:true,force:true});}
});
test('Node worker rejects non-file source and oversized mailbox configuration',()=>{
  assert.throws(()=>spawnNodeActor({moduleUrl:'data:text/javascript,export{}'}),/trusted file/);
  assert.throws(()=>spawnNodeActor({moduleUrl,maxPending:0}),/invalid mailbox limit/);
});

test('Node worker fails closed on CPU/GPU placement requests',()=>{
  assert.throws(
    ()=>spawnNodeActor({moduleUrl,placement:{cpuAffinity:'PREFER_SAME_CORE'}}),
    /cannot guarantee CPU\/GPU placement: placement/);
  assert.throws(
    ()=>spawnNodeActor({moduleUrl,cpuAffinity:'PREFER_SAME_CORE'}),
    /cannot guarantee CPU\/GPU placement: cpuAffinity/);
  assert.throws(
    ()=>spawnNodeActor({moduleUrl,accelerator:'GPU_REQUIRED',gpuDeviceId:'gpu0'}),
    /cannot guarantee CPU\/GPU placement: accelerator/);
});

test('Worker actor copy-only admission snapshots and forbids SAB',async()=>{
  const actor=spawnNodeActor({moduleUrl});
  try {
    const payload={n:1};
    const pending=actor.request({type:'echo',payload});
    payload.n=999;
    assert.deepEqual(await pending,{n:1});
    assert.deepEqual(await actor.request({type:'reply-snapshot'}),{n:1});
    if(typeof SharedArrayBuffer==='function') {
      await assert.rejects(
        actor.request({type:'echo',payload:new SharedArrayBuffer(8)}),/shared-memory/);
      await assert.rejects(
        actor.request({type:'echo',payload:new Map([['bad',new Uint8Array(new SharedArrayBuffer(8))]])}),/shared-memory/);
    }
  } finally {await actor.close();}
});
