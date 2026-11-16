// Fast Markdown renderer: parse(markdown) returns exactly the HTML that
// marked 18.1.3 renders with its default options (GFM on, breaks off).
// Written from scratch for speed: one pass over the input for blocks, one
// pass per text span for inlines, no dependencies, no per-token regexes on
// the hot path. (MIT)
//
// Layout: the block parser below turns the input into a small tree of
// blocks; the inline parser turns each text span (paragraph lines, heading
// text, table cells) into HTML. Link reference definitions are collected
// while blocks are parsed and used by the inline parser afterwards.

// ASCII punctuation, as CommonMark defines it (used by backslash escapes).
function isPunct(ch) {
  return (ch >= '!' && ch <= '/') || (ch >= ':' && ch <= '@') ||
    (ch >= '[' && ch <= '`') || (ch >= '{' && ch <= '~');
}
function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'; }
function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isAlpha(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}
function isAlnum(ch) { return isAlpha(ch) || isDigit(ch); }

// Escape text and attribute values the way marked does: & < > " '
// (marked escapes quotes in text too, not only in attributes).
const ESCAPE_RE = /[&<>"']/g;
function escapeHtml(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
    s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep = null;
    if (c === '&') rep = '&amp;';
    else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

// Decode one entity reference starting at s[i] === '&', for a text
// context. Returns [outputFragment, lengthConsumed] or null when it is
// not a reference. Named references pass through verbatim (marked keeps
// &name; as written, whether or not it is a real HTML5 entity); numeric
// references decode to the code point, or U+FFFD when zero, a surrogate,
// or above U+10FFFF, and the decoded character is escaped if it is one
// of & < > " '. A numeric reference is only recognised with 1-7 decimal
// digits or 1-6 hex digits; anything longer is not a reference.
function decodeEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const ds = j;
    if (hex) { while (j < n && isHex(s[j])) j++; }
    else { while (j < n && isDigit(s[j])) j++; }
    const digits = j - ds;
    if (digits === 0 || j >= n || s[j] !== ';') return null;
    if (hex ? digits > 6 : digits > 7) return null;
    const cp = parseInt(s.slice(ds, j), hex ? 16 : 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
      return ['\uFFFD', j + 1 - i];
    }
    return [escapeHtml(String.fromCodePoint(cp)), j + 1 - i];
  }
  // named: word characters then ';'
  while (j < n) {
    const c = s[j];
    if (c === ';') {
      if (j === i + 1) return null;
      return [s.slice(i, j + 1), j + 1 - i];
    }
    if (!isAlnum(c) && c !== '_') return null;
    j++;
  }
  return null;
}

// Is there a valid entity reference starting at s[i] === '&' (named or
// numeric, same rules as decodeEntity)? Used by the attribute escaper,
// which leaves references verbatim and escapes any other &.
function isEntityRef(s, i) {
  const n = s.length;
  if (i + 1 >= n) return false;
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const ds = j;
    if (hex) { while (j < n && isHex(s[j])) j++; }
    else { while (j < n && isDigit(s[j])) j++; }
    const digits = j - ds;
    if (digits === 0 || j >= n || s[j] !== ';') return false;
    return hex ? digits <= 6 : digits <= 7;
  }
  while (j < n) {
    const c = s[j];
    if (c === ';') return j > i + 1;
    if (!isAlnum(c) && c !== '_') return false;
    j++;
  }
  return false;
}

// Escape an attribute value (href, title, alt, info-string class) the
// way marked does: & < > " ' are escaped, except that a valid entity
// reference is left verbatim.
function escapeAttr(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
    s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&' && isEntityRef(s, i)) continue;
    let rep = null;
    if (c === '&') rep = '&amp;';
    else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start < s.length) out += s.slice(start);
  return out;
}
function isHex(ch) {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

// marked's cleanUrl: encodeURI, with % left as-is (encodeURI already does
// that). Control characters never reach here: the link parser rejects
// destinations containing them.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// ---------- block parsing helpers ----------

// Columns of leading whitespace in s (starting at virtual column col),
// and the index just past it. A tab advances to the next multiple of 4.
function countIndent(s, col) {
  let i = 0;
  let c = col;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') { i++; c++; }
    else if (ch === '\t') { i++; c += 4 - (c % 4); }
    else break;
  }
  return { cols: c - col, idx: i, col: c };
}

// Consume n columns of leading whitespace from s (starting at col).
// Returns the index after the consumed whitespace, the new column, and
// the number of literal spaces a partially consumed tab leaves behind.
function consumeCols(s, col, n) {
  let i = 0;
  let c = col;
  let spaces = 0;
  while (n > 0 && i < s.length) {
    const ch = s[i];
    if (ch === ' ') { i++; c++; n--; }
    else if (ch === '\t') {
      const w = 4 - (c % 4);
      if (w <= n) { i++; c += w; n -= w; }
      else { spaces = w - n; c += n; n = 0; i++; }
    } else break;
  }
  return { idx: i, col: c, spaces };
}

// The text of s after consuming n columns of leading whitespace
// (a partially consumed tab becomes literal spaces).
function stripCols(s, col, n) {
  const r = consumeCols(s, col, n);
  return { text: (r.spaces ? ' '.repeat(r.spaces) : '') + s.slice(r.idx), col: r.col };
}

// Strip a list-item indent (a container strip): unlike a leaf
// dedent, a tab that starts exactly at the stripped boundary is
// expanded to spaces, its width from its original column to the
// next tab stop.
function stripItemIndent(s, col, n) {
  const r = consumeCols(s, col, n);
  let text = (r.spaces ? ' '.repeat(r.spaces) : '') + s.slice(r.idx);
  let c = r.col;
  if (!r.spaces && r.idx < s.length && s[r.idx] === '\t') {
    const w = 4 - (c % 4);
    text = ' '.repeat(w) + s.slice(r.idx + 1);
    c += w;
  }
  return { text, col: c };
}

function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

// Match a block quote prefix at the start of s: up to 3 spaces, '>',
// then one optional space (or tab, which counts as one space here only
// when it is the single space after '>': a tab after '>' advances to the
// next multiple of 4, but the quote marker consumes just one column of
// it, leaving the rest as spaces). Returns {text, col} after the prefix,
// or null.
// Expand tabs to spaces, measuring tab stops from `indent`
// (marked's expandTabs).
function expandTabs(line, indent = 0) {
  if (line.indexOf('\t') === -1) return line;
  const spaces = '    ';
  const parts = line.split('\t');
  let out = '';
  let cur = indent;
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i < parts.length - 1) {
      cur += parts[i].length;
      const add = 4 - (cur % 4);
      out += spaces.slice(0, add);
      cur += add;
    }
  }
  return out;
}

function matchQuote(s, col) {
  const ind = countIndent(s, col);
  if (ind.cols > 3 || ind.idx >= s.length || s[ind.idx] !== '>') return null;
  // marked's blockquote processing, in two steps: first expand the
  // whole whitespace run after the marker (blockquoteMarkerWhitespace,
  // tabs measured from the marker's own length), then strip the
  // marker plus one optional space (blockquoteSetextReplace2).
  const markerLen = ind.cols + 1;
  let i = ind.idx + 1;
  let j = i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
  const ws = s.slice(i, j);
  const rest = s.slice(j);
  const expanded = ws.includes('\t') ? expandTabs(ws, markerLen) : ws;
  const text = expanded.length > 0 && expanded[0] === ' ' ? expanded.slice(1) + rest : expanded + rest;
  return { text, col: ind.col + (expanded.length > 0 ? 2 : 1) };
}

// Block-level HTML tags (CommonMark HTML block type 6).
const HTML_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// Split a table row line into cells on unescaped '|'. Leading and
// trailing pipes are optional; a cell is the text between pipes with
// surrounding spaces removed (the split keeps escapes for later).
// Cell text is sliced out of the line instead of built char by char;
// only cells containing an escaped pipe pay for a replace.
function splitTableRow(line) {
  const cells = [];
  const n = line.length;
  let i = 0;
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i < n && line[i] === '|') i++;
  let start = i;
  let hasEsc = false;
  for (; i < n; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < n && line[i + 1] === '|') {
      hasEsc = true;
      i++;
    } else if (ch === '|') {
      let cell = line.slice(start, i);
      if (hasEsc) cell = cell.replace(/\\\|/g, '|');
      cells.push(cell.trim());
      start = i + 1;
      hasEsc = false;
    }
  }
  // a trailing pipe (ignoring trailing whitespace) ends the last
  // cell; otherwise the rest is a cell. An escaped trailing pipe
  // was already consumed into cur above, so it still pushes.
  let j = n;
  while (j > 0 && (line[j - 1] === ' ' || line[j - 1] === '\t')) j--;
  const endsWithPipe = j > 0 && line[j - 1] === '|' &&
    !(j >= 2 && line[j - 2] === '\\' && (j < 3 || line[j - 3] !== '\\'));
  if (!endsWithPipe) {
    let cell = line.slice(start);
    if (hasEsc) cell = cell.replace(/\\\|/g, '|');
    cells.push(cell.trim());
  }
  return cells;
}

// Parse a table delimiter row: returns the alignment array ('l', 'c',
// 'r' or null per cell), or null when it is not a delimiter row. The
// row must have the same cell count as the header.
function parseDelimiterRow(line, headerCount) {
  const cells = splitTableRow(line);
  if (cells.length !== headerCount) return null;
  const aligns = [];
  for (const cell of cells) {
    // manual equivalent of /^(:?)-+(:?)$/"
    const len = cell.length;
    if (len === 0) return null;
    let a = 0, b = len;
    if (cell.charCodeAt(0) === 58) a = 1; // ':'
    if (b > a && cell.charCodeAt(b - 1) === 58) b--;
    if (b - a < 1) return null;
    for (let k = a; k < b; k++) if (cell.charCodeAt(k) !== 45) return null; // '-'
    aligns.push(a === 1 && b < len ? 'center' : a === 1 ? 'left' : b < len ? 'right' : null);
  }
  return aligns;
}

// Is this line a setext heading underline (after a paragraph)?
// Returns 1 for '=', 2 for '-', else 0. Leading indent <= 3.
function setextLevel(line, col) {
  const ind = countIndent(line, col);
  if (ind.cols > 3) return 0;
  let i = ind.idx;
  if (i >= line.length) return 0;
  const ch = line[i];
  if (ch !== '=' && ch !== '-') return 0;
  while (i < line.length && line[i] === ch) i++;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i !== line.length) return 0;
  return ch === '=' ? 1 : 2;
}

// Is this line a thematic break? Three or more of the same of * - _,
// with only spaces between, indent <= 3.
function isThematicBreak(line, col) {
  const ind = countIndent(line, col);
  if (ind.cols > 3) return false;
  let i = ind.idx;
  if (i >= line.length) return false;
  const ch = line[i];
  if (ch !== '*' && ch !== '-' && ch !== '_') return false;
  let count = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ch) { count++; i++; }
    else if (c === ' ' || c === '\t') i++;
    else return false;
  }
  return count >= 3;
}

// Normalize a link label: collapse internal whitespace to one space,
// trim, lowercase (Unicode-aware, as marked does).
function normalizeLabel(label) {
  return label.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/\u00df/g, 'ss')
    .replace(/\ufb00/g, 'ff').replace(/\ufb01/g, 'fi')
    .replace(/\ufb02/g, 'fl').replace(/\ufb03/g, 'ffi')
    .replace(/\ufb04/g, 'ffl').replace(/\ufb05/g, 'st')
    .replace(/\ufb06/g, 'st');
}

// ---------- link destinations and titles ----------

// Skip spaces and tabs (not newlines) from s[i].
function skipSpacesTabs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

// Skip spaces, tabs and newlines from s[i].
function skipWhitespace(s, i) {
  while (i < s.length && isSpace(s[i])) i++;
  return i;
}

