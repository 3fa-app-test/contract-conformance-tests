import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, writeFile, rm, symlink, rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compile} from '../src/compiler.mjs';
import {buildPackage} from '../src/build-package.mjs';
import {admitPackage,PackageAdmissionError} from '../src/package-admission.mjs';
import {decodeInt64,invokeTrustedModule} from '../src/host-bridge.mjs';
const digest = data => createHash('sha256').update(data).digest('hex');
const SHA = 'a'.repeat(40);

test('int64 minimum is supported only through unary minus',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ores-min-'));
  try{
    const out=join(dir,'min.mjs');
    await writeFile(out,compile('pub fnc min(): int {return -9223372036854775808;}'));
    const ns=await import(pathToFileURL(out).href);
    assert.equal(ns.min(),-(1n<<63n));
    assert.throws(()=>compile('pub fnc main(): int {return 9223372036854775808;}'),/positive int outside signed i64/);
    assert.throws(()=>compile('pub fnc main(): int {return -9223372036854775809;}'),/positive int outside signed i64/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('wire decoder rejects accessors without invoking a getter',()=>{
  let called=false;
  const forged={type:'int64'};
  Object.defineProperty(forged,'value',{enumerable:true,get(){called=true;return '42';}});
  assert.throws(()=>decodeInt64(forged),/invalid canonical int64/);
  assert.equal(called,false);
  assert.throws(()=>decodeInt64({...{type:'int64',value:'42'},[Symbol.for('extra')]:true}),/invalid canonical int64/);
});

test('host bridge rejects an easily forged mutable Module-tagged object',()=>{
  const forged=Object.create(null);
  forged[Symbol.toStringTag]='Module';
  forged.add=(a,b)=>a+b;
  assert.throws(()=>invokeTrustedModule(forged,{
    entry:'add',allowlist:['add'],args:[{type:'int64',value:'1'},{type:'int64',value:'2'}]
  }),/expected a trusted ESM module namespace/);
});

test('exclusive directory reservation prevents concurrent package overwrite',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ores-race-'));
  try{
    const source=join(dir,'main.ores'),output=join(dir,'output');
    await writeFile(source,'pub fnc main(): int {return 42;}');
    const build=()=>buildPackage({sourceFile:source,outputDir:output,declaredCompilerSha:SHA});
    const results=await Promise.allSettled([build(),build()]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.filter(r=>r.status==='rejected').length,1);
    assert.match(results.find(r=>r.status==='rejected').reason.message,/refusing to overwrite/);
    assert.equal(JSON.parse(await readFile(join(output,'manifest.json'),'utf8')).module,'module.mjs');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('admission requires independent hashes and refuses corrupted or substituted packages',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ores-admission-'));
  try{
    const source=join(dir,'app.ores'),output=join(dir,'build');
    await writeFile(source,'pub fnc main(): int {return 20 + 22;}');
    const built=await buildPackage({sourceFile:source,outputDir:output,target:'browser',declaredCompilerSha:SHA});
    const pinned={
      directory:output,target:'browser',expectedCompilerSha:SHA,
      expectedSourceSha256:built.sourceSha256,expectedModuleSha256:built.moduleSha256,
      expectedManifestSha256:digest(await readFile(join(output,'manifest.json')))
    };
    const admitted=await admitPackage(pinned);
    assert.deepEqual(admitted.publicEntrypoints,['main']);
    assert.ok(Object.isFrozen(admitted));
    await assert.rejects(admitPackage({...pinned,expectedManifestSha256:'0'.repeat(64)}),/manifest digest mismatch/);
    await assert.rejects(admitPackage({...pinned,expectedSourceSha256:'0'.repeat(64)}),/trusted expectations/);
    await assert.rejects(admitPackage({...pinned,target:'edge-js'}),/trusted expectations/);
    const mod=join(output,'module.mjs');
    const saved=await readFile(mod);
    await writeFile(mod,Buffer.concat([saved,Buffer.from('\n// changed')]));
    await assert.rejects(admitPackage(pinned),/module digest mismatch/);
    await writeFile(mod,saved);
    const link=join(dir,'real-module.mjs');
    await rename(mod,link);
    await symlink(link,mod);
    await assert.rejects(admitPackage(pinned),/package file inaccessible|bounded regular (?:non-symlink )?file/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('UTF-8 BOM is admitted and invalid manifest trust inputs are rejected',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ores-bom-'));
  try{
    const source=join(dir,'bom.ores'),output=join(dir,'build');
    await writeFile(source,Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('pub fnc main(): int {return 42;}')]));
    const m=await buildPackage({sourceFile:source,outputDir:output,declaredCompilerSha:SHA});
    assert.equal(m.publicEntrypoints[0],'main');
    await assert.rejects(admitPackage({directory:output,target:'edge-js',expectedCompilerSha:SHA}),/missing or invalid trusted manifest digest/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('package rejects more entrypoints than host bridge supports',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ores-exports-'));
  try{
    const source=join(dir,'many.ores');
    await writeFile(source,Array.from({length:129},(_,i)=>'pub fnc f'+i+'(): int {return '+i+';}').join('\n'));
    await assert.rejects(buildPackage({sourceFile:source,outputDir:join(dir,'out'),declaredCompilerSha:SHA}),/unsupported public entrypoint count/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
