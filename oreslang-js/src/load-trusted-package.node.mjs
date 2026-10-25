/** Node trusted loader: import exact independently pinned bytes, not a mutable path. */
import {readVerifiedPackage,PackageAdmissionError} from './package-admission.mjs';
import {invokeTrustedNodeModule} from './host-bridge.node.mjs';

/**
 * Only for independently approved, trusted compiler outputs. The imported JS
 * executes with the Node process's privileges. This is NOT an untrusted sandbox.
 *
 * Importing a data URL from the previously verified byte snapshot closes the
 * verification-to-reopen path race. A caller must still independently approve
 * compiler provenance and artifact hashes before invoking this function.
 */
export async function loadTrustedNodePackage(options){
  const {manifest,moduleBase64}=await readVerifiedPackage(options);
  const specifier='data:text/javascript;base64,'+moduleBase64;
  const namespace=await import(specifier);
  const actual=Object.getOwnPropertyNames(namespace).sort();
  const declared=[...manifest.publicEntrypoints].sort();
  if(actual.length!==declared.length || actual.some((name,i)=>name!==declared[i])){
    throw new PackageAdmissionError('module exports do not match reviewed manifest');
  }
  for(const entry of declared){
    if(typeof Object.getOwnPropertyDescriptor(namespace,entry)?.value!=='function')
      throw new PackageAdmissionError('reviewed entrypoint is not a function');
  }
  return Object.freeze({
    manifest,
    invoke(entry,args){
      return invokeTrustedNodeModule(namespace,{entry,args,allowlist:declared});
    }
  });
}
