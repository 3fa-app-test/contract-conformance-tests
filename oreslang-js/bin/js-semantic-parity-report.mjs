#!/usr/bin/env node
// Executed JS fixture report. Never an attestation of Java runtime parity.
import {execFileSync} from 'node:child_process';
import {executeJsReferenceFixtures} from '../src/java-js-parity-v1.mjs';

function git(args) {
  return execFileSync('git',args,{encoding:'utf8',timeout:3000,
    maxBuffer:8192,stdio:['ignore','pipe','ignore']}).trim();
}
try {
  if(process.argv.length!==2)throw Error('usage: node bin/js-semantic-parity-report.mjs');
  const report=await executeJsReferenceFixtures();
  const checkoutCommit=git(['rev-parse','--verify','HEAD']);
  const checkoutTree=git(['rev-parse','--verify','HEAD^{tree}']);
  if(!/^[a-f0-9]{40}$/.test(checkoutCommit)||!/^[a-f0-9]{40}$/.test(checkoutTree))
    throw Error('invalid Git checkout identity');
  const result={...report,checkout_commit_sha:checkoutCommit,
    checkout_tree_sha:checkoutTree,
    node_version:process.version,
    checked_fixture_count:report.results.length,
    // Tree identity is auditable, but this report cannot self-attest an Actions job.
    github_run_authenticated:false,
    java_js_semantic_parity_certified:false};
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
} catch(error) {
  console.error('JS semantic fixture execution failed: '+String(error?.message??error));
  process.exitCode=1;
}
