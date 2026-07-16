/**
 * The core/shell seam (DESIGN.md §15).
 *
 * Core never writes to stdout. It emits progress events; a shell decides what
 * they look like. The CLI renders a bar; Electron (M5) renders a window. This
 * type is what makes that true rather than aspirational — if core could reach
 * stdout, the seam would be fiction.
 */

export type ProgressEvent =
  /** A unit of work began. `total` is absent when it isn't known up front. */
  | { readonly kind: 'start'; readonly task: string; readonly total?: number }
  /** Incremental progress within a task. */
  | {
      readonly kind: 'tick';
      readonly task: string;
      readonly done: number;
      readonly detail?: string;
    }
  /** A unit of work finished. */
  | { readonly kind: 'done'; readonly task: string; readonly summary?: string }
  /** Something worth surfacing that isn't progress — a skip, a dead image, a retry. */
  | { readonly kind: 'note'; readonly message: string }
  /** Non-fatal: recorded and carried past. Image failures are data (DESIGN.md §9). */
  | { readonly kind: 'warn'; readonly message: string };

export type ProgressReporter = (event: ProgressEvent) => void;

/** Default for tests and non-interactive callers. */
export const silentReporter: ProgressReporter = () => {};
