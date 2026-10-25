#!/usr/bin/env node
// Numeric evidence from a real Node.js execution; never Java/Graal parity.
import {execFileSync} from 'node:child_process';
import {executeJsNumericBoundaryProbes} from '../src/js-numeric-boundary-v1.mjs';
try {
 if(process.argv.length!==2)throw Error('usage: node bin/js-numeric-boundary-report.mjs');
 const git=args=>execFileSync('git',args,{encoding:'utf8',timeout:3000,
   maxBuffer:8192,stdio:['ignore','pipe','ignore']}).trim();
 const report=await executeJsNumericBoundaryProbes();
 const checkout_commit_sha=git(['rev-parse','--verify','HEAD']);
 const checkout_tree_sha=git(['rev-parse','--verify','HEAD^{tree}']);
 if(!/^[a-f0-9]{40}$/.test(checkout_commit_sha)||
    !/^[a-f0-9]{40}$/.test(checkout_tree_sha))
   throw Error('unverified local checkout identity');
 process.stdout.write(JSON.stringify({
   ...report,checkout_commit_sha,checkout_tree_sha,
   node_version:process.version,github_run_authenticated:false
 },null,2)+'\n');
} catch(error) {
 console.error('Numeric evidence failed: '+String(error?.message??error));
 process.exitCode=1;
}
