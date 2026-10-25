/**
 * Experimental method-only JS multi-inheritance lowering helper.
 * This does NOT implement Oreslang constructors, fields, statics or super.
 * It makes inherited-slot conflicts explicit and uses runtime nominal brands
 * instead of incorrectly equating Oreslang inheritance with JS instanceof.
 */
export class InheritancePlanError extends Error {
  constructor(message) {
    super('error: multiple inheritance: ' + message);
    this.name = 'InheritancePlanError';
  }
}
const fail = m => {throw new InheritancePlanError(m);};
const ID = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_CLASSES = 128, MAX_METHODS = 256;
const brands = new WeakMap();

function plainDataObject(value,keys,context) {
  if(!value || typeof value!=='object' || Array.isArray(value))fail('invalid '+context);
  const proto=Object.getPrototypeOf(value);
  if(proto!==Object.prototype && proto!==null)fail('non-plain '+context);
  const actual=Reflect.ownKeys(value);
  if(actual.length!==keys.length || actual.some(k=>typeof k!=='string'||!keys.includes(k)))fail('unexpected fields in '+context);
  for(const k of keys){
    const desc=Object.getOwnPropertyDescriptor(value,k);
    if(!desc || !Object.hasOwn(desc,'value'))fail('accessor or missing field in '+context);
  }
  return value;
}
function dataArray(value,max,context) {
  if(!Array.isArray(value)||value.length>max)fail('invalid '+context+' array');
  for(let i=0;i<value.length;i++){
    const desc=Object.getOwnPropertyDescriptor(value,i);
    if(!desc||!Object.hasOwn(desc,'value'))fail('sparse/accessor '+context+' array');
  }
  return value;
}

function validate(definitions) {
  dataArray(definitions,MAX_CLASSES,'class graph');
  if (!definitions.length) fail('invalid class graph size');
  const byName = new Map();
  for (const def of definitions) {
    plainDataObject(def,['name','parents','methods','fields'],'class definition');
    if (typeof def.name !== 'string' || !ID.test(def.name)) fail('invalid class definition');
    if (byName.has(def.name)) fail('duplicate class ' + def.name);
    dataArray(def.parents,MAX_CLASSES,'parents');
    dataArray(def.methods,MAX_METHODS,'methods');
    dataArray(def.fields,MAX_METHODS,'fields');
    const seen = new Set(), local = new Set();
    for (const parent of def.parents) {
      if (typeof parent !== 'string' || !ID.test(parent) || seen.has(parent)) {
        fail('duplicate or invalid parent in ' + def.name);
      }
      seen.add(parent);
    }
    for (const f of def.fields) {
      if (typeof f !== 'string' || !ID.test(f) || local.has(f)) fail('duplicate/invalid field in ' + def.name);
      local.add(f);
    }
    local.clear();
    for (const method of def.methods) {
      plainDataObject(method,['name','arity','pub','impl'],'method');
      if (typeof method.name !== 'string' ||
          !ID.test(method.name) || method.name === 'constructor' ||
          !Number.isInteger(method.arity) || method.arity < 0 || method.arity > 128 ||
          typeof method.pub !== 'boolean' || typeof method.impl !== 'function') fail('invalid method in ' + def.name);
      const slot = method.name + '/' + method.arity;
      if (local.has(slot)) fail('duplicate method slot ' + slot + ' in ' + def.name);
      local.add(slot);
    }
    byName.set(def.name,def);
  }
  for(const def of definitions)for(const name of def.parents)if(!byName.has(name))fail('unknown parent '+name);
  const visiting = new Set(), completed = new Set(), ancestry = new Map();
  function visit(name) {
    if(visiting.has(name)) fail('inheritance cycle at '+name);
    if(completed.has(name)) return ancestry.get(name);
    visiting.add(name);
    const all=new Set();
    for(const p of byName.get(name).parents) {
      all.add(p);
      for(const a of visit(p)) all.add(a);
    }
    visiting.delete(name);completed.add(name);
    ancestry.set(name,all);
    return all;
  }
  for(const def of definitions)visit(def.name);
  return {byName,ancestry};
}

