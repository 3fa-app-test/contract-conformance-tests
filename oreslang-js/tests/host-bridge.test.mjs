import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {compile} from '../src/compiler.mjs';
import {buildPackage} from '../src/build-package.mjs';
import {HOST_ABI,decodeInt64,encodeInt64,invokeTrustedModule} from '../src/host-bridge.mjs';

const i = value => ({type:'int64',value});
const SHA = 'a'.repeat(40);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixtureModule() {
  const dir = await mkdtemp(join(tmpdir(),'ores-bridge-'));
  const file = join(dir,'fixture.mjs');
  await writeFile(file,compile('pub fnc add(int a, int b): int {return a + b;} fnc private(): int {return 77;}'));
  return {dir, namespace:await import(pathToFileURL(file).href)};
}

test('JSON wire encoding preserves int64 precision and bounds',()=>{
 for(const v of [0n,42n,-7n,(1n<<63n)-1n,-(1n<<63n)]) {
   assert.equal(decodeInt64(JSON.parse(JSON.stringify(encodeInt64(v)))),v);
 }
 for(const bad of [i('01'),i('-0'),i('+1'),i('1.0'),i(' 2'),i('9223372036854775808'),i('-9223372036854775809'),i('9'.repeat(100)),{type:'int64',value:42},{type:'int64',value:'1',extra:true},null,42,[],{}]) {
   assert.throws(()=>decodeInt64(bad),/int64/);
 }
 assert.throws(()=>encodeInt64(42),/int64/);
});

test('trusted ES module boundary calls explicitly allowed public function',async()=>{
 const {dir,namespace} = await fixtureModule();
 try {
  assert.deepEqual(invokeTrustedModule(namespace,{entry:'add',allowlist:['add'],args:[i('40'),i('2')]}),i('42'));
  assert.throws(()=>invokeTrustedModule(namespace,{entry:'private',allowlist:['private'],args:[]}),/not a public function/);
  assert.throws(()=>invokeTrustedModule(namespace,{entry:'add',allowlist:['main'],args:[i('1'),i('2')]}),/not permitted/);
  assert.throws(()=>invokeTrustedModule(namespace,{entry:'add',allowlist:['add'],args:[i('1')]}),/arity mismatch/);
  assert.throws(()=>invokeTrustedModule(namespace,{entry:'add',allowlist:['add'],args:[i('1'),i('2'),i('3')]}),/arity mismatch/);
  assert.throws(()=>invokeTrustedModule({add(){return 1n;}},{entry:'add',allowlist:['add'],args:[]}),/module namespace/);
 }finally { await rm(dir,{recursive:true,force:true}); }
});

test('buildPackage creates manifest plus executable ESM for browser/edge',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ores-package-'));
 try{
   const source=join(dir,'app.ores'); const output=join(dir,'output');
   await writeFile(source,'pub fnc main(): int { return 20 + 22; }\n');
   const manifest=await buildPackage({sourceFile:source,outputDir:output,target:'edge-js',declaredCompilerSha:SHA});
   assert.equal(manifest.schemaVersion,1);assert.equal(manifest.hostABI,HOST_ABI);
   assert.deepEqual(manifest.publicEntrypoints,['main']);
   assert.deepEqual(manifest.declaredCapabilities,[]);
   const compiled=await readFile(join(output,'module.mjs'));
   assert.equal(digest(compiled),manifest.moduleSha256);
   assert.equal(digest(await readFile(source)),manifest.sourceSha256);
   const hostNamespace = await import(pathToFileURL(join(output,'module.mjs')).href);
   assert.deepEqual(invokeTrustedModule(hostNamespace,{entry:'main',allowlist:manifest.publicEntrypoints,args:[]}),i('42'));
   await assert.rejects(buildPackage({sourceFile:source,outputDir:output,target:'edge-js',declaredCompilerSha:SHA}),/overwrite/);
   const parsed=JSON.parse(await readFile(join(output,'manifest.json'),'utf8'));
   assert.deepEqual(parsed,manifest);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('package refuses unsupported target, revision, source and syntax without publishing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ores-package-negative-'));
 try{
   const source=join(dir,'bad.ores');const output=join(dir,'bad-out');
   await writeFile(source,'pub fnc main(): int { return nonexistent_symbol; }');
   await assert.rejects(buildPackage({sourceFile:source,outputDir:output,declaredCompilerSha:SHA}),/unresolved identifier/);
   await assert.rejects(buildPackage({sourceFile:source,outputDir:output,target:'nativex',declaredCompilerSha:SHA}),/unsupported JS host/);
   await assert.rejects(buildPackage({sourceFile:source,outputDir:output,declaredCompilerSha:'bad'}),/SHA/);
   await assert.rejects(readFile(join(output,'manifest.json')), {code:'ENOENT'});
   const badUtf=join(dir,'invalid-utf.ores');await writeFile(badUtf,Buffer.from([0xff,0xfe]));
   await assert.rejects(buildPackage({sourceFile:badUtf,outputDir:output,declaredCompilerSha:SHA}),/not valid|encoded|valid UTF-8/i);
   const symlinkPath=join(dir,'source-link.ores');await symlink(source,symlinkPath);
   await assert.rejects(buildPackage({sourceFile:symlinkPath,outputDir:output,declaredCompilerSha:SHA}),/regular (?:non-symlink )?file/);
 }finally {await rm(dir,{recursive:true,force:true});}
});

test('enforces bounded integer literals and compiler lowering depth',()=>{
 assert.throws(()=>compile('pub fnc main(): int {return '+ '0'.repeat(65) +';}'),/integer literal length limit/);
 assert.throws(()=>compile('pub fnc main(): int {return '+ ('1+'.repeat(1000)) +'1;}'),/expression limit exceeded|expression depth limit during lowering/);
});
