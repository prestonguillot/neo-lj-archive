#!/usr/bin/env node
import { Command } from 'commander';
import { DEFAULTS, Secret, type Config } from '../core/index.js';
import { LjClient, BannedError } from '../core/fetch/client.js';
import { localizeImages } from '../core/images/index.js';
import { downloadUserpics } from '../core/images/userpics.js';
import { downloadEmbedThumbs } from '../core/images/embeds.js';
import { buildSite } from '../core/build/index.js';
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
    // So later stages can resolve relative image URLs without re-asking (§5.2).
    store.setState('username', config.username);
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
  .option('-u, --user <username>', 'LJ username (for resolving relative image URLs)')
  .option('-o, --out <dir>', 'output directory', DEFAULTS.outputDir)
  .option('-c, --concurrency <n>', 'parallel downloads', String(DEFAULTS.imageConcurrency))
  .option('-t, --timeout <ms>', 'per-image timeout', String(DEFAULTS.imageTimeoutMs))
  .action(async (opts: { user?: string; out: string; concurrency: string; timeout: string }) => {
    const store = Store.open(opts.out);
    try {
      const { entries } = store.stats();
      if (entries === 0) {
        console.error('Nothing fetched yet. Run: neo-lj fetch');
        process.exit(2);
      }

      // No credentials needed: this stage never talks to LiveJournal. It reads
      // archive.db and fetches from third-party hosts. The username is only for
      // building the permalink that relative URLs resolve against (§5.2).
      const username = opts.user ?? process.env['LJ_USER'] ?? store.getState('username');
      if (username === undefined) {
        console.error('Need --user (or LJ_USER) to resolve relative image URLs.');
        process.exit(2);
      }

      const config: Config = {
        username,
        passwordMd5: new Secret(''), // unused here; this stage never authenticates
        outputDir: opts.out,
        requestDelayMs: DEFAULTS.requestDelayMs,
        imageConcurrency: Number(opts.concurrency),
        imageTimeoutMs: Number(opts.timeout),
      };

      const stats = await localizeImages(config, { store, report: renderProgress() });

      console.log(
        `\n${stats.blobs} images stored, ${stats.deadRefs} refs dead, ` +
          `${stats.poison} placeholder blob(s) — across ${stats.hosts} hosts`,
      );
      console.log(`${stats.distinctUrls} distinct URLs from ${stats.refs} references`);
      if (stats.pending > 0) console.log(`${stats.pending} still to try — re-run to resume.`);
    } finally {
      store.close();
    }
  });

program
  .command('userpics')
  .description('Download the userpics the scrape recovered. Deduped by content.')
  .option('-o, --out <dir>', 'output directory', DEFAULTS.outputDir)
  .action(async (opts: { out: string }) => {
    const store = Store.open(opts.out);
    try {
      const known = (store.query('SELECT COUNT(*) AS n FROM userpics') as { n: number }[])[0]?.n;
      if (known === undefined || known === 0) {
        console.error('No userpics known yet. They are scraped, not fetched from the API:');
        console.error('  npx tsx scripts/audit-vs-live.mts 200');
        process.exit(2);
      }
      // No credentials: userpics are served publicly and this never talks to
      // LJ's API. Nothing here needs a session.
      const stats = await downloadUserpics(opts.out, { store, report: renderProgress() });
      console.log(
        `\n${stats.stored}/${stats.known} userpics stored for ${stats.people} people` +
          (stats.failed > 0 ? `, ${stats.failed} gone` : ''),
      );
    } finally {
      store.close();
    }
  });

program
  .command('video-posters')
  .description('Download a poster frame for each recovered YouTube embed.')
  .option('-o, --out <dir>', 'output directory', DEFAULTS.outputDir)
  .action(async (opts: { out: string }) => {
    const store = Store.open(opts.out);
    try {
      const known = (store.query('SELECT COUNT(*) AS n FROM entry_embeds') as { n: number }[])[0]
        ?.n;
      if (known === undefined || known === 0) {
        console.error('No embeds known yet. They are scraped by the live audit.');
        process.exit(2);
      }
      const stats = await downloadEmbedThumbs(opts.out, { store, report: renderProgress() });
      console.log(
        `\n${stats.stored}/${stats.known} video posters stored` +
          (stats.failed > 0 ? `, ${stats.failed} gone` : ''),
      );
    } finally {
      store.close();
    }
  });

program
  .command('classify')
  .description('Optional: LLM pass over suspect image hashes. Skipping keeps images as-is.')
  .option('-o, --out <dir>', 'output directory', DEFAULTS.outputDir)
  .action(NOT_YET('M5'));

program
  .command('build')
  .description('archive.db -> site/. Plain HTML, opens from file://.')
  .option('-u, --user <username>', 'LJ username (for resolving self-links)')
  .option('-o, --out <dir>', 'output directory', DEFAULTS.outputDir)
  .action(async (opts: { user?: string; out: string }) => {
    const store = Store.open(opts.out);
    try {
      if (store.stats().entries === 0) {
        console.error('Nothing fetched yet. Run: neo-lj fetch');
        process.exit(2);
      }

      // Like `images`, this stage never authenticates. The username is only for
      // spotting links back into the author's own journal (§7.3).
      const username = opts.user ?? process.env['LJ_USER'] ?? store.getState('username');
      if (username === undefined) {
        console.error('Need --user or LJ_USER to resolve self-links.');
        process.exit(2);
      }

      const config: Config = {
        username,
        passwordMd5: new Secret(''), // unused here; this stage never authenticates
        outputDir: opts.out,
        requestDelayMs: DEFAULTS.requestDelayMs,
        imageConcurrency: DEFAULTS.imageConcurrency,
        imageTimeoutMs: DEFAULTS.imageTimeoutMs,
      };

      const stats = await buildSite(config, { store, report: renderProgress() });

      console.log(
        `\n${stats.pages} pages: ${stats.entries} entries, ${stats.comments} comments, ` +
          `${stats.imagesKept} images (${stats.imagesLost} marked lost)`,
      );
      console.log(`\nOpen it: ${opts.out}/site/index.html`);
    } finally {
      store.close();
    }
  });

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
