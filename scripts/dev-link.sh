#!/usr/bin/env bash
# Link the DSH packages this plugin resolves at runtime into node_modules, so
# `npm test` can import them without a build. The installed plugin resolves
# them from the DSH profile instead; these links exist only for local tests.
set -euo pipefail
source_dir="${1:-$HOME/.dsh/profiles/node_modules/@deepseek-ai}"
cd "$(dirname "$0")/.."
# A fresh clone has no node_modules at all; lay down the one runtime dependency first.
[ -d node_modules/ws ] || npm install --no-audit --no-fund
mkdir -p node_modules/@deepseek-ai
for package in dsh-llm dsh-session schemastery dsh-credentials dsh-launch-environment; do
  [ -d "$source_dir/$package" ] || continue
  ln -sfn "$source_dir/$package" "node_modules/@deepseek-ai/$package"
done
echo "linked DSH packages from $source_dir"
