import {createHash} from 'node:crypto';
import {compileToIR} from './compiler.mjs';

// Source-derived only after the real JS scalar parser and validated IR.
// Advisory facts are NOT producer-attested proofs of work/termination/GC.
export function staticFactsV0(source) {
  if (typeof source !== 'string') throw TypeError('source must be a string');
  if (source.charCodeAt(0) === 0xfeff || source.includes('\0'))
    throw Error('BOM and NUL source are not admitted for exact-byte facts');
  for (let i = 0; i < source.length; i++) {
    const n = source.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const low = source.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw Error('invalid Unicode surrogate');
    } else if (n >= 0xdc00 && n <= 0xdfff) {
      throw Error('invalid Unicode surrogate');
    }
  }
  // The current scalar IR forgets the optional declared module header.
  // Reject it instead of publishing a false __root__ namespace identity.
  if (/\bmodule\b/.test(source))
    throw Error('module namespace is not retained by scalar IR facts');
  const bytes = Buffer.from(source, 'utf8');
  if (bytes.length > 262144) throw Error('source exceeds JS compiler byte limit');
  const ir = compileToIR(source);
  if (ir.functions.length < 1 || ir.functions.length > 512)
    throw Error('invalid procedure collection');
  const ids = ir.functions.map(f => '__root__.' + f.name + '/' + f.params.length);
  const edges = [];
  const seen = new Set();
  let nodes = 0;
  function walk(expr, owner, depth = 0) {
    if (++nodes > 30000 || depth > 128) throw Error('facts AST budget exceeded');
    if (expr.kind === 'call') {
      const pair = owner + '=>' + expr.target;
      if (seen.has(pair)) throw Error('multiple callsites require distinct callsite evidence');
      seen.add(pair);
      edges.push({from: ids[owner], to: ids[expr.target],
                  kind: 'call', fanout: 1, guard: 'unproved'});
      if (edges.length > 8192) throw Error('fact edge budget exceeded');
      for (const a of expr.args) walk(a, owner, depth + 1);
    } else if (expr.kind === 'binary') {
      walk(expr.left, owner, depth + 1);
      walk(expr.right, owner, depth + 1);
    } else if (expr.kind === 'neg') {
      walk(expr.inner, owner, depth + 1);
    } else if (!['int','param'].includes(expr.kind)) {
      throw Error('unrepresented typed expression cannot be emitted');
    }
  }
  ir.functions.forEach((fn, i) => walk(fn.body, i));
  // ASCII/UTF-16 ordinal order is stable across hosts and locales.
  const cmp = (a,b) => a < b ? -1 : a > b ? 1 : 0;
  edges.sort((a,b) => cmp(a.from,b.from) || cmp(a.to,b.to));
  return {
    version: 'ores-static-facts/v0',
    unit: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    procedures: ids.sort().map(id => ({id,loops: []})),
    edges,
    taint_sources: [], flows: [], sinks: [], permission_checks: []
  };
}
