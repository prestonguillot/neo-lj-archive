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
<header class="site">
  <a class="site-title" href="<%= root %>index.html"><%= journal %></a>
  <nav>
    <a href="<%= root %>calendar/index.html">Calendar</a>
    <a href="<%= root %>tags/index.html">Tags</a>
  </nav>
</header>
<main>
<%- content %>
</main>
<footer class="site">
  <p>Archived from LiveJournal. <%= entryCount %> entries, <%= commentCount %> comments.</p>
  <p class="muted">Static HTML. No server, no runtime. It will still open when nothing else does.</p>
</footer>
</body>
</html>
`;

export const ENTRY = `
<article class="entry">
  <header>
    <p class="date"><a href="<%= dayHref %>"><%= displayDate %></a></p>
    <h1><%= subject %></h1>
    <div class="meta">
      <span class="security security-<%= security %>" title="<%= securityTitle %>"><%= securityLabel %></span>
      <% if (mood) { %><span class="mood">mood: <b><%= mood %></b></span><% } %>
      <% if (music) { %><span class="music">music: <b><%= music %></b></span><% } %>
      <% if (location) { %><span class="location">location: <b><%= location %></b></span><% } %>
    </div>
    <% if (tags.length) { %>
    <ul class="tags">
      <% tags.forEach(function (t) { %><li><a href="<%= t.href %>"><%= t.name %></a></li><% }) %>
    </ul>
    <% } %>
  </header>

  <div class="body"><%- body %></div>
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
<section class="intro">
  <h1><%= journal %></h1>
  <p class="lede"><%= entryCount %> entries and <%= commentCount %> comments,
     <%= firstYear %>&ndash;<%= lastYear %>.</p>
  <p><%= imagesKept %> images recovered and stored locally.
     <% if (imagesLost) { %><%= imagesLost %> could not be found; each says so where it stood.<% } %></p>
</section>

<section class="years">
  <h2>By year</h2>
  <ul class="year-grid">
    <% years.forEach(function (y) { %>
      <li><a href="<%= y.href %>"><b><%= y.year %></b><span><%= y.count %></span></a></li>
    <% }) %>
  </ul>
</section>

<section class="recent">
  <h2>Most recent</h2>
  <ul class="entry-list">
    <% recent.forEach(function (e) { %>
      <li><a href="<%= e.href %>"><span class="d"><%= e.date %></span> <%= e.subject %></a></li>
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
