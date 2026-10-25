/**
 * Source-pinned JS execution observations for the Java semantic fixture subset.
 * A verified JS checkout is not evidence of Java/Graal execution.
 */
import {createHash} from 'node:crypto';
import {parseStrictJsonReport} from './parity-json-strict.mjs';
import {compileProgramV2, ProgramCompileError} from './program-v2.mjs';
import {PROGRAM_IR_INT_MODEL} from './program-ir-v2.mjs';

export const JAVA_FIXTURE_REVISION='e719222e2c4c8ff8eff5d3986ad1885bfc02bc7a';
export const FIXTURE_AUTHORITY='ores-truffle-oreslang/oreslang-source.java';
export const JS_PARITY_REPORT_FORMAT='oreslang-js-reference-fixtures-v1';

// Independently reconstructed from the 19 files read by Java's
// contracts/v1/semantics/run.py validate_suite() at JAVA_FIXTURE_REVISION.
// Both JSON Schema and TypeSpec are included. Never accept arbitrary
// well-formed 64-digit "suite digests" as evidence of matching sources.
export const JAVA_SEMANTIC_SUITE_SHA256='6f1b0303b609a400d3ea1b6809a95bcf0d43061bacb4db2c1b8a9233f4528ec1';

// The Java v1.1 manifest has fifteen required Graal cases. The JS backend
// executes only a pinned subset of ten of these (see REFERENCE_CASES).
// The remaining Java-only results cannot be promoted as JS parity evidence.
export const JAVA_GRAAL_MANIFEST=Object.freeze([
  ['native.add',42],['native.precedence',40],['native.forward',42],
  ['native.owned-identifier',42],['native.underscores',42],['native.unary',42],
  ['native.defer-lifo-cfg',111],['native.defer-field-return',42],
  ['native.try-finally-return-snapshot',42],
  ['diagnostic.unknown','unknown_name'],['diagnostic.arity','call_arity'],
  ['diagnostic.duplicate','duplicate_declaration'],
  ['diagnostic.overflow','integer_overflow'],
  ['diagnostic.comment','unterminated_comment'],
  ['ownership.mutable-borrow','ownership_violation']
].map(([id,expected])=>Object.freeze({id,expected})));


export const REFERENCE_CASES=Object.freeze([
  {id:'native.add',kind:'value',expected:'42',blob:'015f8b0f79aafa796a148d2adeff1574e8d6c491',
   source:'pub fnc main(): int { return 40 + 2; }\n'},
  {id:'native.precedence',kind:'value',expected:'40',blob:'2d09e697ad4eeac4ee263c3656b92998c67f0bfc',
   source:'pub fnc main(): int { return (2 + 3) * 8; }\n'},
  {id:'native.forward',kind:'value',expected:'42',blob:'63067f3b4ac9ad0f2550fa4ccc3314a9c05fc63b',
   source:'pub fnc main(): int { return times(7, 6); }\nfnc times(int a, int b): int { return a * b; }\n'},
  {id:'native.unary',kind:'value',expected:'42',blob:'f9376d50509ce4b69572c610547b96cfdaa4cd7d',
   source:'pub fnc main(): int { return -5 + 47; }\n'},
  {id:'native.underscores',kind:'value',expected:'42',blob:'9de6f26fac278174c9f86ae7fa63ad331f99e96a',
   source:'/* tokens */ pub fnc main(): int { return 4_0 + 2; }\n'},
  {id:'diagnostic.unknown',kind:'diagnostic',expected:'unknown_name',
   error:/unresolved identifier neverDeclared/,
   blob:'b942e9df050acb5bc8d291096b1435f5e0e0a83e',
   source:'pub fnc main(): int { return neverDeclared; }\n'},
  {id:'diagnostic.arity',kind:'diagnostic',expected:'call_arity',
   error:/call arity mismatch/,
   blob:'fbd0b9e28888c7f21dbf91fa676cbb849e389c2f',
   source:'fnc add(int a, int b): int { return a + b; }\npub fnc main(): int { return add(1); }\n'},
  {id:'diagnostic.duplicate',kind:'diagnostic',expected:'duplicate_declaration',
   error:/duplicate caller-visible arity/,
   blob:'e819095613496106885d6c6d223c9bd1a8bfa28f',
   source:'fnc f(): int { return 1; }\nfnc f(): int { return 2; }\n'},
  {id:'diagnostic.overflow',kind:'diagnostic',expected:'integer_overflow',
   error:/int literal outside provisional signed i64/,
   blob:'60a6dce7a302e0b54af26c49452afecb1b4ffb7c',
   source:'pub fnc main(): int { return 9223372036854775808; }\n'},
  {id:'diagnostic.comment',kind:'diagnostic',expected:'unterminated_comment',
   error:/unterminated comment/,
   blob:'e144dcbda7c5333cba38549ff754f697b3676bc2',
   source:'pub fnc main(): int { return 42; } /* unterminated /* nested\n'},
].map(Object.freeze));