// Parse a link destination at s[i]. Returns {dest, end} (dest raw, with
// backslash escapes kept) or null. A destination is <...> (no < or
// newline inside) or a bare run with no spaces or control characters and
// balanced parentheses.
function parseDestination(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s[i] === '<') {
    let j = i + 1;
    while (j < n) {
      const c = s[j];
      if (c === '>') return { dest: s.slice(i + 1, j), end: j + 1 };
      if (c === '<' || c === '\n') return null;
      if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) j += 2;
      else j++;
    }
    return null;
  }
  // bare destination: must not start with '<'
  if (s[i] === '<') return null;
  let j = i;
  let depth = 0;
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' ||
      c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7F) break;
    if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) { j += 2; continue; }
    if (c === '(') { depth++; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; j++; continue;
    }
    j++;
  }
  if (j === i) return null;
  return { dest: s.slice(i, j), end: j };
}

// Parse a link title at s[i]: "..." or '...' or (...), possibly spanning
// lines. Returns {title, end} (title raw, escapes kept) or null.
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const open = s[i];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) { j += 2; continue; }
    if (c === close) return { title: s.slice(i + 1, j), end: j + 1 };
    if (open === '(' && c === '(') return null;
    j++;
  }
  return null;
}

// Unescape backslash escapes in a raw string: \ + ASCII punctuation
// becomes the punctuation itself. Used for destinations, titles, and
// link labels' display text (not for label comparison).
function unescape(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isPunct(s[i + 1])) {
      if (i > start) out += s.slice(start, i);
      out += s[i + 1];
      i++;
      start = i + 1;
    }
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

// Try to parse one link reference definition starting at the beginning
// of the paragraph text `text` at position `pos` (which must be at a
// line start). Returns the position just past the definition, or -1.
// On success, adds the definition to `refs` (first definition wins).
function parseRefDef(text, pos, refs) {
  const n = text.length;
  let i = pos;
  // up to 3 spaces of indent
  let spaces = 0;
  while (i < n && text[i] === ' ' && spaces < 3) { i++; spaces++; }
  if (i >= n || text[i] !== '[') return -1;
  // label: [ ... ] with no unescaped [ or ], 1-999 chars; a
  // newline is allowed inside the label unless the next line is blank
  let j = i + 1;
  let labelEnd = -1;
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && isPunct(text[j + 1])) { j += 2; continue; }
    if (c === '[') return -1;
    if (c === ']') { labelEnd = j; break; }
    if (c === '\n') {
      let m = j + 1;
      while (m < n && (text[m] === ' ' || text[m] === '\t')) m++;
      if (m >= n || text[m] === '\n') return -1;
      j++;
      continue;
    }
    j++;
  }
  if (labelEnd < 0) return -1;
  const rawLabel = text.slice(i + 1, labelEnd);
  if (rawLabel.length === 0 || rawLabel.length > 999) return -1;
  j = labelEnd + 1;
  if (j >= n || text[j] !== ':') return -1;
  j++;
  // optional whitespace (including newlines) then the destination
  j = skipWhitespace(text, j);
  const d = parseDestination(text, j);
  if (!d) return -1;
  j = d.end;
  // optional whitespace, then an optional title; the title must be
  // separated from the destination by whitespace, and if it does not
  // parse cleanly (or has trailing junk) the definition stands
  // without a title
  let title = null;
  let jEnd = j;
  const k = skipWhitespace(text, j);
  if (k > j && k < n && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
    const t = parseTitle(text, k);
    if (t) {
      const m = skipSpacesTabs(text, t.end);
      if (m >= n || text[m] === '\n') {
        title = t.title;
        jEnd = t.end;
      }
    }
  }
  // only spaces/tabs may follow on this line
  j = skipSpacesTabs(text, jEnd);
  if (j < n && text[j] !== '\n') return -1;
  if (j < n) j++; // consume the line ending
  const label = normalizeLabel(rawLabel);
  if (label === '') return -1;
  if (!refs.has(label)) {
    refs.set(label, { href: d.dest, title });
  }
  return j;
}


// ---------- block parser ----------

// Match an HTML block start at the start of `s` (s[0] === '<').
// Returns the block type (1-7) or 0.
function htmlBlockType(s) {
  let m = /^<(script|pre|style|textarea)(\s|\/>|>|$)/i.exec(s);
  if (m) return 1;
  if (s.startsWith('<!--')) return 2;
  if (s.startsWith('<?')) return 3;
  if (s.startsWith('<!') && s.length > 2 && isAlpha(s[2])) return 4;
  if (s.startsWith('<![CDATA[')) return 5;
  m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(s);
  if (m) {
    const tag = m[1].toLowerCase();
    const after = s.slice(m[0].length);
    if (HTML_BLOCK_TAGS.has(tag)) {
      // type 6 (block tag): the tag name may be followed by
      // whitespace, '>', '/', end-of-line, or the tag may continue
      // on the next line
      if (after === '' || after[0] === ' ' || after[0] === '\t' ||
          after[0] === '>' || after[0] === '/') return 6;
    } else {
      // type 7 (any other tag): the tag must close on this line,
      // with only whitespace after the '>'. A closing tag takes no
      // attributes.
      if (s.startsWith('</')) {
        const cm = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(s);
        if (cm && /^[ \t]*$/.test(s.slice(cm[0].length))) return 7;
      } else {
        const om = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z:_][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/.exec(s);
        if (om && /^[ \t]*$/.test(s.slice(om[0].length))) return 7;
      }
    }
  }
  return 0;
  return 0;
}

// The end marker a line must contain to close an HTML block of type t
// (types 1-5). Returns a lowercase substring to look for, or null.
function htmlBlockEnd(t) {
  if (t === 1) return null; // depends on the tag; handled separately
  if (t === 2) return '-->';
  if (t === 3) return '?>';
  if (t === 4) return '>';
  if (t === 5) return ']]>';
  return null;
}

// Parse a list marker at the start of s (indent <= 3, s is the text
// after container prefixes). Returns null or:
// {bullet, ordered, delim, num, markerCols, contentIndent, empty,
//  contentText, contentCol}
function parseListMarker(s, col) {
  const ind = countIndent(s, col);
  if (ind.cols > 3) return null;
  const rest = s.slice(ind.idx);
  if (rest.length === 0) return null;
  const c0 = rest[0];
  let markerLen = 0;
  let bullet = false;
  let ordered = false;
  let delim = null;
  let num = 0;
  let markerChar = null;
  if (c0 === '-' || c0 === '+' || c0 === '*') {
    bullet = true;
    markerLen = 1;
    markerChar = c0;
  } else if (isDigit(c0)) {
    let i = 0;
    while (i < rest.length && isDigit(rest[i]) && i < 10) i++;
    if (i === 0 || i > 9) return null;
    if (i >= rest.length || (rest[i] !== '.' && rest[i] !== ')')) return null;
    ordered = true;
    delim = rest[i];
    num = parseInt(rest.slice(0, i), 10);
    markerLen = i + 1;
  } else {
    return null;
  }
  let j = markerLen;
  if (j < rest.length && rest[j] !== ' ' && rest[j] !== '\t') return null;
  const markerEndCol = ind.col + markerLen;
  // whitespace columns after the marker
  let k = j;
  let wcol = markerEndCol;
  while (k < rest.length) {
    const ch = rest[k];
    if (ch === ' ') { k++; wcol++; }
    else if (ch === '\t') { k++; wcol += 4 - (wcol % 4); }
    else break;
  }
  const wsCols = wcol - markerEndCol;
  const empty = k >= rest.length;
  if (empty) {
    return {
      bullet, ordered, delim, num, markerCols: markerLen, markerChar,
      contentIndent: ind.cols + markerLen + 1, empty: true,
      contentText: '', contentCol: markerEndCol + 1,
    };
  }
  if (wsCols >= 1 && wsCols <= 4) {
    return {
      bullet, ordered, delim, num, markerCols: markerLen, markerChar,
      contentIndent: ind.cols + markerLen + wsCols, empty: false,
      contentText: rest.slice(k), contentCol: wcol,
    };
  }
  // 5+ columns of whitespace: only one column is consumed
  const r = consumeCols(rest.slice(j), markerEndCol, 1);
  return {
    bullet, ordered, delim, num, markerCols: markerLen, markerChar,
    contentIndent: ind.cols + markerLen + 1, empty: false,
    contentText: (r.spaces ? ' '.repeat(r.spaces) : '') + rest.slice(j + r.idx),
    contentCol: markerEndCol + 1,
  };
}

