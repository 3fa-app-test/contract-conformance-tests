import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPackage} from '../src/build-package.mjs';
import {readVerifiedPackage} from '../src/package-admission.mjs';
import {loadTrustedNodePackage} from '../src/load-trusted-package.node.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const compilerSHA = 'c'.repeat(40);

async function specimen(){
  const root=await mkdtemp(join(tmpdir(),'ores-pinned-'));
  const sourceFile=join(root,'main.ores'),directory=join(root,'pkg');
  await writeFile(sourceFile,'pub fnc main(): int {return 40 + 2;}\n');
  const m=await buildPackage({sourceFile,outputDir:directory,target:'edge-js',declaredCompilerSha:compilerSHA});
  const options={
    directory, target:'edge-js',
    expectedManifestSha256:sha(await readFile(join(directory,'manifest.json'))),
    expectedModuleSha256:m.moduleSha256,
    expectedSourceSha256:m.sourceSha256,
    expectedCompilerSha:compilerSHA
  };
  return {root,directory,options};
}

test('Node loader executes a pinned generated Oreslang ESM module',async()=>{
  const p=await specimen();
  try{
    const host=await loadTrustedNodePackage(p.options);
    assert.deepEqual(host.manifest.publicEntrypoints,['main']);
    assert.deepEqual(host.invoke('main',[]),{type:'int64',value:'42'});
    assert.throws(()=>host.invoke('hidden',[]),/not permitted/);
    assert.throws(()=>host.invoke('main',[{type:'int64',value:'4'}]),/arity mismatch/);
  }finally{await rm(p.root,{recursive:true,force:true});}
});

test('verified bytes remain fixed even if the filesystem path later changes',async()=>{
  const p=await specimen();
  try{
    const pinned=await readVerifiedPackage(p.options);
    assert.equal(pinned.manifest.moduleSha256,p.options.expectedModuleSha256);
    await writeFile(join(p.directory,'module.mjs'),'export function main(){return 777n;}\n');
    const loaded=await import('data:text/javascript;base64,'+pinned.moduleBase64);
    assert.equal(loaded.main(),42n);
    await assert.rejects(loadTrustedNodePackage(p.options),/module digest mismatch/);
  }finally{await rm(p.root,{recursive:true,force:true});}
});

test('unapproved manifest pins, symlinks and incorrect exports fail closed',async()=>{
  const p=await specimen();
  try{
    await assert.rejects(loadTrustedNodePackage({...p.options,expectedManifestSha256:'0'.repeat(64)}),/manifest digest mismatch/);
    const modulePath=join(p.directory,'module.mjs');
    const original=await readFile(modulePath);
    const tampered=Buffer.concat([original,Buffer.from('\nexport const unexpected=1;\n')]);
    await writeFile(modulePath,tampered);
    const manifestPath=join(p.directory,'manifest.json');
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    manifest.moduleSha256=sha(tampered);
    await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
    const changed={
      ...p.options,
      expectedManifestSha256:sha(await readFile(manifestPath)),
      expectedModuleSha256:manifest.moduleSha256
    };
    await assert.rejects(loadTrustedNodePackage(changed),/module exports do not match reviewed manifest/);
    await rm(modulePath);
    const backing=join(p.root,'backing.mjs');
    await writeFile(backing,original);
    await symlink(backing,modulePath);
    await assert.rejects(readVerifiedPackage(changed),/package file inaccessible|non-symlink|bounded regular/);
  }finally{await rm(p.root,{recursive:true,force:true});}
});

test('package self-reference exports the exact-byte Node loader',async()=>{
  const mod=await import('@oreslang/source-js/load-trusted-package.node');
  assert.equal(typeof mod.loadTrustedNodePackage,'function');
});
