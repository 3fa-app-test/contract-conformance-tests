import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
const cli=resolve('bin/oreslang-jsc.mjs');
const fixture=resolve('tests/fixtures/arithmetic.ores');
const invoke=args=>new Promise((ok,fail)=>{
 const p=spawn(process.execPath,[cli,...args],{stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 p.stdout.on('data',v=>stdout+=v.toString());
 p.stderr.on('data',v=>stderr+=v.toString());
 p.on('error',fail);
 p.on('close',code=>ok({code,stdout,stderr}));
});

test('atomic --out publishes executable ESM and never replaces an existing destination',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ores-cli-atomic-'));
 try{
   const dest=join(dir,'out.mjs');
   const one=await invoke([fixture,'--out='+dest]);
   assert.equal(one.code,0,one.stderr);
   const mod=await import(pathToFileURL(dest).href);
   assert.equal(mod.main(),42n);
   const original=await readFile(dest,'utf8');
   assert.equal((await stat(dest)).mode & 0o777,0o600);
   const two=await invoke([fixture,'--out='+dest]);
   assert.notEqual(two.code,0);
   assert.equal(await readFile(dest,'utf8'),original);
   assert.deepEqual(await readdir(dir),['out.mjs']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('simultaneous writers cannot overwrite each other',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ores-cli-race-'));
 try{
   const dest=join(dir,'out.mjs');
   const results=await Promise.all([invoke([fixture,'--out='+dest]),invoke([fixture,'--out='+dest])]);
   assert.deepEqual(results.map(r=>r.code).sort((a,b)=>a-b),[0,1]);
   assert.equal((await import(pathToFileURL(dest).href)).main(),42n);
   assert.deepEqual(await readdir(dir),['out.mjs']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('failed parsing leaves no output or temporary file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ores-cli-negative-'));
 try{
   const input=join(dir,'bad.ores'),dest=join(dir,'out.mjs');
   await writeFile(input,'pub fnc main(): int { return unknown_symbol; }');
   const result=await invoke([input,'--out='+dest]);
   assert.notEqual(result.code,0);
   assert.match(result.stderr,/unresolved identifier unknown_symbol/);
   assert.deepEqual(await readdir(dir),['bad.ores']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('rejects symbolic-link source input',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ores-cli-symlink-'));
 try{
   const link=join(dir,'source.ores');
   await symlink(fixture,link);
   const result=await invoke(['--check',link]);
   assert.notEqual(result.code,0);
   assert.match(result.stderr,/regular non-symlink/);
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('CLI rejects malformed UTF-8 including invalid bytes hidden in comments',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ores-cli-utf8-'));
 try{
   const source=join(dir,'bad.ores'),dest=join(dir,'compiled.mjs');
   const prefix=Buffer.from('// comment ');
   const suffix=Buffer.from('\npub fnc main(): int { return 42; }\n');
   await writeFile(source,Buffer.concat([prefix,Buffer.from([0xff]),suffix]));
   const checked=await invoke(['--check',source]);
   assert.notEqual(checked.code,0);
   const compiled=await invoke([source,'--out='+dest]);
   assert.notEqual(compiled.code,0);
   assert.deepEqual((await readdir(dir)).sort(),['bad.ores']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('CLI rejects oversized real files and relative --out paths',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ores-cli-limits-'));
 try{
   const input=join(dir,'large.ores');
   await writeFile(input,' '.repeat(262145));
   const oversized=await invoke(['--check',input]);
   assert.notEqual(oversized.code,0);
   assert.match(oversized.stderr,/262144/);
   const relative=await invoke([fixture,'--out=relative-output.mjs']);
   assert.notEqual(relative.code,0);
   assert.match(relative.stderr,/absolute destination path/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
