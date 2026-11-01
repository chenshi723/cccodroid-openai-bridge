#!/bin/bash
set -euo pipefail
SOURCE=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
MARKET=${1:?用法：recipe/sync.sh <cccodroid-components 仓库绝对路径>}
[[ "$MARKET" = /* && -f "$MARKET/AGENTS.md" && -d "$MARKET/recipes" ]] || { printf '不是组件仓库：%s\n' "$MARKET" >&2; exit 1; }
DEST="$MARKET/recipes/openai-bridge"
mkdir -p "$DEST/runtime" "$DEST/skill"
for name in recipe.json openai-bridge; do cp -- "$SOURCE/recipe/$name" "$DEST/$name"; done
cp -- "$SOURCE/recipe/skill/SKILL.md" "$DEST/skill/SKILL.md"
for name in component.cjs installer.cjs gui-models.cjs package.json package-lock.json LICENSE LICENSE-CCR.txt NOTICE SECURITY.md; do cp -- "$SOURCE/$name" "$DEST/$name"; done
for name in patch-ccr.js bridge-common.sh start-bridge.sh watchdog.sh selftest.cjs health.cjs service-registration.cjs; do cp -- "$SOURCE/runtime/$name" "$DEST/runtime/$name"; done
printf '已同步 openai-bridge 配方与运行源文件到 %s\n' "$DEST"
