#!/usr/bin/env bash
set -euo pipefail
source_file="$1"
artifact="$2"
node "$GITHUB_WORKSPACE/oreslang-js/bin/oreslang-jsc.mjs" --program-v2 "$source_file" "--out=$artifact.mjs"
