import { parse } from 'parse5';

/**
 * Content LiveJournal kept on its OWN servers, recovered from its rendered pages
 * (DESIGN.md §5.3).
 *
 * The export has only a placeholder for these — `<lj-poll-N>`, `<lj-template>` —
 * because the questions, answers, and prompts never lived in the entry. The live
 * page renders them, so the audit (scripts/audit-vs-live.mts), which already
 * reads those pages, hands the HTML here and stores what comes back.
 *
 * Structured data, not LJ's markup: that markup is a voting form, onclick
 * handlers, and svg sprites from LJ's site, none of which means anything in a
 * static archive. What the reader needs is the question, the answers, and — when
 * LJ shows them — the counts.
 */

export interface PollAnswer {
  readonly text: string;
  /** Present only when LJ rendered results; a voting form has none. */
  readonly count?: number;
  readonly percent?: number;
}

export interface PollQuestion {
  readonly text: string;
  readonly answers: readonly PollAnswer[];
}

export interface RecoveredPoll {
  readonly kind: 'poll';
  readonly id: number;
  /** The poll's own name, when it had one. */
  readonly title: string;
  /** LJ's line about who could vote and see results, and how many took part. */
  readonly meta: string;
  readonly questions: readonly PollQuestion[];
}

export interface RecoveredPrompt {
  readonly kind: 'prompt';
  readonly title: string;
  readonly text: string;
  readonly url?: string;
}

export type Recovered = RecoveredPoll | RecoveredPrompt;

interface Node {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
}

const attr = (n: Node, name: string): string | undefined =>
  n.attrs?.find((a) => a.name === name)?.value;
const hasClass = (n: Node, c: string): boolean => (attr(n, 'class') ?? '').split(/\s+/).includes(c);

function* below(n: Node): Generator<Node> {
  for (const c of n.childNodes ?? []) {
    yield c;
    yield* below(c);
  }
}
const firstBelow = (n: Node, pred: (d: Node) => boolean): Node | undefined => {
  for (const d of below(n)) if (pred(d)) return d;
  return undefined;
};
const allBelow = (n: Node, pred: (d: Node) => boolean): Node[] => [...below(n)].filter(pred);
const byClass =
  (c: string) =>
  (d: Node): boolean =>
    hasClass(d, c);

/** Visible text, whitespace collapsed. Comments carry no text in parse5's tree. */
const textOf = (n: Node | undefined): string => {
  if (n === undefined) return '';
  const out: string[] = [];
  const walk = (x: Node): void => {
    if (x.nodeName === '#text') out.push(x.value ?? '');
    else if (x.nodeName !== 'script' && x.nodeName !== 'style') (x.childNodes ?? []).forEach(walk);
  };
  walk(n);
  return out.join('').replace(/\s+/g, ' ').trim();
};

const num = (s: string): number | undefined => {
  const v = Number(s.replace(/[^\d.]/g, ''));
  return s.trim() === '' || !Number.isFinite(v) ? undefined : v;
};

/**
 * Every poll on a page, in document order.
 *
 * LJ renders a poll two ways, measured on live pages: with RESULTS (a
 * `div.ljpoll`, each answer with a count and percentage) when the viewer may see
 * them, or as a VOTING FORM (a `form.ljpoll`, answers as radio labels, no counts)
 * when the viewer hasn't voted. Both carry the same question boxes.
 */
