/**
 * The default theme (DESIGN.md §7.1).
 *
 * Themeable means CSS custom properties over semantic markup with ONE swappable
 * stylesheet — not a framework. That's why this deviates from vibes' Bootstrap
 * (§15): the archive is a reading surface with almost no chrome.
 *
 * TYPE. The archive must open from file:// forever, so a webfont is not an
 * option — a font that needs the network is a font that eventually isn't there
 * (§13). That constraint dates the palette of available faces to roughly 2003,
 * which is exactly when this journal was written, so the type leans into it
 * rather than apologising: Trebuchet for display (the splayed M, the ear on the
 * g — a face with opinions, and one nobody reaches for now), Verdana for reading
 * (literally what LiveJournal set its entries in), Courier for metadata.
 *
 * LAYOUT. No centred column. A 42rem measure floating in the middle of a 1400px
 * screen is ~470px of dead margin on each side, which is the single most tiresome
 * habit of the modern web. A persistent rail spends that space on navigation —
 * the journal, the years, the tags — which is also what LJ itself did.
 *
 * COLOUR. Cool blue-grey paper, because this was read on a SCREEN at 6am, not
 * printed on parchment. Rose carries the security state: 1,422 of 1,547 entries
 * are private, which makes "this was locked" the truest single fact about the
 * archive, and worth seeing rather than decoding from a grey pill.
 */
