import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import semver from 'semver';

/**
 * INVERTED TESTS. These are green while we are BLOCKED, and fail the moment the
 * block lifts.
 *
 * Every workaround in this repo that exists only because an upstream constraint
 * exists gets a guard here. Otherwise the workaround silently outlives its
 * reason — a `REMOVE THIS` comment only helps someone who happens to open the
 * file, and nobody opens the file.
 *
 * When one of these fails, the failure IS the good news. The message says what
 * to delete.
 *
 * Why a test and not a scheduled workflow: scheduled workflows are disabled
 * automatically after 60 days without repo activity, and this tool gets run
 * about twice a year. A test fires on the exact Dependabot PR that changes the
 * condition, needs no network, and cannot be silently switched off.
 */

const require = createRequire(import.meta.url);

/**
 * Does this peer range still exclude TypeScript 7?
 *
 * Pure and range-in, boolean-out so it can be tested in both directions —
 * including the direction that has not happened yet. A guard nobody has seen
 * fail is a guard nobody knows works.
 */
export function blocksTypeScript7(peerRange: string): boolean {
  return !semver.satisfies('7.0.0', peerRange);
}

describe('blocksTypeScript7', () => {
  it('reports blocked for the range typescript-eslint ships today', () => {
    expect(blocksTypeScript7('>=4.8.4 <6.1.0')).toBe(true);
  });

  // catches: a guard that can never fire. If this returned true for a range that
  // admits TS 7, the live check below would be decorative — permanently green,
  // reporting nothing, exactly the tautology DESIGN.md §10 forbids.
  it('reports unblocked once a range admits TypeScript 7', () => {
    expect(blocksTypeScript7('>=4.8.4 <8.0.0')).toBe(false);
    expect(blocksTypeScript7('>=7.0.0')).toBe(false);
  });
});

describe('upgrade guards', () => {
  /**
   * Guards: the `ignore` rule for TypeScript majors in .github/dependabot.yml.
   *
   * Read from the installed package rather than the npm registry — no network,
   * so this can't flake, and it changes exactly when Dependabot bumps
   * typescript-eslint, which is the PR where a human is already looking.
   */
  it('typescript-eslint still refuses TypeScript 7', () => {
    const pkg = require('typescript-eslint/package.json') as {
      version: string;
      peerDependencies?: Record<string, string>;
    };
    const range = pkg.peerDependencies?.['typescript'];
    expect(range, 'typescript-eslint no longer declares a typescript peer range').toBeDefined();

    expect(
      blocksTypeScript7(range as string),
      [
        '',
        '  THIS FAILURE IS GOOD NEWS.',
        '',
        `  typescript-eslint@${pkg.version} now accepts TypeScript 7 (peer: ${range}).`,
        '  The upstream block that forced a workaround is gone.',
        '',
        '  Do this:',
        '    1. Delete the `ignore:` block for `typescript` in .github/dependabot.yml',
        '    2. Delete this guard test',
        '    3. Let Dependabot re-propose the TypeScript major',
        '',
      ].join('\n'),
    ).toBe(true);
  });
});
