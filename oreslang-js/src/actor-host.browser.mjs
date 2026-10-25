import {createWorkerActorClient,rejectUnsupportedWorkerPlacement} from './worker-actor-client.mjs';
export function spawnBrowserActor(options) {
  rejectUnsupportedWorkerPlacement(options);
  const {moduleUrl, exportName = 'receive', mode = 'handler',
    maxPending = 64, WorkerCtor = globalThis.Worker} = options;
  if (typeof WorkerCtor !== 'function') throw new Error('module Web Workers unavailable');
  const url = new URL(moduleUrl, globalThis.location?.href);
  // By default, allow only same-origin trusted modules (including same-origin blobs).
  if (!['https:', 'http:', 'blob:'].includes(url.protocol) || url.origin !== globalThis.location?.origin)
    throw new TypeError('browser actor module must be same-origin http(s) or blob URL');
  const worker = new WorkerCtor(new URL('./worker-actor.browser.mjs', import.meta.url), {type:'module'});
  try {return createWorkerActorClient({worker,moduleUrl:url.href,exportName,mode,maxPending});}
  catch (error) {void worker.terminate();throw error;}
}
