// Copy-only actor wire profile; no borrowed/transferable memory authority.
// structuredClone does not copy SharedArrayBuffer, so reject any such alias.
export function copyOwnedValue(value) {
  const snapshot=structuredClone(value);
  const seen=new WeakSet();
  let count=0;
  function check(node,depth) {
    if(node===null || typeof node!=='object')return;
    if(++count>8192 || depth>64)throw new RangeError('actor message complexity exceeded');
    if(typeof SharedArrayBuffer!=='undefined' &&
       (node instanceof SharedArrayBuffer ||
       (ArrayBuffer.isView(node) && node.buffer instanceof SharedArrayBuffer)))
      throw new TypeError('shared-memory actor message forbidden in copy-only profile');
    if(seen.has(node))return;
    seen.add(node);
    if(node instanceof Map)for(const [key,v] of node){check(key,depth+1);check(v,depth+1);}
    else if(node instanceof Set)for(const v of node)check(v,depth+1);
    else for(const key of Reflect.ownKeys(node)){
      const desc=Object.getOwnPropertyDescriptor(node,key);
      if(desc && Object.hasOwn(desc,'value'))check(desc.value,depth+1);
    }
  }
  check(snapshot,0);
  return snapshot;
}