export function gitBlobSha1(source) {
  const b=Buffer.from(source,'utf8');
  return createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
}
export function fixtureSuiteSha256() {
  // Length-delimited, sorted-by-authority manifest. IDs, source bytes and expected
  // outcomes are independently bound, not just the set of file names.
  const hash=createHash('sha256').update('oreslang-js-reference-fixtures-v1\0');
  for(const c of REFERENCE_CASES) {
    for(const part of [c.id,c.kind,c.expected,c.blob,c.source]){
      const bytes=Buffer.from(part,'utf8');
      const len=Buffer.alloc(8);len.writeBigUInt64BE(BigInt(bytes.length));
      hash.update(len).update(bytes);
    }
  }
  return hash.digest('hex');
}
function assertFixtureAuthority() {
  const names=new Set();
  for(const c of REFERENCE_CASES) {
    if(names.has(c.id))throw Error('duplicate authority fixture '+c.id);
    names.add(c.id);
    if(gitBlobSha1(c.source)!==c.blob)
      throw Error('Java fixture Git blob changed: '+c.id);
  }
  if(names.size!==10)throw Error('incomplete Java reference fixture slice');
}

export async function executeJsReferenceFixtures() {
  assertFixtureAuthority();
  const results=[];
  for(const c of REFERENCE_CASES) {
    let observed;
    try {
      const esm=compileProgramV2(c.source);
      if(c.kind!=='value')throw Error('diagnostic fixture accepted: '+c.id);
      const ns=await import('data:text/javascript,'+encodeURIComponent(esm));
      const value=ns.main();
      if(typeof value!=='bigint')throw Error('not typed i64 BigInt: '+c.id);
      observed=value.toString();
    } catch(error) {
      if(c.kind!=='diagnostic'||!(error instanceof ProgramCompileError)||
         !c.error.test(error.message))
        throw Error('JS fixture divergence '+c.id+': '+String(error));
      observed=c.expected;
    }
    if(observed!==c.expected)throw Error('JS reference value mismatch '+c.id+': '+observed);
    results.push({
      id:c.id,fixture_git_blob:c.blob,kind:c.kind,status:'pass',
      ...(c.kind==='value'?{observed_int64:observed}:{diagnostic_class:observed})
    });
  }
  return {
    format:JS_PARITY_REPORT_FORMAT,
    backend:'js',
    fixture_authority:FIXTURE_AUTHORITY,
    fixture_authority_revision:JAVA_FIXTURE_REVISION,
    fixture_suite_sha256:fixtureSuiteSha256(),
    integer_model:PROGRAM_IR_INT_MODEL,
    execution:'real-node-guest',
    provenance_authenticated:false,
    java_execution_verified:false,
    results
  };
}

