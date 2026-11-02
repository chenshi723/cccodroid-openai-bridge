#!/bin/bash
# 持续探活，而不是前台等待 Node；退出看护本身不会中断正在运行的桥。
umask 077
BR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || exit 1
source "$BR/bridge-common.sh" || exit 1
unset CCAPP_RUN CLAUDECODE CLAUDE_CODE_ENTRYPOINT
mkdir -p "$STATE" || exit 1
cd "$BR" || exit 1
exec 8> "$STATE/watchdog.lock" || exit 1
flock -n 8 || exit 0
printf '%s\n' "$$" > "$STATE/watchdog.pid" || exit 1

cleanup() {
  if [[ -r "$STATE/watchdog.pid" && $(< "$STATE/watchdog.pid") = "$$" ]]; then
    rm -f -- "$STATE/watchdog.pid"
  fi
}
trap cleanup EXIT
trap 'exit 0' TERM INT HUP

FAILURES=0
FAILED_SINCE=$SECONDS
LAST_START=$((-GRACE))
HEALTHY_SINCE=-1
ATTEMPTS=0
LAST_FAILURE='recovery limit reached'
SERVICE_LOCKED=0
COMPONENT_STAMP=
RECHECK_INSTANCE=0
CONFIRM_INSTANCE=
ENSURE_INSTANCE=
ENSURE_DEADLINE=-1
load_attempts() {
  ATTEMPTS=0
  if [[ -r "$STATE/recovery.attempts" ]]; then
    ATTEMPTS=$(< "$STATE/recovery.attempts")
    [[ "$ATTEMPTS" =~ ^[0-9]{1,3}$ ]] || ATTEMPTS=$RECOVERY_LIMIT
  fi
}
load_attempts
[[ ! -e "$STATE/recovery.failed" && ! -L "$STATE/recovery.failed" ]] || exit 1
release_service() {
  flock -u 7 || exit 1
  SERVICE_LOCKED=0
}
# 明确 disabled（配置/升级/卸载）只停止看护，不制造需要 reset 的永久故障锁。
# 真正缺失/无效才在有界确认后锁停；已有故障锁绝不覆盖、更不能自动清除。
require_component() {
  local stamp rc unlocked=0
  [[ ! -e "$STATE/recovery.failed" && ! -L "$STATE/recovery.failed" ]] || exit 1
  stamp=$(bridge_component_state "$COMPONENT_STAMP"); rc=$?
  if (( rc == 3 )); then
    # 只读确认不占服务锁。放弃旧事务，而不是解锁后续跑旧 PID/补丁/恢复预算。
    # 返回主循环重验健康并非阻塞取锁；同一元数据身份贯穿确认与重新取锁后的检查。
    COMPONENT_STAMP=$stamp
    HEALTHY_SINCE=-1
    BRIDGE_HEALTH_LOG_HEALTHY_SINCE=-1
    CONFIRM_INSTANCE=$(bridge_instance) || CONFIRM_INSTANCE=
    RECHECK_INSTANCE=1
    if (( SERVICE_LOCKED )); then
      release_service
      unlocked=1
    fi
    bridge_component_confirm "$stamp"; rc=$?
  fi
  [[ ! -e "$STATE/recovery.failed" && ! -L "$STATE/recovery.failed" ]] || exit 1
  if (( rc == 0 )); then
    COMPONENT_STAMP=$stamp
    (( unlocked )) && return 4
    return 0
  fi
  if (( rc == 2 )); then
    bridge_log watchdog "组件已明确停用；不再重启（保留既有恢复预算）"
  else
    if [[ ! -e "$STATE/recovery.failed" && ! -L "$STATE/recovery.failed" ]]; then
      ( set -o noclobber; printf 'component removed or disabled\n' > "$STATE/recovery.failed" ) 2>/dev/null || true
    fi
    bridge_log watchdog "组件入口持续缺失或安装标记无效；不再重启，请用私有副本 uninstall.sh 清理"
  fi
  exit 0
}
# 锁外确认后只在重新持锁时比较实例。别的 ensure 已启动的新桥先给有界就绪时间，
# 不能因它尚未监听而沿旧故障流程立刻杀掉；到期后仍失败才允许新的恢复事务。
recheck_ensure() {
  local current
  if (( RECHECK_INSTANCE )); then
    current=$(bridge_instance) || current=
    RECHECK_INSTANCE=0
    if [[ -n "$current" && "$current" != "$CONFIRM_INSTANCE" ]]; then
      ENSURE_INSTANCE=$current
      ENSURE_DEADLINE=$((SECONDS + START_TIMEOUT))
      HEALTHY_SINCE=-1
      BRIDGE_HEALTH_LOG_HEALTHY_SINCE=-1
      FAILURES=0
      FAILED_SINCE=$SECONDS
    fi
  fi
  [[ -n "$ENSURE_INSTANCE" ]] || return 0
  current=$(bridge_instance) || current=
  if [[ "$current" != "$ENSURE_INSTANCE" ]] || (( SECONDS >= ENSURE_DEADLINE )); then
    ENSURE_INSTANCE=
    return 0
  fi
  if [[ ! -e "$STATE/restart.request" ]] && bridge_healthy; then
    ENSURE_INSTANCE=
    return 0
  fi
  release_service
  sleep "$INTERVAL"
  return 4
}
exec 7> "$STATE/service.lock" || exit 1
while :; do
  [[ ! -e "$STATE/recovery.failed" && ! -L "$STATE/recovery.failed" ]] || exit 1
  require_component || continue
  if [[ ! -e "$STATE/restart.request" ]] && bridge_healthy; then
    FAILURES=0
    FAILED_SINCE=$SECONDS
    (( HEALTHY_SINCE >= 0 )) || HEALTHY_SINCE=$SECONDS
    if (( ATTEMPTS > 0 && SECONDS - HEALTHY_SINCE >= RECOVERY_STABLE )) && flock -n 7; then
      SERVICE_LOCKED=1
      require_component || continue
      recheck_ensure || continue
      # 持锁重新验健康及 durable 预算；确认等待/别的 ensure 的新预算都不能被旧快照清掉。
      PREVIOUS_ATTEMPTS=$ATTEMPTS
      load_attempts
      if [[ ! -e "$STATE/restart.request" ]] && bridge_healthy; then
        if (( HEALTHY_SINCE >= 0 && SECONDS - HEALTHY_SINCE >= RECOVERY_STABLE && ATTEMPTS == PREVIOUS_ATTEMPTS )); then
          ATTEMPTS=0
          rm -f -- "$STATE/recovery.attempts"
        else
          HEALTHY_SINCE=$SECONDS
        fi
      else
        HEALTHY_SINCE=-1
      fi
      release_service
    fi
    sleep "$INTERVAL"
    continue
  fi
  HEALTHY_SINCE=-1
  BRIDGE_HEALTH_LOG_HEALTHY_SINCE=-1

  ((FAILURES++))
  PID=$(bridge_pid) || PID=
  if [[ ! -e "$STATE/restart.request" ]]; then
    # 留出启动宽限；连续失败才重启，避免短暂调度延迟就误杀正在推理的桥。
    if (( SECONDS - LAST_START < GRACE )) ||
      { [[ -n "$PID" ]] && (( FAILURES < FAIL_LIMIT || SECONDS - FAILED_SINCE < GRACE )); }; then
      sleep "$INTERVAL"
      continue
    fi
  fi

  if ! flock -n 7; then
    sleep 0.2
    continue
  fi
  SERVICE_LOCKED=1
  require_component || continue
  recheck_ensure || continue
  load_attempts
  if [[ ! -e "$STATE/restart.request" ]] && bridge_healthy; then
    release_service
    continue
  fi

  if (( ATTEMPTS >= RECOVERY_LIMIT )); then
    printf '%s\n' "$LAST_FAILURE" > "$STATE/recovery.failed"
    bridge_log watchdog "自动恢复已停止：连续启动/修补尝试达到 $RECOVERY_LIMIT 次，需排查后显式重置"
    release_service
    exit 1
  fi
  ((ATTEMPTS++))
  printf '%s\n' "$ATTEMPTS" > "$STATE/recovery.attempts.tmp"
  mv -f -- "$STATE/recovery.attempts.tmp" "$STATE/recovery.attempts" || exit 1
  LAST_START=$SECONDS

  # 独立重拉时也必须先验证补丁，升级覆盖或补丁失败不能悄悄启动旧代码。
  timeout --kill-after=2 10 node "$BR/patch-ccr.js" >> "$STATE/start.log" 2>&1
  PATCHED=$?
  if [[ "$PATCHED" != 0 && "$PATCHED" != 2 ]]; then
    LAST_FAILURE='patch verification failed'
    bridge_log watchdog "patch failed ($PATCHED); see $STATE/start.log"
    release_service
    sleep "$INTERVAL"
    continue
  fi

  # 若入口确认要让出锁并丢弃旧事务，仍保留本次补丁确有变更的重启意图。
  if (( PATCHED == 2 )); then
    touch "$STATE/restart.request" || exit 1
  fi
  LAST_FAILURE='recovery limit reached'
  require_component || continue
  PID=$(bridge_pid) || PID=
  if [[ -n "$PID" ]]; then
    bridge_log watchdog "restarting bridge PID $PID after patch or repeated health failures"
    if ! bridge_stop "$PID"; then
      bridge_log watchdog "could not safely stop PID $PID; not starting a duplicate"
      release_service
      sleep "$INTERVAL"
      continue
    fi
  elif [[ -r "$PIDFILE" ]]; then
    # 重启设备后 PID 会被复用；只清理已经核实不属于桥的旧记录，绝不杀无关进程。
    STALE=$(< "$PIDFILE")
    bridge_log watchdog "discarding stale or unrelated PID record: $STALE"
    rm -f -- "$PIDFILE"
  fi

  require_component || continue
  # 两个锁 FD 绝不能传给常驻子进程；否则看护退出后单例锁仍无法释放。
  bridge_log watchdog "starting bridge"
  setsid env -u CCAPP_RUN -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
    node "$CLI" start >> "$STATE/bridge.out" 2>&1 < /dev/null 7>&- 8>&- &
  rm -f -- "$STATE/restart.request"
  LAST_START=$SECONDS
  FAILED_SINCE=$SECONDS
  FAILURES=0
  release_service
  sleep "$INTERVAL"
done
