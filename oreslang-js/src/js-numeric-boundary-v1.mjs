/**
 * Executable numeric boundary witnesses for the experimental JS backend.
 * Never treat the host Java long wrap oracle as Java/Graal Oreslang execution.
 */
import {createHash} from 'node:crypto';
import {compileProgramV2} from './program-v2.mjs';
import {PROGRAM_IR_INT_MODEL} from './program-ir-v2.mjs';

const MAX='9223372036854775807';
const MIN='(-9223372036854775807-1)';
const probes=[
  ['max','9223372036854775807','value','9223372036854775807'],
  ['min',MIN,'value','-9223372036854775808'],
  ['max-minus-one',MAX+'-1','value','9223372036854775806'],
  ['min-plus-one',MIN+'+1','value','-9223372036854775807'],
  ['positive-cancel','9223372036854775807-9223372036854775807','value','0'],
  ['multiply-zero',MAX+'*0','value','0'],
  ['negative-modulo','(-5)%3','value','-2'],
  ['min-mod-minus-one',MIN+'%-1','value','0'],
  ['positive-add-overflow',MAX+'+1','checked-overflow',null],
  ['negative-sub-overflow',MIN+'-1','checked-overflow',null],
  ['multiply-overflow',MAX+'*2','checked-overflow',null],
  ['negate-min','-'+MIN,'checked-overflow',null],
  ['multiply-min-negative-one',MIN+'*-1','checked-overflow',null],
  ['intermediate-add-overflow',MAX+'+1-1','checked-overflow',null],
  ['intermediate-mul-overflow','('+MAX+'*2)%5','checked-overflow',null],
  ['modulo-by-zero','1%0','division-by-zero',null]
];
export const NUMERIC_PROBES=Object.freeze(probes.map(([id,expression,expected_kind,expected_value])=>
  Object.freeze({id,expression,expected_kind,expected_value})));
// Java/Graal checked-i64-v1 requires this *exact* first source line.
// Never collect a "checked" witness from an unmarked, legacy-wrap source.
export const CHECKED_I64_SOURCE_DIRECTIVE='// oreslang:checked-i64-v1\n';
export function numericProbeGuestSource(expression) {
  // Source receipts may only execute expressions in the audited inventory.
  // Do not let an externally supplied value forge a new witness source.
  if(typeof expression!=='string'||
      !NUMERIC_PROBES.some(probe=>probe.expression===expression))
    throw TypeError('unlisted checked-i64 numeric witness expression');
  return CHECKED_I64_SOURCE_DIRECTIVE+
    'pub fnc main(): int {return '+expression+';}\n';
}
export function numericProbeSuiteSha256(){
  const h=createHash('sha256').update('oreslang-js-numeric-boundary-v1\0');
  for(const p of NUMERIC_PROBES) {
    // Bind the suite identity to *actual executable Oreslang source bytes*,
    // including the exact checked directive, not merely numeric expectations.
    for(const field of [p.id,p.expression,p.expected_kind,p.expected_value??'',
      numericProbeGuestSource(p.expression)]){
      const b=Buffer.from(field,'utf8');
      const n=Buffer.alloc(8);n.writeBigUInt64BE(BigInt(b.length));
      h.update(n).update(b);
    }
  }
  return h.digest('hex');
}
export async function executeJsNumericBoundaryProbes(){
  if(PROGRAM_IR_INT_MODEL!=='signed-i64-checked-provisional')
    throw Error('numeric probe oracle requires checked-i64 IR');
  const results=[];
  for(const p of NUMERIC_PROBES) {
    const source=numericProbeGuestSource(p.expression);
    const compiled=compileProgramV2(source);
    const namespace=await import('data:text/javascript,'+encodeURIComponent(compiled));
    let kind, value=null;
    try {
      const result=namespace.main();
      if(typeof result!=='bigint')throw Error('unexpected guest result type');
      kind='value';value=result.toString();
    } catch(error) {
      if(error instanceof RangeError&&error.message.startsWith('ORES_I64_OVERFLOW:'))
        kind='checked-overflow';
      else if(error instanceof RangeError&&
        error.message.startsWith('ORES_I64_DIVISION_BY_ZERO:'))
        kind='division-by-zero';
      else throw Error('unknown JS numeric failure '+p.id+': '+String(error));
    }
    if(kind!==p.expected_kind||value!==p.expected_value)
      throw Error('numeric fixture mismatch '+p.id+': '+kind+'/'+value);
    results.push({id:p.id,observed_kind:kind,...(kind==='value'?{observed_int64:value}:{})});
  }
  return {
    format:'oreslang-js-numeric-boundary-v1',
    backend:'js',
    integer_model:PROGRAM_IR_INT_MODEL,
    suite_sha256:numericProbeSuiteSha256(),
    execution:'real-node-guest',
    java_graal_execution_verified:false,
    cross_backend_arithmetic_parity_certified:false,
    results
  };
}
