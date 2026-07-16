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
}

interface Node {
  nodeName: string;
  tagName?: string;
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

const el = (
  tagName: string,
  attrs: { name: string; value: string }[],
  children: Node[] = [],
): Node => ({
  nodeName: tagName,
  tagName,
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

export function renderBody(html: string, ctx: RenderContext): string {
  const frag = parseFragment(html) as unknown as Node;

  const visit = (node: Node): void => {
    // Snapshot: the transform replaces nodes as it goes.
    const children = [...(node.childNodes ?? [])];
    const tag = node.tagName?.toLowerCase();

    if (tag === 'img') {
      const src = attr(node, 'src');
      if (src !== undefined) {
        const local = ctx.localFor(src);
        if (local !== undefined) {
          setAttr(node, 'src', ctx.root + local);
          // Old entries are full of width/height that no longer match, and the
          // layout is ours now, not 2004's.
          setAttr(node, 'loading', 'lazy');
        } else {
          replace(node, deadImage(src, ctx.deadReason(src), attr(node, 'alt')));
          return;
        }
      }
    } else if (tag === 'a') {
      const href = attr(node, 'href');
      if (href !== undefined) {
        const local = IMAGE_EXT.test(href) ? ctx.localFor(href) : undefined;
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
            { name: 'href', value: `https://${user}.livejournal.com/` },
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
      // Kept as a note with its reference, never localized: there is no
      // meaningful local copy of an embedded video (§5.2).
      const url = attr(node, 'src') ?? attr(node, 'data') ?? attr(node, 'id');
      replace(
        node,
        el(
          'span',
          [{ name: 'class', value: 'embed-lost' }],
          [text(`▶ embedded media${url !== undefined ? ` (${url})` : ''}`)],
        ),
      );
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