/**
 * Compare Java's existing semantic-report format to actual JS observations.
 * This is STRUCTURAL comparison only; it never attests Java checkout/build,
 * signature, runner provenance, guest execution, or language-wide parity.
 */

// External report objects must be inert JSON-like values, not objects with
// getters, inherited properties, sparse arrays, symbols or unexpected fields.
// This prevents the comparator itself from invoking ordinary accessors.
// JavaScript proxies remain a host-trust boundary: use parsed JSON for
// independently received reports, never arbitrary foreign live objects.
const JS_REPORT_FIELDS=[
  'format','backend','fixture_authority','fixture_authority_revision',
  'fixture_suite_sha256','integer_model','execution',
  'provenance_authenticated','java_execution_verified','results',
  'checkout_commit_sha','checkout_tree_sha','node_version',
  'checked_fixture_count','github_run_authenticated',
  'java_js_semantic_parity_certified'
];
const JS_REQUIRED=JS_REPORT_FIELDS.slice(0,10);
const JAVA_REPORT_FIELDS=['schema_version','backend','suite_sha256','source_revision','results'];
const JS_RESULT_FIELDS=['id','fixture_git_blob','kind','status','observed_int64','diagnostic_class'];
const JAVA_RESULT_FIELDS=['id','status','observed_exit','diagnostic_class','detail'];
function inertRecord(value,allowed,required,where) {
  if(value===null||typeof value!=='object'||Array.isArray(value))
    throw Error(where+': expected plain record');
  const proto=Object.getPrototypeOf(value);
  if(proto!==Object.prototype&&proto!==null)
    throw Error(where+': non-plain record');
  const keys=Reflect.ownKeys(value);
  if(keys.length<required.length||keys.length>allowed.length||
     keys.some(key=>typeof key!=='string'||!allowed.includes(key)))
    throw Error(where+': unexpected/missing fields');
  const copy=Object.create(null);
  for(const key of keys) {
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!Object.hasOwn(descriptor,'value'))
      throw Error(where+': accessor property rejected');
    copy[key]=descriptor.value;
  }
  for(const key of required)if(!Object.hasOwn(copy,key))
    throw Error(where+': required field missing');
  return copy;
}
function inertArray(value,max,where) {
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||
     value.length>max)throw Error(where+': invalid array');
  const keys=Reflect.ownKeys(value);
  if(keys.length!==value.length+1||
     keys.some(key=>key!=='length'&&
       (typeof key!=='string'||!/^(0|[1-9][0-9]*)$/.test(key)||
        Number(key)>=value.length)))
    throw Error(where+': sparse, accessor or extended array');
  const copy=[];
  for(let i=0;i<value.length;i++) {
    const descriptor=Object.getOwnPropertyDescriptor(value,i);
    if(!descriptor||!Object.hasOwn(descriptor,'value'))
      throw Error(where+': sparse or accessor element');
    copy.push(descriptor.value);
  }
  return copy;
}
function inertReport(value,backend) {
  const java=backend==='graal';
  const where=java?'Java report':'JS report';
  const root=inertRecord(value,
    java?JAVA_REPORT_FIELDS:JS_REPORT_FIELDS,
    java?JAVA_REPORT_FIELDS:JS_REQUIRED,where);
  const records=inertArray(root.results,java?256:REFERENCE_CASES.length,where+' results');
  root.results=records.map((v,i)=>{
    const fieldset=java?JAVA_RESULT_FIELDS:JS_RESULT_FIELDS;
    const required=java?['id','status']:['id','fixture_git_blob','kind','status'];
    const record=inertRecord(v,fieldset,required,where+' result '+i);
    for(const [key,val] of Object.entries(record)) {
      if(typeof val!=='string'&&typeof val!=='number')
        throw Error(where+' result '+i+': non-JSON scalar '+key);
      if(typeof val==='string'&&val.length>700)
        throw Error(where+' result '+i+': oversized field '+key);
      if(typeof val==='number'&&(!Number.isSafeInteger(val)||Object.is(val,-0)))
        throw Error(where+' result '+i+': noncanonical number '+key);
    }
    // A "pass" must carry exactly the observation appropriate for its
    // declared case. Reject conflicting extra outcomes rather than ignoring
    // them (including fake success records with an error in `detail`).
    const hasValue=Object.hasOwn(record,java?'observed_exit':'observed_int64');
    const hasDiagnostic=Object.hasOwn(record,'diagnostic_class');
    if(record.status==='pass') {
      if(java) {
        if(hasValue===hasDiagnostic)
          throw Error(where+' result '+i+': contradictory pass observations');
        if(Object.hasOwn(record,'detail')&&record.detail!=='')
          throw Error(where+' result '+i+': successful case contains error detail');
      } else if(record.kind==='value') {
        if(!hasValue||hasDiagnostic)
          throw Error(where+' result '+i+': contradictory value observation');
      } else if(record.kind==='diagnostic') {
        if(hasValue||!hasDiagnostic)
          throw Error(where+' result '+i+': contradictory diagnostic observation');
      } else {
        throw Error(where+' result '+i+': unknown result kind');
      }
    }
    return record;
  });
  for(const [key,val] of Object.entries(root)) {
    if(key==='results')continue;
    if(!['string','boolean','number'].includes(typeof val)||
       typeof val==='string'&&val.length>128||
       typeof val==='number'&&(!Number.isSafeInteger(val)||Object.is(val,-0)))
      throw Error(where+': invalid metadata '+key);
  }
  if(!java) {
    for(const flag of ['github_run_authenticated','java_js_semantic_parity_certified'])
      if(Object.hasOwn(root,flag)&&root[flag]!==false)
        throw Error('invalid or contradictory JS authentication flag');
    if(Object.hasOwn(root,'checked_fixture_count')&&
       root.checked_fixture_count!==REFERENCE_CASES.length)
      throw Error('invalid JS fixture count');
    for(const field of ['checkout_commit_sha','checkout_tree_sha'])
      if(Object.hasOwn(root,field)&&!/^[a-f0-9]{40}$/.test(root[field]))
        throw Error('invalid JS checkout identity');
  }
  if(!java) {
    // Either a raw in-process, explicitly non-attesting fixture report or
    // the COMPLETE locally observed checkout/Node metadata set. Partial
    // metadata can be inadvertently promoted by a downstream evidence reader.
    const provenanceFields=[
      'checkout_commit_sha','checkout_tree_sha','node_version',
      'checked_fixture_count','github_run_authenticated',
      'java_js_semantic_parity_certified'
    ];
    const present=provenanceFields.filter(k=>Object.hasOwn(root,k));
    // Preserve an actionable diagnostic for malformed supplied Node versions
    // even when the metadata bundle is otherwise incomplete.
    if(Object.hasOwn(root,'node_version')) {
      // This remains self-reported, never a source/run attestation.
      const match=/^v([1-9][0-9]*)\.([0-9]+)\.([0-9]+)(?:[-+][A-Za-z0-9.-]+)?$/
        .exec(root.node_version);
      if(!match||!Number.isSafeInteger(Number(match[1]))||
         Number(match[1])<22)
        throw Error('invalid Node runtime version (requires Node 22+)');
    }
    if(present.length!==0&&present.length!==provenanceFields.length)
      throw Error('incomplete JS checkout identity or execution metadata');
  }
  return root;
}

