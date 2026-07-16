#!/usr/bin/env node
import { Command } from 'commander';
import { DEFAULTS } from '../core/index.js';
import { renderProgress } from './progress.js';

// node:sqlite is experimental on the LTS lines, and Node says so on every run.
// That's a fair warning for a library and pure noise for a CLI a human types.
// Filter it here — in the shell, where console output belongs (DESIGN.md §15).
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  console.warn(`${w.name}: ${w.message}`);
});

const NOT_YET = (milestone: string) => (): never => {
  console.error(`not implemented yet — ${milestone}. See DESIGN.md §11.`);
  process.exit(2);
};

const program = new Command();

program
  .name('neo-lj')
  .description(
    'Archive a LiveJournal — entries, threaded comments, and local copies of every\n' +
      'image — into a static site you can read offline, forever, without this tool.',
  )
  .version('0.1.0');

program
  .command('fetch')
  .description('LiveJournal -> archive.db. Incremental and resumable.')
  .option('-u, --user <username>', 'LJ username')
  .option('-o, --out <dir>', 'output directory', DEFAULTS.outputDir)
  .option(
    '-d, --delay <ms>',
    'delay between LJ requests (deliberately slow; a 403 means a ban)',
    String(DEFAULTS.requestDelayMs),
  )
  .action(NOT_YET('M1'));

program
  .command('images')
  .description('Download every image, content-address it, and auto-classify placeholders.')
  .option('-o, --out <dir>', 'output directory', DEFAULTS.outputDir)
  .option('-c, --concurrency <n>', 'parallel downloads', String(DEFAULTS.imageConcurrency))
  .action(NOT_YET('M2'));

program
  .command('classify')
  .description('Optional: LLM pass over suspect image hashes. Skipping keeps images as-is.')
  .option('-o, --out <dir>', 'output directory', DEFAULTS.outputDir)
  .action(NOT_YET('M5'));

program
  .command('build')
  .description('archive.db -> site/. Plain HTML, opens from file://.')
  .option('-o, --out <dir>', 'output directory', DEFAULTS.outputDir)
  .option('-t, --theme <path>', 'stylesheet to use instead of the default')
  .action(NOT_YET('M3'));

program
  .command('status')
  .description("What's fetched, what's missing, what's dead.")
  .option('-o, --out <dir>', 'output directory', DEFAULTS.outputDir)
  .action(NOT_YET('M1'));

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// Referenced so the shell's own seam implementation is wired from day one.
export { renderProgress };
