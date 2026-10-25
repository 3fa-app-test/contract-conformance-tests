import {createScalarIR, validateScalarIR} from './scalar-ir.mjs';
/** Experimental fail-closed Oreslang scalar-to-ESM compiler. */
const MAX_BYTES = 262144;
const I64_MAX = (1n << 63n) - 1n;
export class CompileError extends Error {
  constructor(message, where) {
    super('error: ' + message + (where ? ' at ' + where.line + ':' + where.col : ''));
    this.name = 'CompileError';
  }
}
function lex(src) {
  if (typeof src !== 'string' || new TextEncoder().encode(src).byteLength > MAX_BYTES) throw new CompileError('invalid or oversized source');
  const out = [];
  let i=0, line=1, col=1;
  function advance() { if(src[i]==='\n'){line++;col=1;}else col++;i++; }
  function add(kind, value, loc) { if(out.length>=30000) throw new CompileError('token limit exceeded'); out.push({kind,value,...loc}); }
  while(i<src.length){
    if(/\s/.test(src[i])) {advance();continue;}
    if(src.startsWith('//',i)){while(i<src.length&&src[i]!=='\n')advance();continue;}
    if(src.startsWith('/*',i)){
      const loc={line,col};advance();advance();let depth=1;
      while(depth&&i<src.length){
        if(src.startsWith('/*',i)){depth++;if(depth>64)throw new CompileError('comment nesting limit',loc);advance();advance();}
        else if(src.startsWith('*'+'/',i)){depth--;advance();advance();}
        else advance();
      }
      if(depth)throw new CompileError('unterminated comment',loc);
      continue;
    }
    const loc={line,col};
    if(/[A-Za-z_]/.test(src[i])){
      let s='';while(i<src.length&&/[A-Za-z0-9_]/.test(src[i])){s+=src[i];advance();}
      add('id',s,loc);
    }else if(/[0-9]/.test(src[i])){
      let s='';while(i<src.length&&/[0-9_]/.test(src[i])){s+=src[i];advance();}
      if(!/^[0-9]+(?:_[0-9]+)*$/.test(s))throw new CompileError('invalid integer literal',loc);
      if (s.length > 64) throw new CompileError('integer literal length limit',loc);
      add('int',s,loc);
    }else if(src.startsWith('->',i)||src.startsWith('::',i)){add('sym',src.slice(i,i+2),loc);advance();advance();}
    else if('(){}:,;+-*/%=.'.includes(src[i])){add('sym',src[i],loc);advance();}
    else throw new CompileError('unsupported character',loc);
  }
  out.push({kind:'eof',value:'<eof>',line,col});return out;
}
class Parser {
  constructor(tokens){this.ts=tokens;this.pos=0;this.depth=0;}
  peek(){return this.ts[this.pos];}
  match(v){if(this.peek().value===v){this.pos++;return true;}return false;}
  expect(v){if(!this.match(v))throw new CompileError('expected '+v+', found '+this.peek().value,this.peek());}
  id(){const t=this.peek();if(t.kind!=='id')throw new CompileError('expected identifier',t);this.pos++;return t.value;}
  parse(){
    const module=this.match('define');if(module){this.expect('module');this.id();this.match('as');}
    const functions=[];
    while(this.peek().kind!=='eof'&&!(module&&this.peek().value==='end')){
      if(functions.length>=512)throw new CompileError('function limit',this.peek());
      const pub=this.match('pub');const at=this.peek();
      if(!this.match('fnc')&&!this.match('routine'))throw new CompileError('unsupported declaration',at);
      const name=this.id();this.expect('(');const params=[];
      if(!this.match(')')){
        do{if(params.length>=128)throw new CompileError('parameter limit');this.expect('int');const v=this.id();if(params.includes(v))throw new CompileError('duplicate parameter '+v);params.push(v);}while(this.match(','));
        this.expect(')');
      }
      // The bootstrap parser only supports int functions with a single
      // return expression. Support canonical arrow/end spellings without
      // pretending to support arbitrary statement bodies or async functions.
      const arrow=this.match('->');
      if(!arrow)this.expect(':');
      this.expect('int');
      const braced=this.match('{');
      if(!braced&&!arrow)throw new CompileError('expected { for colon function body',this.peek());
      if(!braced){if(!this.match('as'))this.match('::');}
      this.expect('return');
      const body=this.expr();this.expect(';');this.expect(braced?'}':'end');
      functions.push({name,params,body,pub});
    }
    if(module)this.expect('end');
    if(this.peek().kind!=='eof')throw new CompileError('trailing tokens',this.peek());
    if(!functions.length)throw new CompileError('no functions');return functions;
  }
  expr(min=0){
    if(++this.depth>256)throw new CompileError('expression nesting limit',this.peek());
    try{
      let left=this.primary();
      while(true){
        const op=this.peek().value;
        if(op==='/')throw new CompileError('unsupported operator '+op,this.peek());
        const prec=op==='*'||op==='%'?20:op==='+'||op==='-'?10:-1;
        if(prec<min)break;
        this.pos++;left={kind:'binary',op,left,right:this.expr(prec+1)};
      }
      return left;
    }finally{this.depth--;}
  }
  primary(){
    const t=this.peek();
    if(this.match('-')){
      // The absolute magnitude 2^63 is legal only as a negated literal.
      // All other positive literals must remain within signed i64.
      const next=this.peek();
      if(next.kind==='int' && BigInt(next.value.replaceAll('_',''))===(1n<<63n)){
        this.pos++;return {kind:'int',n:-(1n<<63n)};
      }
      return {kind:'neg',inner:this.expr(30)};
    }
    if(this.match('+'))return this.expr(30);
    if(this.match('(')){const v=this.expr();this.expect(')');return v;}
    if(t.kind==='int'){this.pos++;const n=BigInt(t.value.replaceAll('_',''));if(n>I64_MAX)throw new CompileError('positive int outside signed i64',t);return {kind:'int',n};}
    if(t.kind==='id' && t.value==='rt'){
      this.pos++;
      const op=this.peek();
      if(op.kind!=='id')throw new CompileError('expected runtime operation after rt',op);
      if(['ref','unref','deref','raw'].includes(op.value))
        throw new CompileError('pointer-style runtime operation rt '+op.value+' is not valid Oreslang source',op);
      if(op.value==='borrow' && this.ts[this.pos+1]?.value==='mut')
        throw new CompileError("legacy 'rt borrow mut' is not valid Oreslang; use 'rt mut borrow value'",op);
      if(op.value==='mut' && this.ts[this.pos+1]?.value!=='borrow')
        throw new CompileError("'rt mut' only supports borrowing; use 'rt mut borrow value'",op);
      throw new CompileError('runtime ownership operation requires typed lowering in the JS scalar backend',op);
    }
    if(t.kind==='id'){
      this.pos++;
      if(this.match('(')){
        const args=[];
        if(!this.match(')')){do{if(args.length>=128)throw new CompileError('argument limit');args.push(this.expr());}while(this.match(','));this.expect(')');}
        return {kind:'call',name:t.value,args};
      }
      return {kind:'var',name:t.value};
    }
    throw new CompileError('unexpected '+t.value,t);
  }
}
// The isolated parser is a bootstrap adapter. Future language frontends
// should produce this versioned IR instead of duplicating parser semantics.
export function compileToIR(source) {
  const parsed=new Parser(lex(source)).parse();
  try {
    return createScalarIR(parsed);
  } catch (error) {
    // Keep the source frontend's stable diagnostics while preserving
    // strict "scalar IR" diagnostics for direct compileIR callers.
    if(error?.name==='ScalarIRError' && typeof error.message==='string' &&
       error.message.startsWith('error: scalar IR: ')) {
      throw new CompileError(error.message.slice('error: scalar IR: '.length));
    }
    throw error;
  }
}
export function compileIR(input) {
  const ir = validateScalarIR(input);
  const fns = ir.functions;
  function lower(e, depth = 0) {
    if (depth > 384) throw new CompileError('expression depth limit during lowering');
    if (e.kind === 'int') return e.value + 'n';
    if (e.kind === 'param') return '_p' + e.index;
    if (e.kind === 'neg') return 'BigInt.asIntN(64,-(' + lower(e.inner, depth+1) + '))';
    if (e.kind === 'binary') {
      return 'BigInt.asIntN(64,(' + lower(e.left, depth+1) + ')' + e.op + '(' +
        lower(e.right, depth+1) + '))';
    }
    if (e.kind === 'call') {
      return '_f' + e.target + '(' + e.args.map(arg => lower(arg, depth+1)).join(',') + ')';
    }
    throw new CompileError('invalid IR expression');
  }
  const out = [
    '// Oreslang JS scalar subset. Signed i64 wrapping is PROVISIONAL, not proven Java parity.',
    'function _int(v){if(typeof v!=="bigint"||v<-(1n<<63n)||v>(1n<<63n)-1n)throw new TypeError("Oreslang int requires a signed i64 BigInt");return v;}'
  ];
  fns.forEach((f,i) => {
    const params = f.params.map((_,j) => '_p' + j);
    out.push('function _f' + i + '(' + params.join(',') + '){');
    params.forEach(p => out.push('_int(' + p + ');'));
    out.push('return ' + lower(f.body) + ';', '}');
  });
  // String-literal export names prevent ECMAScript keyword collisions.
  fns.forEach((f,i) => {
    if (f.pub) out.push('export { _f' + i + ' as ' + JSON.stringify(f.name) + ' };');
  });
  return out.join('\n') + '\n';
}
export function compile(source) {
  return compileIR(compileToIR(source));
}
export function check(source) {
  compile(source);
  return true;
}
