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
npx tsx scripts/audit-vs-live.mts "${1:-40}" 2>&1 \
  | grep -vE "ExperimentalWarning|trace-warnings" >> "$LOG"
echo "===== chunk end   $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$LOG"
