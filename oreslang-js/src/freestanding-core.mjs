// Host-neutral freestanding entrypoint for the verified pure integer core subset.
// Importing this module must never load Node, OS, filesystem or Worker adapters.
import {compileToProgramIRV2,compileProgramIRV2} from './program-v2.mjs';

export class FreestandingCoreError extends Error {
  constructor(message) {
    super('error: freestanding core: '+message);
    this.name='FreestandingCoreError';
  }
}

export function compileFreestandingCore(source) {
  const ir=compileToProgramIRV2(source);
  if(ir.sourceNamespace!==null || ir.modules.length!==1 || ir.modules[0]!=='core' ||
     !ir.functions.length || ir.functions.some(f=>f.module!=='core'||f.kind!=='fnc'))
    throw new FreestandingCoreError('requires one core module with pure integer functions only');
  // The validated program-v2 dialect has no imports, host access, FFI,
  // allocations, clocks, networking, OS handles, dynamic loaders or reflection.
  // This is a deliberately narrow *source-effect* admission proof, not a
  // general Oreslang core tier classifier or a JS no-GC guarantee.
  return compileProgramIRV2(ir);
}

export function checkFreestandingCore(source) {
  compileFreestandingCore(source);
  return true;
}

