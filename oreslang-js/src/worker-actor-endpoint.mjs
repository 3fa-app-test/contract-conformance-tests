import {copyOwnedValue} from './worker-actor-copy.mjs';
// Trusted host reference adapter, NOT general Oreslang actor lowering or a sandbox.
// One serial execution lane per Worker. Reply requires respond() then done().
const PROTOCOL = 'ores.js.worker.v1';
const errorText = e => String(e?.message ?? e).slice(0, 512);
export function installWorkerActorEndpoint({subscribe, post}) {
  let initialized = false, initializing = false, receive = null;
  let processing = false;
  const queue = [];
  const reply = frame => post({protocol: PROTOCOL, ...frame});
  async function drain() {
    if (processing || !receive) return;
    processing = true;
    try {
      while (queue.length) {
        const frame = queue.shift();
        let completed = false, claimed = false, response;
        const self = Object.freeze({
          respond(value) {
            if (completed || claimed || !frame.reply) throw new Error('reply unavailable or already claimed');
            // Snapshot the owned response when claimed; later handler
            // mutation must not change what the requester receives.
            response = copyOwnedValue(value);
            claimed = true;
          },
          done() {
            if (completed) throw new Error('delivery already completed');
            completed = true;
          }
        });
        try {
          await receive(frame.value, self);
          if (!completed) throw new Error('actor handler must call self.done()');
          if (frame.reply && !claimed) throw new Error('request completed without self.respond()');
          reply({kind: 'result', id: frame.id, ok: true, value: frame.reply ? response : null});
        } catch (error) {
          reply({kind: 'result', id: frame.id, ok: false, error: errorText(error)});
        } finally {
          completed = true;
        }
      }
    } finally { processing = false; }
  }
  subscribe(async frame => {
    if (!frame || frame.protocol !== PROTOCOL) return;
    if (frame.kind === 'init') {
      if (initializing || initialized) {reply({kind:'fatal',error:'duplicate initialization'});return;}
      initializing = true;
      try {
        if (typeof frame.moduleUrl !== 'string' || !frame.moduleUrl ||
            typeof frame.exportName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(frame.exportName) ||
            !['handler','call'].includes(frame.mode)) throw new Error('invalid actor module descriptor');
        const module = await import(frame.moduleUrl);
        const fn = Object.getOwnPropertyDescriptor(module, frame.exportName)?.value;
        if (typeof fn !== 'function') throw new Error('actor entrypoint not found');
        receive = frame.mode === 'handler' ? fn : (mail, self) => {
          if (!mail || !Array.isArray(mail.args) || mail.args.length > 128)
            throw new Error('invalid call arguments');
          const result = fn(...mail.args);
          if (result && typeof result.then === 'function') throw new Error('async function ABI unsupported');
          self.respond(result);
          self.done();
        };
        initialized = true;
        reply({kind: 'ready'});
      } catch (error) {reply({kind:'fatal',error:errorText(error)});}
    } else if (frame.kind === 'deliver') {
      if (!initialized || !Number.isSafeInteger(frame.id) || frame.id < 1 ||
          typeof frame.reply !== 'boolean') {
        reply({kind:'fatal',error:'invalid or premature delivery'});
        return;
      }
      queue.push(frame); void drain();
    }
  });
}
