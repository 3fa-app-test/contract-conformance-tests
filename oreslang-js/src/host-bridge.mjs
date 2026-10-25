/** Pure, environment-independent ESM host bridge. NOT a security sandbox. */
export const HOST_ABI = 'oreslang-js-int64-v1';
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export class HostBridgeError extends Error {
  constructor(message) { super(message); this.name = 'HostBridgeError'; }
}

/** Reject oversized, lossy, noncanonical or out-of-range JSON int64 values. */
export function decodeInt64(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Reflect.ownKeys(value).length !== 2) {
    throw new HostBridgeError('invalid canonical int64 wire value');
  }
  const type = Object.getOwnPropertyDescriptor(value, 'type');
  const decimal = Object.getOwnPropertyDescriptor(value, 'value');
  // Never invoke getters or accessor properties on purported JSON data.
  if (!type || !decimal || !Object.hasOwn(type,'value') ||
      !Object.hasOwn(decimal,'value') || type.value !== 'int64' ||
      typeof decimal.value !== 'string' || decimal.value.length > 20 ||
      !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(decimal.value)) {
    throw new HostBridgeError('invalid canonical int64 wire value');
  }
  const v = BigInt(decimal.value);
  if (v < I64_MIN || v > I64_MAX) throw new HostBridgeError('int64 out of range');
  return v;
}

export function encodeInt64(value) {
  if (typeof value !== 'bigint' || value < I64_MIN || value > I64_MAX)
    throw new HostBridgeError('guest result is not a signed int64 BigInt');
  return {type:'int64', value:value.toString(10)};
}

/** The caller supplies JSON-like lists, never executable Array methods. */
function wireArray(value, maximum, label) {
  if(!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype ||
     value.length>maximum)throw new HostBridgeError('invalid '+label);
  const own=Reflect.ownKeys(value);
  if(own.length!==value.length+1)throw new HostBridgeError('invalid '+label);
  for(let i=0;i<value.length;i++){
    const desc=Object.getOwnPropertyDescriptor(value,String(i));
    if(!desc||!Object.hasOwn(desc,'value'))throw new HostBridgeError('invalid '+label);
  }
  return value;
}

/**
 * Invoke a reviewed and explicitly allowlisted ESM module namespace.
 * Host must import a trusted, pinned module in its own security boundary.
 * The namespace shape check catches accidental misuse, NOT forged objects:
 * JavaScript code can imitate its observable properties. Trust must come
 * from an independently verified immutable artifact and trusted host loader.
 * This adapter cannot execute untrusted code safely or establish isolation.
 */
export function invokeTrustedModule(namespace, {entry, allowlist, args} = {}) {
  if (!namespace || typeof namespace !== 'object' ||
      Object.prototype.toString.call(namespace) !== '[object Module]' ||
      Object.getPrototypeOf(namespace) !== null ||
      Object.isExtensible(namespace)) {
    throw new HostBridgeError('expected a trusted ESM module namespace');
  }
  if (typeof entry !== 'string' || !NAME.test(entry) ||
      !wireArray(allowlist,128,'entrypoint allowlist').includes(entry) ||
      allowlist.some(name => typeof name !== 'string' || !NAME.test(name))) {
    throw new HostBridgeError('entrypoint not permitted');
  }
  wireArray(args,128,'argument list');
  const decoded = args.map(decodeInt64);
  const desc = Object.getOwnPropertyDescriptor(namespace, entry);
  if (!desc || typeof desc.value !== 'function') throw new HostBridgeError('entrypoint is not a public function');
  // Generated scalar functions use explicit positional parameters. JS would
  // otherwise ignore extra arguments or fill missing arguments with undefined.
  if (desc.value.length !== decoded.length) throw new HostBridgeError('entrypoint arity mismatch');
  let result;
  try { result = desc.value(...decoded); }
  catch { throw new HostBridgeError('guest invocation failed'); }
  return encodeInt64(result);
}
