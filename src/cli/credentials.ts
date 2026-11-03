import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Secret } from '../core/index.js';

/**
 * Credential resolution lives in the shell, not core (DESIGN.md §15).
 *
 * Never stored. Prompted with no echo, or injected at runtime via env var —
 * injection is not storage, and the var is popped immediately on read so it
 * can't be inherited by a child process or dumped by a later `env`.
 *
 * Never via flag: flags land in shell history and are visible in `ps`.
 */

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** The slice of a TTY stream readHidden needs — so a test can hand it a fake one. */
export interface HiddenInput extends NodeJS.EventEmitter {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * Read a line WITHOUT echoing it, using only public APIs: the terminal goes into
 * raw mode, so keystrokes arrive here instead of being printed, and nothing is
 * written back but the prompt and a newline.
 *
 * This replaced a patch of readline's private `_writeToOutput`, which the
 * promise-based readline in Node 22 doesn't have: the password prompt crashed
 * with "Cannot read properties of undefined (reading 'bind')" before anyone
 * could type. A private API is a crash waiting for a Node upgrade.
 *
 * Not a TTY (piped input): there is no echo to suppress, so read until newline.
 */
export function readHidden(
  question: string,
  input: HiddenInput = stdin,
  output: { write(s: string): unknown } = stdout,
): Promise<string> {
  output.write(question);
  return new Promise((resolve, reject) => {
    let buf = '';
    const raw = input.isTTY === true && typeof input.setRawMode === 'function';
    const done = (err?: Error): void => {
      input.off('data', onData);
      if (raw) input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    if (raw) input.setRawMode?.(true);
    input.on('data', onData);
    input.resume();
  });
}

export interface Credentials {
  readonly username: string;
  readonly passwordMd5: Secret;
}

export async function resolveCredentials(usernameFlag?: string): Promise<Credentials> {
  const username =
    usernameFlag ?? process.env['LJ_USER'] ?? (await prompt('LiveJournal username: '));

  const fromEnv = process.env['LJ_PASSWORD'];
  delete process.env['LJ_PASSWORD'];

  const password = fromEnv ?? (await readHidden('LiveJournal password (not echoed): '));
  if (!username || !password) throw new Error('username and password are both required');

  // md5(password) is password-equivalent to LiveJournal: it authenticates
  // indefinitely and there is nothing to crack. It goes straight into a Secret
  // and the plaintext is never held (§8).
  return {
    username,
    passwordMd5: new Secret(createHash('md5').update(password, 'utf8').digest('hex')),
  };
}
