# Shared helpers for the local loop. Source this; do not execute it.
# Git Bash on Windows and bash on Linux.

step() { printf '==> %s\n' "$*"; }

port_open() {
  node -e 'const n=require("net"); const p=Number(process.argv[1]); const s=n.connect(p,"127.0.0.1",()=>{s.end(); process.exit(0)}); s.on("error",()=>process.exit(1)); setTimeout(()=>process.exit(1),1500);' "$1"
}

wait_http() {
  local url=$1 tries=${2:-60} i
  for ((i = 1; i <= tries; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf 'timed out waiting for %s\n' "$url" >&2
  return 1
}

# Stop a process started by start_detached. The pid file is removed either way.
stop_pid() {
  local file=$1 pid
  if [[ ! -f $file ]]; then
    return 0
  fi
  pid=$(tr -d '[:space:]' < "$file" || true)
  rm -f "$file"
  if [[ -z ${pid:-} ]]; then
    return 0
  fi
  if command -v taskkill >/dev/null 2>&1; then
    # Git Bash rewrites "/F" into a Windows path. "//F" stays a flag.
    taskkill //F //T //PID "$pid" >/dev/null 2>&1 || true
  else
    kill -- "-$pid" >/dev/null 2>&1 || kill "$pid" >/dev/null 2>&1 || true
  fi
}

# Background a command and record its OS pid. The process survives this shell exiting.
# Node records the pid: Git Bash $! is an MSYS pid and taskkill does not see it.
start_detached() {
  local pidfile=$1 logfile=$2
  shift 2
  node "$root/scripts/start-detached.mjs" "$pidfile" "$logfile" "$@"
}

export DATABASE_URL="${DATABASE_URL:-postgres://readmeter:readmeter@127.0.0.1:5442/readmeter}"