/**
 * Preferred external ingress. Parse JSON with bounded size, nesting,
 * complexity and unique-member admission. This is validation, not proof of
 * the origin or truthfulness of a report supplied by another party.
 */
export function compareJavaAndJsJsonReports(jsJson,graalJson) {
  return compareJavaAndJsReports(
    parseStrictJsonReport(jsJson,65536,'JS'),
    parseStrictJsonReport(graalJson,262144,'Java')
  );
}

export function compareJavaAndJsReports(js,graal) {
  js=inertReport(js,'js');
  graal=inertReport(graal,'graal');
  // No claim of provenance: this is a deliberately strict, structural
  // comparison over JSON-shaped reports. Authenticate CI separately.
  if(!js||js.format!==JS_PARITY_REPORT_FORMAT||js.backend!=='js'||
     js.fixture_authority!==FIXTURE_AUTHORITY||
     js.fixture_authority_revision!==JAVA_FIXTURE_REVISION||
     js.fixture_suite_sha256!==fixtureSuiteSha256()||
     js.integer_model!==PROGRAM_IR_INT_MODEL||
     js.execution!=='real-node-guest'||
     js.provenance_authenticated!==false||
     js.java_execution_verified!==false||
     !Array.isArray(js.results)||js.results.length!==REFERENCE_CASES.length)
    throw Error('invalid or incomplete JS fixture report');

  const jsLookup=new Map();
  for(const record of js.results) {
    if(!record||typeof record!=='object'||Array.isArray(record)||
       typeof record.id!=='string'||jsLookup.has(record.id))
      throw Error('duplicate/bad JS result');
    jsLookup.set(record.id,record);
  }
  if(!graal||graal.schema_version!=='1.1.0'||graal.backend!=='graal'||
     graal.suite_sha256!==JAVA_SEMANTIC_SUITE_SHA256||
     graal.source_revision!==JAVA_FIXTURE_REVISION||
     !Array.isArray(graal.results))throw Error('unverified Java report shape');
  const lookup=new Map();
  for(const r of graal.results){
    if(typeof r.id!=='string'||lookup.has(r.id))
      throw Error('duplicate/bad Java result');
    lookup.set(r.id,r);
  }
  if(lookup.size!==JAVA_GRAAL_MANIFEST.length)
    throw Error('missing/pending/failed required Java suite inventory');
  for(const {id,expected} of JAVA_GRAAL_MANIFEST) {
    const observation=lookup.get(id);
    if(!observation||observation.status!=='pass')
      throw Error('missing/pending/failed Java suite case '+id);
    if(typeof expected==='number') {
      if(observation.observed_exit!==expected)
        throw Error('backend value divergence: '+id);
    } else if(observation.diagnostic_class!==expected)
      throw Error('diagnostic-class divergence: '+id);
  }
  const checked=[];
  for(const caseInfo of REFERENCE_CASES) {
    const ja=lookup.get(caseInfo.id), jsr=jsLookup.get(caseInfo.id);
    if(!ja||ja.status!=='pass'||!jsr||jsr.status!=='pass'||
       jsr.kind!==caseInfo.kind||jsr.fixture_git_blob!==caseInfo.blob)
      throw Error('missing/pending/failed required reference case: '+caseInfo.id);
    if(caseInfo.kind==='value') {
      if(typeof jsr.observed_int64!=='string'||
         !/^(0|-?[1-9][0-9]*)$/.test(jsr.observed_int64)||
         !Number.isSafeInteger(ja.observed_exit)||
         ja.observed_exit!==Number(jsr.observed_int64)||
         jsr.observed_int64!==caseInfo.expected)
        throw Error('backend value divergence: '+caseInfo.id);
    } else if(ja.diagnostic_class!==caseInfo.expected||
              jsr.diagnostic_class!==caseInfo.expected)
      throw Error('diagnostic-class divergence: '+caseInfo.id);
    checked.push(caseInfo.id);
  }
  return {
    structural_result:'MATCHING_FIXTURE_RESULTS_ONLY',
    cases_compared:checked,
    ja_report_revision:graal.source_revision,
    js_fixture_suite_sha256:js.fixture_suite_sha256,
    java_runner_authenticated:false,
    source_to_binary_authenticated:false,
    full_java_js_parity_certified:false
  };
}
