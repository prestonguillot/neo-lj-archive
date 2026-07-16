#!/usr/bin/env node
import { Command } from 'commander';
import { DEFAULTS, type Config } from '../core/index.js';
import { LjClient, BannedError } from '../core/fetch/client.js';
import { sync } from '../core/fetch/sync.js';
import { Store } from '../core/store/db.js';
import { renderProgress } from './progress.js';
import { resolveCredentials } from './credentials.js';

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
  .action(async (opts: { user?: string; out: string; delay: string }) => {
    const { username, passwordMd5 } = await resolveCredentials(opts.user);

    const config: Config = {
      username,
      passwordMd5,
      outputDir: opts.out,
      requestDelayMs: Number(opts.delay),
      imageConcurrency: DEFAULTS.imageConcurrency,
      imageTimeoutMs: DEFAULTS.imageTimeoutMs,
    };

    const store = Store.open(config.outputDir);
    const client = new LjClient({
      username: config.username,
      passwordMd5: config.passwordMd5,
      requestDelayMs: config.requestDelayMs,
    });

    try {
      const stats = await sync(config, { client, store, report: renderProgress() });
      console.log(
        `\n${stats.entries} entries, ${stats.comments} comments, ` +
          `${stats.users} commenters, ${stats.moods} moods -> ${config.outputDir}/archive.db`,
      );
      console.log('Re-run any time; it resumes and never re-downloads the world.');
    } finally {
      store.close();
    }
  });

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
  .action((opts: { out: string }) => {
    const store = Store.open(opts.out);
    try {
      const s = store.stats();
      console.log(`archive: ${opts.out}/archive.db`);
      console.log(`  entries    ${s.entries}`);
      console.log(`  comments   ${s.comments}`);
      console.log(`  commenters ${s.users}`);
      console.log(`  moods      ${s.moods}`);
      if (s.entries === 0) console.log('\nNothing fetched yet. Run: neo-lj fetch');
    } finally {
      store.close();
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  // A ban is the one error worth its own exit code: it means stop and wait, not
  // fix something and retry (DESIGN.md §9).
  if (err instanceof BannedError) {
    console.error(`\n${err.message}`);
    process.exit(3);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
