#!/usr/bin/env bash
set -euo pipefail
artifact="$1"
node --input-type=module - "$artifact.mjs" <<'NODE'
import {pathToFileURL} from "node:url";
const modulePath = process.argv[2];
const ns = await import(pathToFileURL(modulePath).href);
let entry = typeof ns.main === "function" ? ns.main : null;
if (!entry) {
  const candidates = [];
  for (const value of Object.values(ns)) {
    if (value && typeof value === "object" && typeof value.main === "function") {
      candidates.push(value.main);
    }
  }
  if (candidates.length !== 1) {
    throw new Error("expected exactly one Oreslang main entrypoint, found " + candidates.length);
  }
  entry = candidates[0];
}
const result = await entry();
let status;
if (typeof result === "bigint") status = Number(result);
else if (typeof result === "number" && Number.isInteger(result)) status = result;
else throw new Error("Oreslang main did not return an integer result");
if (!Number.isSafeInteger(status) || status < 0 || status > 125) {
  throw new Error("parity adapter only admits portable status range 0..125; got " + status);
}
process.exit(status);
NODE
