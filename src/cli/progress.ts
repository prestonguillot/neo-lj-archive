import type { ProgressEvent, ProgressReporter } from '../core/index.js';

/**
 * The CLI's half of the core/shell seam (DESIGN.md §15).
 *
 * Core emits ProgressEvents; this turns them into terminal output. Electron
 * (M5) will implement the same interface against a window. Nothing here is
 * importable from core — that's the whole point, and the lint rule enforces it.
 */

const isTTY = process.stderr.isTTY ?? false;

/** Erase from cursor to end of line — so a shorter line can't leave debris. */
const CLEAR_LINE = '\x1b[K';

/** Progress goes to stderr so stdout stays pipeable. */
function write(line: string): void {
  process.stderr.write(line);
}

export function renderProgress(): ProgressReporter {
  const totals = new Map<string, number | undefined>();

  return (event: ProgressEvent): void => {
    switch (event.kind) {
      case 'start':
        totals.set(event.task, event.total);
        write(`${event.task}${event.total !== undefined ? ` (${event.total})` : ''}\n`);
        break;

      case 'tick': {
        const total = totals.get(event.task);
        const detail = event.detail !== undefined ? ` ${event.detail}` : '';
        const count = total !== undefined ? `${event.done}/${total}` : `${event.done}`;
        // On a TTY, redraw in place. Piped to a file, emit one line per tick so
        // the log is readable afterwards.
        write(isTTY ? `\r  ${count}${detail}${CLEAR_LINE}` : `  ${count}${detail}\n`);
        break;
      }

      case 'done':
        if (isTTY) write(`\r${CLEAR_LINE}`);
        write(`  ${event.task}: ${event.summary ?? 'done'}\n`);
        totals.delete(event.task);
        break;

      case 'note':
        if (isTTY) write(`\r${CLEAR_LINE}`);
        write(`  ${event.message}\n`);
        break;

      case 'warn':
        if (isTTY) write(`\r${CLEAR_LINE}`);
        write(`  ! ${event.message}\n`);
        break;
    }
  };
}
