import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderBody, type RenderContext } from './render.js';

/**
 * Oracle: the same 57 real bodies the extractor is tested against — LiveJournal's
 * markup and 2005 tag soup (DESIGN.md §5.4, §10).
 */
interface Body {
  readonly kind: 'entry' | 'comment';
  readonly id: number;
  readonly html: string;
}
const bodies: Body[] = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/bodies.json', import.meta.url), 'utf8'),
) as Body[];

const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  localFor: () => undefined,
  deadReason: () => undefined,
  username: 'testuser',
  entryHref: () => undefined,
  root: '../',
  ...over,
});

describe('renderBody — images', () => {
  it('points a live image at its local blob', () => {
    const html = renderBody(
      '<img src="http://h1.invalid/a.jpg">',
      ctx({ localFor: () => 'blobs/ab/cd.jpg' }),
    );
    expect(html).toContain('src="../blobs/ab/cd.jpg"');
    expect(html).toContain('loading="lazy"');
  });

  // catches: a dead image rendered as a broken <img>, which in an offline
  // archive is a silent grey box. §4.3 says the archive is honest about its
  // gaps — 254 refs in the real journal are dead, and each has to say so.
  it('replaces a dead image with a marker naming what was lost', () => {
    const html = renderBody(
      '<img src="http://gone.invalid/cat.jpg" alt="my cat">',
      ctx({ deadReason: () => 'HTTP 404' }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('http://gone.invalid/cat.jpg');
    expect(html).toContain('my cat');
    expect(html).toContain('HTTP 404');
  });

  it('falls back to a generic label when there is no alt text', () => {
    // alt exists on 24 of 608 refs, so this is the common case.
    const html = renderBody('<img src="http://gone.invalid/x.jpg">', ctx());
    expect(html).toContain('image lost');
    expect(html).toContain('http://gone.invalid/x.jpg');
  });

  it('rewrites <a href> pointing at a localized image', () => {
    const html = renderBody(
      '<a href="http://h1.invalid/big.jpg">see</a>',
      ctx({ localFor: () => 'blobs/aa/bb.jpg' }),
    );
    expect(html).toContain('href="../blobs/aa/bb.jpg"');
  });
});

describe('renderBody — links (§7.3)', () => {
  // catches: self-references dead-ending. An entry linking to another of the
  // author's own entries should land on the local page, not on a 2005 URL.
  it('rewrites a link to the author own journal to a local page', () => {
    const html = renderBody(
      '<a href="https://testuser.livejournal.com/1234.html">that post</a>',
      ctx({ entryHref: (d) => (d === 1234 ? 'entries/1234.html' : undefined) }),
    );
    expect(html).toContain('href="../entries/1234.html"');
  });

  // catches: rewriting OTHER people's journals. They're external, probably dead,
  // and not ours to fix (§7.3).
  it('leaves other people journals alone', () => {
    const html = renderBody(
      '<a href="https://someoneelse.livejournal.com/9.html">theirs</a>',
      ctx({ entryHref: () => 'entries/9.html' }),
    );
    expect(html).toContain('href="https://someoneelse.livejournal.com/9.html"');
  });

  it('leaves a self-link alone when we do not hold that entry', () => {
    const html = renderBody(
      '<a href="https://testuser.livejournal.com/77.html">deleted post</a>',
      ctx({ entryHref: () => undefined }),
    );
    expect(html).toContain('href="https://testuser.livejournal.com/77.html"');
  });
});

describe('renderBody — LJ markup (§5.3)', () => {
  // catches: <lj user> rendering as nothing. A browser drops unknown elements
  // but KEEPS their text — and <lj user="x"> has no text, so 204 mentions of
  // 193 people vanish silently.
  it('renders <lj user> as a link, not nothing', () => {
    const html = renderBody('hi <lj user="alice"> there', ctx());
    expect(html).toContain('>alice<');
    expect(html).toContain('href="https://alice.livejournal.com/"');
  });

  // catches: an underscore name linking to a hostname that resolves to nothing.
  // LJ maps underscores to hyphens in journal hosts — <lj user="a_b"> goes to
  // a-b.livejournal.com, because an underscore is not legal in a hostname. 40 of
  // the 193 people in the real journal have one, so 21% of mentions dead-ended.
  // Found by diffing entry 353017 against the live page, where exactly the 37
  // underscore-names were the 37 LJ linked and we didn't.
  it('maps underscores to hyphens in the link host, but not in the name', () => {
    const html = renderBody('<lj user="some_user">', ctx());
    expect(html).toContain('href="https://some-user.livejournal.com/"');
    // The person is still called what they are called.
    expect(html).toContain('>some_user<');
  });

  it('renders <lj comm> too', () => {
    expect(renderBody('<lj comm="somegroup">', ctx())).toContain('somegroup');
  });

  // catches: dropping the second of two people mentioned in a row. <lj user> is
  // semantically VOID — LJ never closed it — but parse5 doesn't know that, so
  // `<lj user=a> and <lj user=b>` nests b INSIDE a. Replace the outer, stop, and
  // the inner is silently discarded: 3 of 196 in the real corpus, always the
  // second name in an "a and b". The exact failure this feature exists to stop.
  it('renders both people when mentions nest', () => {
    const html = renderBody('<lj user="alice"> and <lj user="bob"> went', ctx());
    expect(html).toContain('>alice<');
    expect(html).toContain('>bob<');
    expect((html.match(/class="lj-user"/g) ?? []).length).toBe(2);
    // And the prose between and after them survives.
    expect(html).toContain('and');
    expect(html).toContain('went');
  });

  // catches: an unclosed cut losing the rest of the entry. 54 of 69 cuts in the
  // real corpus are never closed — LJ treated that as "cut to end of entry".
  it('wraps an unclosed <lj-cut> to the end of the entry', () => {
    const html = renderBody('before <lj-cut text="the rest"> after the cut', ctx());
    expect(html).toContain('<details');
    expect(html).toContain('<summary>the rest</summary>');
    expect(html).toContain('after the cut');
    // Everything after the cut is INSIDE the details.
    expect(html.indexOf('after the cut')).toBeGreaterThan(html.indexOf('<details'));
  });

  it('renders a cut open, because LJ expanded it on the entry own page', () => {
    expect(renderBody('<lj-cut>x</lj-cut>', ctx())).toMatch(/<details[^>]*open/);
  });

  it('labels a cut with no text', () => {
    expect(renderBody('<lj-cut>x</lj-cut>', ctx())).toContain('Read more');
  });

  // catches: an embed silently disappearing. There's no local copy of a video,
  // but "a video was here" is information the archive owes the reader (§4.3).
  it('leaves a note where an embed used to be', () => {
    const html = renderBody('<iframe src="https://v.invalid/x"></iframe>', ctx());
    expect(html).not.toContain('<iframe');
    expect(html).toContain('embedded media');
    expect(html).toContain('https://v.invalid/x');
  });

  // catches: EVERYTHING AFTER A VIDEO BEING DELETED. <lj-embed> opens 28 times in
  // the real corpus and closes zero times — it is void, exactly like <lj user>.
  // parse5 therefore nests the rest of the entry inside it, and replacing the tag
  // without hoisting its children threw that away: entry 406397 has 3 images and
  // rendered 1, plus the text after the video, across 6 items. Found by the author
  // comparing a built page against the live journal, not by this suite.
  it('keeps the images and prose that follow an unclosed lj-embed', () => {
    const html = renderBody(
      '<img src="http://h.invalid/a.jpg"><lj-embed id="42">' +
        'words after the video<img src="http://h.invalid/b.jpg">',
      ctx({ localFor: (u) => (u.endsWith('a.jpg') ? 'blobs/a.jpg' : 'blobs/b.jpg') }),
    );
    expect(html).toContain('embedded media');
    expect(html).toContain('words after the video');
    // BOTH images survive — the one before the embed and the one after it.
    expect((html.match(/<img/g) ?? []).length).toBe(2);
  });

  // catches: hoisting <object>'s children. Unlike lj-embed these are balanced
  // 17/17 in the corpus, and their children are <param>s and fallback text that
  // mean nothing once the object is gone — they belong to it and go with it.
  it('drops the fallback content inside a properly closed object', () => {
    const html = renderBody(
      '<object data="http://v.invalid/x"><param name="movie"><b>needs flash</b></object>after',
      ctx(),
    );
    expect(html).toContain('embedded media');
    expect(html).not.toContain('needs flash');
    expect(html).not.toContain('<param');
    // But real content after the object is untouched.
    expect(html).toContain('after');
  });

  // catches: a poll rendering as nothing. LJ kept polls on its servers, so the
  // export has only <lj-poll-1438708> — an unknown tag a browser drops silently.
  // One real entry reads "So LiveJournal, I ask you:" and then the poll; drop it
  // and the entry trails off into nothing with no sign anything was ever there.
  it('names a poll that LiveJournal kept on its own servers', () => {
    const html = renderBody('I ask you: <lj-poll-1438708>', ctx());
    expect(html).toContain('poll');
    expect(html).toContain('1438708'); // the id survives, so it stays recoverable
    expect(html).not.toMatch(/<lj-poll/i);
  });

  // catches: the poll eating the rest of the entry. LJ never closed these tags,
  // so parse5 nests everything after one INSIDE it — the same void-tag trap that
  // dropped the second person in an "<lj user=a> and <lj user=b>" pair.
  it('keeps the prose that follows an unclosed poll tag', () => {
    const html = renderBody('before <lj-poll-99> after the poll', ctx());
    expect(html).toContain('after the poll');
  });

  it('names a qotd template by name', () => {
    const html = renderBody('<lj-template name="qotd" id="27" />', ctx());
    expect(html).toContain('qotd');
    expect(html).not.toMatch(/<lj-template/i);
  });

  // catches: lj-raw being replaced by a marker. It means "render this untouched"
  // — a directive, not a lost feature. Its contents are real and must survive.
  it('unwraps lj-raw and keeps what it wrapped', () => {
    const html = renderBody('<lj-raw><b>kept</b></lj-raw>', ctx());
    expect(html).toContain('<b>kept</b>');
    expect(html).not.toContain('lj-lost');
    expect(html).not.toMatch(/<lj-raw/i);
  });
});

describe('renderBody — emoticons that look like markup', () => {
  // catches: a broken heart eating the end of the entry. HTML5 sends `</` plus a
  // non-letter into the BOGUS COMMENT state, which swallows to the next `>` — and
  // with none, the rest of the body. Entry 127053 signs off "</3, Preston" and
  // lost the heart AND the name. The live LJ page still shows both, so this is a
  // real divergence, not fidelity to a 2005 browser.
  //
  // Found by diffing against the live journal — the only oracle in this project
  // that isn't derived from my own assumptions. No fixture test could catch it.
  it('keeps a broken-heart emoticon and everything after it', () => {
    const html = renderBody('I am angry.\n\n</3,\nPreston', ctx());
    expect(html).toContain('Preston');
    expect(html).toContain('3,');
    expect(html).not.toContain('<!--');
  });

  it('keeps a plain heart too', () => {
    // A different tokenizer state — this one already worked, and must stay working.
    expect(renderBody('love you <3 bye', ctx())).toContain('bye');
  });

  // catches: over-escaping. Real closing tags must still close.
  it('does not break real closing tags', () => {
    const html = renderBody('<b>bold</b> after', ctx());
    expect(html).toContain('<b>bold</b>');
    expect(html).toContain('after');
    expect(html).not.toContain('&lt;/b');
  });
});

describe('renderBody — recovered embeds', () => {
  // catches: a recovered video not being linked. A YouTube player can't load from
  // file:// (error 153), so the card links OUT to the video — but it must link.
  it('links a recovered embed out to its video', () => {
    const html = renderBody(
      '<lj-embed id="42">',
      ctx({ embedUrl: () => ({ watch: 'https://www.youtube.com/watch?v=abc' }) }),
    );
    expect(html).toContain('href="https://www.youtube.com/watch?v=abc"');
    // Opens elsewhere, and does NOT try to embed a player (which would 153).
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('<iframe');
  });

  // catches: a downloaded poster not being shown. The poster is what makes the
  // card read as a video rather than a link, and it's stored locally so it shows
  // offline — the whole reason it was fetched.
  it('shows the local poster over the card when there is one', () => {
    const html = renderBody(
      '<lj-embed id="1">',
      ctx({ embedUrl: () => ({ watch: 'https://youtu.be/x', poster: 'blobs/aa/bb.jpg' }) }),
    );
    expect(html).toContain('src="../blobs/aa/bb.jpg"');
  });

  // catches: the ordinal mapping drifting. The Nth lj-embed in the body must get
  // the Nth recovered video — off-by-one attaches the wrong video to a post.
  it('maps recovered videos to embeds in document order', () => {
    const urls = [{ watch: 'https://youtu.be/A' }, { watch: 'https://youtu.be/B' }];
    const html = renderBody(
      'one <lj-embed id="1"> two <lj-embed id="2">',
      ctx({ embedUrl: (i) => urls[i] }),
    );
    expect(html.indexOf('youtu.be/A')).toBeLessThan(html.indexOf('youtu.be/B'));
    expect(html).toContain('two');
  });

  // catches: an unrecovered embed still claiming to be a video. 7 of 28 carried
  // only dead session tokens; those stay plain markers, not links.
  it('falls back to a plain marker when nothing was recovered', () => {
    const html = renderBody('<lj-embed id="9">', ctx({ embedUrl: () => undefined }));
    expect(html).toContain('embedded media');
    expect(html).not.toContain('<a');
  });
});

describe('renderBody — schemeless links', () => {
  // catches: <a href="www.foo.com"> resolving as a RELATIVE path. A 2003 habit:
  // with no scheme the browser resolves it against the current directory, so
  // inside the archive it lands on a file:// 404 rather than going anywhere.
  it('restores the scheme on a bare hostname', () => {
    const html = renderBody('<a href="www.somethingawful.com">SA</a>', ctx());
    expect(html).toContain('href="http://www.somethingawful.com"');
  });

  // catches: mangling real relative links. Not everything without a scheme is a
  // hostname, and rewriting an anchor or a path would break a working link.
  it('leaves real relative and anchor links alone', () => {
    expect(renderBody('<a href="#top">top</a>', ctx())).toContain('href="#top"');
    expect(renderBody('<a href="/foo/bar">x</a>', ctx())).toContain('href="/foo/bar"');
  });
});

describe('renderBody — real corpus', () => {
  // catches: throwing on real tag soup. This is 2003 HTML: unclosed tags,
  // uppercase elements, unquoted attributes, table layouts, foster-parented text.
  it('renders all 57 real bodies without throwing', () => {
    for (const b of bodies) {
      expect(() => renderBody(b.html, ctx({ localFor: () => 'blobs/x/y.jpg' }))).not.toThrow();
    }
  });

  // catches: leaving LJ markup in the output. A browser renders <lj user> as
  // nothing and <lj-cut> as nothing — the whole point of the transform.
  it('leaves no lj-namespace tags in the output', () => {
    for (const b of bodies) {
      const html = renderBody(b.html, ctx({ localFor: () => 'blobs/x/y.jpg' }));
      expect(html).not.toMatch(/<lj[\s>]/i);
      expect(html).not.toMatch(/<lj-cut/i);
      expect(html).not.toMatch(/<lj-embed/i);
    }
  });

  it('renders every lj-user mention in the corpus as a link', () => {
    const n = bodies.reduce((sum, b) => {
      const html = renderBody(b.html, ctx());
      return sum + (html.match(/class="lj-user"/g) ?? []).length;
    }, 0);
    expect(n).toBe(196);
  });
});
