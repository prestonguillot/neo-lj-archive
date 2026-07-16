/**
 * What LiveJournal actually sends. Every optional field here is optional
 * because a real capture proved it (DESIGN.md §5.1) — not because it seemed
 * safer.
 */

/** LJ's security levels. Absent from the response entirely means public. */
export type Security = 'public' | 'private' | 'usemask';

/**
 * Comment states. `A` is never transmitted — LJ omits the attribute when the
 * comment is active, so absent means active.
 */
export type CommentState = 'A' | 'D' | 'S' | 'F';

export interface Entry {
  readonly itemid: number;
  readonly anum: number;
  /** From LJ directly. Not computed as itemid*256+anum (DESIGN.md §7.3). */
  readonly ditemid: number;
  readonly eventtime: string;
  readonly logtime: string | undefined;
  readonly subject: string | undefined;
  /** Body HTML. LJ base64-encodes this selectively — 1 of 20 in one sample. */
  readonly body: string;
  readonly security: Security;
  /** Only meaningful when security === 'usemask'. */
  readonly allowmask: number | undefined;
  /** Free-text mood. Independent of moodid — either, both, or neither. */
  readonly mood: string | undefined;
  /** Reference into LJ's mood vocabulary. Resolve via the moods table. */
  readonly moodid: number | undefined;
  readonly music: string | undefined;
  readonly location: string | undefined;
  readonly pictureKeyword: string | undefined;
  readonly tags: readonly string[];
  /** Everything else LJ sent, so nothing is silently discarded. */
  readonly props: Readonly<Record<string, string>>;
}

/** One row of LJ's mood vocabulary, from `login` with `getmoods`. */
export interface Mood {
  readonly moodid: number;
  readonly name: string;
  readonly parent: number | undefined;
}

/** posterid → username, from the `usermaps` block of comment_meta. */
export interface UserMap {
  readonly posterid: number;
  readonly username: string;
}

/** From comment_meta: the index. Every comment, no text. */
export interface CommentMeta {
  readonly id: number;
  readonly jitemid: number;
  /** undefined = anonymous. LJ omits the attribute; it is never 0. */
  readonly posterid: number | undefined;
  readonly state: CommentState;
}

/** From comment_body: the text. Paged at 1,000. */
export interface CommentBody {
  readonly id: number;
  readonly jitemid: number;
  /** undefined = anonymous. */
  readonly posterid: number | undefined;
  /** undefined = top-level. LJ omits the attribute; it is never 0. */
  readonly parentid: number | undefined;
  readonly state: CommentState;
  readonly subject: string | undefined;
  /** undefined for deleted comments — they arrive self-closing, no children. */
  readonly body: string | undefined;
  readonly date: string | undefined;
}

export interface CommentMetaPage {
  /** Highest comment id in the journal. The termination condition for paging. */
  readonly maxid: number;
  readonly comments: readonly CommentMeta[];
  readonly usermaps: readonly UserMap[];
}

export interface LoginResult {
  readonly username: string;
  readonly fullname: string | undefined;
  /** Communities the account may post to. We never fetch these (DESIGN.md §3). */
  readonly usejournals: readonly string[];
  readonly moods: readonly Mood[];
}