export function parsePolls(html: string): RecoveredPoll[] {
  const doc = parse(html) as unknown as Node;
  return allBelow(
    doc,
    (d) => (d.nodeName === 'div' || d.nodeName === 'form') && hasClass(d, 'ljpoll'),
  )
    .map((root): RecoveredPoll | undefined => {
      const idLink = firstBelow(root, byClass('ljpoll-meta-pollid'));
      const idText =
        /#(\d+)/.exec(textOf(idLink))?.[1] ??
        /[?&]id=(\d+)/.exec(attr(idLink ?? { nodeName: '' }, 'href') ?? '')?.[1];
      const id = idText !== undefined ? Number(idText) : NaN;
      if (!Number.isFinite(id)) return undefined;

      const questions = allBelow(root, byClass('ljpoll-questionbox')).map((box) => {
        const results = allBelow(box, byClass('ljpoll-results-item'));
        const answers: PollAnswer[] =
          results.length > 0
            ? results.map((item) => {
                // "aswer" is LJ's own spelling, read off the live markup.
                const count = num(textOf(firstBelow(item, byClass('ljpoll-results-count'))));
                const percent = num(textOf(firstBelow(item, byClass('ljpoll-results-percent'))));
                return {
                  text: textOf(firstBelow(item, byClass('ljpoll-results-aswer'))),
                  ...(count !== undefined ? { count } : {}),
                  ...(percent !== undefined ? { percent } : {}),
                };
              })
            : allBelow(box, byClass('ljpoll-item')).map((item) => ({
                text: textOf(firstBelow(item, (d) => d.nodeName === 'label')),
              }));
        return { text: textOf(firstBelow(box, byClass('ljpoll-question'))), answers };
      });

      return {
        kind: 'poll',
        id,
        title: textOf(firstBelow(root, byClass('ljpoll-meta-pollname'))),
        meta: textOf(firstBelow(root, byClass('ljpoll-meta-data'))),
        questions,
      };
    })
    .filter((p): p is RecoveredPoll => p !== undefined);
}

/** Does this poll carry counts, or only the questions a voting form shows? */
export const hasResults = (p: RecoveredPoll): boolean =>
  p.questions.some((q) => q.answers.some((a) => a.count !== undefined));

/**
 * A voting-form poll, completed with the counts from LJ's results view of the
 * same poll. Matched by position: the results page renders the same questions and
 * answers in the same order. If the shapes disagree, the form is kept as it was —
 * a poll without counts beats one with counts pinned to the wrong answers.
 */
export function withResults(form: RecoveredPoll, results: RecoveredPoll): RecoveredPoll {
  const same =
    form.id === results.id &&
    form.questions.length === results.questions.length &&
    form.questions.every((q, i) => q.answers.length === results.questions[i]!.answers.length);
  if (!same) return form;
  return {
    ...form,
    meta: results.meta || form.meta,
    questions: form.questions.map((q, i) => ({
      text: q.text,
      answers: q.answers.map((a, j) => {
        const r = results.questions[i]!.answers[j]!;
        return {
          text: a.text,
          ...(r.count !== undefined ? { count: r.count } : {}),
          ...(r.percent !== undefined ? { percent: r.percent } : {}),
        };
      }),
    })),
  };
}

/**
 * A Writer's Block prompt — what an `<lj-template>` rendered as: a question LJ
 * posed, which the entry then answered. The reply link and reply count around it
 * are LJ's site, not the entry, and are left behind.
 */
export function parsePrompt(html: string): RecoveredPrompt | undefined {
  const doc = parse(html) as unknown as Node;
  const box = firstBelow(doc, byClass('flatquestionjournal'));
  if (box === undefined) return undefined;
  const titleBox = firstBelow(box, byClass('flatquestionjournal-question-title'));
  const link = titleBox && firstBelow(titleBox, (d) => d.nodeName === 'a');
  const href = link && attr(link, 'href');
  const title = textOf(titleBox);
  const text = textOf(firstBelow(box, byClass('flatquestionjournal-question-text')));
  if (title === '' && text === '') return undefined;
  return { kind: 'prompt', title, text, ...(href !== undefined ? { url: href } : {}) };
}

/** Key a recovered item by the placeholder it fills: `poll:<id>` or `template:<id>`. */
export const pollKey = (id: number): string => `poll:${id}`;
export const templateKey = (id: string): string => `template:${id}`;
