import {parentPort} from 'node:worker_threads';
import {installWorkerActorEndpoint} from './worker-actor-endpoint.mjs';
if (!parentPort) throw new Error('actor node worker requires parentPort');
installWorkerActorEndpoint({
  subscribe: callback => parentPort.on('message', callback),
  post: frame => parentPort.postMessage(frame)
});
