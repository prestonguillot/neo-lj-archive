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

async function prompt(question: string, hide: boolean): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    if (!hide) return (await rl.question(question)).trim();

    // Suppress the echo of what's typed while still showing the prompt itself.
    const iface = rl as unknown as { _writeToOutput: (s: string) => void };
    const original = iface._writeToOutput.bind(iface);
    iface._writeToOutput = (s: string): void => original(s.includes(question) ? s : '');
    const answer = await rl.question(question);
    stdout.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}

export interface Credentials {
  readonly username: string;
  readonly passwordMd5: Secret;
}

export async function resolveCredentials(usernameFlag?: string): Promise<Credentials> {
  const username =
    usernameFlag ?? process.env['LJ_USER'] ?? (await prompt('LiveJournal username: ', false));

  const fromEnv = process.env['LJ_PASSWORD'];
  delete process.env['LJ_PASSWORD'];

  const password = fromEnv ?? (await prompt('LiveJournal password (not echoed): ', true));
  if (!username || !password) throw new Error('username and password are both required');

  // md5(password) is password-equivalent to LiveJournal: it authenticates
  // indefinitely and there is nothing to crack. It goes straight into a Secret
  // and the plaintext is never held (§8).
  return {
    username,
    passwordMd5: new Secret(createHash('md5').update(password, 'utf8').digest('hex')),
  };
}
