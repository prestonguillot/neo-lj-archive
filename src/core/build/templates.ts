/**
 * Page templates, inlined as TypeScript.
 *
 * Not .ejs files on disk: tsc does not copy non-TS assets into dist/, so a
 * template read at runtime builds green, tests green (vitest resolves from
 * src/), then dies with ENOENT on first real use. schema.sql did exactly that.
 * A bundler (Electron, M5) would have the same problem with extra steps.
 *
 * EJS is what prestonguillot/vibes uses (§15); inlining keeps the tool and drops
 * the asset problem.
 *
 * No backticks inside these strings — they are template literals, and a markdown
 * habit terminates the string. That has bitten this repo once already.
 */

/** Shared shell. Relative paths only: the archive must open from file:// (§13). */
export const LAYOUT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><%= title %></title>
<link rel="stylesheet" href="<%= root %>style.css">
<script>
/* "On this day" means today, and the build must be reproducible — the same
   archive.db must produce the same bytes on any day, so the date cannot be baked
   in. This retargets the link when the page opens. With JS off the href still
   works; it just lands on the newest entry's date instead. The archive never
   REQUIRES script (DESIGN.md §13) — this only sharpens a link that already works.
   Dates that were never written on have no page, so it walks forward to the next
   one that exists rather than sending you to a 404. */
document.addEventListener('click', function (ev) {
  var a = ev.target.closest ? ev.target.closest('a.embed-play') : null;
  if (!a) return;
  var m = /[?&]v=([^&]+)/.exec(a.href);
  if (!m) return; // not a shape we can embed — let the link do its normal thing
  ev.preventDefault();
  var f = document.createElement('iframe');
  f.src = 'https://www.youtube-nocookie.com/embed/' + m[1] + '?autoplay=1';
  f.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture';
  f.allowFullscreen = true;
  f.className = 'lj-video-frame';
  a.replaceWith(f);
});
window.addEventListener('DOMContentLoaded', function () {
  var a = document.getElementById('otd');
  if (!a) return;
  var have = <%- JSON.stringify(otdDates) %>;
  var now = new Date();
  var md = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  var next = have.find(function (d) { return d >= md; }) || have[0];
  if (next) a.href = a.getAttribute('href').replace(/[^/]+$/, next + '.html');
});
</script>
</head>
<body>
<div class="shell">
  <aside class="rail">
    <a class="site-title" href="<%= root %>index.html"><%= journal %></a>
    <p class="counts"><%= entryCount %> entries &middot; <%= commentCount %> comments</p>
    <nav>
      <a href="<%= root %>index.html">Journal</a>
      <a href="<%= root %>calendar/index.html">Calendar</a>
      <a id="otd" href="<%= root %>onthisday/<%= todayHref %>">On this day</a>
      <a href="<%= root %>tags/index.html">Tags</a>
      <a href="<%= root %>retrospect/index.html">Retrospect</a>
      <a href="<%= root %>people/index.html">People</a>
      <a href="<%= root %>userpics/index.html">Userpics</a>
    </nav>
    <p class="rail-heading">Years</p>
    <ul class="years">
      <% railYears.forEach(function (y) { %><li><a href="<%= root %>calendar/<%= y %>/index.html"><%= y %></a></li><% }) %>
    </ul>
  </aside>
  <main>
<%- content %>
  </main>
</div>
</body>
</html>
`;

export const ENTRY = `
<article class="entry">
  <div class="entry-main">
    <p class="date"><a href="<%= dayHref %>"><%= displayDate %></a></p>
    <h1><%= subject %></h1>
    <div class="body"><%- body %></div>
  </div>

  <aside class="entry-side">
    <% if (pic) { %><img class="userpic" src="<%= root %><%= pic %>" alt="" loading="lazy"><% } %>
    <div class="meta">
      <span class="security security-<%= security %>" data-k="security" title="<%= securityTitle %>"><b><%= securityLabel %></b></span>
      <% if (mood) { %><span class="mood" data-k="mood"><b><%= mood %></b></span><% } %>
      <% if (music) { %><span class="music" data-k="music"><b><%= music %></b></span><% } %>
      <% if (location) { %><span class="location" data-k="where"><b><%= location %></b></span><% } %>
    </div>
    <% if (tags.length) { %>
    <ul class="tags">
      <% tags.forEach(function (t) { %><li><a href="<%= t.href %>"><%= t.name %></a></li><% }) %>
    </ul>
    <% } %>
  </aside>
