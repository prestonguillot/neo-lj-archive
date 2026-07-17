#!/usr/bin/env bash
# One place to tail, always: archive/audit/run.log
#
#   ./scripts/audit-chunk.sh [n]
#
# Appends rather than truncates, so every chunk's history survives and a
# `tail -f` never has to be restarted. Gitignored with the rest of archive/.
set -uo pipefail
# pipefail is load-bearing. Without it this script's exit status is grep's, so
# when it called `stdbuf` — which does not exist on macOS; it is GNU coreutils —
# the run died on the first line and still exited 0. A no-op that reports success
# is worse than a crash, because a crash tells you.

LOG=./archive/audit/run.log
mkdir -p ./archive/audit

{
  echo ""
  echo "===== chunk start $(date '+%Y-%m-%d %H:%M:%S') — target ${1:-40} ====="
} >>"$LOG"

# grep --line-buffered, and nothing else. BSD grep has it, and it alone keeps the
# log honest: grep block-buffers at 4KB when its stdout is a file, so a tail
# freezes for ~90 lines at a stretch while the run is perfectly healthy.
npx tsx scripts/audit-vs-live.mts "${1:-40}" 2>&1 |
  grep --line-buffered -vE "ExperimentalWarning|trace-warnings" >>"$LOG"
status=${PIPESTATUS[0]}

if [ "$status" -eq 0 ]; then
  echo "===== chunk end   $(date '+%Y-%m-%d %H:%M:%S') =====" >>"$LOG"
else
  echo "===== chunk FAILED (exit $status) at $(date '+%Y-%m-%d %H:%M:%S') =====" >>"$LOG"
fi
exit "$status"
