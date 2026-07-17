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
</head>
<body>
<div class="shell">
  <aside class="rail">
    <a class="site-title" href="<%= root %>index.html"><%= journal %></a>
    <p class="counts"><%= entryCount %> entries &middot; <%= commentCount %> comments</p>
    <nav>
      <a href="<%= root %>index.html">Journal</a>
      <a href="<%= root %>calendar/index.html">Calendar</a>
      <a href="<%= root %>onthisday/<%= todayHref %>">On this day</a>
      <a href="<%= root %>tags/index.html">Tags</a>
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
  <div class="heat">
    <% heat.forEach(function (row) { %>
    <div class="heat-row">
      <a class="y" href="<%= row.href %>"><%= row.year %></a>
      <span class="heat-cells">
        <% row.cells.forEach(function (c) { %><i data-n="<%= c.level %>" title="<%= c.label %>"></i><% }) %>
      </span>
      <span class="t"><%= row.total %></span>
    </div>
    <% }) %>
  </div>
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
      <a class="lj-user" href="<%= p.href %>"><%= p.name %></a>
      <span class="n"><%= p.n %></span>
    </li>
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
