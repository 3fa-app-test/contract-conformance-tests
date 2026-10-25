// Closed-world pure core linker for the experimental signed-i64 program-v2.
// It is intentionally NOT a general Oreslang import resolver or std linker.
// The caller supplies both complete source strings; no filesystem/network.
import {compileToProgramIRV2,compileProgramIRV2} from './program-v2.mjs';
import {checkFreestandingCore,FreestandingCoreError} from './freestanding-core.mjs';

const HEADER=/^import[ \t]+module[ \t]+core[ \t]+from[ \t]+"(core|std\/core)"[ \t]*;[ \t]*(?:\r?\n|$)/;
const MAX_COMBINED_BYTES=262144;

export function compileLinkedFreestandingCore({coreSource,appSource}) {
  if(typeof coreSource!=='string'||typeof appSource!=='string')
    throw new FreestandingCoreError('core and application sources must be strings');
  // One explicit import at the first byte, rather than magically importing
  // a standard library or scanning arbitrary comments for what looks like it.
  const match=HEADER.exec(appSource);
  if(!match)throw new FreestandingCoreError(
    'application must begin with import module core from "core"; (legacy "std/core" is accepted)');
  const userSource=appSource.slice(match[0].length);
  if(!userSource.trim())throw new FreestandingCoreError('empty application source');
  // All core source is independently checked before any application symbols
  // are admitted. Do not trust its name or directory path as proof of purity.
  checkFreestandingCore(coreSource);
  // Embed one already-validated core module in the same source compilation.
  // The standard program-v2 resolver now sees both sets of actual functions,
  // validates visibility, signature arities and call graph, and refuses host
  // calls or unknown imports. No runtime JS 'import' is introduced.
  const combined=coreSource+'\n'+userSource;
  if(new TextEncoder().encode(combined).length>MAX_COMBINED_BYTES)
    throw new FreestandingCoreError('combined source budget exceeded');
  const ir=compileToProgramIRV2(combined);
  if(ir.sourceNamespace!==null||ir.modules.length!==1||ir.modules[0]!=='core')
    throw new FreestandingCoreError('application may not declare another module or namespace');
  const coreIR=compileToProgramIRV2(coreSource);
  const count=coreIR.functions.length;
  if(ir.functions.length<=count || ir.functions.slice(0,count).some(f=>f.module!=='core') ||
     ir.functions.slice(count).some(f=>f.module!==null))
    throw new FreestandingCoreError('application may only declare pure file functions');
  if(!ir.functions.slice(count).some(f=>f.pub))
    throw new FreestandingCoreError('application requires a public entrypoint');
  return compileProgramIRV2(ir);
}

export function checkLinkedFreestandingCore(sources) {
  compileLinkedFreestandingCore(sources);
  return true;
}
