/**
 * Bound and validate externally supplied parity JSON before materializing it.
 * Duplicate keys (including escaped aliases), nonfinite numbers and excessive
 * nesting/complexity are rejected. This does not authenticate report provenance.
 */
export function parseStrictJsonReport(text,maximum,where) {
  if(typeof text!=='string'||!Number.isSafeInteger(maximum)||maximum<0||
     Buffer.byteLength(text,'utf8')>maximum)
    throw Error(where+': missing or oversized JSON report');
  let at=0,values=0;
  const fail=reason=>{throw Error(where+': '+reason);};
  const invalid=()=>fail('invalid JSON report');
  const spaces=()=>{while(at<text.length&&/[ \t\r\n]/.test(text[at]))at++;};
  function quoted() {
    if(text[at]!=='"')invalid();
    const start=at++;
    while(at<text.length) {
      const ch=text[at++];
      if(ch==='"') {
        try {return JSON.parse(text.slice(start,at));}
        catch {invalid();}
      }
      if(ch==='\\')at++;
    }
    invalid();
  }
  function value(depth) {
    if(depth>64||++values>20000)fail('JSON report depth or complexity exceeded');
    spaces();
    if(text[at]==='{') {
      at++;spaces();
      const seen=new Set();
      if(text[at]==='}') {at++;return;}
      for(;;) {
        spaces();
        const key=quoted();
        if(seen.has(key))fail('duplicate JSON member');
        seen.add(key);
        spaces();
        if(text[at++]!==':')invalid();
        value(depth+1);
        spaces();
        if(text[at]===','){at++;continue;}
        if(text[at]==='}'){at++;return;}
        invalid();
      }
    }
    if(text[at]==='[') {
      at++;spaces();
      if(text[at]===']'){at++;return;}
      for(;;) {
        value(depth+1);
        spaces();
        if(text[at]===','){at++;continue;}
        if(text[at]===']'){at++;return;}
        invalid();
      }
    }
    if(text[at]==='"') {quoted();return;}
    const start=at;
    while(at<text.length&&!/[,}\]\x20\t\r\n]/.test(text[at]))at++;
    const token=text.slice(start,at);
    if(token==='true'||token==='false'||token==='null')return;
    if(!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token))invalid();
    if(!Number.isFinite(Number(token)))fail('non-finite JSON number');
  }
  value(0);spaces();
  if(at!==text.length)invalid();
  // Only admitted, bounded text reaches full object/array materialization.
  try {return JSON.parse(text);}
  catch {invalid();}
}
