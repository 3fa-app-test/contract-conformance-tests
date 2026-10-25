import {validateProgramIRV2,PROGRAM_IR_VERSION,PROGRAM_IR_DIALECT,PROGRAM_IR_INT_MODEL} from './program-ir-v2.mjs';
/**
 * Experimental Oreslang program-to-ESM v2 slice:
 * flat runtime modules, private/public functions, qualified calls, integer matches.
 * Standalone parser until the shared typed frontend and IR become available.
 * DOES NOT implement classes, actors, imports, or the type-only namespace grammar.
 */
const MAX_BYTES = 262144, MAX_TOKENS = 30000, MAX_DEPTH = 192;
const MIN = -(1n << 63n), MAX = (1n << 63n) - 1n;
const TOKEN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export class ProgramCompileError extends Error {
  constructor(message, loc) {
    super('error: program v2: ' + message + (loc ? ' at ' + loc.line + ':' + loc.col : ''));
    this.name = 'ProgramCompileError';
  }
}
const fail = (message, loc) => {throw new ProgramCompileError(message, loc);};

/**
 * Align source-profile negotiation with Java CheckedI64SourceHeader.
 * Provisional JS arithmetic stays checked for unmarked source too, but a
 * malformed or displaced explicit opt-in must never be silently ignored.
 * Only actual line-comment tokens count; block/quoted lookalikes do not.
 */