// Parse an ATX heading at the start of s (indent <= 3). Returns
// {level, text} (text is the heading's raw content) or null.
function parseAtx(s, col) {
  const ind = countIndent(s, col);
  if (ind.cols > 3) return null;
  const rest = s.slice(ind.idx);
  let n = 0;
  while (n < rest.length && rest[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (n < rest.length && rest[n] !== ' ' && rest[n] !== '\t') return null;
  let text = rest.slice(n);
  // strip leading spaces/tabs, trailing spaces, and a closing run
  // of '#' preceded by a space
  let a = 0;
  while (a < text.length && (text[a] === ' ' || text[a] === '\t')) a++;
  let b = text.length;
  while (b > a && (text[b - 1] === ' ' || text[b - 1] === '\t')) b--;
  if (b > a && text[b - 1] === '#') {
    let c = b;
    while (c > a && text[c - 1] === '#') c--;
    if (c === a || text[c - 1] === ' ' || text[c - 1] === '\t') {
      b = c;
      while (b > a && (text[b - 1] === ' ' || text[b - 1] === '\t')) b--;
    }
  }
  return { level: n, text: text.slice(a, b) };
}

// Parse a fenced code start at the start of s (indent <= 3). Returns
// {char, len, info} or null. info is the raw info string.
function parseFence(s, col) {
  const ind = countIndent(s, col);
  if (ind.cols > 3) return null;
  const rest = s.slice(ind.idx);
  if (rest.length === 0) return null;
  const c0 = rest[0];
  if (c0 !== '`' && c0 !== '~') return null;
  let n = 0;
  while (n < rest.length && rest[n] === c0) n++;
  if (n < 3) return null;
  const info = rest.slice(n);
  if (c0 === '`' && info.indexOf('`') >= 0) return null;
  return { char: c0, len: n, info };
}

// Is this line a closing fence for a fence of `char` and length `len`?
function isClosingFence(s, col, char, len) {
  const ind = countIndent(s, col);
  if (ind.cols > 3) return false;
  const rest = s.slice(ind.idx);
  let n = 0;
  while (n < rest.length && rest[n] === char) n++;
  if (n < len) return false;
  for (let i = n; i < rest.length; i++) {
    if (rest[i] !== ' ' && rest[i] !== '\t') return false;
  }
  return true;
}

// The language for a fenced code info string: its first word, with
// backslash escapes decoded.
function fenceLanguage(info) {
  let i = 0;
  while (i < info.length && (info[i] === ' ' || info[i] === '\t')) i++;
  let j = i;
  while (j < info.length && info[j] !== ' ' && info[j] !== '\t') j++;
  return unescape(info.slice(i, j));
}


// The block parser: turns the input into a tree of blocks and collects
// link reference definitions.
function parseBlocks(src) {
  const lines = src.split('\n');
  let lastContentIdx = lines.length - 1;
  while (lastContentIdx > 0 && lines[lastContentIdx] === '') lastContentIdx--;
  const refs = new Map();
  const doc = { t: 'doc', children: [], lines: null, parent: null };
  const stack = [doc];

  function top() { return stack[stack.length - 1]; }
  // Open a block as a child of the top of the stack. When the parent
  // is a list item that a blank line passed through, the item's list
  // becomes loose (the item holds two blocks separated by a blank).
  function open(node) {
    const parent = top();
    node.parent = parent;
    parent.children.push(node);
    if (parent.t === 'item') {
      if (parent.sawBlank) {
        parent.parent.loose = true;
        parent.sawBlank = false;
      }
      // a block opened inside this item means a pending blank line
      // was between blocks of the item, not between items of an
      // ancestor list
      let p = parent.parent;
      while (p) {
        if (p.t === 'list') p.blankAfterItem = false;
        p = p.parent;
      }
    }
    stack.push(node);
    return node;
  }
  function finalize(b) {
    if (b.t === 'para' || b.t === 'heading') {
      b.lines = stripDefs(b);
      if (b.lines.length === 0 && b.t === 'para') {
        const ch = b.parent.children;
        if (ch[ch.length - 1] === b) ch.pop();
      }
    } else if (b.t === 'code') {
      // indented code: all trailing empty lines are dropped; a line
      // of spaces is content and is kept
      const ls = b.lines;
      while (ls.length > 0 && ls[ls.length - 1] === '') ls.pop();
    } else if (b.t === 'fence' && !b.closed) {
      // an unclosed fence drops one trailing empty line (the
      // artifact of the input's final newline)
      const ls = b.lines;
      if (ls.length > 0 && ls[ls.length - 1] === '') ls.pop();
    }
    // a closed fence keeps its trailing blank lines as content
  }

  function closeTo(n) {
    while (stack.length > n) finalize(stack.pop());
  }
  // Register leading link reference definitions of a paragraph and
  // drop them from its lines. Returns the remaining lines.
  function stripDefs(b) {
    if (!b.lines || b.lines.length === 0) return [];
    // a reference definition must start the paragraph (after at
    // most 3 spaces); otherwise the join + scan below is wasted.
    const first = b.lines[0];
    let k = 0;
    while (k < first.length && first[k] === ' ' && k < 3) k++;
    if (k >= first.length || first[k] !== '[') return b.lines;
    const text = b.lines.join('\n');
    let pos = 0;
    let last = 0;
    for (;;) {
      const end = parseRefDef(text, pos, refs);
      if (end < 0) break;
      last = end;
      pos = end;
    }
    if (last === 0) return b.lines;
    const rest = text.slice(last);
    return rest === '' ? [] : rest.split('\n');
  }

  // The lines of a paragraph after its leading link reference
  // definitions, without registering them (used to decide whether a
  // setext underline may turn the paragraph into a heading).
  function stripDefsDry(ls) {
    if (!ls || ls.length === 0) return [];
    const first = ls[0];
    let k = 0;
    while (k < first.length && first[k] === ' ' && k < 3) k++;
    if (k >= first.length || first[k] !== '[') return ls;
    const text = ls.join('\n');
    const dummy = new Map();
    let pos = 0;
    let last = 0;
    for (;;) {
      const end = parseRefDef(text, pos, dummy);
      if (end < 0) break;
      last = end;
      pos = end;
    }
    if (last === 0) return ls;
    const rest = text.slice(last);
    return rest === '' ? [] : rest.split('\n');
  }


  // Strip the current open containers' prefixes from a raw line, as
  // phase 1 does, but without lazy matching. Returns {text, col} or
  // null when a container fails to match.
  function stripPrefixes(raw) {
    let s = raw;
    let col = 0;
    for (let k = 1; k < stack.length; k++) {
      const b = stack[k];
      if (b.t === 'quote') {
        const m = matchQuote(s, col);
        if (!m) return null;
        s = m.text; col = m.col;
      } else if (b.t === 'list') {
        // lists always match
      } else if (b.t === 'item') {
        if (isBlank(s)) continue;
        const ind = countIndent(s, col);
        if (ind.cols < b.indent) return null;
        const r = stripItemIndent(s, col, b.indent);
        s = r.text; col = r.col;
      } else {
        break;
      }
    }
    return { text: s, col };
  }

  // Can this list item interrupt a paragraph? It must be non-empty,
  // and an ordered list must start with 1.
  function canInterruptList(lm) {
    if (lm.empty) return false;
    if (lm.ordered && lm.num !== 1) return false;
    return true;
  }

  // Does this line start a block that can interrupt a paragraph?
  // `nextRaw` is the next raw line (for the table check), or null.
  function startsInterruptingBlock(s, col, nextRaw) {
    const ind = countIndent(s, col);
    if (ind.cols > 3) return false;
    if (true) {
      const rest = s.slice(ind.idx);
      if (rest.length > 0) {
        const c0 = rest[0];
        if (c0 === '#') {
          if (parseAtx(s, col)) return true;
        } else if (c0 === '`' || c0 === '~') {
          if (parseFence(s, col)) return true;
        } else if (c0 === '>') {
          return true;
        } else if (c0 === '<') {
          const ht = htmlBlockType(rest);
          if (ht >= 1 && ht <= 6) return true;
        } else if (c0 === '*' || c0 === '-' || c0 === '_') {
          if (isThematicBreak(s, col)) return true;
        }
        const lm = parseListMarker(s, col);
        if (lm && canInterruptList(lm)) return true;
      }
    }
    if (nextRaw !== null && nextRaw !== undefined && nextRaw.indexOf('-') >= 0) {
      const stripped = stripPrefixes(nextRaw);
      if (stripped) {
        const dInd = countIndent(stripped.text, stripped.col);
        if (dInd.cols <= 3) {
          const d = parseDelimiterRow(stripped.text, splitTableRow(s).length);
          if (d && setextLevel(stripped.text, stripped.col) === 0) return true;
        }
      }
    }
    return false;
  }

  // Would this line, as the next line of an open paragraph, start a
  // table (this line is the header, the following line the delimiter)?
  // Returns the alignment array or null.
  function tableStart(s, col, nextRaw) {
    if (nextRaw === null || nextRaw === undefined) return null;
    // a delimiter row is made of cells that each contain a '-';
    // stripping container prefixes cannot introduce one, so a next
    // line without '-' can never be a delimiter row.
    if (nextRaw.indexOf('-') < 0) return null;
    if (isBlank(s)) return null;
    const ind = countIndent(s, col);
    if (ind.cols > 3) return null;
    const stripped = stripPrefixes(nextRaw);
    if (!stripped) return null;
    const dInd = countIndent(stripped.text, stripped.col);
    if (dInd.cols > 3) return null;
    const headerCells = splitTableRow(s);
    if (headerCells.length === 0) return null;
    const d = parseDelimiterRow(stripped.text, headerCells.length);
    if (!d) return null;
    if (setextLevel(stripped.text, stripped.col) > 0) return null;
    return d;
  }

  // Does a line match a container lazily: it is a plain paragraph line
  // (starts no interrupting block) and either the tip is an open
  // paragraph (1: continue it), or the container's last child is a
  // list and no blank line has intervened (2: start a new paragraph
  // in the container). `nextRaw` is the next raw line.
  function lazyOk(b, s, col, nextRaw) {
    // a blank line is never a lazy paragraph continuation: it ends
    // the paragraph, so a container it does not match must close
    // (e.g. an inner blockquote whose '>' prefix a blank outer-quote
    // line does not carry)
    if (isBlank(s)) return 0;
    // a line that starts a list item (of any kind) is never a lazy
    // continuation line; it ends the container and starts a new list
    if (parseListMarker(s, col)) return 0;
    if (startsInterruptingBlock(s, col, nextRaw)) return 0;
    if (top().t === 'para') return 1;
    const ch = b.children;
    if (ch.length > 0 && ch[ch.length - 1].t === 'list' && !b.afterBlank) return 2;
    return 0;
  }

  // The text of a blank line after its container prefixes are
  // stripped, keeping the remaining spaces (for indented code).
  function stripBlankLineRaw(raw) {
    let s = raw;
    let col = 0;
    for (let k = 1; k < stack.length; k++) {
      const b = stack[k];
      if (b.t === 'quote') {
        const m = matchQuote(s, col);
        if (!m) return '';
        s = m.text; col = m.col;
      } else if (b.t === 'list') {
        // lists always match
      } else if (b.t === 'item') {
        const ind = countIndent(s, col);
        const r = stripItemIndent(s, col, Math.min(ind.cols, b.indent));
        s = r.text; col = r.col;
      } else {
        break;
      }
    }
    return s;
  }

  // The text of a blank line after its container prefixes are
  // stripped (fence / HTML content keeps it, indented code does not).
  function stripBlankLine(raw) {
    let s = raw;
    let col = 0;
    for (let k = 1; k < stack.length; k++) {
      const b = stack[k];
      if (b.t === 'quote') {
        const m = matchQuote(s, col);
        if (!m) return '';
        s = m.text; col = m.col;
      } else if (b.t === 'list') {
        // lists always match
      } else if (b.t === 'item') {
        // a blank line inside a list item contributes an empty line,
        // whatever spaces it has
        return '';
      } else {
        break;
      }
    }
    return s;
  }


  // Strip up to `wsLen` leading spaces/tabs from a fenced-code
  // content line (marked's indent-code compensation: the content is
  // dedented by the opening fence line's indent).
  // Does the open-container stack contain a list item?
  function hasItemAncestor() {
    for (let j = 1; j < stack.length; j++) {
      if (stack[j].t === 'item') return true;
    }
    return false;
  }

  // Dedent a fenced-code line by the opening fence's indent, in
  // characters (marked's Dt: slice min(leading-ws, indent) chars).
  function dedentFenceLine(line, wsLen) {
    let k = 0;
    while (k < line.length && k < wsLen && (line[k] === ' ' || line[k] === '\t')) k++;
    return line.slice(k);
  }

  // Dedent a paragraph continuation line: a lazy line, or a line
  // inside a list item, that still has 4+ columns of indent loses
  // 4 columns (marked's indented-code compensation for continuations).
  function dedentParaLine(line, col, lazy) {
    if (!lazy && !hasItemAncestor()) return line;
    const ind = countIndent(line, col);
    if (ind.cols < 4) return line;
    return stripCols(line, col, 4).text;
  }

  // Does this line end an HTML block of the given type (the line is
  // included in the block)? Type 1 depends on the opening tag.
  function htmlLineEnds(node, line) {
    const t = node.htmlType;
    if (t === 1) return line.toLowerCase().indexOf('</' + node.htmlTag + '>') >= 0;
    if (t === 2) return line.indexOf('-->') >= 0;
    if (t === 3) return line.indexOf('?>') >= 0;
    if (t === 5) return line.indexOf(']]>') >= 0;
    return false;
  }

  // Create (or reuse) a list for this marker and add an item to it.
  function startListItem(lm) {
    let list = top();
    // If the top is an item that was entered by container matching
    // on an EARLIER line but NOT by this line's matching (e.g. it was
    // skipped by the fence-content exception and an outer container
    // then failed), a list marker here is a sibling of that item, not
    // a nested list inside it: close it and reuse its parent list
    // when the marker matches. An item just created on this very line
    // (matchedLi undefined) is not skipped -- its content is the
    // nested marker, so it stays nested.
    if (list.t === 'item' && list.matchedLi !== undefined && list.matchedLi !== curLi && list.parent && list.parent.t === 'list') {
      const parentList = list.parent;
      if ((lm.bullet && parentList.bulletChar === lm.markerChar) ||
          (lm.ordered && parentList.delim === lm.delim)) {
        closeTo(stack.indexOf(list));
        list = top();
      }
    }
    let reuse = false;
    if (list.t === 'list') {
      if (lm.bullet && list.bulletChar === lm.markerChar) reuse = true;
      if (lm.ordered && list.delim === lm.delim) reuse = true;
    }
    if (!reuse) {
      if (list.t === 'list') closeTo(stack.indexOf(list));
      list = {
        t: 'list', children: [], lines: null, parent: null,
        bulletChar: lm.bullet ? lm.markerChar : null,
        delim: lm.ordered ? lm.delim : null,
        start: lm.ordered ? lm.num : null,
        loose: false, ordered: lm.ordered, blankAfterItem: false,
      };
      open(list);
    }
    // close the previous item of this list, if any
    closeTo(stack.indexOf(list) + 1);
    if (list.blankAfterItem) {
      list.loose = true;
      list.blankAfterItem = false;
    }
    const item = {
      t: 'item', children: [], lines: null, parent: null,
      indent: lm.contentIndent, sawBlank: false, afterBlank: false,
    };
    open(item);
  }

  // Start new blocks in the current top container from (s, col).
  // `nextRaw` is the next raw line (for the table check);
  // `interruptingPara` is true when an open paragraph is being
  // interrupted. Returns {done} when the line was consumed, or
  // {rest, col} to keep starting blocks inside a new container, and
  // optionally {skipNext} when the next line was consumed too.
  function startBlock(s, col, nextRaw, interruptingPara) {
    if (isBlank(s)) return { done: true };
    // A thematic break beats a list item (`* * *` is an <hr>, not a
    // list item), and a block that is not a list item cannot be a
    // direct child of a list, so it closes the list (a following list
    // item starts a new list).
    const ind0 = countIndent(s, col);
    const isHr0 = ind0.cols <= 3 && isThematicBreak(s, col);
    const lm0 = parseListMarker(s, col);
    const isListItem0 = lm0 && !isHr0 && (!interruptingPara || canInterruptList(lm0) || top().t === 'item');
    if (!isListItem0 && top().t === 'list') {
      closeTo(stack.length - 1);
    }
    // ATX heading
    const h = parseAtx(s, col);
    if (h) {
      const node = { t: 'heading', children: [], lines: [h.text], parent: null, level: h.level };
      open(node);
      finalize(node);
      stack.pop();
      return { done: true };
    }
    // fenced code
    const f = parseFence(s, col);
    if (f) {
      const wsm = /^[ \t]*/.exec(s);
      const node = {
        t: 'fence', children: [], lines: [], parent: null,
        fenceChar: f.char, fenceLen: f.len, info: f.info,
        fenceWs: wsm ? wsm[0] : '',
      };
      open(node);
      return { done: true };
    }
    // HTML block
    const ind = countIndent(s, col);
    if (ind.cols <= 3) {
      const rest = s.slice(ind.idx);
      const ht = rest[0] === '<' ? htmlBlockType(rest) : 0;
      // type 7 cannot interrupt a paragraph
      if (ht > 0 && (!interruptingPara || ht < 7)) {
        const node = {
          t: 'html', children: [], lines: [s], parent: null,
          htmlType: ht, htmlTag: null, lastLi: curLi,
        };
        if (ht === 1) {
          const m = /^<(script|pre|style|textarea)/i.exec(rest);
          node.htmlTag = m ? m[1].toLowerCase() : '';
        }
        open(node);
        // types 1-5 may already end on their opening line;
        // type 4 always does (its '>' is the tag itself)
        if (ht === 4 || htmlLineEnds(node, s)) {
          node.endedByMarker = true;
          stack.pop();
        }
        return { done: true };
      }
      // thematic break
      if (isThematicBreak(s, col)) {
        const node = { t: 'hr', children: [], lines: null, parent: null };
        open(node);
        stack.pop();
        return { done: true };
      }
    }
    // block quote
    const qm = matchQuote(s, col);
    if (qm && ind.cols <= 3) {
      const node = { t: 'quote', children: [], lines: null, parent: null, afterBlank: false };
      open(node);
      return { rest: qm.text, col: qm.col };
    }
    // list item (a paragraph that is a direct child of a list item
    // is interrupted by any list marker, not only canInterruptList)
    const lm = parseListMarker(s, col);
    if (lm && (!interruptingPara || canInterruptList(lm) || top().t === 'item')) {
      startListItem(lm);
      if (lm.empty) return { done: true };
      return { rest: lm.contentText, col: lm.contentCol };
    }
    // table
    const aligns = tableStart(s, col, nextRaw);
    if (aligns) {
      const node = {
        t: 'table', children: [], lines: null, parent: null,
        align: aligns, header: splitTableRow(s), rows: [],
      };
      open(node);
      return { done: true, skipNext: true };
    }
    // indented code (only when not interrupting a paragraph)
    if (!interruptingPara && ind.cols >= 4) {
      const r = stripCols(s, col, 4);
      const node = { t: 'code', children: [], lines: [r.text], parent: null };
      open(node);
      return { done: true };
    }
    // paragraph
    const node = { t: 'para', children: [], lines: [s], parent: null };
    open(node);
    return { done: true };
  }

  // Start blocks from (s, col) in the current top container, looping
  // while containers (quote/item) leave a rest to process. Returns
  // true when the next line must also be skipped (table delimiter).
  function startBlocks(s, col, nextRaw, interruptingPara) {
    let cur = s;
    let ccol = col;
    for (;;) {
      const r = startBlock(cur, ccol, nextRaw, interruptingPara);
      if (r.done) return !!r.skipNext;
      cur = r.rest;
      ccol = r.col;
      interruptingPara = false;
      if (cur === undefined || cur === null) return false;
    }
  }

  // ---- main line loop ----
  // whether the previous line was a lazy continuation line (it did not
  // match its containers' prefixes but continued an open paragraph)
  let lastLazy = false;
  let curLi = 0;
  for (let li = 0; li < lines.length; li++) {
    curLi = li;
    const raw = lines[li];
    const blank = isBlank(raw);
    const nextRaw = li + 1 < lines.length ? lines[li + 1] : null;
    const prevLazy = lastLazy;
    let wasLazy = false;

    // phase 1: match open containers
    let s = raw;
    let col = 0;
    let unmatched = -1;
    let lazyNewPara = null;
    let k = 1;
    for (; k < stack.length; k++) {
      const b = stack[k];
      if (b.t === 'quote') {
        if (blank) {
          // a blank line only stays inside a quote if it carries the
          // quote's '>' prefix; otherwise the quote closes
          const m = matchQuote(s, col);
          if (!m) { unmatched = k; break; }
          s = m.text; col = m.col;
        } else {
          const m = matchQuote(s, col);
          if (!m) {
            // Note: unlike list items, a fence inside a blockquote
            // DOES require the '>' prefix on content lines (cm-237):
            // a line without '>' closes the quote (and the fence).
            // So no fence-content exception here.
            const lz = lazyOk(b, s, col, nextRaw);
            if (lz === 2) { lazyNewPara = b; b.afterBlank = false; }
            else if (lz === 1) { b.afterBlank = false; wasLazy = true; }
            else { unmatched = k; break; }
          } else {
            s = m.text; col = m.col;
            b.afterBlank = false;
          }
        }
      } else if (b.t === 'list') {
        // lists always match
      } else if (b.t === 'item') {
        // a blank line matches an item -- including a line that is
        // only blank once its outer container prefixes are stripped
        // (e.g. '>' inside a quote): in marked a blank line is always
        // item content, and the indent check below must not run on it
        if (blank || isBlank(s)) {
          // blank matches an item
        } else {
          const ind = countIndent(s, col);
          if (ind.cols >= b.indent) {
            const r = stripItemIndent(s, col, b.indent);
            s = r.text; col = r.col;
            b.afterBlank = false;
            b.matchedLi = curLi;
          } else {
            // A fenced code block's content lines are taken literally
            // regardless of the item indent -- but only once the fence
            // already has content: an empty fence does not absorb a
            // first NON-BLANK line that falls below the item's indent
            // (marked closes the item and leaves the fence empty; the
            // line becomes a top-level block). A blank line is always
            // item content in marked, so it is fence content even when
            // the fence is still empty. A non-closing line is fence
            // content when the fence is non-empty.
            // NOTE: do not break out of the container loop here -- a
            // line that does not match an OUTER container of the fence
            // (e.g. a blockquote '>' prefix) is not fence content at
            // all; skip this item and let the remaining containers be
            // checked, so the fence closes with them.
            const tip0 = top();
            if (tip0.t === 'fence' && !isClosingFence(s, col, tip0.fenceChar, tip0.fenceLen) && (isBlank(s) || tip0.lines.length > 0)) continue;
            const lz = lazyOk(b, s, col, nextRaw);
            if (lz === 2) { lazyNewPara = b; b.afterBlank = false; }
            else if (lz === 1) { b.afterBlank = false; wasLazy = true; }
            else { unmatched = k; break; }
          }
        }
      } else {
        break; // leaf reached
      }
    }

    lastLazy = wasLazy;

    // a line that is only container prefixes (e.g. '>') is blank
    // once those prefixes are stripped
    const effectiveBlank = blank || isBlank(s);

    if (effectiveBlank) {
      // the blank line did not match some container (a quote without
      // its '>' prefix): close it and everything inside it
      if (unmatched >= 0) closeTo(unmatched);
      const tip = top();
      // A whitespace-only line of 0-3 spaces + a single tab is an
      // empty table row in marked, not a blank line: marked's table
      // regex excludes only spaces-only lines ( *\n) and indented
      // code lines, so such a line is a row of empty cells.
      if (tip.t === 'table' && /^ {0,3}\t$/.test(s)) {
        const row = splitTableRow(s);
        const cells = [];
        for (let c = 0; c < tip.header.length; c++) cells.push(c < row.length ? row[c] : '');
        tip.rows.push(cells);
        continue;
      }
      // a trailing spaces-only line (non-empty after its prefixes
      // are stripped) that is the last content line is a paragraph
      // line, not a separator (there is no newline after it)
      if (tip.t === 'para' && s !== '' && li === lastContentIdx) {
        tip.lines.push(dedentParaLine(s, col, wasLazy));
        continue;
      }
      if (tip.t === 'fence' || tip.t === 'code' || (tip.t === 'html' && tip.htmlType <= 5)) {
        // a blank line inside a fence, indented code, or an HTML
        // block of types 1-5 is content, not a separator
        if (tip.t === 'code') {
          // indented code: the line after its container prefixes,
          // minus up to 4 columns (a line with fewer stays empty)
          const stripped = stripBlankLineRaw(raw);
          const ind = countIndent(stripped, 0);
          const r = stripCols(stripped, 0, Math.min(4, ind.cols));
          tip.lines.push(r.text);
        } else if (tip.t === 'fence') {
          // marked's indentCodeCompensation only strips the opening
          // fence's indent for ``` fences (its regex is /^(\s+)(?:```)/);
          // ~~~ fences keep their content lines untouched.
          tip.lines.push(tip.fenceChar === '`' ? dedentFenceLine(stripBlankLine(raw), tip.fenceWs.length) : stripBlankLine(raw));
        } else {
          tip.lines.push(stripBlankLine(raw));
          tip.lastLi = curLi;
        }
      } else {
        if (tip.t === 'para' || tip.t === 'table' ||
          (tip.t === 'html' && (tip.htmlType === 6 || tip.htmlType === 7))) {
          closeTo(stack.length - 1);
        }
        // a blank line directly inside an item counts as a separator
        // between items of that item's list and of ancestor lists
        // (until a block opened inside the item shows it was
        // intra-item); a blank line inside a quote or other block does
        // not separate items. Record this before closing empty items,
        // so an empty item still counts as the innermost container.
        const inner = top();
        for (let j = 1; j < stack.length; j++) {
          const b = stack[j];
          if (b.t === 'item') { b.sawBlank = true; b.afterBlank = true; }
          else if (b.t === 'quote') b.afterBlank = true;
        }
        if (inner.t === 'item') {
          for (let j = 1; j < stack.length; j++) {
            if (stack[j].t === 'list') stack[j].blankAfterItem = true;
          }
        }
        // an empty list item cannot absorb a following block after a
        // blank line: close empty items
        while (stack.length > 1) {
          const t = top();
          if (t.t === 'item' && t.children.length === 0) {
            closeTo(stack.length - 1);
          } else break;
        }
      }
      continue;
    }

    if (unmatched >= 0) {
      if (lazyNewPara) {
        closeTo(stack.indexOf(lazyNewPara) + 1);
        const node = { t: 'para', children: [], lines: [s], parent: null };
        open(node);
        continue;
      }
      closeTo(unmatched);
    }

    // phase 2 / leaf handling
    let tip = top();
    if (tip.t === 'para') {
      // setext heading?
      const sl = setextLevel(s, col);
      if (sl > 0 && wasLazy) {
        // a setext underline cannot be a lazy continuation line: it
        // is paragraph text. Inside a blockquote, and after another
        // lazy line, it is indented by 4 spaces.
        let hasQuote = false;
        for (let j = 1; j < stack.length; j++) {
          if (stack[j].t === 'quote') { hasQuote = true; break; }
        }
        tip.lines.push(prevLazy && hasQuote ? '    ' + s : s);
        continue;
      }
      if (sl > 0 && stripDefsDry(tip.lines).length > 0) {
        tip.t = 'heading';
        tip.level = sl;
        finalize(tip);
        stack.pop();
        continue;
      }
      // a block that interrupts the paragraph?
      const ind = countIndent(s, col);
      let interrupts = false;
      if (ind.cols <= 3) {
        const rest = s.slice(ind.idx);
        if (rest.length > 0) {
          const c0 = rest[0];
          if (c0 === '#') interrupts = !!parseAtx(s, col);
          else if (c0 === '`' || c0 === '~') interrupts = !!parseFence(s, col);
          else if (c0 === '>') interrupts = true;
          else if (c0 === '<') {
            const ht = htmlBlockType(rest);
            // marked's paragraph rule interrupts on HTML blocks of
            // types 1-6 everywhere, including inside list items.
            interrupts = ht >= 1 && ht <= 6;
          } else if (c0 === '*' || c0 === '-' || c0 === '_') {
            interrupts = isThematicBreak(s, col);
          }
          if (!interrupts) {
            const lm = parseListMarker(s, col);
            if (lm && (canInterruptList(lm) || (tip.parent && tip.parent.t === 'item'))) interrupts = true;
          }
        }
      }
      if (interrupts) {
        closeTo(stack.length - 1);
        if (startBlocks(s, col, nextRaw, true)) li++;
        continue;
      }
      // table start?
      const aligns = tableStart(s, col, nextRaw);
      if (aligns) {
        closeTo(stack.length - 1);
        const node = {
          t: 'table', children: [], lines: null, parent: null,
          align: aligns, header: splitTableRow(s), rows: [],
        };
        open(node);
        li++; // consume the delimiter line
        continue;
      }
      tip.lines.push(dedentParaLine(s, col, wasLazy));
      continue;
    }

    if (tip.t === 'fence') {
      if (isClosingFence(s, col, tip.fenceChar, tip.fenceLen)) {
        tip.closed = true;
        closeTo(stack.length - 1);
      } else {
        // ~~~ fences keep their content lines untouched (see above).
        tip.lines.push(tip.fenceChar === '`' ? dedentFenceLine(s, tip.fenceWs.length) : s);
      }
      continue;
    }

    if (tip.t === 'code') {
      const ind = countIndent(s, col);
      if (ind.cols >= 4) {
        const r = stripCols(s, col, 4);
        tip.lines.push(r.text);
      } else {
        closeTo(stack.length - 1);
        li--; // reprocess this line as a fresh block
      }
      continue;
    }

    if (tip.t === 'html') {
      tip.lines.push(s);
      tip.lastLi = curLi;
      if (htmlLineEnds(tip, s)) {
        tip.endedByMarker = true;
        closeTo(stack.length - 1);
      }
      continue;
    }

    if (tip.t === 'table') {
      // a line that starts a new block (blockquote, heading, fence,
      // html, thematic break, or any list item) ends the table
      if (startsInterruptingBlock(s, col, null) || parseListMarker(s, col)) {
        closeTo(stack.length - 1);
        li--; // reprocess this line as a fresh block
        continue;
      }
      const row = splitTableRow(s);
      const cells = [];
      for (let c = 0; c < tip.header.length; c++) {
        cells.push(c < row.length ? row[c] : '');
      }
      tip.rows.push(cells);
      continue;
    }

    // no leaf open: start new blocks
    if (startBlocks(s, col, nextRaw, false)) li++;
  }

  closeTo(1);
  // An HTML block's text carries a trailing newline exactly when
  // marked's html token keeps one: trimTrailingBlankLines keeps a
  // single trailing newline and drops two or more, so the token ends
  // with '\n' iff the block ended by its marker and the next line
  // exists and is non-empty (one newline follows), or — at top level
  // only — it runs to the very end of the input and the input ends
  // with a newline. A blank line after the block means the token
  // ends with '\n\n', which is trimmed to nothing.
  // Whether a raw line is blank in the context of the html block's
  // enclosing containers: a lone '>' (or '>' plus spaces) is a blank
  // line inside a blockquote. Note this is an EXACTLY EMPTY line:
  // a spaces-only or tab-only line is not blank here, because marked's
  // html regex (type 1: </tag>[^\n]*\n*, type 2: comment[^\n]*(\n+|$))
  // stops its trailing-newline run at the first non-newline char, so
  // the token still ends with a single '\n' (trimTrailingBlankLines
  // keeps one). Only a truly empty next line makes the match end with
  // '\n\n', which is trimmed to nothing.
  function nextLineBlankInContext(node, rawLine) {
    let depth = 0;
    let p = node.parent;
    while (p) { if (p.t === 'quote') depth++; p = p.parent; }
    let s = rawLine;
    for (let d = 0; d < depth; d++) {
      const m = /^ {0,3}>/.exec(s);
      if (!m) break;
      s = s.slice(m[0].length);
      if (s.startsWith(' ') || s.startsWith('\t')) s = s.slice(1);
    }
    return s === '';
  }

  // Whether the html node is the last descendant of its nearest
  // enclosing list item: a list item's text (the source the html
  // tokenizer runs on) has no trailing newline, so an html block
  // that ends the item never carries a trailing '\n'.
  function isLastInItem(node) {
    let item = null;
    let p = node.parent;
    while (p) { if (p.t === 'item') { item = p; break; } p = p.parent; }
    if (!item) return false;
    // walk from the item down to the node; at each level the child on
    // the path must be the parent's last child
    let cur = node;
    while (cur !== item) {
      const par = cur.parent;
      if (!par || !par.children || par.children[par.children.length - 1] !== cur) return false;
      cur = par;
    }
    return true;
  }

  const endsNl = src.endsWith('\n');
  const nReal = endsNl ? lines.length - 1 : lines.length;
  (function setHtmlTrailingNl(node, isTop) {
    const kids = node.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const ch = kids[i];
      if (ch.t === 'html') {
        const nextLine = ch.lastLi + 1 < lines.length ? lines[ch.lastLi + 1] : undefined;
        ch.trailingNl = !isLastInItem(ch) &&
          ((isTop && ch.lastLi === nReal - 1 && endsNl) ||
          (ch.endedByMarker && nextLine !== undefined && !nextLineBlankInContext(ch, nextLine)));
      }
      setHtmlTrailingNl(ch, false);
    }
  })(doc, true);
  return { doc, refs };
}

// ---- inline parsing ----

// Link label patterns, reconstructed from marked 18.1.3 (its regexes
// are the ground truth for the nested-bracket behaviour).
const LE_BRACKET = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const RE_LABEL_SRC = '(?:\\[(?:' + LE_BRACKET.source + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const LE_REF_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const HREF_SRC = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
const TITLE_SRC = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';
const LINK_RE = new RegExp('^!?\\[(' + RE_LABEL_SRC + ')\\]\\([ \\t\\n]*(' + HREF_SRC + ')(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(' + TITLE_SRC + '))?[ \\t\\n]*\\)');
const REFLINK_RE = new RegExp('^!?\\[(' + RE_LABEL_SRC + ')\\]\\[(' + LE_REF_SRC + ')\\]');
const NOLINK_RE = new RegExp('^!?\\[(' + LE_REF_SRC + ')\\](?:\\[\\])?');
// <...> autolink and raw-HTML tag patterns (marked 18.1.3).
const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const COMMENT_RE = /^<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const TAG_RE = new RegExp('^' + COMMENT_RE.source.slice(1) + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>');
// GFM extended autolinks (marked 18.1.3): three separate patterns, one
// per alternative of its url rule, so no group numbering is involved.
const EMAIL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTO_RE = new RegExp('^(?:mailto:' + EMAIL_RE.source + '|xmpp:' + EMAIL_RE.source + '(?:\\/[A-Za-z0-9@.]+)?)');
const SCHEME_URL_RE = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*/;
const WWW_URL_RE = /^www\.(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*/;
const PLAIN_EMAIL_RE = new RegExp('^' + EMAIL_RE.source);
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const CODE_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const BACKSLASH_ESCAPE_RE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/;
const BR_RE = /^( {2,}|\\\\)\n(?!\s*$)[ \t]*/;
// local-part characters for the email lookahead (marked's text rule).
const LOCAL_PART_RE = /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@/y;
// Lookup table for the same class: a per-character regex test in the
// text-run scanner is far slower than a table lookup.
const LOCAL_PART_TABLE = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~-") LOCAL_PART_TABLE[ch.charCodeAt(0)] = 1;
function isLocalPartCh(c) {
  const cc = c.charCodeAt(0);
  return cc < 128 && LOCAL_PART_TABLE[cc] === 1;
}

// Characters that can start an extended autolink: [A-Za-z0-9._+-]
// (plain email) plus 'm'/'x' (mailto:/xmpp:), 'w' (www.) and
// 'h'/'H'/'f'/'F' (scheme). Anything else cannot start one, so the
// scanner skips the autolink attempt entirely.
const AUTO_START_TABLE = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._+-") AUTO_START_TABLE[ch.charCodeAt(0)] = 1;

// Manual equivalent of SCHEME_PREFIX_RE at position j (no slice).
function hasSchemePrefix(text, j) {
  const c0 = text[j];
  if (c0 === 'h' || c0 === 'H') {
    const c1 = text[j + 1], c2 = text[j + 2], c3 = text[j + 3];
    if ((c1 !== 't' && c1 !== 'T') || (c2 !== 't' && c2 !== 'T') || (c3 !== 'p' && c3 !== 'P')) return false;
    const c4 = text[j + 4];
    if (c4 === ':') return text[j + 5] === '/' && text[j + 6] === '/';
    if (c4 === 's' || c4 === 'S') return text[j + 5] === ':' && text[j + 6] === '/' && text[j + 7] === '/';
    return false;
  }
  if (c0 === 'f' || c0 === 'F') {
    const c1 = text[j + 1], c2 = text[j + 2];
    if ((c1 !== 't' && c1 !== 'T') || (c2 !== 'p' && c2 !== 'P')) return false;
    return text[j + 3] === ':' && text[j + 4] === '/' && text[j + 5] === '/';
  }
  return false;
}

const LETTER_DIGIT_RE = /[\p{L}\p{N}]/u;
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isLetterOrDigit(c) {
  const cc = c.charCodeAt(0);
  if (cc < 128) {
    return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
  }
  return LETTER_DIGIT_RE.test(c);
}
function isPunctCh(c) {
  const cc = c.charCodeAt(0);
  // ASCII punctuation is exactly isPunct(); only non-ASCII pays
  // for the Unicode property test. (c === '' gives NaN, which falls
  // through to the regex and returns false, as before.)
  if (cc < 128) {
    return (cc >= 33 && cc <= 47) || (cc >= 58 && cc <= 64) ||
      (cc >= 91 && cc <= 96) || (cc >= 123 && cc <= 126);
  }
  return PUNCT_RE.test(c);
}
function isSpaceCh(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\u1680' || (c >= '\u2000' && c <= '\u200a') || c === '\u2028' || c === '\u2029' || c === '\u202f' || c === '\u205f' || c === '\u3000' || c === '\ufeff';
}
// Parenthesis balance of a link destination: -1 = none/balanced,
// -2 = unmatched '(', otherwise the index of the first unmatched ')'.
function parenBalance(s) {
  let depth = 0;
  let hasParen = false;
  for (let n = 0; n < s.length; n++) {
    if (s[n] === '\\') { n++; continue; }
    if (s[n] === '(') { depth++; hasParen = true; }
    else if (s[n] === ')') {
      hasParen = true;
      depth--;
      if (depth < 0) return n;
    }
  }
  if (!hasParen) return -1;
  return depth > 0 ? -2 : -1;
}
function trailingBackslashes(s) {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === '\\'; i--) n++;
  return n;
}
// Unescape backslash + punctuation/symbol (marked's anyPunctuation).
const ANY_PUNCT_RE = /\\([\p{P}\p{S}])/gu;
function unescapePunct(s) {
  return s.replace(ANY_PUNCT_RE, '$1');
}
// Does the label contain a '<' starting a tag/autolink that extends
// past the end of the label? (marked's Be check.)
function labelHasTagBeyond(full, labelOff, label) {
  if (label.indexOf('<') < 0) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = CODE_RE.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const r = full.slice(labelOff + s);
    const o = TAG_RE.exec(r) || AUTOLINK_RE.exec(r);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}
// Does the (recursively parsed) label contain a link or image?
function labelHasLink(labelText, refs) {
  const nodes = parseInline(labelText, refs);
  const stack = nodes.slice();
  while (stack.length > 0) {
    const nd = stack.pop();
    if (nd.t === 'link') return true;
    if (nd.children) for (let i = 0; i < nd.children.length; i++) stack.push(nd.children[i]);
  }
  return false;
}

// Try to match a link (or image) starting at position `i` of `text`
// (text[i] is '[' or '!' followed by '['). Returns a node and the
// number of source characters consumed, or null.
function matchLink(text, i, refs) {
  const sub = text.slice(i);
  const isImage = sub[0] === '!';
  const labelOff = isImage ? 2 : 1;
  // inline link
  let m = LINK_RE.exec(sub);
  if (m) {
    const label = m[1];
    if (!labelHasTagBeyond(sub, labelOff, label)) {
      let href = m[2];
      let title = m[3] ? m[3].slice(1, -1) : '';
      let matchLen = m[0].length;
      let ok = true;
      const hrefTrim = href.trim();
      if (hrefTrim.charAt(0) === '<') {
        if (hrefTrim.charAt(hrefTrim.length - 1) !== '>') ok = false;
        else if (trailingBackslashes(hrefTrim.slice(0, -1)) % 2 === 1) ok = false;
        else href = hrefTrim.slice(1, -1);
      } else {
        const l = parenBalance(href);
        if (l === -2) ok = false;
        else if (l > -1) {
          const h = (isImage ? 5 : 4) + label.length + l;
          href = href.substring(0, l);
          matchLen = sub.slice(0, h).trim().length;
          title = '';
        }
      }
      if (ok) {
        const raw = sub.slice(0, matchLen);
        // the match must not end with an escaped ')'
        if (trailingBackslashes(raw.slice(0, -1)) % 2 === 1) ok = false;
      }
      if (ok) {
        href = href.trim();
        if (href.charAt(0) === '<') href = href.slice(1, -1);
        href = unescapePunct(href);
        title = unescapePunct(title);
        const labelText = label.replace(/\\([\[\]])/g, '$1');
        if (!isImage && labelHasLink(labelText, refs)) return null;
        const children = parseInline(labelText, refs, !isImage);
        if (isImage) {
          return { node: { t: 'img', src: href, title, alt: plainText(children) }, len: matchLen };
        }
        return { node: { t: 'link', href, title, children }, len: matchLen };
      }
    }
  }
  // full reference link
  m = REFLINK_RE.exec(sub);
  if (m) {
    const label = m[1];
    if (!labelHasTagBeyond(sub, labelOff, label)) {
      const ref = refs.get(normalizeLabel(m[2]));
      if (!ref) {
        // the text looks like a full reference link but the
        // reference is undefined: do not fall back to a shortcut
        // link at this position (the '[label]' is literal text)
        return null;
      }
      if (ref) {
        const labelText = label.replace(/\\([\[\]])/g, '$1');
        if (!isImage && labelHasLink(labelText, refs)) return null;
        const children = parseInline(labelText, refs, !isImage);
        const href = unescapePunct(ref.href);
        const title = ref.title === null || ref.title === undefined ? ref.title : unescapePunct(ref.title);
        if (isImage) {
          return { node: { t: 'img', src: href, title, alt: plainText(children) }, len: m[0].length };
        }
        return { node: { t: 'link', href, title, children }, len: m[0].length };
      }
    }
  }
  // collapsed / shortcut reference link
  m = NOLINK_RE.exec(sub);
  if (m) {
    const label = m[1];
    if (!labelHasTagBeyond(sub, labelOff, label)) {
      const ref = refs.get(normalizeLabel(label));
      if (ref) {
        const labelText = label.replace(/\\([\[\]])/g, '$1');
        if (!isImage && labelHasLink(labelText, refs)) return null;
        const children = parseInline(labelText, refs, !isImage);
        const href = unescapePunct(ref.href);
        const title = ref.title === null || ref.title === undefined ? ref.title : unescapePunct(ref.title);
        if (isImage) {
          return { node: { t: 'img', src: href, title, alt: plainText(children) }, len: m[0].length };
        }
        return { node: { t: 'link', href, title, children }, len: m[0].length };
      }
    }
  }
  return null;
}
// Plain-text rendering of inline nodes (for image alt text):
// formatting is stripped, entities stay verbatim.
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') out += nd.s;
    else if (nd.t === 'raw') out += nd.s;
    else if (nd.t === 'code') out += nd.s;
    else if (nd.t === 'br') out += '\n';
    else if (nd.t === 'delim') out += nd.ch.repeat(nd.rem);
    else if (nd.t === 'html') out += '';
    else if (nd.t === 'autolink') out += nd.text;
    else if (nd.t === 'img') out += nd.alt;
    else if (nd.children) out += plainText(nd.children);
  }
  return out;
}

