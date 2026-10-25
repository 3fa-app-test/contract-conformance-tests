import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,symlink,unlink,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {buildPackage} from '../src/build-package.mjs';
import {readVerifiedPackage} from '../src/package-admission.mjs';
import {invokeTrustedModule} from '../src/host-bridge.mjs';

// These are LOCAL FIXTURE hashes only, NOT independently trusted release approvals.
const SHA='a'.repeat(40);
const hash=x=>createHash('sha256').update(x).digest('hex');
async function fixture(fn){
  const dir=await mkdtemp(join(tmpdir(),'ores-pkg-audit-'));
  try{
    const source=join(dir,'app.ores'),dest=join(dir,'package');
    await writeFile(source,'pub fnc main(): int {return 20 + 22;}');
    const manifest=await buildPackage({sourceFile:source,outputDir:dest,declaredCompilerSha:SHA});
    const expect={
      directory:dest,target:'edge-js',
      expectedManifestSha256:hash(await readFile(join(dest,'manifest.json'))),
      expectedModuleSha256:manifest.moduleSha256,
      expectedSourceSha256:manifest.sourceSha256,
      expectedCompilerSha:SHA
    };
    await fn({dir,source,dest,manifest,expect});
  }finally{await rm(dir,{force:true,recursive:true});}
}
test('approved-test fixture bytes roundtrip and execute trusted scalar ESM',async()=>{
 await fixture(async({dest,manifest,expect})=>{
   const pkg=await readVerifiedPackage(expect);
   assert.deepEqual(pkg.manifest.publicEntrypoints,['main']);
   assert.equal(hash(Buffer.from(pkg.moduleBase64,'base64')),manifest.moduleSha256);
   const ns=await import(pathToFileURL(join(dest,'module.mjs')));
   assert.deepEqual(invokeTrustedModule(ns,{entry:'main',allowlist:pkg.manifest.publicEntrypoints,args:[]}),{type:'int64',value:'42'});
 });
});
test('wrong source, manifest or module trusted hashes are rejected',async()=>{
 await fixture(async({expect})=>{
   await assert.rejects(readVerifiedPackage({...expect,expectedSourceSha256:'0'.repeat(64)}),/trusted expectations/);
   await assert.rejects(readVerifiedPackage({...expect,expectedManifestSha256:'0'.repeat(64)}),/manifest digest mismatch/);
   await assert.rejects(readVerifiedPackage({...expect,expectedModuleSha256:'0'.repeat(64)}),/trusted expectations/);
 });
});
test('incorrect target is rejected even if package bytes match',async()=>{
 await fixture(async({expect})=>{
   await assert.rejects(readVerifiedPackage({...expect,target:'browser'}),/trusted expectations/);
 });
});
test('mutated module content is rejected against trusted expected hash',async()=>{
 await fixture(async({dest,expect})=>{
   await writeFile(join(dest,'module.mjs'),'export const main=()=>33n;');
   await assert.rejects(readVerifiedPackage(expect),/module digest mismatch/);
 });
});
test('symlink substituted for unchanged module bytes is rejected',async()=>{
 await fixture(async({dest,expect})=>{
   const moduleFile=join(dest,'module.mjs'),alternate=join(dest,'real.mjs');
   await writeFile(alternate,await readFile(moduleFile));
   await unlink(moduleFile);await symlink(alternate,moduleFile);
   await assert.rejects(readVerifiedPackage(expect),/package file inaccessible|non-symlink|bounded regular/);
 });
});
test('trusted manifest bytes must still be valid UTF-8',async()=>{
 await fixture(async({dest,expect})=>{
   const path=join(dest,'manifest.json');
   const raw=await readFile(path);
   const needle=Buffer.from('caller-declared');
   const at=raw.indexOf(needle);
   assert.ok(at>=0);
   const invalid=Buffer.from(raw);
   invalid[at]=0xff;
   await writeFile(path,invalid);
   await assert.rejects(readVerifiedPackage({
     ...expect,expectedManifestSha256:hash(invalid)
   }),/invalid package JSON or UTF-8/);
 });
});
test('two package builders cannot both publish the same directory',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ores-pkg-race-'));
 try{
   const source=join(dir,'source.ores'),dest=join(dir,'built');
   await writeFile(source,'pub fnc main(): int {return 42;}');
   const tasks=[0,1].map(()=>buildPackage({sourceFile:source,outputDir:dest,declaredCompilerSha:SHA}));
   const results=await Promise.allSettled(tasks);
   assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
   assert.equal(results.filter(x=>x.status==='rejected').length,1);
   assert.deepEqual(await readdir(dest),['manifest.json','module.mjs']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
