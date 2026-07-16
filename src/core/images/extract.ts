import { parseFragment } from 'parse5';

/**
 * Pull everything localizable out of an entry or comment body (DESIGN.md §5.2).
 *
 * The input is hand-written tag soup from 2000–2010: unclosed tags, uppercase
 * elements, unquoted attributes, font/table layouts, and LJ's own markup. parse5
 * implements the real HTML5 parsing algorithm, which is what browsers do with
 * this, so it is the only thing that agrees with how the entry actually looked.
 */

export type ImageKind =
  /** <img src> — inline, must be localized. */
  | 'img'
  /** <a href> straight at an image file — also localized (§3). */
  | 'link';

export interface ImageRef {
  readonly url: string;
  /** Exactly as written, before resolution. Kept so a dead ref can name itself. */
  readonly raw: string;
  /** Present on 24 of 608 refs in the real corpus — usually absent (§5.2). */
  readonly alt: string | undefined;
  readonly kind: ImageKind;
}

export interface EmbedRef {
  readonly tag: string;
  /** Whatever URL it referenced, if any. Embeds are kept as links, not localized. */
  readonly url: string | undefined;
}

export interface Extraction {
  readonly images: readonly ImageRef[];
  /** Usernames from <lj user="…">. 179 of 193 are also commenters (§5.3). */
  readonly ljUsers: readonly string[];
  readonly embeds: readonly EmbedRef[];
  /** Whether the body has an <lj-cut>, closed or not. */
  readonly hasCut: boolean;
  /** The cut's teaser text, if it carried one. */
  readonly cutText: string | undefined;
}

/** Extensions that mean "this link IS an image", not "a page about one". */
const IMAGE_EXT = /\.(jpe?g|png|gif|bmp|webp|tiff?)(?:[?#]|$)/i;

const EMBED_TAGS = new Set(['iframe', 'object', 'embed', 'video', 'lj-embed']);

interface Node {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
}

const attr = (n: Node, name: string): string | undefined =>
  n.attrs?.find((a) => a.name.toLowerCase() === name)?.value;

/**
 * Resolve a possibly-relative URL against the entry's own permalink.
 *
 * 5 of 608 refs in the real corpus are relative or protocol-relative. Without a
 * base they're unfetchable, and dropping them would lose real images.
 */
function resolve(raw: string, base: string | undefined): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    return base !== undefined ? new URL(trimmed, base).href : new URL(trimmed).href;
  } catch {
    // Unparseable even with a base — keep it verbatim so the dead-image
    // placeholder can still name what was lost (§4.3).
    return trimmed;
  }
}

export function extract(html: string, entryUrl?: string): Extraction {
  const images: ImageRef[] = [];
  const ljUsers: string[] = [];
  const embeds: EmbedRef[] = [];
  let hasCut = false;
  let cutText: string | undefined;

  const visit = (node: Node): void => {
    const tag = node.tagName?.toLowerCase();

    if (tag === 'img') {
      const src = attr(node, 'src');
      if (src?.trim()) {
        images.push({
          url: resolve(src, entryUrl),
          raw: src,
          alt: attr(node, 'alt')?.trim() || undefined,
          kind: 'img',
        });
      }
    } else if (tag === 'a') {
      const href = attr(node, 'href');
      // Only links whose target IS an image. A link to a Flickr *page* is a
      // link; a link to the .jpg is an image we must keep.
      if (href?.trim() && IMAGE_EXT.test(href)) {
        images.push({
          url: resolve(href, entryUrl),
          raw: href,
          alt: undefined,
          kind: 'link',
        });
      }
    } else if (tag === 'lj') {
      // <lj user="…"> renders as a linked username with a userhead icon. Left
      // alone it renders as NOTHING — 204 mentions of people would silently
      // vanish from the entries (§5.3).
      const user = attr(node, 'user') ?? attr(node, 'comm');
      if (user?.trim()) ljUsers.push(user.trim().toLowerCase());
    } else if (tag === 'lj-cut') {
      hasCut = true;
      cutText ??= attr(node, 'text')?.trim() || undefined;
    } else if (tag !== undefined && EMBED_TAGS.has(tag)) {
      // Kept as a link with metadata, never localized: there is no meaningful
      // local copy of an embedded video (§5.2).
      embeds.push({
        tag,
        url: attr(node, 'src') ?? attr(node, 'data') ?? attr(node, 'id'),
      });
    }

    for (const c of node.childNodes ?? []) visit(c);
    if (node.content) visit(node.content);
  };

  visit(parseFragment(html) as unknown as Node);

  return { images, ljUsers, embeds, hasCut, cutText };
}

/**
 * Every distinct image URL in a corpus, and how many times each is referenced.
 *
 * Deliberately keyed on the URL rather than the host: dedup is by CONTENT hash
 * once downloaded (§5.2), and this is only the work list.
 */
export function distinctUrls(extractions: readonly Extraction[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of extractions) {
    for (const i of e.images) out.set(i.url, (out.get(i.url) ?? 0) + 1);
  }
  return out;
}
