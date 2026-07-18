import { parseFragment, serialize } from 'parse5';

/**
 * Turn a 2005 LiveJournal body into something a browser in 2040 renders right
 * (DESIGN.md §7).
 *
 * parse5 parse -> transform -> serialize. Round-tripping is CORRECT here, and
 * was wrong in the scrubber, for the same reason: it repairs malformed markup.
 * The scrubber had to preserve the malformation (it was the thing under test);
 * the browser needs valid HTML. An unclosed <lj-cut> auto-closing to the end of
 * the entry is exactly LJ's semantics (§5.3).
 */

export interface RenderContext {
  /** source URL -> local blob path, relative to the page. Only live images. */
  readonly localFor: (url: string) => string | undefined;
  /** source URL -> why it died, for the placeholder to carry (§4.3). */
  readonly deadReason: (url: string) => string | undefined;
  /** The journal owner, for spotting self-referential links. */
  readonly username: string;
  /** ditemid -> relative path of that entry's page, for self-link rewriting. */
  readonly entryHref: (ditemid: number) => string | undefined;
  /** Prefix from this page back to the archive root, e.g. '../'. */
  readonly root: string;
  /**
   * Normalise a src/href the SAME way extraction did before storing it (resolve
   * against the entry's permalink, percent-encode, etc). The store is keyed by
   * the normalised URL; looking up by the raw attribute misses whenever the two
   * differ — six real Photobucket images whose src carries a trailing `"`
   * (extraction stored `%22`) were shown as "lost" while their blobs sat on disk.
   * Optional: without it, lookups use the raw attribute (fine for absolute srcs).
   */
  readonly resolveUrl?: (raw: string) => string;
  /**
   * LJ's opt_preformatted prop: the body is already real HTML, leave its
   * newlines alone. Only 4 of 1,547 entries set it — the other 1,543 rely on LJ
   * turning newlines into breaks at render time.
   */
  readonly preformatted?: boolean;
  /**
   * The Nth <lj-embed> in this body, in document order: where the video lives and
   * (if downloaded) its local poster frame. undefined if unrecoverable.
   *
   * The export gives only <lj-embed id="X">, where the id is LJ's internal embed
   * key, not the video. The real URL was scraped from the rendered page. A YouTube
   * player cannot load from file:// — proven: a video that plays over http fails
   * with error 153 over file:// — so the archive links OUT to the video rather
   * than trying to play it inline, over a poster frame stored locally.
   */
  readonly embedUrl?: (index: number) => { watch: string; poster?: string } | undefined;
}

interface Node {
  nodeName: string;
  tagName?: string;
  namespaceURI?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  parentNode?: Node | null;
  content?: Node;
}

const attr = (n: Node, name: string): string | undefined =>
  n.attrs?.find((a) => a.name.toLowerCase() === name)?.value;

const setAttr = (n: Node, name: string, value: string): void => {
  const a = n.attrs?.find((x) => x.name.toLowerCase() === name);
  if (a) a.value = value;
  else (n.attrs ??= []).push({ name, value });
};

/**
 * namespaceURI is not decoration: parse5's serializer only recognises a void
 * element when the node is in the HTML namespace. Without it, <br> serialises as
 * `<br></br>` — and HTML5 parses a `</br>` end tag as ANOTHER break, so every
 * line in the archive would come out double-spaced.
 */
const HTML_NS = 'http://www.w3.org/1999/xhtml';

const el = (
  tagName: string,
  attrs: { name: string; value: string }[],
  children: Node[] = [],
): Node => ({
  nodeName: tagName,
  tagName,
  namespaceURI: HTML_NS,
  attrs,
  childNodes: children,
});

const text = (value: string): Node => ({ nodeName: '#text', value });

function replace(node: Node, withNode: Node): void {
  replaceWith(node, [withNode]);
}

/** Swap a node for zero or more siblings in its parent. */
function replaceWith(node: Node, nodes: Node[]): void {
  const p = node.parentNode;
  if (!p?.childNodes) return;
  const i = p.childNodes.indexOf(node);
  if (i === -1) return;
  for (const n of nodes) n.parentNode = p;
  p.childNodes.splice(i, 1, ...nodes);
}

