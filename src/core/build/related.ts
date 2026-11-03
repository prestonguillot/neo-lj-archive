/**
 * Related entries (DESIGN.md §7.5): for each entry, the few others it has the
 * most in common with, as plain links worked out at build time. No script, no
 * model — it outlives everything the HTML does.
 *
 * TF-IDF cosine. Two entries are related when they share words that are RARE in
 * the journal: a friend's name, a band, a place, a tag. Words every entry uses
 * carry no weight (IDF), long entries don't relate to everything (L2
 * normalisation), and an entry too thin to say anything gets no list rather than
 * a confident-looking guess (the threshold).
 *
 * This is the lexical baseline. If semantic embeddings arrive (§7.4), they
 * replace the vectors here; the shape of the output stays the same.
 */

export interface RelatedDoc {
  readonly id: number;
  /** Visible text: title and body. */
  readonly text: string;
  readonly tags: readonly string[];
}

export interface Related {
  readonly id: number;
  readonly score: number;
  /** The shared words that contributed most — shown, so the link explains itself. */
  readonly why: readonly string[];
}

/**
 * Words too common in English to say what an entry is about. IDF would mostly
 * sink these anyway; dropping them keeps them out of the "why" line, where
 * "because: the, and" would be an embarrassing explanation.
 */
const STOP = new Set(
  `about after again also always am an and any are around as at back be because been
  before being but by can cant could day did didnt do does doesnt doing dont down even
  ever every first for from get gets getting go goes going gonna got had has have having
  he her here him his how i if im in into is isnt it its ive just know last like little
  lot make many may me more most much my never new no not now of off oh ok okay on one
  only or other our out over really right said say says see she should since so some
  something still such than that thats the their them then there these they thing
  things think this those though through time to today too two up us very want was way
  we well went were what when where which while who why will with would yeah yes yet
  you your youre`.split(/\s+/),
);

/** Lowercase, accents off, apostrophes dropped (don't -> dont), 3+ letters. */
export function tokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

/** A tag is an explicit statement of topic, so it outweighs a passing word. */
const TAG_WEIGHT = 3;

export function relatedEntries(
  docs: readonly RelatedDoc[],
  opts: { k?: number; min?: number } = {},
): Map<number, Related[]> {
  const k = opts.k ?? 5;
  const min = opts.min ?? 0.12;
  const n = docs.length;

  // Term frequencies, and how many entries each term appears in.
  const tfs: Map<string, number>[] = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const w of tokens(d.text)) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const t of d.tags) {
      const key = `#${t.toLowerCase()}`;
      tf.set(key, (tf.get(key) ?? 0) + TAG_WEIGHT);
    }
    return tf;
  });
  const df = new Map<string, number>();
  for (const tf of tfs) for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);

  // Sublinear tf × idf, L2-normalised. A term in exactly one entry can't link two
  // entries, and a term in over half of them can't distinguish any — both are
  // left out of the vector, so neither shapes the normalisation.
  const vecs: Map<string, number>[] = tfs.map((tf) => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [w, c] of tf) {
      const d = df.get(w)!;
      if (d < 2 || d > n / 2) continue;
      const x = (1 + Math.log(c)) * Math.log(n / d);
      v.set(w, x);
      norm += x * x;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (const [w, x] of v) v.set(w, x / norm);
    return v;
  });

  // Postings, so each entry only meets the entries it shares a term with.
  const post = new Map<string, number[]>();
  vecs.forEach((v, i) => {
    for (const w of v.keys()) post.set(w, [...(post.get(w) ?? []), i]);
  });

  const out = new Map<number, Related[]>();
  for (let i = 0; i < n; i++) {
    const vi = vecs[i]!;
    const acc = new Map<number, number>();
    for (const [w, x] of vi) {
      for (const j of post.get(w) ?? []) {
        if (j === i) continue;
        acc.set(j, (acc.get(j) ?? 0) + x * vecs[j]!.get(w)!);
      }
    }
    const top = [...acc.entries()]
      .filter(([, s]) => s >= min)
      .map(([j, score]) => {
        const vj = vecs[j]!;
        const shared = [...vi.entries()]
          .filter(([w]) => vj.has(w))
          .map(([w, x]) => [w, x * vj.get(w)!] as const)
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
        return { j, score, shared };
      })
      // One shared word is a coincidence, not a relation: two short entries that
      // both swear score high on that single word and nothing else.
      .filter((c) => c.shared.length >= 2)
      // Deterministic: the same archive.db builds the same bytes (score ties break
      // on id, never on Map iteration order).
      .sort((a, b) => b.score - a.score || docs[a.j]!.id - docs[b.j]!.id)
      .slice(0, k)
      .map((c) => ({
        id: docs[c.j]!.id,
        score: c.score,
        why: c.shared.slice(0, 3).map(([w]) => w),
      }));
    out.set(docs[i]!.id, top);
  }
  return out;
}
