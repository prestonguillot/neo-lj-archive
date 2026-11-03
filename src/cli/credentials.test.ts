import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { readHidden, type HiddenInput } from './credentials.js';

/**
 * The password prompt. A fake terminal stands in for stdin: it records raw-mode
 * changes and lets the test type keystrokes. Expected values are the keys typed,
 * so nothing here is derived from the code under test (DESIGN.md §10).
 */
class FakeTty extends EventEmitter implements HiddenInput {
  readonly isTTY = true;
  rawModes: boolean[] = [];
  setRawMode(m: boolean): this {
    this.rawModes.push(m);
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  type(s: string): void {
    this.emit('data', Buffer.from(s, 'utf8'));
  }
}

const sink = (): { out: string; write(s: string): void } => ({
  out: '',
  write(s: string) {
    this.out += s;
  },
});

describe('readHidden', () => {
  // catches: the password echoing to the screen — or the prompt depending on a
  // private readline API, which crashed on Node 22 before anyone could type.
  it('returns what was typed and never writes it back', async () => {
    const tty = new FakeTty();
    const out = sink();
    const p = readHidden('pw: ', tty, out);
    tty.type('hunter2');
    tty.type('\r');
    expect(await p).toBe('hunter2');
    expect(out.out).toBe('pw: \n');
    expect(out.out).not.toContain('hunter2');
  });

  // catches: leaving the terminal in raw mode, which makes the user's shell
  // unusable after the script exits.
  it('puts the terminal in raw mode and always restores it', async () => {
    const tty = new FakeTty();
    const p = readHidden('pw: ', tty, sink());
    tty.type('x\r');
    await p;
    expect(tty.rawModes).toEqual([true, false]);

    const tty2 = new FakeTty();
    const p2 = readHidden('pw: ', tty2, sink());
    tty2.type('\u0003');
    await expect(p2).rejects.toThrow('cancelled');
    expect(tty2.rawModes).toEqual([true, false]);
  });

  // catches: backspace stored as a character, so a corrected typo becomes part
  // of the password and auth fails with no visible reason.
  it('applies backspace', async () => {
    const tty = new FakeTty();
    const p = readHidden('pw: ', tty, sink());
    tty.type('hunterX\u007f2\r');
    expect(await p).toBe('hunter2');
  });

  // catches: one keystroke split across chunks, or a paste arriving as one chunk.
  it('reads input arriving in any chunking, including non-ASCII', async () => {
    const tty = new FakeTty();
    const p = readHidden('pw: ', tty, sink());
    tty.type('pä');
    tty.type('ss wörd\n');
    expect(await p).toBe('päss wörd');
  });
});
