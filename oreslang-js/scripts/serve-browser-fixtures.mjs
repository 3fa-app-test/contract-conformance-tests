// Local-only browser fixture server. Never deploy this as a production host.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {extname,resolve,sep} from 'node:path';

const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const port=Number(process.env.ORES_BROWSER_FIXTURE_PORT??'8000');
if(!Number.isSafeInteger(port)||port<0||port>65535)
  throw new Error('invalid local fixture port');
const types={'.html':'text/html; charset=utf-8',
             '.mjs':'text/javascript; charset=utf-8',
             '.ores':'text/plain; charset=utf-8'};
const server=createServer(async(request,response)=>{
  try {
    if(request.method!=='GET'&&request.method!=='HEAD') {
      response.writeHead(405,{Allow:'GET, HEAD'});response.end();return;
    }
    const url=new URL(request.url,'http://localhost');
    const path=decodeURIComponent(url.pathname);
    // Serve just the code/tests needed by the local browser ESM fixtures.
    const file=resolve(root,path.startsWith('/')?path.slice(1):path);
    const ext=extname(file);
    if(!file.startsWith(root+sep)||!Object.hasOwn(types,ext)||
       !/^\/(?:src\/|tests\/)/.test(path)) {
      response.writeHead(403);response.end();return;
    }
    const content=await readFile(file);
    response.writeHead(200,{'Content-Type':types[ext],
      'Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff',
      // The fixture deliberately tests generated Blob ESM. CSP admits only
      // localhost scripts and their temporary generated module URL.
      'Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-inline' blob:; connect-src 'self'; worker-src 'self' blob:; style-src 'none'; base-uri 'none'; object-src 'none'"});
    response.end(request.method==='HEAD'?undefined:content);
  }catch(error){
    response.writeHead(error?.code==='ENOENT'?404:400);
    response.end();
  }
});
server.listen(port,'127.0.0.1',()=>{
  console.log('Local browser fixtures: http://127.0.0.1:'+server.address().port+'/tests/core-browser-smoke.html');
});
