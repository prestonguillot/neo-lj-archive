const REDACTED = '<Secret redacted>';

/**
 * A credential that cannot be accidentally printed, logged, or rendered into a
 * stack trace. `reveal()` is the only way out, so every use site is greppable.
 *
 * This does not defend against a memory dump — it defends against the leak that
 * actually happens, which is a stray template literal in a log line.
 *
 * Note what this must hold: LiveJournal computes `md5(challenge + md5(password))`,
 * so `md5(password)` *is* password-equivalent. Anyone holding it authenticates
 * indefinitely without ever learning the password. There is nothing to crack.
 * Treat the hash as the secret itself, not as a hashed derivative of one.
 *
 * See DESIGN.md §8.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The only accessor. Grep for `.reveal()` to audit every use. */
  reveal(): string {
    return this.#value;
  }

  /** Covers `${secret}`, string concatenation, and `util.format('%s', …)`. */
  toString(): string {
    return REDACTED;
  }

  /** Covers `JSON.stringify(…)`, including when nested inside another object. */
  toJSON(): string {
    return REDACTED;
  }

  /** Covers `console.log(secret)` and anything else routed through util.inspect. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}
