import {copyOwnedValue} from './worker-actor-copy.mjs';
const PROTOCOL = 'ores.js.worker.v1';
const UNSUPPORTED_PLACEMENT_KEYS = Object.freeze([
  'placement','cpuAffinity','maxParallelTurns',
  'accelerator','gpuDeviceId','maxGpuInFlight'
]);

export function rejectUnsupportedWorkerPlacement(options) {
  if (!options || typeof options !== 'object')
    throw new TypeError('worker actor options must be an object');
  for (const key of UNSUPPORTED_PLACEMENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(options,key)) {
      throw new TypeError(
        'JavaScript Worker backend cannot guarantee CPU/GPU placement: ' + key);
    }
  }
}
export function createWorkerActorClient({worker, moduleUrl, exportName = 'receive', mode = 'handler', maxPending = 64}) {
  if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function')
    throw new TypeError('invalid Worker');
  if (typeof moduleUrl !== 'string' || !moduleUrl || typeof exportName !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(exportName) || !['handler','call'].includes(mode))
    throw new TypeError('invalid entrypoint');
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 65536)
    throw new RangeError('invalid mailbox limit');
  const pending = new Map();
  let nextId = 1, closed = false, ready = false;
  let readyResolve, readyReject;
  const readyPromise = new Promise((resolve,reject) => {readyResolve = resolve; readyReject = reject;});
  void readyPromise.catch(() => {}); // callers can await actor.ready explicitly
  function shutdown(error) {
    if (closed) return;
    closed = true;
    if (!ready) readyReject(error);
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  }
  function onFrame(frame) {
    if (closed || !frame || frame.protocol !== PROTOCOL) return;
    if (frame.kind === 'ready') {
      if (ready) {shutdown(new Error('duplicate actor ready'));void worker.terminate();return;}
      ready = true; readyResolve();
    } else if (frame.kind === 'fatal') {
      shutdown(new Error('actor startup/protocol failure: ' + String(frame.error).slice(0,512)));
      void worker.terminate();
    } else if (frame.kind === 'result') {
      const entry = pending.get(frame.id);
      if (!entry) {shutdown(new Error('unexpected actor response id'));void worker.terminate();return;}
      pending.delete(frame.id);
      if (frame.ok === true) entry.resolve(entry.reply ? frame.value : undefined);
      else if (frame.ok === false) entry.reject(new Error('actor delivery failed: '+String(frame.error).slice(0,512)));
      else {entry.reject(new Error('invalid actor response'));shutdown(new Error('invalid actor response'));void worker.terminate();}
    }
  }
  if (typeof worker.addEventListener === 'function') {
    worker.addEventListener('message', e => onFrame(e.data));
    worker.addEventListener('error', () => shutdown(new Error('worker execution failure')));
    worker.addEventListener('messageerror', () => shutdown(new Error('worker message decoding failure')));
  } else if (typeof worker.on === 'function') {
    worker.on('message', onFrame);
    worker.on('error', err => shutdown(new Error('worker execution failure: ' + String(err.message))));
    worker.on('exit', code => shutdown(new Error('worker exited: ' + code)));
  } else throw new TypeError('Worker event interface unsupported');
  try {worker.postMessage({protocol: PROTOCOL,kind:'init',moduleUrl,exportName,mode});}
  catch (error) {shutdown(error);void worker.terminate();}
  function send(value, reply) {
    if (closed) return Promise.reject(new Error('actor closed'));
    if (pending.size >= maxPending) return Promise.reject(new Error('actor mailbox capacity exceeded'));
    if (!Number.isSafeInteger(nextId)) return Promise.reject(new Error('actor message id exhausted'));
    // Take ownership at admission, not after the Worker startup handshake.
    // This prevents callers from mutating an outstanding queued delivery.
    let snapshot;
    try {
      snapshot = copyOwnedValue(value);
    } catch (error) {return Promise.reject(error);}
    const id = nextId++;
    return new Promise((resolve,reject) => {
      pending.set(id,{resolve,reject,reply});
      void readyPromise.then(() => {
        if (!pending.has(id) || closed) return;
        try {worker.postMessage({protocol:PROTOCOL,kind:'deliver',id,reply,value:snapshot});}
        catch (error) {pending.delete(id);reject(error);}
      },reject);
    });
  }
  return Object.freeze({
    get ready() {return readyPromise;},
    get pending() {return pending.size;},
    request(value) {return send(value,true);},
    tell(value) {return send(value,false);},
    async close() {shutdown(new Error('actor closed'));await worker.terminate();}
  });
}
