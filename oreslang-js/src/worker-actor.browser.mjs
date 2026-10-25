import {installWorkerActorEndpoint} from './worker-actor-endpoint.mjs';
installWorkerActorEndpoint({
  subscribe: callback => self.addEventListener('message', e => callback(e.data)),
  post: frame => self.postMessage(frame)
});
