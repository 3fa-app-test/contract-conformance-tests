// Real Chromium+Node browser regression; never substitutes an ESM-only mock.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const profile=await mkdtemp(join(tmpdir(),'ores-core-browser-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const server=createServer(async(request,response)=>{
  try {
    const url=new URL(request.url,'http://localhost');
    const pathname=decodeURIComponent(url.pathname);
    const file=resolve(root,pathname.startsWith('/')?pathname.slice(1):pathname);
    if(!file.startsWith(resolve(root)+sep)) {response.writeHead(403);response.end();return;}
    const contents=await readFile(file);
    response.setHeader('Cache-Control','no-store');
    response.setHeader('Content-Type',extname(file)==='.html'?'text/html; charset=utf-8':
      extname(file)==='.ores'?'text/plain; charset=utf-8':'text/javascript; charset=utf-8');
    response.end(contents);
  }catch{response.writeHead(404);response.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const chrome=spawn(process.env.CHROME_BIN||'google-chrome',[
  '--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run',
  '--disable-background-networking','--remote-debugging-port=0',
  '--user-data-dir='+profile,'about:blank'
],{stdio:'ignore'});
let exited=false,launchError=null,socket;
chrome.once('error',e=>{launchError=e;exited=true;});
chrome.once('exit',()=>{exited=true;});
try {
  let port;
  for(let tries=0;tries<90;tries++){
    if(exited)throw new Error('browser process unavailable: '+launchError);
    try {
      const data=await readFile(join(profile,'DevToolsActivePort'),'utf8');
      port=Number(data.split('\n')[0]);
      if(Number.isInteger(port)&&port>0)break;
    }catch{}
    await sleep(100);
  }
  if(!port)throw new Error('browser startup timed out');
  const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  const tab=tabs.find(t=>t.type==='page');
  if(!tab?.webSocketDebuggerUrl)throw new Error('no Chrome debugging page');
  socket=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    socket.addEventListener('open',resolve,{once:true});
    socket.addEventListener('error',()=>reject(Error('Chrome DevTools socket failed')),{once:true});
  });
  let seq=0;
  const jobs=new Map();
  socket.addEventListener('message',event=>{
    const packet=JSON.parse(event.data),job=jobs.get(packet.id);
    if(!job)return;
    jobs.delete(packet.id);
    if(packet.error)job.reject(Error(JSON.stringify(packet.error)));
    else job.resolve(packet.result);
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq;jobs.set(id,{resolve,reject});
    socket.send(JSON.stringify({id,method,params}));
  });
  await send('Page.enable');await send('Runtime.enable');
  await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/tests/core-browser-smoke.html'});
  let result='';
  for(let i=0;i<120;i++){
    await sleep(100);
    const evaluated=await send('Runtime.evaluate',{
      expression:"document.querySelector('#result')?.textContent",returnByValue:true
    });
    result=evaluated.result?.value||'';
    if(result.startsWith('PASS_')||result.startsWith('FAIL_'))break;
  }
  console.log('Freestanding core real browser ESM: '+(result||'<no result>'));
  if(result!=='PASS_BROWSER_FREESTANDING_CORE')throw Error('browser core test failed');
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  server.closeAllConnections();
  await new Promise(r=>server.close(r));
  if(!exited)await Promise.race([new Promise(r=>chrome.once('exit',r)),sleep(1500)]);
  await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}).catch(()=>{});
}

