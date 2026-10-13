#!/bin/bash
# Proto linting. Read-only by design: it must never rewrite the files it
# checks, or CI would silently package whatever it reformatted.
set -euo pipefail

if ! command -v buf >/dev/null 2>&1; then
	# Previously this script used `set -u` alone, which does not stop on a failed
	# command. A missing buf made `buf lint` exit 127, the script kept going, and
	# the exit status came from the trailing grep — so proto lint passed without
	# ever running. Failing loudly is the point of a lint step.
	echo "Error: buf is not installed, so proto lint did not run." >&2
	echo "Install it with: npm install -g @bufbuild/buf   (or see https://buf.build/docs/installation)" >&2
	echo "If you are formatting rather than linting, run: bun run format:proto" >&2
	exit 1
fi

buf lint

# No -w here. Use `bun run format:proto` to write changes; a lint step that
# edits the working tree cannot fail on drift and hides the drift instead.
if ! buf format --exit-code >/dev/null; then
	echo "Error: proto files are not formatted. Run: bun run format:proto" >&2
	exit 1
fi

if grep -rn "rpc .*[A-Z][A-Z].*[(]" --include="*.proto"; then
	# See https://github.com/cline/cline/pull/7054
	echo "Error: Proto RPC names cannot contain repeated capital letters" >&2
	exit 1
fi