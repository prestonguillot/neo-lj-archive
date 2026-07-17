#!/usr/bin/env bash
# Live view of the audit. Redraws in place until you ^C.
#
#   ./scripts/audit-watch.sh
#
# Reads the DATABASE and state.json, not the log. Both are written as the work
# happens, so this cannot stutter the way a buffered pipe does — a `tail -f` on
# run.log froze for ~90 lines at a stretch while the run was 760 entries ahead of
# it, which is exactly the confusion this exists to end.
#
# `watch` isn't on macOS by default, hence the loop.
set -u
cd "$(dirname "$0")/.." || exit 1

TOTAL=$(node -e 'const{DatabaseSync}=require("node:sqlite");
  console.log(new DatabaseSync("./archive/archive.db").prepare("SELECT COUNT(*) n FROM entries").get().n)' 2>/dev/null)

while true; do
  node - "$TOTAL" <<'JS' 2>/dev/null
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, existsSync } = require('node:fs');
const total = Number(process.argv[2] || 1547);
const db = new DatabaseSync('./archive/archive.db');
const n = (s) => db.prepare(s).get().n;

const state = existsSync('./archive/audit/state.json')
  ? JSON.parse(readFileSync('./archive/audit/state.json', 'utf8'))
  : {};
const v = Object.values(state);
const parity = v.filter((x) => x.gap === 0).length;
const diverging = v.filter((x) => x.gap > 0);

const bar = (done, all, w = 34) => {
  const f = all ? Math.round((done / all) * w) : 0;
  return '[' + '#'.repeat(f) + '.'.repeat(w - f) + '] ' + ((done / all) * 100).toFixed(1) + '%';
};
const pad = (x, w) => String(x).padStart(w);

// \x1b[H = home, \x1b[J = clear to end. Redraw in place, no flicker, no scroll.
let out = '\x1b[H\x1b[J';
out += 'neo-lj audit — live\n';
out += '\n  entries audited  ' + bar(v.length, total) + '  ' + pad(v.length, 4) + '/' + total;
out += '\n  at parity        ' + pad(parity, 4) + '   diverging ' + diverging.length;
out += '\n';
out += '\n  userpics known   ' + pad(n('SELECT COUNT(*) n FROM userpics'), 4) +
       '   downloaded ' + pad(n('SELECT COUNT(*) n FROM userpics WHERE hash IS NOT NULL'), 4) +
       '   people ' + n('SELECT COUNT(DISTINCT userid) n FROM userpics');
out += '\n  entry  -> pic    ' + pad(n('SELECT COUNT(*) n FROM entry_userpics'), 4) + '/' + total;
out += '\n  comment -> pic   ' + pad(n('SELECT COUNT(*) n FROM comment_userpics'), 4) + '/' +
       n('SELECT COUNT(*) n FROM comments');
if (diverging.length) {
  out += '\n\n  diverging from LJ (all explained — polls/qotd are server-side):';
  for (const [id, d] of Object.entries(state).filter(([, d]) => d.gap > 0).sort((a, b) => b[1].gap - a[1].gap))
    out += `\n    ${id.padEnd(9)} ${String(d.shape).padEnd(12)} ${d.gap} chars`;
}
out += '\n\n  ^C to stop watching (does not stop the audit)\n';
process.stdout.write(out);
JS

  if pgrep -f "audit-vs-live" >/dev/null 2>&1; then
    printf '  \033[32m● running\033[0m   %s\n' "$(date '+%H:%M:%S')"
  else
    printf '  \033[33m○ idle\033[0m      %s\n' "$(date '+%H:%M:%S')"
  fi
  sleep 2
done
