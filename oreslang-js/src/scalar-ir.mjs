// Versioned, JSON-safe Oreslang scalar IR for the experimental JS backend.
// This contract is intentionally narrower than Oreslang's eventual shared typed IR.
export const SCALAR_IR_VERSION = 1;
export const SCALAR_IR_DIALECT = 'oreslang.scalar';
export const SCALAR_IR_INT_MODEL = 'signed-i64-wrap-provisional';

export class ScalarIRError extends Error {
  constructor(message) {
    super('error: scalar IR: ' + message);
    this.name = 'ScalarIRError';
  }
}
const fail = message => { throw new ScalarIRError(message); };
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const decimal = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;
const MAX_FN = 512;
const MAX_PARAMS = 128;
const MAX_NODES = 30000;
const MAX_DEPTH = 256;
const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;

function record(value, fields, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(context + ': expected object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(context + ': non-plain object');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(k => typeof k !== 'string' || !fields.includes(k))) {
    fail(context + ': unexpected or missing field');
  }
  for (const key of fields) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !Object.hasOwn(desc, 'value')) fail(context + ': accessor or missing field ' + key);
  }
}
function name(value, context) {
  if (typeof value !== 'string' || value.length > 128 || !identifier.test(value)) fail(context + ': invalid identifier');
  return value;
}
function array(value, maximum, context) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum)
    fail(context + ': invalid array size');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 ||
      keys.some(k => k !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(k) || Number(k) >= value.length)))
    fail(context + ': unexpected array properties');
  for (let i = 0; i < value.length; i++) {
    const desc = Object.getOwnPropertyDescriptor(value, i);
    if (!desc || !Object.hasOwn(desc, 'value')) fail(context + ': sparse or accessor array');
  }
  return value;
}
function index(value, maximum, context) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0 || value >= maximum)
    fail(context + ': out-of-range index');
  return value;
}
function integer(value) {
  if (typeof value !== 'string' || value.length > 20 || !decimal.test(value)) fail('invalid canonical int literal');
  const n = BigInt(value);
  if (n < MIN_I64 || n > MAX_I64) fail('int literal outside provisional signed i64');
  return value;
}

// Resolve lexical parameter names and function calls into numeric references.
// No JS identifiers from the IR are ever emitted as executable expressions.
export function createScalarIR(parsedFunctions) {
  array(parsedFunctions, MAX_FN, 'functions');
  if (!parsedFunctions.length) fail('no functions');
  const slots = new Map();
  parsedFunctions.forEach((fn, i) => {
    const fnName = name(fn.name, 'function');
    if (slots.has(fnName)) fail('duplicate function ' + fnName);
    slots.set(fnName, i);
  });
  let nodes = 0;
  function convert(expr, params, depth = 0) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('expression limit exceeded');
    switch (expr.kind) {
      case 'int': return {kind: 'int', value: String(expr.n)};
      case 'var': {
        const i = params.indexOf(expr.name);
        if (i < 0) fail('unresolved identifier ' + expr.name);
        return {kind: 'param', index: i};
      }
      case 'neg': return {kind: 'neg', inner: convert(expr.inner, params, depth + 1)};
      case 'binary': return {
        kind: 'binary', op: expr.op,
        left: convert(expr.left, params, depth + 1),
        right: convert(expr.right, params, depth + 1)
      };
      case 'call': {
        const target = slots.get(expr.name);
        if (target === undefined) fail('unresolved identifier ' + expr.name);
        if (expr.args.length !== parsedFunctions[target].params.length) fail('arity mismatch for ' + expr.name);
        return {kind: 'call', target, args: expr.args.map(e => convert(e, params, depth + 1))};
      }
      default: fail('unsupported expression');
    }
  }
  const ir = {
    schemaVersion: SCALAR_IR_VERSION,
    dialect: SCALAR_IR_DIALECT,
    integerModel: SCALAR_IR_INT_MODEL,
    functions: parsedFunctions.map(fn => ({
      name: fn.name,
      pub: fn.pub,
      params: [...fn.params],
      resultType: 'int',
      body: convert(fn.body, fn.params)
    }))
  };
  return validateScalarIR(ir);
}

