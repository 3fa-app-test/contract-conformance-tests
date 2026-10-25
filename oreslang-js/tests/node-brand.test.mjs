import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compile} from '../src/compiler.mjs';
import {invokeTrustedNodeModule} from '../src/host-bridge.node.mjs';

test('native brand accepts a real generated ESM namespace',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ores-node-brand-'));
  try{
    const file=join(dir,'module.mjs');
    await writeFile(file,compile('pub fnc main(): int {return 42;}'));
    const ns=await import(pathToFileURL(file).href);
    assert.deepEqual(invokeTrustedNodeModule(ns,{entry:'main',allowlist:['main'],args:[]}),{type:'int64',value:'42'});
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('native brand rejects frozen and tagged imitation of an ESM namespace',()=>{
  const fake=Object.create(null);
  Object.defineProperty(fake,Symbol.toStringTag,{value:'Module',configurable:false});
  Object.defineProperty(fake,'main',{value:()=>42n});
  Object.preventExtensions(fake);
  assert.throws(()=>invokeTrustedNodeModule(fake,{entry:'main',allowlist:['main'],args:[]}),
    /genuine ESM module namespace/);
});