/** An image we couldn't recover, rendered as a marker that names what was lost. */
function deadImage(url: string, reason: string | undefined, alt: string | undefined): Node {
  // §4.3: the archive is honest about its gaps. alt text exists on only 24 of
  // 608 refs in this corpus, so the URL and the reason are most of what's left.
  return el(
    'span',
    [
      { name: 'class', value: 'dead-image' },
      { name: 'title', value: `${url}${reason !== undefined ? ` — ${reason}` : ''}` },
    ],
    [
      text('🖼 '),
      el('span', [{ name: 'class', value: 'dead-image-label' }], [text(alt ?? 'image lost')]),
      el('span', [{ name: 'class', value: 'dead-image-url' }], [text(url)]),
      ...(reason !== undefined
        ? [el('span', [{ name: 'class', value: 'dead-image-why' }], [text(reason)])]
        : []),
    ],
  );
}

/** Any lj-* element. The poll id is part of the TAG NAME: <lj-poll-1438708>. */
const LJ_TAG = /^lj-/i;
const LJ_POLL = /^lj-poll(?:-(\d+))?$/i;

/** Say what the feature was and, where LJ put it in the tag name, which one. */
function ljLostLabel(tag: string, node: Node): string {
  const poll = LJ_POLL.exec(tag);
  if (poll !== null) {
    const id = poll[1];
    return `📊 poll${id !== undefined ? ` #${id}` : ''} — LiveJournal kept the questions and answers on its own servers, so they are not in the export`;
  }
  if (tag.toLowerCase() === 'lj-template') {
    const name = attr(node, 'name');
    return `🔖 LiveJournal template${name !== undefined ? ` (${name})` : ''} — rendered by LJ, not stored in the entry`;
  }
  return `🔖 LiveJournal <${tag}> — a feature that lived on LJ's servers`;
}

/**
 * A person's journal URL.
 *
 * LJ maps underscores to hyphens in journal HOSTNAMES: <lj user="a_b"> links to
 * a-b.livejournal.com, because an underscore is not legal in a hostname.
 * Building a_b.livejournal.com yields an address that resolves to nothing — 40
 * of the 193 people in this journal, 21% of them. The NAME keeps its underscore;
 * only the host is rewritten.
 *
 * Exported because comment AUTHORS are linked from build/index.ts, a separate
 * code path that had its own copy of this URL and its own copy of the bug. Two
 * places building the same string is how the fix reached body mentions and left
 * 644 comment bylines broken.
 */
export const journalUrl = (username: string): string =>
  `https://${username.replace(/_/g, '-')}.livejournal.com/`;