</article>

<nav class="spine">
  <% if (prev) { %><a class="prev" href="<%= prev.href %>">&larr; <%= prev.label %></a><% } else { %><span></span><% } %>
  <% if (next) { %><a class="next" href="<%= next.href %>"><%= next.label %> &rarr;</a><% } %>
</nav>

<section class="comments">
  <h2><%= commentCount %> comment<%= commentCount === 1 ? '' : 's' %></h2>
  <%- comments %>
</section>
`;

/** One comment, recursive. Threading is real nesting, not indentation. */
export const COMMENT = `
<article class="comment comment-<%= state %>" id="c<%= id %>">
  <header>
    <% if (pic) { %><img class="userpic-sm" src="<%= root %><%= pic %>" alt="" loading="lazy"><% } %>
    <span class="who"><%- who %></span>
    <% if (date) { %><time><%= date %></time><% } %>
    <% if (stateLabel) { %><span class="state"><%= stateLabel %></span><% } %>
    <a class="permalink" href="#c<%= id %>">#</a>
  </header>
  <% if (subject) { %><h3><%= subject %></h3><% } %>
  <% if (body) { %><div class="body"><%- body %></div><% } %>
  <% if (children) { %><div class="replies"><%- children %></div><% } %>
</article>
`;

export const INDEX = `
<h1><%= journal %></h1>

<section class="recent">
  <ul class="entry-list">
    <% recent.forEach(function (e) { %>
      <li><a href="<%= e.href %>"><span class="d"><%= e.date %></span> <%= e.subject %></a></li>
    <% }) %>
  </ul>
</section>

<section class="years">
  <h2>By year</h2>
  <ul class="year-grid">
    <% years.forEach(function (y) { %>
      <li><a href="<%= y.href %>"><b><%= y.year %></b><span><%= y.count %></span></a></li>
    <% }) %>
  </ul>
</section>
`;

export const YEARS = `
<h1>Calendar</h1>
<ul class="year-grid">
  <% years.forEach(function (y) { %>
    <li><a href="<%= y.href %>"><b><%= y.year %></b><span><%= y.count %></span></a></li>
  <% }) %>
</ul>
`;

export const YEAR = `
<h1><%= year %></h1>
<p class="muted"><%= count %> entries</p>
<div class="months">
  <% months.forEach(function (m) { %>
  <section class="month" id="<%= m.anchor %>">
    <h2><%= m.name %></h2>
    <table class="cal">
      <thead><tr><% dayNames.forEach(function (d) { %><th><%= d %></th><% }) %></tr></thead>
      <tbody>
      <% m.weeks.forEach(function (w) { %>
        <tr><% w.forEach(function (d) { %>
          <td><% if (!d) { %><% } else if (d.href) { %><a href="<%= d.href %>" title="<%= d.count %> entries"><%= d.day %></a><% } else { %><span><%= d.day %></span><% } %></td>
        <% }) %></tr>
      <% }) %>
      </tbody>
    </table>
  </section>
  <% }) %>
</div>
`;

export const DAY = `
<h1><%= displayDate %></h1>
<ul class="entry-list">
  <% entries.forEach(function (e) { %>
    <li><a href="<%= e.href %>"><%= e.subject %></a>
        <% if (e.commentCount) { %><span class="c"><%= e.commentCount %> comments</span><% } %></li>
  <% }) %>
</ul>
<p><a href="<%= monthHref %>">&larr; <%= monthName %></a></p>
`;

export const TAGS = `
<h1>Tags</h1>
<ul class="tag-cloud">
  <% tags.forEach(function (t) { %>
    <li><a href="<%= t.href %>"><%= t.name %> <span><%= t.count %></span></a></li>
  <% }) %>
