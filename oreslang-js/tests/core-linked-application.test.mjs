import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {compileLinkedFreestandingCore,checkLinkedFreestandingCore}
  from '../src/freestanding-core-link.mjs';
import {compileLinkedFreestandingCore as compileViaPublicExport}
  from '@oreslang/source-js/freestanding-core-link';

const corePath=resolve('tests/fixtures/freestanding-core-java.ores');
const appPath=resolve('tests/fixtures/core-linked-app.ores');
const read=async()=>({
  coreSource:await readFile(corePath,'utf8'),
  appSource:await readFile(appPath,'utf8')
});
const esmModule=async(input)=>import('data:text/javascript,'+
  encodeURIComponent(compileLinkedFreestandingCore(input)));
const app=(body,library='core')=>'import module core from "'+library+'";\n'+body;

test('Node runs a pure app statically linked against real Oreslang core',async()=>{
  const input=await read();
  assert.equal(checkLinkedFreestandingCore(input),true);
  assert.equal(compileViaPublicExport(input),compileLinkedFreestandingCore(input));
  const generated=compileLinkedFreestandingCore(input);
  assert.doesNotMatch(generated,/^\s*import\s/m);
  const mod=await esmModule(input);
  assert.deepEqual(Object.keys(mod).sort(),['core','large','sample']);
  assert.equal(Object.getPrototypeOf(mod.core),null);
  assert.ok(Object.isFrozen(mod.core));
  assert.equal(mod.sample(-4n),0n);
  assert.equal(mod.sample(2n),2n);
  assert.equal(mod.sample(12n),10n);
  assert.equal(mod.large(),9007199254740992n);
  assert.equal(mod.core.max_int(99n,3n),99n);
  assert.throws(()=>mod.sample(1),/BigInt/);
  assert.throws(()=>mod.sample(),/arity/);
  assert.throws(()=>mod.sample(1n<<63n),/OVERFLOW/);
});

test('explicit legacy std/core spelling links to same pure core without std authority',async()=>{
  const {coreSource,appSource}=await read();
  const legacy=appSource.replace('from "core";','from "std/core";');
  assert.equal(compileLinkedFreestandingCore({coreSource,appSource:legacy}),
    compileLinkedFreestandingCore({coreSource,appSource}));
});

test('imports are exact and hosted std cannot cross core boundary',async()=>{
  const {coreSource}=await read();
  for(const source of [
    'import module core from "std/fs";\npub fnc run(): int {return 0;}',
    'import module core from "../core";\npub fnc run(): int {return 0;}',
    'import module core from "std/core/../fs";\npub fnc run(): int {return 0;}',
    '// lookalike comment\nimport module core from "core";\npub fnc run(): int {return 0;}',
    'import module c from "core";\npub fnc run(): int {return 0;}',
    'import module core from "core";\nimport module fs from "std/fs";\npub fnc run(): int {return 0;}',
    app('pub fnc run(): int {return stdio.stdout.write(1);}'),
    app('pub fnc run(): int {return process.exit(1);}'),
    app('pub fnc run(): int {return core.does_not_exist();}'),
    app('define module core as pub fnc run(): int {return 1;} end'),
    app('define module http as pub fnc run(): int {return 1;} end'),
    app('namespace hosted; pub fnc run(): int {return 1;}'),
    app('fnc private_only(): int {return core.min_int(1,2);}'),
    app('pub fnc runaway(): int {return runaway();}')
  ]) assert.throws(()=>compileLinkedFreestandingCore({coreSource,appSource:source}),
    /error:/,source);
});

test('revalidate supplied core source; allow no implicit host, no arbitrary module',async()=>{
  const {coreSource,appSource}=await read();
  for(const corrupted of [
    'define module std as pub fnc foo():int{return 1;}end',
    'define module core as pub fnc foo():int{return process.clock();}end',
    'define module core as pub fnc foo():int{return stdio.stdout.write(1);}end',
    coreSource+'\ndefine module evil as pub fnc foo():int{return 1;}end'
  ]) assert.throws(()=>compileLinkedFreestandingCore({coreSource:corrupted,appSource}),/error:/);
});

test('CLI builds a linked application as a usable local ESM and rejects missing core',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'ores-linked-core-'));
  const cli=resolve('bin/oreslang-jsc.mjs');
  try {
    const out=join(folder,'app.mjs'),options=['--linked-core','--core='+corePath];
    const digest=createHash('sha256').update(await readFile(corePath)).digest('hex');
    const pinned=[...options,'--core-sha256='+digest];
    const checks=spawnSync(process.execPath,[cli,...pinned,'--check',appPath],{encoding:'utf8'});
    assert.equal(checks.status,0,checks.stderr);
    const generated=spawnSync(process.execPath,[cli,...pinned,appPath,'--out='+out],{encoding:'utf8'});
    assert.equal(generated.status,0,generated.stderr);
    const mod=await import(pathToFileURL(out).href);
    assert.equal(mod.sample(19n),10n);
    assert.equal(mod.large(),9007199254740992n);
    for(const badPin of ['0'.repeat(64),'BAD_SHA256']){
      const invalid=spawnSync(process.execPath,[cli,...options,
        '--core-sha256='+badPin,'--check',appPath],{encoding:'utf8'});
      assert.notEqual(invalid.status,0,'bad source pin must fail closed');
    }
    const noCore=spawnSync(process.execPath,[cli,'--linked-core',appPath],{encoding:'utf8'});
    assert.notEqual(noCore.status,0);
    const wrongProfile=spawnSync(process.execPath,[cli,'--freestanding-core','--check',appPath],{encoding:'utf8'});
    assert.notEqual(wrongProfile.status,0);
  } finally {await rm(folder,{recursive:true,force:true});}
});

test('bounded deterministic signed-i64 vectors verify whole-program core calls',async()=>{
  const mod=await esmModule(await read());
  for(let n=-1024n;n<=1024n;n++) {
    const value=mod.sample(n),expected=n<0n?0n:n>10n?10n:n;
    assert.equal(value,expected);
  }
});