const IMAGE_EXT = /\.(jpe?g|png|gif|bmp|webp|tiff?)(?:[?#]|$)/i;

/**
 * `<a href="www.somethingawful.com">` — a 2003 habit. There's no scheme, so a
 * browser resolves it against the current directory and lands on a file:// 404
 * inside the archive. Unlike a normal external link, which at least still names
 * a place, this one points at nothing anywhere. Restoring the scheme the author
 * meant is the only reading that isn't broken.
 */
const BARE_HOST = /^(?:www\.|[a-z0-9-]+\.(?:com|net|org|edu|gov|co\.uk)\b)/i;

function repairScheme(href: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) {
    return undefined;
  }
  return BARE_HOST.test(href) ? `http://${href}` : undefined;
}

/** Is this a link to the owner's own journal? If so it can point at a local page. */
function selfDitemid(href: string, username: string): number | undefined {
  try {
    const u = new URL(href);
    if (u.hostname.toLowerCase() !== `${username.toLowerCase()}.livejournal.com`) return undefined;
    const m = /^\/(\d+)\.html$/.exec(u.pathname);
    return m?.[1] !== undefined ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `</3` is a broken heart, not a tag.
 *
 * HTML5 puts `</` followed by a non-letter into the BOGUS COMMENT state: it
 * swallows everything up to the next `>`, and when there isn't one, the rest of
 * the entry. Entry 127053 signs off with a broken heart and the author's name,
 * and both silently vanished — the tokenizer ate them.
 *
 * LiveJournal escapes these on the way in, and the live page still shows that
 * sign-off. So this isn't faithful-to-a-2005-browser, it's a real divergence
 * from both what the author wrote and what LJ renders. Escaping matches both.
 *
 * Only `</` needs it. A bare `<3` is a different tokenizer state — "invalid
 * first character of tag name" — which emits the `<` as text and carries on, so
 * hearts already survive.
 */
const escapeBogusEndTags = (html: string): string => html.replace(/<\/(?![a-zA-Z])/g, '&lt;/');

/**
 * Tags whose newlines are MARKUP, not writing. Suppression is inherited, so
 * anything inside a table is covered at any depth.
 *
 * DERIVED from the live journal, not reasoned out — the reasoning was wrong. The
 * first version of this list included ul/ol, on the sensible theory that
 * indentation inside a list is markup rather than prose. The page disagrees:
 *
 *   353595   6 newlines inside a <ul>   -> LJ renders 6 <br>
 *   61314    3 newlines beside a table  -> LJ renders 3
 *   278183   16 newlines, 14 in a table -> LJ renders 2
 *   35094    620 newlines, ~617 in one  -> LJ renders 3
 *   355841   35 newlines, bare prose    -> LJ renders 35
 *   115772   opt_preformatted           -> LJ renders 0
 *
 * So: suppress inside tables and <pre>, not lists. Verified per container against
 * the live pages — lj-cut (61 entries), i, center, lj-embed, lj, a, b,
 * blockquote, div, colgroup all match.
 *
 * KNOWN LIMITATION — 4 entries of 1,547: 79958, 163243, 87570, 353017.
 *
 * Only 12 entries in this journal have a table AND newlines; 8 match LJ exactly
 * and these 4 do not, by between 2 and 22 breaks. The cause is architectural
 * rather than a rule to tweak. LJ's cleaner walks the RAW TOKEN STREAM and
 * counts open tags as it goes, so "inside a table" means "a <table> was opened
 * and not yet closed". parse5 hands us a REPAIRED TREE, where malformed 2004
 * table soup — unclosed cells, foster-parented text — has already been
 * restructured. On broken markup the two genuinely disagree about what is inside
 * the table, and no configuration of this list reconciles them.
 *
 * Matching LJ exactly would mean reimplementing its linear scanner instead of
 * using a real HTML parser: adopting LiveJournal's parsing bugs to recover some
 * blank lines inside table cells in four posts. The content of all four is
 * present and correct; only the spacing differs. That trade is not worth it, so
 * this is written down rather than fixed.
 */
const NO_BREAKS = new Set([
  'pre',
  'textarea',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'select',
  'option',
  'script',
  'style',
]);

/**
 * A newline is a line break (LJ's addbreaks).
 *
 * LiveJournal converted \n to <br /> when it rendered an entry, unless
 * opt_preformatted was set. We stored the raw body — newlines and all — and then
 * parsed it as HTML, where whitespace collapses. So every paragraph break in
 * 1,132 of 1,547 entries silently vanished: 73% of the journal rendered as one
 * wall of text.
 *
 * Verified against the live page rather than assumed: entry 355841 has 35
 * newlines and no <br> in the source, and LJ renders it with exactly 35 <br>.
 *
 * Done on the parsed tree, not with a regex over the source, because a regex
 * cannot tell a newline inside an attribute or between two <tr>s from a newline
 * the author typed.
 */
function addBreaks(node: Node, inNoBreak: boolean): void {
  const parentTag = node.tagName?.toLowerCase();
  const suppressed = inNoBreak || (parentTag !== undefined && NO_BREAKS.has(parentTag));
  for (const c of [...(node.childNodes ?? [])]) {
    if (c.nodeName === '#text') {
      if (suppressed || c.value === undefined || !c.value.includes('\n')) continue;
      const parts = c.value.split('\n');
      const out: Node[] = [];
      parts.forEach((part, i) => {
        if (i > 0) out.push(el('br', []));
        if (part !== '') out.push(text(part));
      });
      replaceWith(c, out);
    } else {
      addBreaks(c, suppressed);
      if (c.content) addBreaks(c.content, suppressed);
    }
  }
}

export function renderBody(html: string, ctx: RenderContext): string {
  const frag = parseFragment(escapeBogusEndTags(html)) as unknown as Node;

  // Which <lj-embed> we're on, so ctx.embedUrl gets them in document order.
  let embedSeen = 0;

  // Before the transform: the LJ tags below rebuild subtrees, and a newline that
  // has already become a <br> element survives that intact, where a raw \n in a
  // text node would be at the mercy of every later reparent.
  if (ctx.preformatted !== true) addBreaks(frag, false);

  const visit = (node: Node): void => {
    // Snapshot: the transform replaces nodes as it goes.
    const children = [...(node.childNodes ?? [])];
    const tag = node.tagName?.toLowerCase();

    // Sanitize third-party content BEFORE any other handling (§8). LJ scrubbed
    // comments and the owner injected nothing, so the corpus is clean today — but
    // renderBody serializes commenter-supplied HTML into the page, and the moment
    // the archive is served over HTTP that is stored XSS. parse5 already gives us
    // the tree; neutralize it here rather than trust the input.
    if (tag === 'script' || tag === 'style') {
      // Executable/leaky content with no reader value once the video/CSS is gone.
      replaceWith(node, []);
      return;
    }
    if (node.attrs !== undefined) {
      node.attrs = node.attrs.filter((a) => {
        const name = a.name.toLowerCase();
        // Event handlers (onclick, onerror, …) are script; drop them.
        if (name.startsWith('on')) return false;
        // A javascript: URL in href/src/action executes on click/load.
        if (
          (name === 'href' || name === 'src' || name === 'action') &&
          /^\s*javascript:/i.test(a.value)
        ) {
          return false;
        }
        return true;
      });
    }

    if (tag === 'img') {
      const src = attr(node, 'src');
      if (src !== undefined) {
        // Look up by the normalised URL the store was keyed by, not the raw src.
        const key = ctx.resolveUrl?.(src) ?? src;
        const local = ctx.localFor(key);
        if (local !== undefined) {
          setAttr(node, 'src', ctx.root + local);
          // Old entries are full of width/height that no longer match, and the
          // layout is ours now, not 2004's.
          setAttr(node, 'loading', 'lazy');
          // A missing alt makes a screen reader read the sha256 blob name aloud;
          // we don't know what the image showed, so "" (skip) is the honest choice.
          if (attr(node, 'alt') === undefined) setAttr(node, 'alt', '');
        } else {
          // The placeholder still shows the raw src — what the author wrote.
          replace(node, deadImage(src, ctx.deadReason(key), attr(node, 'alt')));
          return;
        }
      }
    } else if (tag === 'a') {
      const href = attr(node, 'href');
      if (href !== undefined) {
        const key = ctx.resolveUrl?.(href) ?? href;
        const local = IMAGE_EXT.test(href) ? ctx.localFor(key) : undefined;
        if (local !== undefined) {
          setAttr(node, 'href', ctx.root + local);
        } else {
          const d = selfDitemid(href, ctx.username);
          const page = d !== undefined ? ctx.entryHref(d) : undefined;
          // Self-references stop dead-ending (§7.3). Links to OTHER people's
          // journals are left alone — external, probably dead, not ours to fix.
          if (page !== undefined) {
            setAttr(node, 'href', ctx.root + page);
          } else {
            const repaired = repairScheme(href);
            if (repaired !== undefined) setAttr(node, 'href', repaired);
          }
        }
        // A 2004 target="_blank" opens the opener to the linked page; close it.
        if (attr(node, 'target')?.toLowerCase() === '_blank' && attr(node, 'rel') === undefined) {
          setAttr(node, 'rel', 'noopener noreferrer');
        }
      }
    } else if (tag === 'lj') {
      // 204 of these across 193 people. Unhandled they render as NOTHING (§5.3).
      const user = attr(node, 'user') ?? attr(node, 'comm');
      if (user !== undefined) {
        // <lj user="x"> is semantically VOID — LJ never closed it. parse5 doesn't
        // know that, so consecutive mentions NEST: `<lj user=a> and <lj user=b>`
        // makes b a child of a. Replacing the outer and stopping would silently
        // drop the inner — 3 of 196 in the real corpus, i.e. the second person in
        // every "a and b" pair. So the children are hoisted to siblings, which is
        // what the author meant and what LJ rendered.
        const link = el(
          'a',
          [
            { name: 'class', value: 'lj-user' },
            { name: 'href', value: journalUrl(user) },
          ],
          [text(user)],
        );
        replaceWith(node, [link, ...children]);
        for (const c of children) visit(c);
        return;
      }
    } else if (tag === 'lj-cut') {
      // <details open>: a native element, no JS, and honest about the structure.
      // Open by default because LJ itself expanded the cut on the entry's own
      // page — the cut only ever mattered on the friends view.
      const cutText = attr(node, 'text')?.trim();
      const details = el(
        'details',
        [
          { name: 'class', value: 'lj-cut' },
          { name: 'open', value: '' },
        ],
        [
          el(
            'summary',
            [],
            [text(cutText !== undefined && cutText !== '' ? cutText : 'Read more')],
          ),
          ...children,
        ],
      );
      for (const c of children) c.parentNode = details;
      replace(node, details);
      for (const c of children) visit(c);
      return;
    } else if (tag === 'lj-raw') {
      // "Render this untouched" — a directive, not content. Drop the wrapper and
      // keep what it wrapped, which is the whole of what it meant.
      replaceWith(node, children);
      for (const c of children) visit(c);
      return;
    } else if (tag === 'lj-embed' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
      // There is no meaningful LOCAL copy of an embedded video (§5.2), but the
      // link is worth keeping: the video may still exist even though the entry's
      // copy of it doesn't.
      const recovered = tag === 'lj-embed' ? ctx.embedUrl?.(embedSeen++) : undefined;
      const rawUrl = attr(node, 'src') ?? attr(node, 'data') ?? attr(node, 'id');
      const marker =
        recovered !== undefined
          ? el(
              'a',
              [
                { name: 'href', value: recovered.watch },
                { name: 'class', value: 'lj-video' },
                { name: 'target', value: '_blank' },
                { name: 'rel', value: 'noopener' },
                { name: 'title', value: 'Opens on YouTube — a local file cannot play it inline' },
              ],
              [
                // A real poster frame when we have one; a plain dark card when the
                // video is gone. Either way a play badge, and it opens the video.
                ...(recovered.poster !== undefined
                  ? [
                      el('img', [
                        { name: 'src', value: ctx.root + recovered.poster },
                        { name: 'alt', value: '' },
                        { name: 'loading', value: 'lazy' },
                      ]),
                    ]
                  : []),
                el(
                  'span',
                  [{ name: 'class', value: 'play-badge' }],
                  [text('\u25B6 Watch on YouTube')],
                ),
              ],
            )
          : el(
              'span',
              [{ name: 'class', value: 'embed-lost' }],
              [text(`\u25B6 embedded media${rawUrl !== undefined ? ` (${rawUrl})` : ''}`)],
            );

      // <lj-embed> is VOID and the others are not, so they cannot share a branch.
      // In this corpus lj-embed opens 28 times and closes ZERO; <object> and
      // <embed> are balanced 17/17. So parse5 nests the rest of the entry inside
      // an lj-embed, and dropping its children deleted real content: 2 images and
      // the text after the video in 6 entries, silently. Same void-tag trap as
      // <lj user> and <lj-poll> — this is the third place it has bitten.
      //
      // The others keep dropping their children, which is correct rather than an
      // omission: an <object>'s children are <param>s and fallback text that mean
      // nothing once the object is gone.
      if (tag === 'lj-embed') {
        replaceWith(node, [marker, ...children]);
        for (const c of children) visit(c);
      } else {
        replace(node, marker);
      }
      return;
    } else if (tag !== undefined && LJ_TAG.test(tag)) {
      // Every OTHER lj-* tag, AFTER the specific handlers so it can only see the
      // ones nothing else claimed. These are server-side features whose content
      // never lived in the entry body — polls and qotd templates here. The 57-body
      // fixture contains none of them, which is exactly why this is a rule about
      // the class rather than a list of the four I happened to find.
      //
      // A browser renders an unknown tag as nothing, so an entry reading "So
      // LiveJournal, I ask you:" would trail off into silence. Naming the gap is
      // the honest rendering (§4.3), and keeping the id leaves it recoverable.
      replaceWith(node, [
        el('span', [{ name: 'class', value: 'lj-lost' }], [text(ljLostLabel(tag, node))]),
        // Same void-tag trap as <lj user>: LJ never closed these, so parse5 nests
        // the rest of the entry INSIDE them. Hoist the children back to siblings
        // or everything after a poll vanishes with it.
        ...children,
      ]);
      for (const c of children) visit(c);
      return;
    }

    for (const c of children) visit(c);
    if (node.content) visit(node.content);
  };

  visit(frag);
  return serialize(frag as never);
}