</ul>
`;

export const TAG = `
<h1>Tagged <em><%= tag %></em></h1>
<p class="muted"><%= count %> entries</p>
<ul class="entry-list">
  <% entries.forEach(function (e) { %>
    <li><a href="<%= e.href %>"><span class="d"><%= e.date %></span> <%= e.subject %></a></li>
  <% }) %>
</ul>
`;

/**
 * On this day, across every year (§11 M4).
 *
 * The one navigation a diary actually wants: not "what did I write in March
 * 2005" but "what was I doing on this date, ever". The calendar answers the
 * first; nothing answered the second.
 */
export const ONTHISDAY = `
<h1><%= displayDate %></h1>
<p class="muted"><%= count %> entries on this date, across <%= yearCount %> years</p>

<% years.forEach(function (y) { %>
<section class="otd-year">
  <h2><%= y.year %></h2>
  <ul class="entry-list">
    <% y.entries.forEach(function (e) { %>
      <li><a href="<%= e.href %>"><span class="d"><%= e.time %></span> <%= e.subject %></a></li>
    <% }) %>
  </ul>
</section>
<% }) %>

<nav class="spine">
  <a class="prev" href="<%= prevHref %>">&larr; <%= prevLabel %></a>
  <a class="next" href="<%= nextHref %>"><%= nextLabel %> &rarr;</a>
</nav>
`;

/** Everyone who ever showed up, and how much (§11 M4). */
export const PEOPLE = `
<h1>People</h1>
<p class="muted"><%= count %> people left <%= total %> comments<% if (anon) { %>, plus <%= anon %> anonymous<% } %></p>
<ul class="people">
  <% people.forEach(function (p) { %>
    <li>
      <% if (p.pic) { %><img class="userpic-sm" src="<%= root %><%= p.pic %>" alt="" loading="lazy"><% } else { %><span class="userpic-sm nopic"></span><% } %>
      <a class="who" href="<%= p.href %>"><%= p.name %></a>
      <span class="span"><%= p.span %></span>
      <span class="n"><%= p.n %></span>
    </li>
  <% }) %>
</ul>
`;

/**
 * One person, and where they actually turn up (§11 M4).
 *
 * The first version linked each name to their LiveJournal, which is as dead as
 * this one — a link out of the archive into nothing. What you want from a name
 * is the conversations: which posts they showed up in, and what they said.
 */
export const PERSON = `
<h1><%= name %></h1>
<p class="muted"><%= n %> comments on <%= entryCount %> of your entries, <%= span %><% if (ljHref) { %> &middot; <a href="<%= ljHref %>">their journal</a><% } %></p>

<ul class="entry-list">
  <% entries.forEach(function (e) { %>
    <li><a href="<%= e.href %>"><span class="d"><%= e.date %></span> <%= e.subject %><span class="c"><%= e.n %></span></a></li>
  <% }) %>
</ul>
`;

/**
 * The faces (§11 M4).
 *
 * Every pic is here because it was SCRAPED off a rendered page — LJ's API never
 * returns which pic an entry used, and the comment export carries no picid at
 * all. The counts are the whole point: which face you actually wore, how often.
 */
export const FACES = `
<h1>Userpics</h1>
<p class="muted"><%= mine.length %> of yours<% if (others.length) { %>, and <%= others.length %> belonging to people who commented<% } %></p>

<section class="faces">
  <h2>Yours</h2>
  <ul class="face-grid">
    <% mine.forEach(function (f) { %>
      <li>
        <img src="<%= root %><%= f.pic %>" alt="" loading="lazy">
        <span class="n"><%= f.n %> <%= f.n === 1 ? 'use' : 'uses' %></span>
      </li>
    <% }) %>
  </ul>
</section>

