#!/bin/bash
# Writes buf's canonical formatting to the proto files. Kept separate from
# proto-lint so that linting stays read-only.
set -euo pipefail

if ! command -v buf >/dev/null 2>&1; then
	echo "Error: buf is not installed, so proto files were NOT formatted." >&2
	echo "Install it with: npm install -g @bufbuild/buf   (or see https://buf.build/docs/installation)" >&2
	exit 1
fi

buf format -w
echo "Proto files formatted."