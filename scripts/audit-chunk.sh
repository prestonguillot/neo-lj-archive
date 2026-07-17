#!/usr/bin/env bash
# One place to tail, always: archive/audit/run.log
#
# Appends rather than truncates, so the history of every chunk survives and a
# `tail -f` never has to be restarted. Gitignored with the rest of archive/.
set -u
LOG=./archive/audit/run.log
mkdir -p ./archive/audit
{
  echo ""
  echo "===== chunk start $(date '+%Y-%m-%d %H:%M:%S') — target ${1:-40} ====="
} >> "$LOG"
# --line-buffered is load-bearing. grep block-buffers at 4KB when its stdout is
# a file rather than a terminal, so a `tail -f` on this log freezes for ~90 lines
# at a time and looks hung while the run is perfectly healthy. A progress log that
# reports progress in bursts is worse than none: it invites exactly the "is this
# thing stuck?" question it exists to answer.
# stdbuf -oL on tsx for the same reason, one layer up.
stdbuf -oL npx tsx scripts/audit-vs-live.mts "${1:-40}" 2>&1 \
  | grep --line-buffered -vE "ExperimentalWarning|trace-warnings" >> "$LOG"
echo "===== chunk end   $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$LOG"
