#!/bin/bash
# SessionStart：串行打补丁、确保单例看护存在，并等到桥真正就绪。
umask 077
BR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || exit 1
source "$BR/bridge-common.sh" || exit 1
unset CCAPP_RUN CLAUDECODE CLAUDE_CODE_ENTRYPOINT
mkdir -p "$STATE" || exit 1
LOG="$STATE/start.log"

fail() {
  printf '[start-bridge] %s\n' "$*" | tee -a "$LOG" >&2
  exit 1
}

for cmd in node flock setsid timeout; do
  command -v "$cmd" >/dev/null 2>&1 || fail "缺少命令：$cmd"
done
[[ -r "$CLI" && -r "$BR/watchdog.sh" ]] || fail "桥文件不完整：$BR"

# 两把短锁分别保护会话并发，以及与看护之间的补丁/重启竞争。
exec 9> "$STATE/start.lock" || fail "无法打开启动锁"
flock -w 10 9 || fail "等待其他启动检查超时"
# 首次迁移前的旧看护没有锁，不能与新看护并跑；明确报错，不偷偷停止现有工作负载。
if ! watchdog_running; then
  for PROC in /proc/[0-9]*/cmdline; do
    ARGS=()
    { mapfile -d '' -t ARGS < "$PROC"; } 2>/dev/null || continue
    if [[ ${#ARGS[@]} -ge 2 && ${ARGS[0]##*/} = bash && ${ARGS[1]} = "$BR/watchdog.sh" ]]; then
      sleep 0.2
      watchdog_running || fail "发现尚未迁移的看护（${PROC%/cmdline}），需先确认并替换旧看护"
      break
    fi
  done
fi
exec 7> "$STATE/service.lock" || fail "无法打开服务锁"
flock -w 10 7 || fail "等待看护操作超时"
timeout --kill-after=2 10 node "$BR/patch-ccr.js" >> "$LOG" 2>&1
PATCHED=$?
case "$PATCHED" in
  0) ;;
  2) touch "$STATE/restart.request" || fail "无法记录补丁重启请求" ;;
  *) fail "补丁检查失败（退出码 $PATCHED），详情：$LOG" ;;
esac
flock -u 7
exec 7>&-
# 就绪等待不占启动锁，多个会话可一起等，避免冷启动时彼此等锁超时。
flock -u 9
exec 9>&-

# 看护自身也持有生命周期锁；旧看护刚退出但子进程尚未释放 FD 时，稍后重试。
DEADLINE=$((SECONDS + START_TIMEOUT))
while (( SECONDS < DEADLINE )); do
  if watchdog_running; then
    if [[ ! -e "$STATE/restart.request" ]] && bridge_healthy; then
      exit 0
    fi
  elif flock -n "$STATE/watchdog.lock" true; then
    setsid env -u CCAPP_RUN -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
      bash "$BR/watchdog.sh" >> "$STATE/bridge.out" 2>&1 < /dev/null &
  fi
  sleep 0.2
done
fail "桥或看护在 ${START_TIMEOUT}s 内未就绪，详情：$STATE/bridge.out"
