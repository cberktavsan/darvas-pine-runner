#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Starts the server runner from a built bundle directory (default: dist-server).
# The front process may listen, read its settings and start the child; nothing else.
set -euo pipefail
dir="$(cd "${1:-dist-server}" && pwd)"
export PINE_RUNNER_CHILD="$dir/child.js"
exec deno run --no-prompt --no-config --no-remote --no-npm \
  --allow-net="${PINE_RUNNER_HOST:-127.0.0.1}:${PINE_RUNNER_PORT:-8787}" \
  --allow-env=PINE_RUNNER_PORT,PINE_RUNNER_HOST,PINE_RUNNER_TOKEN,PINE_RUNNER_CHILD,PINE_RUNNER_CONCURRENCY \
  --allow-run="$(command -v deno)" \
  "$dir/main.js"
