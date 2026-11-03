import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePolls, parsePrompt, hasResults, withResults, type RecoveredPoll } from './ljpage.js';

/**
 * Recovering what LiveJournal kept server-side, from its rendered pages.
 *
 * The fixtures keep LJ's real markup STRUCTURE (classes, nesting, its "aswer"
 * typo, the two ways it renders a poll) with every word, id, and link invented,
 * so the expected values below are the invented text — not the parser's output.
 */
const fixture = (name: string): string =>
  readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), 'utf8');

describe('parsePolls: the results view', () => {
  const [poll] = parsePolls(fixture('ljpoll-results.html'));

  // catches: reading only the first answer, or answers from the wrong box.
  it('reads the poll, its question, and every answer with its count', () => {
    expect(poll).toEqual({
      kind: 'poll',
      id: 9000002,
      title: 'Which snack wins the night',
      meta: 'Open to: All, detailed results viewable to: All. Participants: 7',
      questions: [
        {
          text: 'Pick exactly one',
          answers: [
            { text: 'Answer <b>one</b> & more', count: 3, percent: 42.9 },
            { text: 'Answer two', count: 0, percent: 0 },
            { text: 'Answer three', count: 4, percent: 57.1 },
          ],
        },
      ],
    });
  });

  // catches: a zero-vote answer read as "no count" — 0 is a result, not a gap.
  it('keeps a count of zero', () => {
    expect(poll!.questions[0]!.answers[1]!.count).toBe(0);
    expect(hasResults(poll!)).toBe(true);
  });

  // catches: entity-decoding the answer twice or not at all. LJ sent the text
  // `Answer <b>one</b> & more` escaped; it must come back as those characters.
  it('returns answer text as characters, not markup', () => {
    expect(poll!.questions[0]!.answers[0]!.text).toBe('Answer <b>one</b> & more');
  });
});

describe('parsePolls: the voting-form view', () => {
  const [poll] = parsePolls(fixture('ljpoll-form.html'));

  // catches: the form view yielding nothing because it isn't a div. LJ renders an
  // unvoted poll as a <form class="ljpoll"> with radio labels.
  it('reads the question and answers, with no counts', () => {
    expect(poll!.id).toBe(9000003);
    expect(poll!.questions[0]!.text).toBe('Which one is it');
    expect(poll!.questions[0]!.answers.map((a) => a.text)).toEqual([
      'First choice',
      'Second choice',
      'Third choice',
      'Fourth choice',
      'Fifth choice',
    ]);
    expect(hasResults(poll!)).toBe(false);
  });
});

describe('withResults', () => {
  const form: RecoveredPoll = {
    kind: 'poll',
    id: 1,
    title: '',
    meta: 'form meta',
    questions: [{ text: 'Q', answers: [{ text: 'a' }, { text: 'b' }] }],
  };
  const results: RecoveredPoll = {
    ...form,
    meta: 'results meta',
    questions: [
      {
        text: 'Q',
        answers: [
          { text: 'a', count: 2, percent: 66.7 },
          { text: 'b', count: 1, percent: 33.3 },
        ],
      },
    ],
  };

  it('fills a form with the counts from the results view', () => {
    expect(withResults(form, results).questions[0]!.answers).toEqual([
      { text: 'a', count: 2, percent: 66.7 },
      { text: 'b', count: 1, percent: 33.3 },
    ]);
  });

  // catches: counts pinned to the wrong answers when the two views disagree. A
  // poll without counts beats one with counts on the wrong rows.
  it('leaves the form alone when the shapes differ', () => {
    const short: RecoveredPoll = {
      ...results,
      questions: [{ text: 'Q', answers: [{ text: 'a', count: 2 }] }],
    };
    expect(withResults(form, short)).toBe(form);
    expect(withResults(form, { ...results, id: 2 })).toBe(form);
  });
});

describe('parsePrompt', () => {
  // catches: LJ's chrome (the Reply link, the reply count) leaking in as if it
  // were the prompt.
  it("reads a Writer's Block prompt and leaves LJ's controls behind", () => {
    expect(parsePrompt(fixture('lj-writersblock.html'))).toEqual({
      kind: 'prompt',
      title: 'Music: A Made-Up Prompt',
      text: 'What did you listen to first?',
      url: 'https://www.livejournal.com/writersblock/question?qid=999',
    });
  });

  it('finds nothing on a page without one', () => {
    expect(parsePrompt('<div class="entry_text">just words</div>')).toBeUndefined();
    expect(parsePolls('<div class="entry_text">just words</div>')).toEqual([]);
  });
});
