/** Trusted build-time package for browser/edge JS hosts; no guest execution. */
import {lstat, open, mkdtemp, mkdir, link, writeFile, rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, basename, join, resolve} from 'node:path';
import {TextDecoder} from 'node:util';
import {compileToIR, compileIR} from './compiler.mjs';
import {HOST_ABI} from './host-bridge.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Create a never-overwritten output directory containing module.mjs/manifest.json.
 * Caller must pin and review compiler and source independently; a digest is not authorization.
 */
export async function buildPackage({sourceFile, outputDir, target='edge-js', declaredCompilerSha}={}) {
  if (!['edge-js','browser'].includes(target)) throw Error('unsupported JS host target');
  if (!/^[0-9a-f]{40}$/.test(declaredCompilerSha || '')) throw Error('exact declared compiler SHA required');
  if (typeof sourceFile !== 'string' || typeof outputDir !== 'string') throw Error('source and output paths required');
  const input = resolve(sourceFile), dest = resolve(outputDir);
  // Read from one file descriptor, without following a final-component
  // symlink. Bound actual bytes even if the source changes while being read.
  const before=await lstat(input);
  if(!before.isFile() || before.isSymbolicLink() || before.size > 262144)
    throw Error('source must be a bounded regular non-symlink file');
  const flags=constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0);
  const file=await open(input,flags);
  let sourceBytes;
  try{
    const stat=await file.stat();
    if(!stat.isFile() || stat.size > 262144 ||
       before.dev!==stat.dev || before.ino!==stat.ino)
      throw Error('source changed or is not a bounded regular file');
    const chunks=[];let size=0;
    while(size<=262144){
      const b=Buffer.allocUnsafe(Math.min(65536,262145-size));
      const {bytesRead}=await file.read(b,0,b.length,null);
      if(!bytesRead)break;
      size+=bytesRead;
      if(size>262144)throw Error('source grew beyond limit');
      chunks.push(b.subarray(0,bytesRead));
    }
    sourceBytes=Buffer.concat(chunks,size);
  }finally{await file.close();}
  const source = new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(sourceBytes);
  const ir = compileToIR(source);
  const generated = compileIR(ir);
  const emitted = Buffer.from(generated,'utf8');
  if (emitted.length > 4194304) throw Error('generated module exceeds package limit');
  // Derive the manifest from validated IR, not text patterns in generated JS.
  const exports = ir.functions.filter(fn => fn.pub).map(fn => fn.name);
  if (exports.length > 128 || new Set(exports).size !== exports.length)
    throw Error('unsupported public entrypoint count');
  const manifest = {
    schemaVersion:1, backend:'javascript', target, hostABI:HOST_ABI,
    module:'module.mjs', declaredCompilerSha,
    sourceSha256:digest(sourceBytes), moduleSha256:digest(emitted),
    publicEntrypoints:exports, declaredCapabilities:[],
    provenanceNote:'The compiler SHA is caller-declared, not independently attested. A hash is not an authorization or a sandbox.'
  };
  const parent = dirname(dest);
  // The caller must control the parent directory. Cross-process attackers with
  // write access to the parent can replace paths despite any JS-only checks.
  const temp = await mkdtemp(join(parent,'.'+basename(dest)+'.staging-'));
  try {
    await writeFile(join(temp,'module.mjs'),emitted,{flag:'wx',mode:0o600});
    await writeFile(join(temp,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    try { await mkdir(dest,{mode:0o700}); }
    catch(error) {
      if (error.code === 'EEXIST') throw Error('refusing to overwrite an existing package');
      throw error;
    }
    // Reserve destination exclusively, then link each fully written file.
    // Manifest is published last as the ready marker. If interrupted, leave
    // an incomplete directory that the verifying host must fail closed on.
    await link(join(temp,'module.mjs'),join(dest,'module.mjs'));
    await link(join(temp,'manifest.json'),join(dest,'manifest.json'));
  } finally {
    await rm(temp,{recursive:true,force:true});
  }
  return manifest;
}