// Validate and canonicalize all externally supplied IR before code generation.
// This is a format/type gate, NOT a sandbox for adversarial JS objects.
export function validateScalarIR(ir) {
  record(ir, ['schemaVersion', 'dialect', 'integerModel', 'functions'], 'module');
  if (ir.schemaVersion !== SCALAR_IR_VERSION || ir.dialect !== SCALAR_IR_DIALECT ||
      ir.integerModel !== SCALAR_IR_INT_MODEL) fail('unsupported IR version/dialect/integer model');
  array(ir.functions, MAX_FN, 'functions');
  if (!ir.functions.length) fail('no functions');
  const seen = new Set();
  const headers = ir.functions.map(fn => {
    record(fn, ['name', 'pub', 'params', 'resultType', 'body'], 'function');
    const fnName = name(fn.name, 'function');
    if (seen.has(fnName)) fail('duplicate function ' + fnName);
    seen.add(fnName);
    if (typeof fn.pub !== 'boolean' || fn.resultType !== 'int') fail('invalid function signature');
    array(fn.params, MAX_PARAMS, 'parameters');
    const params = fn.params.map(p => name(p, 'parameter'));
    if (new Set(params).size !== params.length) fail('duplicate parameter');
    return {name: fnName, pub: fn.pub, params, resultType: 'int'};
  });
  let nodes = 0;
  const dependencies = headers.map(() => new Set());
  function checkExpr(expr, owner, depth = 0) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('expression limit exceeded');
    if (expr === null || typeof expr !== 'object' || Array.isArray(expr)) fail('invalid expression');
    const proto = Object.getPrototypeOf(expr);
    if (proto !== Object.prototype && proto !== null) fail('expression: non-plain object');
    const kind = Object.getOwnPropertyDescriptor(expr, 'kind');
    if (!kind || !Object.hasOwn(kind, 'value')) fail('expression: missing or accessor kind');
    switch (kind.value) {
      case 'int':
        record(expr, ['kind', 'value'], 'int');
        return {kind: 'int', value: integer(expr.value)};
      case 'param':
        record(expr, ['kind', 'index'], 'parameter reference');
        return {kind: 'param', index: index(expr.index, headers[owner].params.length, 'parameter')};
      case 'neg':
        record(expr, ['kind', 'inner'], 'negation');
        return {kind: 'neg', inner: checkExpr(expr.inner, owner, depth + 1)};
      case 'binary':
        record(expr, ['kind', 'op', 'left', 'right'], 'binary');
        if (!['+', '-', '*', '%'].includes(expr.op)) fail('unsupported binary operator');
        return {kind: 'binary', op: expr.op,
          left: checkExpr(expr.left, owner, depth + 1),
          right: checkExpr(expr.right, owner, depth + 1)};
      case 'call': {
        record(expr, ['kind', 'target', 'args'], 'call');
        const target = index(expr.target, headers.length, 'function target');
        array(expr.args, MAX_PARAMS, 'call arguments');
        if (expr.args.length !== headers[target].params.length) fail('call arity mismatch');
        dependencies[owner].add(target);
        return {kind: 'call', target, args: expr.args.map(e => checkExpr(e, owner, depth + 1))};
      }
      default: fail('unsupported expression kind');
    }
  }
  const functions = headers.map((fn, i) => ({
    ...fn, body: checkExpr(ir.functions[i].body, i)
  }));
  // This subset has only eager return expressions, so any reachable call cycle
  // is unconditionally nonterminating. General Oreslang recursion is not banned.
  const state = new Uint8Array(functions.length);
  function visit(i) {
    if (state[i] === 1) fail('unconditional recursive call cycle at ' + functions[i].name);
    if (state[i] === 2) return;
    state[i] = 1;
    for (const j of dependencies[i]) visit(j);
    state[i] = 2;
  }
  functions.forEach((_, i) => visit(i));
  return {
    schemaVersion: SCALAR_IR_VERSION,
    dialect: SCALAR_IR_DIALECT,
    integerModel: SCALAR_IR_INT_MODEL,
    functions
  };
}

export function stringifyScalarIR(ir) {
  return JSON.stringify(validateScalarIR(ir));
}