// Match a GFM extended autolink at position `i` of `text`.
// `prev` is the character before position i ('' at the start).
// Returns a node and the number of source characters consumed, or null.
// Works on `text` directly with sticky regexes: no slice of the
// remaining source is allocated. `hasAt` is whether the text contains
// '@' at all: the mailto:/email branches cannot match without one.
function matchExtendedAutolink(text, i, prev, hasAt) {
  // mailto:/xmpp: + email : may start anywhere
  if (hasAt && (text.startsWith('mailto:', i) || text.startsWith('xmpp:', i))) {
    EMAIL_PROTO_RE_Y.lastIndex = i;
    const m = EMAIL_PROTO_RE_Y.exec(text);
    if (m) return { node: { t: 'autolink', href: m[0], text: m[0] }, len: m[0].length };
  }
  // www. : the preceding char must be start / whitespace / * _ ~ (
  if (text.startsWith('www.', i)) {
    if (prev === '' || isSpaceCh(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(') {
      WWW_URL_RE_Y.lastIndex = i;
      const m = WWW_URL_RE_Y.exec(text);
      if (m) return finishUrlAutolink(m[0], true);
    }
  }
  // scheme (http/https/ftp) : may start anywhere
  if ((text[i] === 'h' || text[i] === 'H' || text[i] === 'f' || text[i] === 'F') && hasSchemePrefix(text, i)) {
    SCHEME_URL_RE_Y.lastIndex = i;
    const m = SCHEME_URL_RE_Y.exec(text);
    if (m) return finishUrlAutolink(m[0], false);
  }
  // email : only at the start of a local-part run. The plain-email
  // local part is [A-Za-z0-9._+-]+, so only those chars block a start
  // (e.g. '*' does NOT block: '**a@b.com' links, marked).
  if (hasAt && (prev === '' || !(isAlnum(prev) || prev === '.' || prev === '_' || prev === '+' || prev === '-'))) {
    PLAIN_EMAIL_RE_Y.lastIndex = i;
    const m = PLAIN_EMAIL_RE_Y.exec(text);
    if (m) {
      return { node: { t: 'autolink', href: 'mailto:' + m[0], text: m[0] }, len: m[0].length };
    }
  }
  return null;
}
// Apply marked's backpedal trimming to a www/scheme autolink match.
function finishUrlAutolink(raw, isWww) {
  let url = raw;
  let prev;
  do {
    prev = url;
    const m = BACKPEDAL_RE.exec(url);
    url = m ? m[0] : '';
  } while (url !== prev);
  if (url.length === 0) return null;
  return {
    node: { t: 'autolink', href: isWww ? 'http://' + url : url, text: url },
    len: url.length,
  };
}

// ---- the inline scanner ----
const LOCAL_PART_CHARS = /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]/;
const SCHEME_PREFIX_RE = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//;
const NAMED_ENTITY_RE = /^&([A-Za-z0-9_]+);/;
const NUMERIC_ENTITY_RE = /^&#[Xx]([A-Fa-f0-9]{1,6});|^&#([0-9]{1,7});/;

// Sticky copies of the anchored inline regexes, for matching at an
// offset without slicing the source string first. (The `^` anchors
// are stripped: with `y` they would only match at position 0.)
function stickyOf(re) {
  return new RegExp(re.source.replace(/(^|\|)\^/g, '$1'), 'y');
}
const CODE_RE_Y = stickyOf(CODE_RE);
const BACKSLASH_ESCAPE_RE_Y = stickyOf(BACKSLASH_ESCAPE_RE);
const AUTOLINK_RE_Y = stickyOf(AUTOLINK_RE);
const TAG_RE_Y = stickyOf(TAG_RE);
const NAMED_ENTITY_RE_Y = stickyOf(NAMED_ENTITY_RE);
const NUMERIC_ENTITY_RE_Y = stickyOf(NUMERIC_ENTITY_RE);
const EMAIL_PROTO_RE_Y = stickyOf(EMAIL_PROTO_RE);
const WWW_URL_RE_Y = stickyOf(WWW_URL_RE);
const SCHEME_URL_RE_Y = stickyOf(SCHEME_URL_RE);
const PLAIN_EMAIL_RE_Y = stickyOf(PLAIN_EMAIL_RE);

function parseInline(text, refs, inLink) {
  const nodes = [];
  const n = text.length;
  const hasAt = text.indexOf('@') >= 0;
  let i = 0;
  let buf = '';
  function flush() {
    if (buf !== '') { nodes.push({ t: 'text', s: buf }); buf = ''; }
  }
  function pushText(s) { buf += s; }
  // Is position j the start of a hard break (2+ spaces or a backslash
  // before a newline, with non-whitespace after the newline)?
  function hardBreakAt(j) {
    if (text[j] === ' ') {
      let k = j;
      while (k < n && text[k] === ' ') k++;
      if (k - j < 2 || text[k] !== '\n') return 0;
      let m = k + 1;
      while (m < n && (text[m] === ' ' || text[m] === '\t')) m++;
      if (m >= n) return 0;
      return m; // index just past the newline + following spaces/tabs
    }
    return 0;
  }
  // End of the plain-text run starting at i (stops at a special char,
  // a hard break, or an autolink start).
  function textRunEnd(start) {
    let j = start;
    while (j < n) {
      const c = text[j];
      if (c === '\\' || c === '`' || c === '[' || c === '<' || c === '*' || c === '_' || c === '~' || c === '&' || c === '\n') break;
      if (c === '!') {
        if (text[j + 1] === '[') break;
        j++;
        continue;
      }
      if (c === ' ') {
        if (hardBreakAt(j) > 0) break;
        j++;
        continue;
      }
      if (c === 'w' && text.startsWith('www.', j)) {
        const p = j > 0 ? text[j - 1] : '';
        if (p === '' || isSpaceCh(p) || p === '*' || p === '_' || p === '~' || p === '(') break;
        j++;
        continue;
      }
      if ((c === 'h' || c === 'H' || c === 'f' || c === 'F') && hasSchemePrefix(text, j)) break;
      if (isLocalPartCh(c)) {
        const p = j > 0 ? text[j - 1] : '';
        if (p === '' || !isLocalPartCh(p)) {
          LOCAL_PART_RE.lastIndex = j;
          if (LOCAL_PART_RE.test(text)) break;
        }
      }
      j++;
    }
    return j;
  }

  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === '\n') {
        // backslash hard break (only when more text follows)
        let m = i + 2;
        while (m < n && (text[m] === ' ' || text[m] === '\t')) m++;
        if (m < n) {
          flush();
          nodes.push({ t: 'br' });
          i = m;
          continue;
        }
        pushText('\\');
        i++;
        continue;
      }
      BACKSLASH_ESCAPE_RE_Y.lastIndex = i;
      const m = BACKSLASH_ESCAPE_RE_Y.exec(text);
      if (m) {
        pushText(m[1]);
        i += 2;
        continue;
      }
      pushText('\\');
      i++;
      continue;
    }
    if (c === ' ') {
      const hb = hardBreakAt(i);
      if (hb > 0) {
        flush();
        nodes.push({ t: 'br' });
        i = hb;
        continue;
      }
      const end = textRunEnd(i);
      pushText(text.slice(i, end));
      i = end;
      continue;
    }
    if (c === '`') {
      CODE_RE_Y.lastIndex = i;
      const m = CODE_RE_Y.exec(text);
      if (m) {
        flush();
        let content = m[2].replace(/\n/g, ' ');
        if (content.trim() !== '' && content.charAt(0) === ' ' && content.charAt(content.length - 1) === ' ') {
          content = content.slice(1, -1);
        }
        nodes.push({ t: 'code', s: content });
        i += m[0].length;
        continue;
      }
      // unmatched backticks are literal text
      let j = i;
      while (j < n && text[j] === '`') j++;
      pushText(text.slice(i, j));
      i = j;
      continue;
    }
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      // inside a link, a nested link is suppressed but an image is
      // still formed
      const res = (inLink && c === '[') ? null : matchLink(text, i, refs);
      if (res) {
        flush();
        nodes.push(res.node);
        i += res.len;
        continue;
      }
      pushText(c === '!' ? '![' : '[');
      i += c === '!' ? 2 : 1;
      continue;
    }
    if (c === '<') {
      // Angle-bracket autolinks ARE formed inside a link's text
      // (marked nests them); only [...] links and extended autolinks
      // are suppressed there. So no inLink check here.
      AUTOLINK_RE_Y.lastIndex = i;
      const am = AUTOLINK_RE_Y.exec(text);
      if (am) {
        flush();
        const inner = am[1];
        const isEmail = inner.indexOf(':') < 0;
        nodes.push({
          t: 'autolink',
          href: isEmail ? 'mailto:' + inner : inner,
          text: inner,
        });
        i += am[0].length;
        continue;
      }
      TAG_RE_Y.lastIndex = i;
      const tm = TAG_RE_Y.exec(text);
      if (tm) {
        // A block-level HTML tag (types 1-6: script/pre/style/textarea,
        // comment, PI, declaration, CDATA, block tags) appearing inline
        // in a paragraph drops a single preceding soft-break newline;
        // an inline tag (type 7, e.g. <b>) keeps it.
        const ht0 = htmlBlockType(tm[0]);
        if (buf.endsWith('\n')) {
          if (ht0 >= 1 && ht0 <= 6) buf = buf.slice(0, -1);
        }
        flush();
        nodes.push({ t: 'html', s: tm[0] });
        // marked quirk: an <a> opening tag parsed as inline HTML (i.e. in
        // a paragraph, not an HTML block) sets a document-level state that
        // suppresses extended autolinks for the rest of the document until
        // a </a> clears it. A bare <a> alone as an HTML block does not
        // reach here (HTML blocks are raw), and a closed <a>...</a> clears
        // it in the same inline pass.
        if (/^<\/a[\s>]/i.test(tm[0])) refs._suppressExt = false;
        else if (/^<a[\s\/>]/i.test(tm[0]) && tm[0].toLowerCase() !== '<a/>') refs._suppressExt = true;
        i += tm[0].length;
        // A block-level HTML tag at the start of a paragraph line makes
        // the rest of that line raw text: no links, autolinks, emphasis
        // or code spans are formed in it (marked). Only the rest of the
        // same line is raw; the next line parses normally (an unclosed
        // tag such as <div> is a separate, rarer case).
        if (ht0 >= 1 && ht0 <= 6 && (i - tm[0].length === 0 || text[i - tm[0].length - 1] === '\n')) {
          let eol = text.indexOf('\n', i);
          if (eol < 0) eol = n;
          if (eol > i) { pushText(text.slice(i, eol)); i = eol; }
        }
        continue;
      }
      pushText('<');
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && text[j] === c) j++;
      const len = j - i;
      // The emphasis scanner works on run positions in the source
      // (pos/len/after); canOpen/canClose are recomputed from the
      // masked string by processEmphasis.
      flush();
      nodes.push({ t: 'delim', ch: c, pos: i, len, rem: len, before: i > 0 ? text[i - 1] : '', after: j < n ? text[j] : '', masked: false });
      i = j;
      continue;
    }
    if (c === '&') {
      NAMED_ENTITY_RE_Y.lastIndex = i;
      const nm = NAMED_ENTITY_RE_Y.exec(text);
      if (nm) {
        flush();
        nodes.push({ t: 'raw', s: nm[0] });
        i += nm[0].length;
        continue;
      }
      NUMERIC_ENTITY_RE_Y.lastIndex = i;
      const dm = NUMERIC_ENTITY_RE_Y.exec(text);
      if (dm) {
        flush();
        const cp = dm[1] !== undefined ? parseInt(dm[1], 16) : parseInt(dm[2], 10);
        let ch;
        if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) ch = '\uFFFD';
        else ch = String.fromCodePoint(cp);
        nodes.push({ t: 'text', s: ch });
        i += dm[0].length;
        continue;
      }
      pushText('&');
      i++;
      continue;
    }
    if (c === '\n') {
      pushText('\n');
      i++;
      continue;
    }
    // www. / scheme / email autolink starts, and plain text
    const prev = i > 0 ? text[i - 1] : '';
    const cc = c.charCodeAt(0);
    const auto = (inLink || refs._suppressExt || cc >= 128 || AUTO_START_TABLE[cc] === 0)
      ? null : matchExtendedAutolink(text, i, prev, hasAt);
    if (auto) {
      flush();
      nodes.push(auto.node);
      i += auto.len;
      continue;
    }
    const end = textRunEnd(i);
    if (end > i) {
      pushText(text.slice(i, end));
      i = end;
    } else {
      pushText(c);
      i++;
    }
  }
  flush();
  let hasDelim = false;
  for (const nd of nodes) if (nd.t === 'delim') { hasDelim = true; break; }
  if (!hasDelim) return nodes;
  const { masked, spans } = computeMask(text, refs);
  return processEmphasis(nodes, text, masked, spans, refs, inLink);
}

