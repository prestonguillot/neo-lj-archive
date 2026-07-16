import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { format } from 'node:util';
import { Secret } from './secret.js';

// A fixture that shares nothing with any real credential. Do not "make it
// realistic" by starting from one — a prefix of a real password is still a
// prefix of a real password, and this file is public.
const PASSWORD = 'correct-horse-battery-staple-0000';

describe('Secret', () => {
  it('reveals the value only through reveal()', () => {
    expect(new Secret(PASSWORD).reveal()).toBe(PASSWORD);
  });

  // Each of these is a real way a credential escapes into a log file.
  // DESIGN.md §10: "enforced by test, not convention".
  describe('never renders its value', () => {
    const s = new Secret(PASSWORD);

    it('via String()', () => {
      expect(String(s)).not.toContain(PASSWORD);
    });

    it('via template literal', () => {
      expect(`${s}`).not.toContain(PASSWORD);
    });

    it('via string concatenation', () => {
      expect('password is ' + s).not.toContain(PASSWORD);
    });

    it('via util.format %s', () => {
      expect(format('%s', s)).not.toContain(PASSWORD);
    });

    it('via util.inspect (what console.log uses)', () => {
      expect(inspect(s)).not.toContain(PASSWORD);
    });

    it('via util.inspect when nested in an object', () => {
      expect(inspect({ auth: { secret: s } }, { depth: null })).not.toContain(PASSWORD);
    });

    it('via JSON.stringify', () => {
      expect(JSON.stringify(s)).not.toContain(PASSWORD);
    });

    it('via JSON.stringify when nested', () => {
      expect(JSON.stringify({ config: { password: s } })).not.toContain(PASSWORD);
    });

    it('via object spread (the private field does not enumerate)', () => {
      expect(JSON.stringify({ ...s })).not.toContain(PASSWORD);
    });

    it('via Object.keys / entries', () => {
      expect(Object.keys(s)).toEqual([]);
      expect(JSON.stringify(Object.entries(s))).not.toContain(PASSWORD);
    });

    it('via a thrown error carrying it in the message', () => {
      const err = new Error(`auth failed for ${s}`);
      expect(err.message).not.toContain(PASSWORD);
      expect(err.stack ?? '').not.toContain(PASSWORD);
    });
  });

  it('redacts consistently regardless of the wrapped value', () => {
    expect(String(new Secret('a'))).toBe(String(new Secret('b')));
  });
});
