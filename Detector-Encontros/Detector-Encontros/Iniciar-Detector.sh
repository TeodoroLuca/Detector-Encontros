#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js nao encontrado. Instale Node.js 22 ou superior com npm e tente novamente.' >&2
  exit 1
fi
exec node "$project_dir/scripts/launch.mjs" "$@"