// ---- marked 18.1.3 emphasis masking (Lexer #maskSrc) ----
// The mask hides link / code-span / html delimiters from the emphasis
// scan. Every replacement preserves length, so masked positions line
// up with the source text.
const MASK_OT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCKSKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const MASK_REFLINK_SEARCH_RE = /!?\[((?:[^[\]\\`]*(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;

// Does the label text contain a link or image? (marked's linkInText.)
function maskLinkInText(e, refs) {
  if (!e.includes('[')) return false;
  // Fresh regex instances: this function recurses, so a shared
  // global regex would have its lastIndex clobbered mid-loop.
  const reSkip = new RegExp(MASK_BLOCKSKIP_RE.source, 'g');
  const reRef = new RegExp(MASK_REFLINK_SEARCH_RE.source, 'g');
  let n;
  while ((n = reSkip.exec(e)) !== null) {
    if (LINK_RE.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  while ((n = reRef.exec(e)) !== null) {
    const s = n[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !refs.has(normalizeLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && maskLinkInText(s.slice(1, r - 1), refs))) return true;
  }
  return false;
}

// Mask reference links in `s` (defined references only). Returns the
// masked string and the [start, end) spans that were hidden, in
// coordinates relative to `base`.
function maskReflinkStr(s, refs, base) {
  let out = '';
  let last = 0;
  const spans = [];
  const reRef = new RegExp(MASK_REFLINK_SEARCH_RE.source, 'g');
  let m;
  while ((m = reRef.exec(s)) !== null) {
    const m0 = m[0];
    const ms = m.index, me = ms + m0.length;
    const refStart = m0.lastIndexOf('[');
    if (!refs.has(normalizeLabel(m0.slice(refStart + 1, -1)))) {
      out += s.slice(last, me);
      last = me;
      continue;
    }
    out += s.slice(last, ms);
    if (refStart > 1 && m0.charAt(0) !== '!') {
      const text = m0.slice(1, refStart - 1);
      if (maskLinkInText(text, refs)) {
        const rec = maskReflinkStr(text, refs, base + ms + 1);
        out += '[' + rec.out + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        for (const sp of rec.spans) spans.push(sp);
        spans.push([base + ms + refStart + 1, base + me - 1]);
        last = me;
        continue;
      }
    }
    out += '[' + 'a'.repeat(m0.length - 2) + ']';
    spans.push([base + ms + 1, base + me - 1]);
    last = me;
  }
  out += s.slice(last);
  return { out, spans };
}

// Compute marked's masked source for `src` and the hidden spans.
// Each masking step only runs when the source can actually contain
// what it masks: the reflink step needs a '[' and a defined reference,
// the code/escape step needs a backtick or backslash, and the
// inline-link/code/tag step needs a '[', backtick or '<'. Plain
// emphasis-only text skips all three.
function computeMask(src, refs) {
  let masked = src;
  const spans = [];
  if (refs.size > 0 && src.includes('[')) {
    const res = maskReflinkStr(masked, refs, 0);
    masked = res.out;
    for (const s of res.spans) spans.push(s);
  }
  if (masked.includes('`') || masked.includes('\\')) {
    masked = masked.replace(MASK_OT_RE, (m0, code, punct) => {
      if (punct) return '+'.repeat(m0.length);
      if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return m0;
    });
  }
  if (masked.includes('[') || masked.includes('`') || masked.includes('<')) {
    let out = '';
    let last = 0;
    const reSkip = new RegExp(MASK_BLOCKSKIP_RE.source, 'g');
    let m;
    while ((m = reSkip.exec(masked)) !== null) {
      out += masked.slice(last, m.index);
      out += '[' + 'a'.repeat(m[0].length - 2) + ']';
      spans.push([m.index, m.index + m[0].length]);
      last = m.index + m[0].length;
    }
    out += masked.slice(last);
    masked = out;
  }
  return { masked, spans };
}

function isPunctSpaceCh(c) { return c !== '' && (isSpaceCh(c) || isPunctCh(c)); }
function isPunctGfm(c) { return c !== '~' && isPunctCh(c); }

// Character class of the masked string at index i ('ws' at the edges),
// following marked's RDelim groups. GFM treats `~` as a letter for `*`.
function maskedClassAt(masked, i, gfm) {
  if (i < 0 || i >= masked.length) return 'ws';
  const c = masked[i];
  if (isSpaceCh(c)) return 'ws';
  if (gfm ? isPunctGfm(c) : isPunctCh(c)) return 'punct';
  return 'letter';
}

// Classify a delimiter run in the masked string (marked's
// emStrongRDelim / delRDelim groups): 'left' (open only), 'right'
// (close only), 'either' (both), 'neither'.
function classifyRun(masked, pos, rem, ch) {
  const gfm = ch === '*';
  const b = maskedClassAt(masked, pos - 1, gfm);
  const a = maskedClassAt(masked, pos + rem, gfm);
  if (b === 'punct') {
    if (a === 'ws') return 'right';
    if (a === 'punct') return 'either';
    return 'left';
  }
  if (b === 'ws') {
    if (a === 'ws') return 'neither';
    return 'left';
  }
  if (a === 'letter') return ch === '_' ? 'neither' : 'either';
  return 'right';
}

// marked's emStrongRDelim "skip orphan inside strong" alternative: at
// the start of the window, `__...*...__` (for a `*` opener) or
// `**..._...**` (for a `_` opener) hides the orphan delimiter.
function isOrphanCloser(arr, oi, xi, ch) {
  const strongCh = ch === '*' ? '_' : '*';
  let seenStrong = false;
  for (let k = oi + 1; k < xi; k++) {
    const nd = arr[k];
    if (nd.t === 'delim' && !nd.masked && nd.rem > 0) {
      if (nd.ch === strongCh && nd.rem >= 2 && !seenStrong) { seenStrong = true; continue; }
      return false;
    }
  }
  if (!seenStrong) return false;
  for (let k = xi + 1; k < arr.length; k++) {
    const nd = arr[k];
    if (nd.t === 'delim' && !nd.masked && nd.rem > 0) {
      return nd.ch === strongCh && nd.rem >= 2;
    }
  }
  return false;
}

// Try to match the opener at index oi (marked's Tokenizer emStrong).
// Returns {ci, rLength, use, kind} or null.
function tryMatchEmStrong(arr, oi, text, masked) {
  const O = arr[oi];
  const ch = O.ch;
  const afterSrc = O.after;
  // The LDelim must be followed by a non-space character.
  if (afterSrc === '' || isSpaceCh(afterSrc)) return null;
  const origStart = O.pos - (O.len - O.rem);
  const runPrevChar = origStart > 0 ? masked[origStart - 1] : '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || isPunctSpaceCh(runPrevChar);
  const midRun = (O.pos > 0 ? text[O.pos - 1] : '') === ch;
  const prevChar = O.rem < O.len ? runPrevChar : (O.pos > 0 ? text[O.pos - 1] : '');
  const prevPunct = O.rem < O.len ? runPrevPunct
    : (prevChar !== '' && prevChar !== '*' && prevChar !== '_' && isPunctSpaceCh(prevChar));
  // `_` between alphanumerics cannot open.
  if (ch === '_' && prevChar !== '' && isLetterOrDigit(prevChar)) return null;
  const nextChar = isPunctGfm(afterSrc) ? afterSrc : '';
  if (nextChar !== '' && prevChar !== '' && !prevPunct) return null;
  const openerCanClose = runPrevChar.trim() !== '' &&
    (nextChar !== '' || (ch === '*' && !runPrevPunct));
  const runLength = O.len;
  let delimTotal = O.rem;
  let midDelimTotal = 0;
  let checkedOrphan = false;
  for (let xi = oi + 1; xi < arr.length; xi++) {
    const X = arr[xi];
    if (X.t !== 'delim' || X.ch !== ch || X.rem <= 0 || X.masked) continue;
    // A run adjacent to the opener sits at window index 0 and is
    // invisible to the RDelim scan; it also ends the orphan window.
    if (X.pos === O.pos + O.rem) { checkedOrphan = true; continue; }
    if (!checkedOrphan) {
      checkedOrphan = true;
      if (isOrphanCloser(arr, oi, xi, ch)) continue;
    }
    const cls = classifyRun(masked, X.pos, X.rem, ch);
    if (cls === 'neither') continue;
    if (cls === 'left') { delimTotal += X.rem; continue; }
    if (cls === 'either' || openerCanClose) {
      if (midRun && cls === 'either') return null;
      if (runLength % 3 !== 0 && (runLength + X.rem) % 3 === 0) { midDelimTotal += X.rem; continue; }
    }
    delimTotal -= X.rem;
    if (delimTotal > 0) continue;
    const rLength = Math.min(X.rem, X.rem + delimTotal + midDelimTotal);
    const use = Math.min(O.rem, rLength) % 2 === 1 ? 1 : 2;
    return { ci: xi, rLength, use, kind: use === 2 ? 'strong' : 'em' };
  }
  return null;
}

// Try to match the `~` opener at index oi (marked's Tokenizer del).
// Returns {ci, rLength, use, kind} or null.
function tryMatchDel(arr, oi, text, masked) {
  const O = arr[oi];
  if (O.rem > 2) return null; // delLDelim matches at most `~~`
  const afterSrc = O.after;
  if (afterSrc === '' || isSpaceCh(afterSrc)) return null;
  const prevChar = O.pos > 0 ? text[O.pos - 1] : '';
  const afterPunct = isPunctCh(afterSrc);
  const prevPunct = prevChar !== '' && prevChar !== '*' && prevChar !== '_' && isPunctSpaceCh(prevChar);
  if (afterPunct && prevChar !== '' && !prevPunct) return null;
  const o = O.rem;
  let p = o;
  for (let xi = oi + 1; xi < arr.length; xi++) {
    const X = arr[xi];
    if (X.t !== 'delim' || X.ch !== '~' || X.rem <= 0 || X.masked) continue;
    if (X.pos === O.pos + O.rem) continue;
    if (X.rem !== o) continue; // del closers must match the opener's length
    const cls = classifyRun(masked, X.pos, X.rem, '~');
    if (cls === 'neither') continue;
    if (cls === 'left') { p += X.rem; continue; }
    p -= X.rem;
    if (p > 0) continue;
    return { ci: xi, rLength: X.rem, use: o, kind: 'del' };
  }
  return null;
}

// ---- emphasis / strong / strikethrough (marked 18.1.3 emStrong/del) ----
// Opener-driven, like marked: each opener scans forward in the masked
// string for its closer; the inner text is re-parsed from scratch
// (which is why an email at the end of an emphasis span links fully).
function processEmphasis(nodes, text, masked, spans, refs, inLink) {
  const arr = nodes.slice();
  if (spans.length > 0) {
    for (const nd of arr) {
      if (nd.t !== 'delim') continue;
      for (let s = 0; s < spans.length; s++) {
        if (nd.pos >= spans[s][0] && nd.pos < spans[s][1]) { nd.masked = true; break; }
      }
    }
  }
  let i = 0;
  while (i < arr.length) {
    const O = arr[i];
    if (O.t !== 'delim' || O.rem <= 0 || O.masked) { i++; continue; }
    const res = O.ch === '~' ? tryMatchDel(arr, i, text, masked) : tryMatchEmStrong(arr, i, text, masked);
    if (!res) {
      // No match: emit one delimiter char as text and retry the rest
      // of the run (marked's scanner advances one char, mid-run).
      if (O.rem > 1) {
        O.pos += 1;
        O.rem -= 1;
        arr.splice(i, 0, { t: 'text', s: O.ch });
        i++;
        continue;
      }
      i++;
      continue;
    }
    const D = arr[res.ci];
    const innerText = text.slice(O.pos + res.use, D.pos + res.rLength - res.use);
    const children = parseInline(innerText, refs, inLink);
    const span = { t: res.kind, children };
    D.rem -= res.rLength;
    D.pos += res.rLength;
    arr.splice(i, res.ci - i + 1, span, ...(D.rem > 0 ? [D] : []));
    i = i + 1; // continue at the leftover closer, if any
  }
  return arr.map((nd) => (nd.t === 'delim' ? { t: 'text', s: nd.ch.repeat(nd.rem) } : nd));
}

// ---- rendering ----
function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') out += escapeHtml(nd.s);
    else if (nd.t === 'raw') out += nd.s;
    else if (nd.t === 'code') out += '<code>' + escapeHtml(nd.s) + '</code>';
    else if (nd.t === 'br') out += '<br>';
    else if (nd.t === 'delim') out += nd.ch.repeat(nd.rem);
    else if (nd.t === 'html') out += nd.s;
    else if (nd.t === 'autolink') {
      out += '<a href="' + escapeAttr(cleanUrl(nd.href)) + '">' + escapeHtml(nd.text) + '</a>';
    } else if (nd.t === 'link') {
      out += '<a href="' + escapeAttr(cleanUrl(nd.href)) + '"' +
        (nd.title ? ' title="' + escapeAttr(nd.title) + '"' : '') + '>' +
        renderInline(nd.children) + '</a>';
    } else if (nd.t === 'img') {
      out += '<img src="' + escapeAttr(cleanUrl(nd.src)) + '" alt="' + escapeAttr(nd.alt) + '"' +
        (nd.title ? ' title="' + escapeAttr(nd.title) + '"' : '') + '>';
    } else if (nd.t === 'em') out += '<em>' + renderInline(nd.children) + '</em>';
    else if (nd.t === 'strong') out += '<strong>' + renderInline(nd.children) + '</strong>';
    else if (nd.t === 'del') out += '<del>' + renderInline(nd.children) + '</del>';
  }
  return out;
}

