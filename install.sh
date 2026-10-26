#!/bin/bash
# 可从共享目录读取安装器，但依赖与运行文件只安装到应用私有目录。
set -e
HERE=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
command -v node >/dev/null 2>&1 || { printf '缺少 Node.js，请先安装 cccodroid 的开发工具包。\n' >&2; exit 1; }
exec node "$HERE/installer.cjs" install "$@"