export const STYLE = `
:root {
  --paper: #e4e8f0;
  --card: #fbfcfe;
  --sunk: #d9dfea;
  --ink: #14161c;
  --ink-2: #59616f;
  --rule: #c2cbdb;

  --rose: #d21e5b;
  --link: #1d54d6;
  --amber: #b07800;
  --dead: #b0451c;

  --display: "Trebuchet MS", "Lucida Grande", "DejaVu Sans", sans-serif;
  --body: Verdana, Geneva, "DejaVu Sans", sans-serif;
  --meta: "Courier New", Courier, monospace;

  --rail: 11rem;
  --radius: 3px;

  /*
   * The rail is dark in BOTH schemes — it is the page's spine, not a surface
   * that follows the paper. These are separate tokens because using --ink (a
   * FOREGROUND token) as a background is what broke it: dark mode inverted --ink
   * to near-white, the rail turned white, and its hardcoded light text became
   * invisible. A token's role has to survive the inversion.
   */
  --rail-bg: #14161c;
  --rail-fg: #cfd6e4;
  --rail-dim: #7c8698;
  --rail-hover: #262b36;
  --rail-rule: #2a313f;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #11141b;
    --card: #171b24;
    --sunk: #1d2230;
    --ink: #e7eaf1;
    --ink-2: #8b95a8;
    --rule: #2b3242;

    --rose: #ff5c8a;
    --link: #6fa0ff;
    --amber: #e0a828;
    --dead: #ff7a4d;

    /* Still dark, but lifted off a now-dark paper so the spine reads as an edge. */
    --rail-bg: #080a0e;
    --rail-hover: #1c212b;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--body);
  /* Verdana runs large; 14px here is roughly Georgia at 16. */
  font-size: 15px;
  line-height: 1.7;
}

a { color: var(--link); text-underline-offset: 2px; text-decoration-thickness: 1px; }
img { max-width: 100%; height: auto; }
.muted { color: var(--ink-2); }

:focus-visible { outline: 2px solid var(--rose); outline-offset: 2px; }

/* --- shell -------------------------------------------------------------- */
/* Rail + content. The rail is doing work, so the width isn't dead space. */
.shell { display: grid; grid-template-columns: var(--rail) minmax(0, 1fr); gap: 0; min-height: 100vh; }

.rail {
  background: var(--rail-bg);
  color: var(--rail-fg);
  border-right: 0;
  padding: 1.25rem .9rem;
  font-family: var(--meta);
  font-size: 12px;
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
}
.rail .site-title {
  font-family: var(--display);
  font-size: 1.2rem; font-weight: 700; line-height: 1.15;
  letter-spacing: -.02em;
  color: #fff; text-decoration: none;
  display: block; margin-bottom: .35rem;
}
.rail .site-title:hover { color: var(--rose); }
.rail .counts { color: var(--rail-dim); margin: 0 0 1.5rem; font-size: 11px; }
.rail nav { display: flex; flex-direction: column; gap: .1rem; margin-bottom: 1.5rem; }
.rail nav a {
  text-decoration: none; color: var(--rail-fg); padding: .28rem .45rem;
  border-radius: var(--radius); text-transform: uppercase; letter-spacing: .1em;
  border-left: 2px solid transparent;
}
.rail nav a:hover { background: var(--rail-hover); color: #fff; border-left-color: var(--rose); }
.rail .rail-heading {
  text-transform: uppercase; letter-spacing: .14em; font-size: 10px;
  color: var(--rail-dim); margin: 0 0 .5rem; padding-bottom: .3rem;
  border-bottom: 1px solid var(--rail-rule);
}
.rail .years { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: .2rem; }
.rail .years a {
  text-decoration: none; color: var(--rail-fg); padding: .18rem .45rem;
  border-radius: var(--radius); background: var(--rail-hover);
}
.rail .years a:hover { background: var(--rose); color: #fff; }

main { padding: 2.5rem 3rem 5rem; max-width: 100rem; }

/*
 * body + side. The measure stays readable (Verdana is wide; past ~70ch the eye
 * loses the line) while the leftover width carries the userpic, the record and
 * the tags. That is the difference between a layout and padding: the space is
 * doing something.
 */
.entry { display: grid; grid-template-columns: minmax(0, 82ch) minmax(12rem, 17rem); gap: 3rem; align-items: start; }
.entry-side { position: sticky; top: 2.5rem; display: flex; flex-direction: column; gap: 1rem; }
.spine, .comments { max-width: 82ch; }

@media (max-width: 68rem) {
  .entry { grid-template-columns: minmax(0, 1fr); gap: 1.25rem; }
  .entry-side { position: static; flex-direction: row; flex-wrap: wrap; align-items: center; gap: .75rem; }
}

/*
 * A bar, not a sidebar lying down.
 *
 * Collapsing simply un-stuck the rail and let it stack, so a phone opened to a
 * screenful of navigation before a word of the entry. Everything reflows onto one
 * line: title and counts left, nav right, years wrapping under. The "YEARS" label
 * goes — in a column it's a heading, in a bar it's a word taking up a row.
 */
@media (max-width: 44rem) {
  .shell { grid-template-columns: 1fr; }
  .rail {
    position: static; height: auto; overflow: visible;
    padding: .6rem .85rem;
    display: flex; flex-wrap: wrap; align-items: baseline; gap: .35rem .75rem;
  }
  .rail .site-title { font-size: 1rem; margin: 0; }
  .rail .counts { margin: 0; font-size: 10px; }
  .rail nav { flex-direction: row; margin: 0 0 0 auto; gap: .6rem; }
  .rail nav a { padding: .1rem .25rem; border-left: 0; }
  .rail nav a:hover { border-left: 0; }
  .rail .rail-heading { display: none; }
  .rail .years { flex-basis: 100%; gap: .2rem; }
  .rail .years a { padding: .08rem .35rem; font-size: 10px; }
  main { padding: 1.25rem 1rem 3rem; }
}

/* --- entry -------------------------------------------------------------- */
.entry header { margin-bottom: 1.75rem; }
.entry h1 {
  font-family: var(--display);
  font-size: 2rem; line-height: 1.1; font-weight: 700; letter-spacing: -.02em;
  margin: .1rem 0 .75rem;
}
.entry .date {
  font-family: var(--meta); font-size: 11px; letter-spacing: .06em;
  text-transform: uppercase; margin: 0; color: var(--ink-2);
}
.entry .date a { color: var(--ink-2); text-decoration: none; }
.entry .date a:hover { color: var(--rose); }

.userpic {
  width: 100px; height: 100px; object-fit: contain;
  background: var(--card); border: 1px solid var(--rule); border-radius: var(--radius);
}

/*
 * THE SIGNATURE. LJ's mood/music line is the one artifact no other platform has,
 * and this archive fought for it — 307 entries carry a moodid and no text, so the
 * word only exists after resolving LJ's vocabulary. It reads as a record, in the
 * typeface of a machine, because that is what it is.
 */
.meta {
  font-family: var(--meta); font-size: 11px; line-height: 1.75;
  border-left: 3px solid var(--rose);
  padding: .1rem 0 .1rem .7rem;
  display: flex; flex-direction: column;
  color: var(--ink-2);
}
.meta b { color: var(--ink); font-weight: 400; }
.meta .mood b { color: var(--amber); }
.meta .music b, .meta .location b { color: var(--ink); }
/* The record labels itself. Stacked, so a long track title wraps under its key
   instead of shoving the value off the column. */
.meta > span { display: block; }
.meta > span::before {
  content: attr(data-k);
  display: block; font-size: 9px; text-transform: uppercase; letter-spacing: .12em;
  color: var(--ink-2); opacity: .6;
}
.meta > span + span { margin-top: .5rem; }
.meta b { display: block; line-height: 1.5; }
.security-private { color: var(--rose); font-weight: 700; }
.security-usemask { color: var(--amber); font-weight: 700; }
.security-public { color: var(--ink-2); }

.tags { list-style: none; display: flex; flex-wrap: wrap; gap: .3rem; padding: 0; margin: 0; }
.tags a {
  font-family: var(--meta); font-size: 11px; text-decoration: none;
  background: var(--sunk); color: var(--ink); padding: .15rem .5rem; border-radius: var(--radius);
}
.tags a:hover { background: var(--amber); color: #14161c; }

.body { overflow-x: auto; }
.body table { max-width: 100%; }
.body p { margin: 0 0 1.15em; }
.body img { border-radius: var(--radius); }

.lj-user {
  font-family: var(--display); font-weight: 700; font-size: .95em;
  text-decoration: none; color: var(--link);
  border-bottom: 1px dotted var(--link);
}
.lj-user:hover { background: var(--link); color: var(--card); border-bottom-color: transparent; }

details.lj-cut {
  border-left: 3px solid var(--amber); padding: .25rem 0 .25rem 1rem; margin: 1.25rem 0;
}
details.lj-cut summary {
  font-family: var(--meta); font-size: 11px; color: var(--amber);
  text-transform: uppercase; letter-spacing: .08em; cursor: pointer; margin-bottom: .5rem;
}

/* Honest about the gaps (§4.3): a lost image says what it was and why. */
.dead-image {
  display: inline-flex; flex-direction: column; gap: .1rem;
  border: 1px dashed var(--dead); border-radius: var(--radius);
  padding: .5rem .7rem; margin: .3rem 0; max-width: 100%;
  font-family: var(--meta); font-size: 10.5px; color: var(--dead);
}
.dead-image-label { font-weight: 700; }
.dead-image-url, .dead-image-why { color: var(--ink-2); word-break: break-all; }
.embed-lost, .lj-lost {
  font-family: var(--meta); font-size: 11px; color: var(--ink-2);
  border: 1px dashed var(--rule); border-radius: var(--radius);
  padding: .3rem .6rem; display: inline-block; margin: .3rem 0;
}

/* --- spine -------------------------------------------------------------- */
.spine {
  display: flex; justify-content: space-between; gap: 1rem; margin: 3rem 0 0;
  font-family: var(--meta); font-size: 11px;
  border-top: 1px solid var(--rule); padding-top: 1rem;
}
.spine a { max-width: 45%; text-decoration: none; color: var(--ink-2); }
.spine a:hover { color: var(--rose); }

/* --- comments ----------------------------------------------------------- */
.comments h2 {
  font-family: var(--meta); font-size: 11px; font-weight: 400;
  text-transform: uppercase; letter-spacing: .12em; color: var(--ink-2);
  border-top: 1px solid var(--rule); padding-top: 1.75rem; margin-top: 3rem;
}
.comment { margin: 1.25rem 0; }
.comment header {
  font-family: var(--meta); font-size: 11px; color: var(--ink-2);
  display: flex; gap: .55rem; align-items: center;
}
.comment .who { font-weight: 700; color: var(--ink); }
.comment .permalink { margin-left: auto; opacity: .35; text-decoration: none; }
.comment .permalink:hover { opacity: 1; color: var(--rose); }
.comment .body { margin: .35rem 0 0; }
.comment h3 { font-family: var(--display); font-size: 1rem; margin: .3rem 0 0; }
.userpic-sm {
  width: 34px; height: 34px; object-fit: contain; flex: none;
  background: var(--sunk); border: 1px solid var(--rule); border-radius: var(--radius);
}
.anon { font-style: italic; }
/* Real nesting, and the rose keeps deep threads legible as threads. */
.replies { margin-left: 1.1rem; padding-left: 1.15rem; border-left: 2px solid var(--rule); }
.replies .replies { border-left-color: var(--sunk); }
.comment-D .body, .comment-D .who { color: var(--ink-2); font-style: italic; }
.state {
  border: 1px solid var(--rule); border-radius: var(--radius);
  padding: 0 .35rem; font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
}

/* --- lists / calendar / tags -------------------------------------------- */
h1 { font-family: var(--display); font-size: 2rem; letter-spacing: -.02em; margin: 0 0 .5rem; }
h2 { font-family: var(--display); font-size: 1.15rem; letter-spacing: -.01em; }

.entry-list { list-style: none; padding: 0; }
.entry-list li { border-bottom: 1px solid var(--rule); }
.entry-list a { display: flex; gap: .9rem; padding: .5rem 0; text-decoration: none; color: var(--ink); }
.entry-list a:hover { color: var(--rose); }
.entry-list .d { font-family: var(--meta); font-size: 11px; color: var(--ink-2); min-width: 6rem; }
.entry-list .c { font-family: var(--meta); font-size: 11px; color: var(--ink-2); }

.year-grid { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr)); gap: .4rem; }
.year-grid a {
  display: flex; flex-direction: column; align-items: center; padding: .7rem .25rem;
  background: var(--card); border: 1px solid var(--rule); border-radius: var(--radius);
  text-decoration: none; color: var(--ink); font-family: var(--display); font-weight: 700;
}
.year-grid a:hover { background: var(--rose); border-color: var(--rose); color: #fff; }
.year-grid a:hover span { color: #fff; }
.year-grid span { font-family: var(--meta); font-size: 10px; font-weight: 400; color: var(--ink-2); }

.months { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: 1.5rem; }
.month h2 { font-family: var(--meta); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; margin: 0 0 .4rem; color: var(--ink-2); }
table.cal { border-collapse: collapse; width: 100%; font-family: var(--meta); font-size: 11px; }
table.cal th { color: var(--ink-2); font-weight: 400; padding: .2rem 0; opacity: .6; }
table.cal td { text-align: center; padding: .08rem; }
table.cal td a {
  display: block; padding: .25rem 0; background: var(--sunk); color: var(--ink);
  border-radius: var(--radius); text-decoration: none;
}
table.cal td a:hover { background: var(--rose); color: #fff; }
table.cal td span { display: block; padding: .25rem 0; color: var(--ink-2); opacity: .3; }

.tag-cloud { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: .4rem; }
.tag-cloud a {
  display: inline-flex; gap: .4rem; align-items: baseline;
  background: var(--card); border: 1px solid var(--rule);
  padding: .25rem .65rem; border-radius: var(--radius);
  text-decoration: none; color: var(--ink); font-family: var(--meta); font-size: 11.5px;
}
.tag-cloud a:hover { background: var(--amber); border-color: var(--amber); color: #14161c; }
.tag-cloud span { font-size: 10px; color: var(--ink-2); }

.intro h1 { font-size: 2.6rem; line-height: 1.05; }
.intro .lede { font-size: 1.05rem; max-width: 46ch; }

footer.site {
  font-family: var(--meta); font-size: 10.5px; color: var(--ink-2);
  border-top: 1px solid var(--rule); margin-top: 3rem; padding-top: 1rem;
}
footer.site p { margin: .2rem 0; }
`;
