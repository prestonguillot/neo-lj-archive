/**
 * The public surface of core. The shell (src/cli) and the tests import from
 * here and nowhere deeper.
 */

export { Secret } from './secret.js';
export { DEFAULTS, NEVER_SEND_USEJOURNAL } from './config.js';
export type { Config } from './config.js';
export { silentReporter } from './progress.js';
export type { ProgressEvent, ProgressReporter } from './progress.js';
