/**
 * The default theme (DESIGN.md §7.1).
 *
 * Themeable means CSS custom properties over semantic markup with ONE swappable
 * stylesheet — not a framework. That's why this deviates from vibes' Bootstrap
 * (§15): the archive is a reading surface — typography, a calendar grid,
 * threaded comments — with almost no chrome, and "swap one stylesheet" is real
 * at this size and awkward when overriding a large opinionated framework.
 *
 * Light and dark both, because the archive should look deliberate on whatever
 * machine opens it in 2040, not assume a 2026 default.
 */
export const STYLE = `
:root {
  --bg: #fbfaf8;
  --bg-sunk: #f2f0eb;
  --fg: #1c1b19;
  --fg-muted: #6b6862;
  --rule: #e2ded6;
  --accent: #7a5c3e;
  --accent-soft: #f0e7dc;
  --dead: #b4472e;

  --font: ui-serif, Georgia, "Iowan Old Style", "Palatino Linotype", serif;
  --font-ui: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --measure: 34rem;
  --radius: 4px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16151a;
    --bg-sunk: #1e1d24;
    --fg: #e8e5e0;
    --fg-muted: #9a958c;
    --rule: #2e2c35;
    --accent: #c9a06a;
    --accent-soft: #2a2620;
    --dead: #e0785c;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font);
  font-size: 1.05rem;
  line-height: 1.65;
}

a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
img { max-width: 100%; height: auto; border-radius: var(--radius); }
h1, h2, h3 { line-height: 1.25; }
.muted { color: var(--fg-muted); }

/* Wide 2003 table layouts must scroll in their own box, never the page. */
main { overflow-x: hidden; }
.body table { max-width: 100%; }
.body { overflow-x: auto; }

header.site, footer.site {
  font-family: var(--font-ui);
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--rule);
  display: flex; flex-wrap: wrap; gap: 1rem; align-items: baseline;
}
footer.site { border-bottom: 0; border-top: 1px solid var(--rule); display: block; font-size: .85rem; color: var(--fg-muted); }
.site-title { font-weight: 700; text-decoration: none; font-size: 1.1rem; }
header.site nav { margin-left: auto; display: flex; gap: 1rem; }

main { max-width: var(--measure); margin: 0 auto; padding: 2rem 1.25rem 4rem; }
@media (min-width: 60rem) { main { max-width: 42rem; } }

/* --- entry ------------------------------------------------------------- */
.entry header { margin-bottom: 1.5rem; }
.entry h1 { margin: .2rem 0 .6rem; font-size: 1.7rem; }
.entry .date { font-family: var(--font-ui); font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; margin: 0; }
.entry .date a { color: var(--fg-muted); text-decoration: none; }

.meta { font-family: var(--font-ui); font-size: .82rem; color: var(--fg-muted); display: flex; flex-wrap: wrap; gap: .25rem 1rem; }
.meta b { color: var(--fg); font-weight: 600; }

.security { border: 1px solid var(--rule); border-radius: 999px; padding: 0 .5rem; }
.security-private { border-color: var(--accent); color: var(--accent); }
.security-usemask { border-color: var(--accent); color: var(--accent); }

.tags { list-style: none; display: flex; flex-wrap: wrap; gap: .4rem; padding: 0; margin: .75rem 0 0; }
.tags a { font-family: var(--font-ui); font-size: .75rem; background: var(--accent-soft); color: var(--accent); padding: .1rem .5rem; border-radius: 999px; text-decoration: none; }

.lj-user { font-family: var(--font-ui); font-weight: 600; font-size: .95em; text-decoration: none; background: var(--accent-soft); padding: 0 .3em; border-radius: var(--radius); }

details.lj-cut { border-left: 2px solid var(--rule); padding-left: 1rem; margin: 1rem 0; }
details.lj-cut summary { font-family: var(--font-ui); font-size: .8rem; color: var(--fg-muted); cursor: pointer; }

/* An image we could not recover. It says so, and says what it was (§4.3). */
.dead-image {
  display: inline-flex; flex-direction: column; gap: .1rem;
  border: 1px dashed var(--dead); border-radius: var(--radius);
  padding: .5rem .7rem; margin: .3rem 0;
  font-family: var(--font-ui); font-size: .75rem; color: var(--dead);
  max-width: 100%;
}
.dead-image-label { font-weight: 600; }
.dead-image-url, .dead-image-why { color: var(--fg-muted); word-break: break-all; }
.embed-lost { font-family: var(--font-ui); font-size: .8rem; color: var(--fg-muted); border: 1px dashed var(--rule); border-radius: var(--radius); padding: .3rem .6rem; display: inline-block; }

/* --- spine ------------------------------------------------------------- */
.spine { display: flex; justify-content: space-between; gap: 1rem; margin: 2.5rem 0; font-family: var(--font-ui); font-size: .85rem; }
.spine a { max-width: 45%; text-decoration: none; }
.spine a:hover { text-decoration: underline; }

/* --- comments ---------------------------------------------------------- */
.comments h2 { font-family: var(--font-ui); font-size: .9rem; text-transform: uppercase; letter-spacing: .05em; color: var(--fg-muted); border-top: 1px solid var(--rule); padding-top: 1.5rem; }
.comment { margin: 1.25rem 0; }
.comment header { font-family: var(--font-ui); font-size: .78rem; color: var(--fg-muted); display: flex; gap: .6rem; align-items: baseline; }
.comment .who { font-weight: 600; color: var(--fg); }
.comment .permalink { margin-left: auto; opacity: .4; text-decoration: none; }
.comment .body { margin: .3rem 0 0; }
.comment h3 { font-size: 1rem; margin: .3rem 0 0; }
.replies { margin-left: 1.1rem; padding-left: 1rem; border-left: 1px solid var(--rule); }

.comment-D .body, .comment-D .who { color: var(--fg-muted); font-style: italic; }
.state { border: 1px solid var(--rule); border-radius: 999px; padding: 0 .4rem; font-size: .7rem; }

/* --- lists / calendar / tags ------------------------------------------- */
.entry-list { list-style: none; padding: 0; }
.entry-list li { border-bottom: 1px solid var(--rule); }
.entry-list a { display: flex; gap: .75rem; padding: .6rem 0; text-decoration: none; color: var(--fg); }
.entry-list a:hover { color: var(--accent); }
.entry-list .d { font-family: var(--font-ui); font-size: .75rem; color: var(--fg-muted); min-width: 5.5rem; }
.entry-list .c { font-family: var(--font-ui); font-size: .75rem; color: var(--fg-muted); }

.year-grid { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(5rem, 1fr)); gap: .5rem; }
.year-grid a { display: flex; flex-direction: column; align-items: center; padding: .75rem .25rem; background: var(--bg-sunk); border-radius: var(--radius); text-decoration: none; color: var(--fg); }
.year-grid a:hover { background: var(--accent-soft); color: var(--accent); }
.year-grid span { font-family: var(--font-ui); font-size: .7rem; color: var(--fg-muted); }

.months { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1.5rem; }
.month h2 { font-family: var(--font-ui); font-size: .9rem; margin: 0 0 .4rem; }
table.cal { border-collapse: collapse; width: 100%; font-family: var(--font-ui); font-size: .75rem; }
table.cal th { color: var(--fg-muted); font-weight: 500; padding: .2rem 0; }
table.cal td { text-align: center; padding: .1rem; }
table.cal td a { display: block; padding: .25rem 0; background: var(--accent-soft); color: var(--accent); border-radius: var(--radius); text-decoration: none; font-weight: 600; }
table.cal td span { display: block; padding: .25rem 0; color: var(--fg-muted); opacity: .45; }

.tag-cloud { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: .5rem; }
.tag-cloud a { display: inline-flex; gap: .4rem; align-items: baseline; background: var(--bg-sunk); padding: .3rem .7rem; border-radius: 999px; text-decoration: none; color: var(--fg); font-family: var(--font-ui); font-size: .85rem; }
.tag-cloud a:hover { background: var(--accent-soft); color: var(--accent); }
.tag-cloud span { font-size: .7rem; color: var(--fg-muted); }

.intro .lede { font-size: 1.15rem; }
`;