// Compute a deterministic method/field proof for a class.
// No priority rule is based on parent declaration order.
export function planMultipleInheritance(definitions, target) {
  const {byName,ancestry}=validate(definitions);
  if(!byName.has(target))fail('target class not found');
  const related=new Set([...ancestry.get(target),target]);
  const fields=new Map(), contributed=new Map();
  const ordered=[...related].sort();
  for(const name of ordered) {
    const def=byName.get(name);
    for(const field of def.fields) {
      if(fields.has(field)) {
        fail('colliding field '+field+' from '+fields.get(field)+' and '+name);
      }
      fields.set(field,name);
    }
    for(const method of def.methods) {
      const key=method.name+'/'+method.arity;
      if(!contributed.has(key))contributed.set(key,[]);
      contributed.get(key).push({owner:name,...method});
    }
  }
  const effective=[];
  for(const [slot, candidates] of [...contributed].sort(([a],[b])=>a.localeCompare(b))) {
    const local=candidates.find(m=>m.owner===target);
    // Only most-specific independent declarations contribute; if parent B
    // overrides A then A is shadowed, even in a diamond graph.
    const maximal=candidates.filter(m=>!candidates.some(other=>
      other!==m && ancestry.get(other.owner).has(m.owner)));
    const inheritedPub=candidates.some(m=>m.owner!==target&&m.pub);
    if(local) {
      if(inheritedPub && !local.pub)fail('override cannot hide public slot '+slot);
      effective.push({...local,slot});
    } else if(maximal.length===1) {
      effective.push({...maximal[0],slot});
    } else {
      fail('ambiguous inherited method '+slot+' from '+maximal.map(m=>m.owner).sort().join(', ')+': explicit child override required');
    }
  }
  return Object.freeze({
    name:target,
    ancestors:Object.freeze([...ancestry.get(target)].sort()),
    fields:Object.freeze([...fields].map(([name,owner])=>Object.freeze({name,owner}))),
    methods:Object.freeze(effective.map(m=>Object.freeze({
      name:m.name,arity:m.arity,pub:m.pub,owner:m.owner,slot:m.slot,impl:m.impl
    })))
  });
}

// Only suitable for stateless methods: no fields, no constructors, no super,
// no JS private instance slots. The type checker must validate method calls
// and reject bound-method extraction on the Oreslang side.
export function materializeMethodOnlyClass(definitions,target) {
  const plan=planMultipleInheritance(definitions,target);
  if(plan.fields.length) fail('field initialization requires future constructor lowering');
  if(plan.methods.some(method => !method.pub))
    fail('private method dispatch requires compiler-controlled access lowering');
  const token=Symbol('Oreslang nominal constructor: '+target);
  const prototype=Object.create(null);
  const names=new Map();
  for(const method of plan.methods) {
    if(!names.has(method.name))names.set(method.name,new Map());
    names.get(method.name).set(method.arity,method.impl);
  }
  for(const [name,overloads] of names) {
    const fn=function(...args) {
      const entry=overloads.get(args.length);
      if(!entry)throw new TypeError('Oreslang method arity mismatch: '+name+'/'+args.length);
      if(brands.get(this)?.token!==token)throw new TypeError('invalid Oreslang receiver');
      return entry.apply(this,args);
    };
    Object.defineProperty(prototype,name,{value:fn,enumerable:false,writable:false,configurable:false});
  }
  Object.freeze(prototype);
  const nominal=new Set([target,...plan.ancestors]);
  return Object.freeze({
    plan,
    newInstance() {
      const instance=Object.create(prototype);
      brands.set(instance,{token,names:new Set(nominal)});
      return Object.preventExtensions(instance);
    },
    isA(instance,type) {
      return !!instance && typeof instance==='object' &&
        typeof type==='string' && nominal.has(type) &&
        brands.get(instance)?.token===token &&
        brands.get(instance)?.names.has(type)===true;
    }
  });
}
