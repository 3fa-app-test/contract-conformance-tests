// Reference-only checked-i64 arithmetic. Deliberately NOT a JavaScript
// Oreslang compiler, and NOT a decision about canonical language overflow.
import test from "node:test";
import assert from "node:assert/strict";
const MIN=-(1n<<63n), MAX=(1n<<63n)-1n;
const checked=x=>{
 if(typeof x!=="bigint"||x<MIN||x>MAX)throw RangeError("signed i64 overflow");
 return x;
};
const binary=(a,op,b)=>{
 checked(a);checked(b);
 switch(op){
 case "+":return checked(a+b);
 case "-":return checked(a-b);
 case "*":return checked(a*b);
 default:throw TypeError("unsupported exact-i64 operation");
 }
};
test("exact BigInt arithmetic never rounds through a Number",()=>{
 assert.equal(binary(9007199254740993n,"+",1n),9007199254740994n);
 assert.equal(binary(MIN,"+",MAX),-1n);
 assert.equal(binary(MAX,"-",MAX),0n);
});
test("checked profile rejects boundaries without returning wrapped output",()=>{
 for(const [a,op,b] of [
  [MAX,"+",1n],[MIN,"-",1n],[MAX,"*",2n],[MIN,"*",-1n]
 ])assert.throws(()=>binary(a,op,b),/signed i64 overflow/);
 assert.throws(()=>checked(-MIN),/signed i64 overflow/);
});
test("intermediate overflow is fatal even when final mathematical result fits",()=>{
 assert.throws(()=>binary(binary(MAX,"+",1n),"-",1n),/signed i64 overflow/);
 assert.throws(()=>binary(1n,"/",1n),/unsupported exact-i64/);
 assert.throws(()=>binary(Number.MAX_SAFE_INTEGER,"+",1n),/signed i64 overflow/);
});