function requireWellFormedCheckedI64Header(source) {
  const directive='// oreslang:checked-i64-v1\n';
  const prefix='oreslang:checked-i64';
  const enabled=source.startsWith(directive);
  let depth=0,quote=null;
  for(let i=0;i<source.length;){
    const ch=source[i], next=source[i+1];
    if(quote!==null) {
      if(ch==='\\'&&i+1<source.length){i+=2;continue;}
      if(ch===quote)quote=null;
      i++;
      continue;
    }
    if(depth!==0) {
      if(ch==='/'&&next==='*'){depth++;i+=2;continue;}
      if(ch==='*'&&next==='/'){depth--;i+=2;continue;}
      i++;
      continue;
    }
    if(ch==='"'||ch==="'"){quote=ch;i++;continue;}
    if(ch==='/'&&next==='*'){depth=1;i+=2;continue;}
    if(ch==='/'&&next==='/'){
      const end=source.indexOf('\n',i);
      const stop=end<0?source.length:end;
      let marker=i+2;
      while(marker<stop&&' \t\r\v\f'.includes(source[marker]))marker++;
      if(source.startsWith(prefix,marker)&&(!enabled||i!==0))
        fail('checked-i64-v1: malformed, duplicated, displaced or unsupported directive');
      i=end<0?stop:end+1;
      continue;
    }
    i++;
  }
  return enabled;
}
function tokenize(source) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > MAX_BYTES) fail('oversized or invalid source');
  requireWellFormedCheckedI64Header(source);
  const result = [];
  let pos = 0, line = 1, col = 1;
  function advance() {
    if (source[pos] === '\n') {line++; col = 1;} else col++;
    pos++;
  }
  function emit(kind, value, start) {
    if (result.length >= MAX_TOKENS) fail('token budget exceeded', start);
    result.push({kind, value, ...start});
  }
  while (pos < source.length) {
    const start = {line, col};
    const c = source[pos];
    if (/\s/.test(c)) {advance(); continue;}
    if (source.startsWith('//',pos)) {
      while (pos < source.length && source[pos] !== '\n') advance();
      continue;
    }
    if (source.startsWith('/*',pos)) {
      advance(); advance(); let nesting = 1;
      while (nesting && pos < source.length) {
        if (source.startsWith('/*',pos)) {
          if (++nesting > 64) fail('comment nesting exceeded',start);
          advance(); advance();
        } else if (source.startsWith('*/',pos)) {
          nesting--; advance(); advance();
        } else advance();
      }
      if (nesting) fail('unterminated comment',start);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let word = '';
      while (pos < source.length && /[A-Za-z0-9_]/.test(source[pos])) {
        word += source[pos]; advance();
      }
      if (word.length > 128) fail('identifier limit',start);
      emit('id',word,start);
    } else if (/[0-9]/.test(c)) {
      let number = '';
      while (pos < source.length && /[0-9_]/.test(source[pos])) {
        number += source[pos]; advance();
      }
      if (number.length > 64 || !/^[0-9]+(?:_[0-9]+)*$/.test(number)) fail('invalid int literal',start);
      emit('int',number,start);
    } else if (['<=','>=','==','!='].some(op=>source.startsWith(op,pos))) {
      emit('sym',source.slice(pos,pos+2),start); advance(); advance();
    } else if (source.startsWith('->',pos) || source.startsWith('::',pos)) {
      emit('sym',source.slice(pos,pos+2),start); advance(); advance();
    } else if ('(){}:,;+-*/%=.<>!'.includes(c)) {
      emit('sym',c,start); advance();
    } else fail('unsupported character',start);
  }
  emit('eof','<eof>',{line,col});
  return result;
}
class Parser {
  constructor(tokens) {this.tokens = tokens;this.i = 0;this.depth = 0;this.expressions = 0;this.statementNodes = 0;}
  peek() {return this.tokens[this.i];}
  eat(s) {if(this.peek().value === s) {this.i++; return true;} return false;}
  expect(s) {if(!this.eat(s)) fail('expected ' + s + ', found ' + this.peek().value,this.peek());}
  name() {
    const t = this.peek();
    if (t.kind !== 'id' || !TOKEN_NAME.test(t.value)) fail('identifier expected',t);
    this.i++; return t.value;
  }
  functions(moduleName) {
    const pub = this.eat('pub'), start=this.peek();
    if (!this.eat('fnc') && !this.eat('routine')) fail('unsupported declaration',start);
    const kind = this.tokens[this.i-1].value, name = this.name();
    this.expect('(');
    const params = [], paramTypes = [];
    if (!this.eat(')')) {
      do {
        if (params.length >= 128) fail('parameter limit',this.peek());
        const type=this.peek().value;
        if(type!=='int'&&type!=='bool')fail('only int/bool parameters supported',this.peek());
        this.i++;
        const p = this.name();
        if (params.includes(p)) fail('duplicate parameter ' + p);
        params.push(p); paramTypes.push(type);
      } while(this.eat(','));
      this.expect(')');
    }
    // Bound source-level control flow to total-returning integer functions.
    // This is a freestanding core slice, not generic statement lowering.
    const arrow=this.eat('->');
    if(!arrow)this.expect(':');
    const returnType=this.peek().value;
    if(returnType!=='int'&&returnType!=='bool')fail('only int/bool returns supported',this.peek());
    this.i++;
    const braced=this.eat('{');
    if(!braced&&!arrow)fail('expected { for colon function body',this.peek());
    if(!braced){if(!this.eat('as'))this.eat('::');}
    const statements=this.statementSequence([braced?'}':'end']);
    this.expect(braced?'}':'end');
    const body=this.lowerStatements(statements,null);
    if(!body)fail('int function requires a return on every path');
    this.checkExpandedBudget(body);
    // Exporting a routine as a module object property would make a
    // direct-call-only routine first class. Leave this for runtime/ABI design.
    if (pub && kind === 'routine') fail('public routine cannot be exported');
    const fn={module:moduleName, name, kind, pub, params, body};
    // Keep the historical integer-only IR exactly stable for old consumers.
    // New typed fields are an all-or-nothing additive extension for bool.
    if(returnType==='bool'||paramTypes.includes('bool')){
      fn.paramTypes=paramTypes;fn.returnType=returnType;
    }
    return fn;
  }
  statementSequence(terminators,depth=0) {
    if(depth>64)fail('conditional nesting budget exceeded',this.peek());
    const statements=[];
    while(this.peek().kind!=='eof'&&!terminators.includes(this.peek().value)) {
      if(++this.statementNodes>MAX_TOKENS)fail('statement budget exceeded',this.peek());
      if(this.eat('return')) {
        const body=this.expression();
        this.expect(';');
        statements.push({kind:'return',body});
      } else if(this.eat('if')) {
        const condition=this.expression();
        this.expect(';');this.expect('do');
        const yes=this.statementSequence(['else','fi'],depth+1);
        const no=this.eat('else')?this.statementSequence(['fi'],depth+1):[];
        this.expect('fi');
        statements.push({kind:'branch',condition,yes,no});
      } else fail('unsupported statement in int function',this.peek());
    }
    if(this.peek().kind==='eof')fail('unterminated function or conditional',this.peek());
    return statements;
  }
  returnsOnAllPaths(stmts) {
    if(!stmts.length)return false;
    const last=stmts[stmts.length-1];
    return last.kind==='return'||
      (last.kind==='branch'&&this.returnsOnAllPaths(last.yes)&&this.returnsOnAllPaths(last.no));
  }
  lowerStatements(stmts,fallback) {
    let result=fallback;
    for(let i=stmts.length-1;i>=0;i--) {
      const stmt=stmts[i];
      if(i<stmts.length-1 &&
         (stmt.kind==='return' ||
          (this.returnsOnAllPaths(stmt.yes||[])&&this.returnsOnAllPaths(stmt.no||[]))))
        fail('unreachable statement after terminating return/if');
      if(stmt.kind==='return')result=stmt.body;
      else {
        const yes=this.lowerStatements(stmt.yes,result);
        const no=this.lowerStatements(stmt.no,result);
        if(!yes||!no)fail('int function requires return on every if branch');
        result={kind:'if',condition:stmt.condition,yes,no};
      }
    }
    return result;
  }
  // Fall-through after sequential if statements can share a continuation
  // between both branches. The AST is a DAG in memory, but resolving or
  // serializing it expands every occurrence into an IR tree. Detect exponential
  // amplification *before* resolution, JSON, or codegen work begins.
  checkExpandedBudget(root) {
    const memo=new WeakMap();
    function size(expr,depth=0) {
      if(depth>MAX_DEPTH)fail('expanded expression depth exceeded');
      if(memo.has(expr))return memo.get(expr);
      let total=1;
      function add(next) {
        if(next===null||typeof next!=='object')fail('invalid expression during lowering');
        total+=size(next,depth+1);
        if(total>MAX_TOKENS)fail('expanded conditional IR node budget exceeded');
      }
      switch(expr.kind){
        case 'int':case 'bool':case 'variable':break;
        case 'neg':case 'not':add(expr.inner);break;
        case 'binary':case 'compare':add(expr.left);add(expr.right);break;
        case 'if':add(expr.condition);add(expr.yes);add(expr.no);break;
        case 'call':for(const arg of expr.args)add(arg);break;
        case 'match':
          add(expr.subject);
          for(const arm of expr.arms)add(arm.body);
          break;
        default:fail('unrecognized lowered expression');
      }
      memo.set(expr,total);
      return total;
    }
    size(root);
  }
  parse() {
    // Oreslang's flat source namespace is compile-time package metadata,
    // not a runtime module/object. It must occur only once at file start.
    let namespace = null;
    if (this.eat('namespace')) {
      namespace = this.name();
      this.expect(';');
    }
    const modules = [], functions = [], usedModules = new Set();
    while (this.peek().kind !== 'eof') {
      if (this.eat('define')) {
        this.expect('module'); const name=this.name();
        if (usedModules.has(name)) fail('duplicate module ' + name);
        usedModules.add(name); this.eat('as');
        modules.push(name);
        let count=0;
        while (!this.eat('end')) {
          if (this.peek().kind === 'eof') fail('unterminated module ' + name);
          if (++count > 512 || functions.length >= 512) fail('declaration budget exceeded');
          functions.push(this.functions(name));
        }
      } else {
        if (functions.length >= 512) fail('declaration budget exceeded');
        functions.push(this.functions(null));
      }
    }
    if (!functions.length && !modules.length) fail('empty program');
    return {namespace,modules,functions};
  }
  integer(negative = false) {
    const token=this.peek();
    if (token.kind !== 'int') fail('integer literal expected',token);
    this.i++;
    const n=BigInt(token.value.replaceAll('_','')) * (negative ? -1n : 1n);
    if (n < MIN || n > MAX) fail('int literal outside provisional signed i64',token);
    return n.toString();
  }
  expression(min=0) {
    if (++this.depth > MAX_DEPTH || ++this.expressions > MAX_TOKENS) fail('expression budget exceeded',this.peek());
    try {
      let left = this.primary();
      while (true) {
        const op = this.peek().value;
        if (op === '/') fail('division unsupported in provisional int profile',this.peek());
        const compare=['<','>','<=','>=','==','!='].includes(op);
        const prec=op==='*'||op==='%'?20:op==='+'||op==='-'?10:compare?5:-1;
        if (prec < min) break;
        this.i++;
        left={kind:compare?'compare':'binary',op,left,right:this.expression(prec+1)};
      }
      return left;
    } finally {this.depth--;}
  }
  primary() {
    if(this.eat('!'))return {kind:'not',inner:this.expression(30)};
    if(this.eat('true'))return {kind:'bool',value:true};
    if(this.eat('false'))return {kind:'bool',value:false};
    if (this.eat('-')) {
      if(this.peek().kind === 'int') return {kind:'int',value:this.integer(true)};
      return {kind:'neg',inner:this.expression(30)};
    }
    if(this.eat('+')) return this.expression(30);
    if(this.eat('(')) {
      const e=this.expression();this.expect(')'); return e;
    }
    if(this.eat('match')) return this.matchExpression();
    if(this.peek().kind==='int') return {kind:'int',value:this.integer()};
    const token=this.peek();
    if (token.kind !== 'id') fail('expression expected',token);
    const first=this.name();
    let qualifier=null, symbol=first;
    if(this.eat('.')) {qualifier=first; symbol=this.name();}
    if (!this.eat('(')) {
      if (qualifier) fail('bare module properties not yet supported',token);
      return {kind:'variable', name:first};
    }
    const args=[];
    if(!this.eat(')')) {
      do {
        if(args.length >= 128) fail('argument limit');
        args.push(this.expression());
      } while(this.eat(','));
      this.expect(')');
    }
    return {kind:'call',qualifier,name:symbol,args};
  }
  matchExpression() {
    const subject=this.expression();
    this.eat('over'); // compatibility with documented compact match syntax
    const arms=[], seen=new Set(); let wildcard=false;
    while(this.peek().value !== 'end' && this.peek().kind !== 'eof') {
      let isDefault=false, value=null;
      if(this.eat('else')) isDefault=true;
      else {
        this.expect('on');
        if(this.eat('_')) isDefault=true;
        else value=this.integer(this.eat('-'));
      }
      if(wildcard) fail('unreachable arm after wildcard',this.peek());
      if(isDefault) wildcard=true;
      else {
        if(seen.has(value)) fail('duplicate scalar pattern');
        seen.add(value);
      }
      this.eat('->');
      this.expect('{');
      // A match expression yields its arm expression, not a statement return.
      if(this.peek().value === 'return') fail('return inside expression match is invalid');
      const body=this.expression();
      this.expect(';');this.expect('}');
      arms.push({value, body});
      if (arms.length > 256) fail('match arm limit');
    }
    this.expect('end');
    if (!wildcard) fail('scalar int match requires exhaustive wildcard/else');
    return {kind:'match',subject,arms};
  }
}
function resolveProgram(parsed) {
  const {modules,functions}=parsed;
  const slots = new Map(), exports = new Set(), symbolKinds = new Map();
  functions.forEach((fn,i)=>{
    const qualified=(fn.module===null?'@file/':'@module/'+fn.module+'/')+fn.name;
    const slot=qualified+'/'+fn.params.length;
    if(slots.has(slot)) fail('duplicate caller-visible arity '+slot);
    if(symbolKinds.has(qualified) && symbolKinds.get(qualified)!==fn.kind)
      fail('fnc and direct-call-only routine cannot share an exported name '+qualified);
    symbolKinds.set(qualified,fn.kind);
    slots.set(slot,i);
    if(fn.pub && fn.module===null) exports.add(fn.name);
  });
  modules.forEach(m=>{
    if(exports.has(m)) fail('module/function export conflict '+m);
    exports.add(m);
  });
  let nodeCount=0;
  function resolve(expr,owner,depth=0) {
    if(++nodeCount>MAX_TOKENS || depth>MAX_DEPTH) fail('IR node/depth budget exceeded');
    switch(expr.kind) {
      case 'int':case 'bool':return expr;
      case 'variable': {
        const index=owner.params.indexOf(expr.name);
        if(index<0) fail('unresolved identifier '+expr.name);
        return {kind:'param',index};
      }
      case 'neg':case 'not':return {kind:expr.kind,inner:resolve(expr.inner,owner,depth+1)};
      case 'binary': return {kind:'binary',op:expr.op,left:resolve(expr.left,owner,depth+1),right:resolve(expr.right,owner,depth+1)};
      case 'compare': return {kind:'compare',op:expr.op,left:resolve(expr.left,owner,depth+1),right:resolve(expr.right,owner,depth+1)};
      case 'if': return {kind:'if',condition:resolve(expr.condition,owner,depth+1),
        yes:resolve(expr.yes,owner,depth+1),no:resolve(expr.no,owner,depth+1)};
      case 'call': {
        const mod=expr.qualifier===null?owner.module:expr.qualifier;
        if(mod!==null && !modules.includes(mod)) fail('unknown module '+mod);
        const key=(mod===null?'@file/':'@module/'+mod+'/')+expr.name;
        const target=slots.get(key+'/'+expr.args.length);
        if(target===undefined) {
          if(symbolKinds.has(key)) fail('call arity mismatch for '+key);
          fail('unresolved callable '+key);
        }
        if(expr.qualifier!==null && mod!==owner.module && !functions[target].pub) fail('private module member '+key);
        return {kind:'call',target,args:expr.args.map(a=>resolve(a,owner,depth+1))};
      }
      case 'match': return {kind:'match',subject:resolve(expr.subject,owner,depth+1),
        arms:expr.arms.map(arm=>({value:arm.value,body:resolve(arm.body,owner,depth+1)}))};
      default: fail('unsupported expression node');
    }
  }
  const resolved=functions.map(fn=>({...fn,body:resolve(fn.body,fn)}));
  const graph=resolved.map(()=>new Set());
  function inspect(expr,owner) {
    if(expr.kind==='call') {graph[owner].add(expr.target);expr.args.forEach(a=>inspect(a,owner));}
    else if(expr.kind==='binary'||expr.kind==='compare') {inspect(expr.left,owner);inspect(expr.right,owner);}
    else if(expr.kind==='if') {inspect(expr.condition,owner);inspect(expr.yes,owner);inspect(expr.no,owner);}
    else if(expr.kind==='neg'||expr.kind==='not') inspect(expr.inner,owner);
    else if(expr.kind==='match') {
      inspect(expr.subject,owner);expr.arms.forEach(a=>inspect(a.body,owner));
    }
  }
  resolved.forEach((f,i)=>inspect(f.body,i));
  // Conservative until there is a fuel/call-depth budget: matches may contain
  // conditional recursion, but rejecting cycles is safer than permitting an
  // unbounded JS stack explosion. This is NOT an Oreslang language restriction.
  const colors=new Uint8Array(resolved.length);
  function visit(i) {
    if(colors[i]===1) fail('recursive call graph unsupported pending fuel budget');
    if(colors[i]===2) return;
    colors[i]=1;for(const j of graph[i])visit(j); colors[i]=2;
  }
  resolved.forEach((_,i)=>visit(i));
  return {sourceNamespace:parsed.namespace,modules,functions:resolved};
}
function emitProgram(program) {
  const out=[
    '// experimental Oreslang program-v2, provisional signed-64 integer model',
    'function _check(v){if(typeof v!=="bigint")throw new TypeError("Oreslang signed i64 BigInt required");if(v<-(1n<<63n)||v>(1n<<63n)-1n)throw new RangeError("ORES_I64_OVERFLOW: checked signed 64-bit overflow");return v;}',
    // Do not expose JS engine-specific "Division by zero" RangeError text as
    // an unclassified Oreslang guest failure. This is a provisional host-side
    // code, NOT the portable guest Error wire ABI or actor CONTROL signal.
    'function _rem(a,b){_check(a);_check(b);if(b===0n)throw new RangeError("ORES_I64_DIVISION_BY_ZERO: checked signed 64-bit remainder by zero");return _check(a%b);}'
  ];
  function emitExpr(expr,depth=0) {
    if(depth > MAX_DEPTH) fail('codegen depth exceeded');
    switch(expr.kind) {
      case 'int': return expr.value+'n';
      case 'bool': return expr.value?'true':'false';
      case 'param':return '_p'+expr.index;
      // Oreslang checked signed-i64 arithmetic is not JS BigInt.asIntN
      // wrapping arithmetic. Check the computed result before returning.
      case 'neg':return '_check(-('+emitExpr(expr.inner,depth+1)+'))';
      case 'not':return '!('+emitExpr(expr.inner,depth+1)+')';
      case 'binary':
        if(expr.op==='%')return '_rem(('+emitExpr(expr.left,depth+1)+'),('+emitExpr(expr.right,depth+1)+'))';
        return '_check(('+emitExpr(expr.left,depth+1)+')'+expr.op+'('+emitExpr(expr.right,depth+1)+'))';
      case 'compare':return '(('+emitExpr(expr.left,depth+1)+')'+expr.op+'('+emitExpr(expr.right,depth+1)+'))';
      case 'if':return '(('+emitExpr(expr.condition,depth+1)+')?('+
        emitExpr(expr.yes,depth+1)+'):('+emitExpr(expr.no,depth+1)+'))';
      case 'call':return '_f'+expr.target+'('+expr.args.map(x=>emitExpr(x,depth+1)).join(',')+')';
      case 'match': {
        // _subject is evaluated exactly once. A branch returns immediately,
        // so no fallthrough and unmatched arm expressions stay lazy.
        const lines=['(()=>{const _subject='+emitExpr(expr.subject,depth+1)+';switch(_subject){'];
        expr.arms.forEach(arm=>{
          lines.push(arm.value===null?'default:':'case '+arm.value+'n:');
          lines.push('return '+emitExpr(arm.body,depth+1)+';');
        });
        lines.push('}})()');
        return lines.join('');
      }
      default: fail('unsupported codegen expression');
    }
  }
  if(program.functions.some(fn=>fn.returnType==='bool'||fn.paramTypes?.includes('bool')))
    out.push('function _checkbool(v){if(typeof v!=="boolean")throw new TypeError("Oreslang bool required");return v;}');
  program.functions.forEach((fn,i)=>{
    const params=fn.params.map((_,j)=>'_p'+j);
    out.push('function _f'+i+'('+params.join(',')+'){');
    params.forEach((p,j)=>out.push((fn.paramTypes?.[j]==='bool'?'_checkbool':'_check')+'('+p+');'));
    out.push('return '+emitExpr(fn.body)+';','}');
  });
  let dispatcherNumber=0;
  function exportCallable(indices) {
    // Always use the public arity dispatcher, even for one overload.
    const name='_dispatch'+(dispatcherNumber++);
    out.push('function '+name+'(..._args){switch(_args.length){');
    for(const i of indices) {
      out.push('case '+program.functions[i].params.length+':return _f'+i+'(..._args);');
    }
    out.push('default:throw new TypeError("Oreslang overload arity mismatch");}}');
    return name;
  }
  function publicGroups(module) {
    const result=new Map();
    program.functions.forEach((fn,i)=>{
      if(fn.module===module && fn.pub) {
        if(!result.has(fn.name))result.set(fn.name,[]);
        result.get(fn.name).push(i);
      }
    });
    return result;
  }
  program.modules.forEach((module,i)=>{
    out.push('const _module'+i+'=Object.create(null);');
    for(const [name,indices] of publicGroups(module)) {
      const callable=exportCallable(indices);
      out.push('Object.defineProperty(_module'+i+','+JSON.stringify(name)+',{value:'+callable+',enumerable:true,configurable:false,writable:false});');
    }
    out.push('Object.freeze(_module'+i+');');
    out.push('export { _module'+i+' as '+JSON.stringify(module)+' };');
  });
  for(const [name,indices] of publicGroups(null)) {
    out.push('export { '+exportCallable(indices)+' as '+JSON.stringify(name)+' };');
  }
  return out.join('\n')+'\n';
}
export function compileToProgramIRV2(source) {
  const program=resolveProgram(new Parser(tokenize(source)).parse());
  return validateProgramIRV2({
    schemaVersion:PROGRAM_IR_VERSION,
    dialect:PROGRAM_IR_DIALECT,
    integerModel:PROGRAM_IR_INT_MODEL,
    ...program
  });
}
export function compileProgramIRV2(ir) {
  return emitProgram(validateProgramIRV2(ir));
}
export function compileProgramV2(source) {
  return emitProgram(compileToProgramIRV2(source));
}
export function checkProgramV2(source) {
  compileProgramV2(source);
  return true;
}