<% if (others.length) { %>
<section class="faces">
  <h2>Theirs</h2>
  <ul class="face-grid">
    <% others.forEach(function (f) { %>
      <li>
        <img src="<%= root %><%= f.pic %>" alt="" loading="lazy">
        <span class="n"><%= f.who %></span>
      </li>
    <% }) %>
  </ul>
</section>
<% } %>
`;

/** A month's posts. The heatmap needs somewhere real to land. */
export const MONTH = `
<h1><%= name %></h1>
<p class="muted"><%= count %> entries</p>
<ul class="entry-list">
  <% entries.forEach(function (e) { %>
    <li><a href="<%= e.href %>"><span class="d"><%= e.date %></span> <%= e.subject %>
      <% if (e.n) { %><span class="c"><%= e.n %></span><% } %></a></li>
  <% }) %>
</ul>
<nav class="spine">
  <% if (prev) { %><a class="prev" href="<%= prev.href %>">&larr; <%= prev.label %></a><% } else { %><span></span><% } %>
  <% if (next) { %><a class="next" href="<%= next.href %>"><%= next.label %> &rarr;</a><% } %>
</nav>
`;

/**
 * Retrospect (§11 M4) — the archive looking at itself.
 *
 * Every number here is one the archive had to FIGHT for. The heatmap only exists
 * because the fetch walked backwards to 2003; the moods only resolve because we
 * pulled LJ's vocabulary; the lost-image count is honest only because we sniffed
 * bytes instead of trusting a 200.
 *
 * No chart library and no external request: this has to open from file:// in 2040
 * (§13). Bars are divs, the heatmap is a grid, tooltips are CSS. Nothing here
 * needs JavaScript to be readable.
 */
export const RETROSPECT = `
<h1>Retrospect</h1>
<p class="lede"><%= entryCount %> entries and <%= commentCount %> comments,
  <%= firstDate %> to <%= lastDate %> &mdash; <%= days %> days.</p>

<section class="viz">
  <h2>The decade</h2>
  <p class="viz-note">Every month, on one scale. Darker is more. Click a month to read it.</p>
  <div class="heat">
    <% heat.forEach(function (row) { %>
    <div class="heat-row">
      <a class="y" href="<%= row.href %>"><%= row.year %></a>
      <span class="heat-cells">
        <% row.cells.forEach(function (c) { %><% if (c.href) { %><a class="cell" data-n="<%= c.level %>" href="<%= c.href %>" data-tip="<%= c.label %>"></a><% } else { %><i class="cell" data-n="0" data-tip="<%= c.label %>"></i><% } %><% }) %>
      </span>
      <span class="t"><%= row.total %></span>
    </div>
    <% }) %>
    <div class="heat-row heat-axis">
      <span class="y"></span>
      <span class="heat-cells"><% months.forEach(function (m) { %><span class="cell mlab"><%= m %></span><% }) %></span>
      <span class="t"></span>
    </div>
  </div>
</section>

<section class="viz">
  <h2>The hours</h2>
  <p class="viz-note">When you wrote, in the time LiveJournal recorded. Click an hour to read it.</p>
  <div class="hours">
    <% hours.forEach(function (h) { %>
      <% if (h.href) { %><a class="hour" href="<%= h.href %>" data-tip="<%= h.label %>"><i style="height: <%= h.pct %>%"></i></a>
      <% } else { %><span class="hour" data-tip="<%= h.label %>"><i style="height: <%= h.pct %>%"></i></span><% } %>
    <% }) %>
  </div>
  <div class="hours-axis">
    <% hourTicks.forEach(function (t) { %><span style="left: <%= t.pct %>%"><%= t.label %></span><% }) %>
  </div>
</section>

<section class="viz">
  <h2>How you felt</h2>
  <p class="viz-note"><%= moodTotal %> of <%= entryCount %> entries recorded a mood.</p>
  <ul class="bars">
    <% moods.forEach(function (m) { %>
      <li><a class="barrow" href="<%= m.href %>" data-tip="<%= m.tip %>"><span class="k"><%= m.name %></span><span class="bar"><i style="width: <%= m.pct %>%"></i></span><span class="v"><%= m.n %></span></a></li>
    <% }) %>
  </ul>
</section>

