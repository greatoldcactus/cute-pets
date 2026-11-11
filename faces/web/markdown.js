// Tiny dependency-free markdown renderer shared by the pet panel and the web tray.
// Everything is escaped before markup is added; raw HTML from the model is shown
// as text. Stash inline code/links so emphasis cannot rewrite URLs.
(function () {
  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function safeUrl(u, image) {
    const v = String(u || "").trim();
    if (/^https?:\/\//i.test(v)) return esc(v);
    if (!image && /^mailto:/i.test(v)) return esc(v);
    if (image && /^data:image\//i.test(v)) return esc(v);
    return "#";
  }

  function inline(escaped) {
    const stash = [];
    const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
    let s = escaped;
    s = s.replace(/`([^`\n]+)`/g, (m, c) => keep(`<code>${c}</code>`));
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) =>
      keep(`<img alt="${alt}" src="${safeUrl(url, true)}" loading="lazy">`));
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, txt, url) =>
      keep(`<a href="${safeUrl(url, false)}" target="_blank" rel="noopener noreferrer">${inline(txt)}</a>`));
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
    for (let n = 0; n < 8 && /\u0000\d+\u0000/.test(s); n++)
      s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[Number(i)] ?? "");
    return s;
  }

  function toHtml(text) {
    const src = String(text || "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
    const lines = src.split("\n");
    const out = [];
    let i = 0;
    const fence = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)\s*$/;
    const fenceEnd = /^\s*(`{3,}|~{3,})\s*$/;
    const list = /^\s*([-*+]|\d+[.)])\s+/;
    while (i < lines.length) {
      const line = lines[i];
      let m = line.match(fence);
      if (m) {
        const lang = (m[2] || "").replace(/[^a-z0-9+#._-]/gi, "");
        const buf = [];
        i++;
        while (i < lines.length && !fenceEnd.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) i++;
        out.push(`<div class="codeblock"><div class="codehead"><span>${esc(lang || "code")}</span>` +
          `<button class="copybtn" type="button">copy</button></div>` +
          `<pre><code${lang ? ` class="language-${esc(lang)}"` : ""}>${esc(buf.join("\n"))}</code></pre></div>`);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) { const n = m[1].length; out.push(`<h${n}>${inline(esc(m[2]))}</h${n}>`); i++; continue; }
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push(`<blockquote>${toHtml(buf.join("\n"))}</blockquote>`);
        continue;
      }
      if (list.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line), items = [];
        while (i < lines.length && list.test(lines[i])) {
          items.push(`<li>${inline(esc(lines[i].replace(list, "")))}</li>`); i++;
        }
        out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length &&
        /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const head = cells(line); i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        out.push(`<table><thead><tr>${head.map((h) => `<th>${inline(esc(h))}</th>`).join("")}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(esc(c))}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        continue;
      }
      const buf = [];
      while (i < lines.length && lines[i].trim()
        && !fence.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])
        && !/^\s*>/.test(lines[i]) && !list.test(lines[i])
        && !/^\s*(---+|\*\*\*+|___+)\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      if (!buf.length) { out.push(`<p>${inline(esc(line))}</p>`); i++; continue; }
      out.push(`<p>${buf.map((l) => inline(esc(l))).join("<br>")}</p>`);
    }
    return out.join("");
  }

  window.CPMarkdown = { toHtml, inline };
})();