// The task-list checkbox of a list item's first paragraph, if any.
// Returns {checked, rest} where rest is the paragraph text after the
// checkbox prefix, or null.
function taskPrefix(lines) {
  if (!lines || lines.length === 0) return null;
  const first = lines[0];
  const m = /^\[([ xX])\][ \t]+\S/.exec(first);
  if (!m) return null;
  return {
    checked: m[1] === 'x' || m[1] === 'X',
    rest: first.slice(m[0].length - 1),
  };
}

function renderBlock(node, refs, looseList) {
  switch (node.t) {
    case 'doc': {
      let out = '';
      for (const ch of node.children) out += renderBlock(ch, refs, false);
      return out;
    }
    case 'para': {
      return '<p>' + renderInline(parseInline(node.lines.join('\n'), refs)) + '</p>\n';
    }
    case 'heading': {
      const text = node.lines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      return '<h' + node.level + '>' + renderInline(parseInline(text, refs)) + '</h' + node.level + '>\n';
    }
    case 'code':
    case 'fence': {
      const text = node.lines.join('\n');
      let out = '<pre><code';
      if (node.t === 'fence') {
        const lang = fenceLanguage(node.info);
        if (lang !== '') out += ' class="language-' + escapeAttr(lang) + '"';
      }
      out += '>' + escapeHtml(text) +
        (text !== '' && !text.endsWith('\n') ? '\n' : '') + '</code></pre>\n';
      return out;
    }
    case 'html': {
      return node.lines.join('\n') + (node.trailingNl ? '\n' : '');
    }
    case 'hr': {
      return '<hr>\n';
    }
    case 'quote': {
      let out = '<blockquote>\n';
      for (const ch of node.children) out += renderBlock(ch, refs, false);
      return out + '</blockquote>\n';
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      let out = '<' + tag;
      if (node.ordered && node.start !== null && node.start !== 1) out += ' start="' + node.start + '"';
      out += '>\n';
      for (const item of node.children) out += renderBlock(item, refs, node.loose);
      return out + '</' + tag + '>\n';
    }
    case 'item': {
      let out = '<li>';
      for (let ci = 0; ci < node.children.length; ci++) {
        const ch = node.children[ci];
        if (ch.t === 'para') {
          if (ci === 0) {
            // task list checkbox
            const tp = taskPrefix(ch.lines);
            if (tp) {
              const restLines = [tp.rest].concat(ch.lines.slice(1));
              const inner = renderInline(parseInline(restLines.join('\n'), refs));
              const box = tp.checked
                ? '<input checked="" disabled="" type="checkbox">'
                : '<input disabled="" type="checkbox">';
              if (looseList) out += '<p>' + box + ' ' + inner + '</p>\n';
              else out += box + ' ' + inner;
              continue;
            }
          }
          if (looseList) {
            out += '<p>' + renderInline(parseInline(ch.lines.join('\n'), refs)) + '</p>\n';
          } else {
            out += renderInline(parseInline(ch.lines.join('\n'), refs));
          }
        } else {
          out += renderBlock(ch, refs, false);
        }
      }
      return out + '</li>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < node.header.length; c++) {
        const a = node.align[c];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' +
          renderInline(parseInline(node.header[c], refs)) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let c = 0; c < row.length; c++) {
            const a = node.align[c];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' +
              renderInline(parseInline(row[c], refs)) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}

// The public entry point: markdown string -> HTML string.
export function parse(src) {
  if (src === '') return '';
  const normalized = src.indexOf('\r') < 0 ? src : src.replace(/\r\n|\r/g, '\n');
  const { doc, refs } = parseBlocks(normalized);
  return renderBlock(doc, refs, false);
}