<section class="viz">
  <h2>What was playing</h2>
  <p class="viz-note"><%= musicTotal %> entries noted the music. Click an artist to read them.</p>
  <ul class="bars">
    <% artists.forEach(function (a) { %>
      <li><a class="barrow" href="<%= a.href %>" data-tip="<%= a.tip %>"><span class="k"><%= a.name %></span><span class="bar"><i style="width: <%= a.pct %>%"></i></span><span class="v"><%= a.n %></span></a></li>
    <% }) %>
  </ul>
</section>

<section class="viz">
  <h2>Records</h2>
  <ul class="facts">
    <li><a href="<%= longest.href %>"><b><%= longest.words %></b> words</a> &mdash; the longest entry, <%= longest.date %>.</li>
    <li><a href="<%= mostComments.href %>"><b><%= mostComments.n %></b> comments</a> &mdash; the most on one entry, <%= mostComments.date %>.</li>
    <li><a href="<%= deepest.href %>"><b><%= deepest.n %></b> replies deep</a> &mdash; the longest thread anyone managed.</li>
    <li><a href="<%= busiest.href %>"><b><%= busiest.n %></b> entries in a day</a> &mdash; <%= busiest.date %>, your busiest.</li>
    <li><a href="<%= quietest.href %>"><b><%= quietest.days %></b> days</a> &mdash; the longest you went without writing, ending <%= quietest.date %>.</li>
  </ul>
</section>

<section class="viz">
  <h2>What is here</h2>
  <ul class="facts">
    <li><b><%= privatePct %>%</b> of the entries are private, <b><%= friendsPct %>%</b> friends-only.</li>
    <li><a href="<%= imagesHref %>"><b><%= imagesKept %></b> images</a> from entries and comments. <b><%= imagesLost %></b> are gone.</li>
    <li><a href="<%= userpicsHref %>"><b><%= userpicCount %></b> userpics</a> across <%= facesPeople %> people.</li>
    <li><a href="<%= peopleHref %>"><b><%= people %></b> people</a> left comments<% if (anon) { %>, plus <%= anon %> anonymous<% } %>.</li>
    <li><a href="<%= tagsHref %>"><b><%= tagTotal %></b> tags</a> on <%= taggedEntries %> entries &mdash; you used nearly every one exactly once.</li>
    <li><b><%= artistTotal %></b> artists and <b><%= songTotal %></b> tracks &mdash; <%= oncePct %>% of the artists turned up exactly once.</li>
  </ul>
</section>
`;

/** Every image that survived, and the post it came from (§11 M4). */
export const IMAGES = `
<h1>Images</h1>
<p class="muted"><%= count %> images recovered from your entries and comments. <%= lost %> could not be found.</p>
<ul class="face-grid img-grid">
  <% images.forEach(function (im) { %>
    <li>
      <a href="<%= im.href %>" data-tip="<%= im.tip %>">
        <img src="<%= root %><%= im.pic %>" alt="" loading="lazy">
      </a>
    </li>
  <% }) %>
</ul>
`;

/** Entries sharing one hour of the day, or one mood (§11 M4). */
export const SLICE = `
<h1><%= title %></h1>
<p class="muted"><%= count %> entries</p>
<ul class="entry-list">
  <% entries.forEach(function (e) { %>
    <li><a href="<%= e.href %>"><span class="d"><%= e.date %></span> <%= e.subject %></a></li>
  <% }) %>
</ul>
<p><a href="<%= backHref %>">&larr; Retrospect</a></p>
`;

/** Everything you played while writing, and when (§11 M4). */
export const ARTIST = `
<h1><%= name %></h1>
<p class="muted">Playing while you wrote <%= count %> <%= count === 1 ? 'entry' : 'entries' %><% if (songCount) { %>, <%= songCount %> <%= songCount === 1 ? 'track' : 'tracks' %><% } %>.</p>
<ul class="entry-list">
  <% entries.forEach(function (e) { %>
    <li><a href="<%= e.href %>"><span class="d"><%= e.date %></span> <%= e.subject %>
      <% if (e.song) { %><span class="c"><%= e.song %></span><% } %></a></li>
  <% }) %>
</ul>
<p><a href="<%= backHref %>">&larr; Retrospect</a></p>
`;
