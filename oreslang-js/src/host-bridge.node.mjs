/** Node-specific stronger module namespace validation for trusted packages. */
import {types} from 'node:util';
import {HostBridgeError,invokeTrustedModule} from './host-bridge.mjs';

/**
 * Native brand check prevents user-created JS objects from posing as genuine
 * ESM module namespaces. It does NOT authenticate the module contents,
 * verify an artifact's digest, enforce isolation or prove source provenance.
 * Use read-only package admission, an immutable verified artifact and a
 * trusted loader BEFORE importing the module into this call.
 */
export function invokeTrustedNodeModule(namespace, options) {
  if (!types.isModuleNamespaceObject(namespace)) {
    throw new HostBridgeError('Node host requires genuine ESM module namespace');
  }
  return invokeTrustedModule(namespace,options);
}
