import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';

test('Node local fixture server exposes browser ESM inputs but not arbitrary repository files',async()=>{
  const script=resolve('scripts/serve-browser-fixtures.mjs');
  const child=spawn(process.execPath,[script],{
    env:{...process.env,ORES_BROWSER_FIXTURE_PORT:'0'},
    stdio:['ignore','pipe','pipe']
  });
  try {
    const url=await new Promise((resolveUrl,reject)=>{
      let data='';
      const onChunk=chunk=>{
        data+=chunk.toString();
        const match=data.match(/Local browser fixtures: (http:\/\/127\.0\.0\.1:\d+)\/tests\/core-browser-smoke\.html/);
        if(match)resolveUrl(match[1]);
      };
      child.stdout.on('data',onChunk);
      child.once('error',reject);
      child.once('exit',code=>reject(Error('fixture server exited '+code)));
    });
    for(const path of ['/tests/core-browser-smoke.html',
      '/tests/fixtures/freestanding-core-java.ores',
      '/tests/fixtures/core-linked-app.ores',
      '/src/freestanding-core-link.mjs']){
      const response=await fetch(url+path);
      assert.equal(response.status,200,path);
      assert.match(response.headers.get('content-type'),/text\/(?:html|javascript|plain)/);
      assert.match(response.headers.get('content-security-policy'),/connect-src 'self'/);
      assert.ok((await response.text()).length>10);
    }
    for(const bad of ['/package.json','/README.md','/.git/config',
      '/docs/FREESTANDING_CORE_BROWSER.md']){
      const response=await fetch(url+bad);
      assert.equal(response.status,403,bad);
    }
    const post=await fetch(url+'/tests/core-browser-smoke.html',{method:'POST'});
    assert.equal(post.status,405);
    const head=await fetch(url+'/src/freestanding-core.mjs',{method:'HEAD'});
    assert.equal(head.status,200);
    assert.equal(await head.text(),'');
  }finally{
    child.kill('SIGTERM');
  }
});
