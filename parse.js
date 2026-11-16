// fleetmark — an original, dependency-free Markdown renderer whose parse()
// returns the same HTML as marked 18.1.3 with default options (GFM on),
// written from scratch for speed: a line-oriented block lexer feeding a
// single-pass inline parser built on the CommonMark delimiter algorithm.

// ---------------------------------------------------------------- utilities

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_ENCODE = /[&<>"']/g;
const ESC_NOENCODE = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Escape HTML text. With encode, every & is escaped; without, existing
 *  entity-looking &...; sequences are left untouched (marked's behaviour). */
function escapeHtml(s, encode) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  return encode ? s.replace(ESC_ENCODE, ch => ESCAPES[ch]) : s.replace(ESC_NOENCODE, ch => ESCAPES[ch]);
}

const BACKSLASH_ESCAPABLE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;
function unescapeStr(s) {
  return s.indexOf('\\') < 0 ? s : s.replace(BACKSLASH_ESCAPABLE, '$1');
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

/** marked drops links to scriptable / non-image data URLs entirely. */
function sanitizeUrl(href, isImage) {
  const t = href.replace(/^[\s\x00-\x20]+/, '').toLowerCase();
  if (t.startsWith('javascript:') || t.startsWith('vbscript:')) return null;
  if (t.startsWith('data:')) {
    if (isImage && /^data:image\/(?:png|gif|jpeg|webp);/.test(t)) return href;
    return null;
  }
  return href;
}

function decodeNumericRef(cp) {
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '�';
  return String.fromCodePoint(cp);
}

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
function isPunctChar(ch) {
  return ch !== undefined && (ASCII_PUNCT.has(ch) || UNICODE_PUNCT.test(ch));
}
function isAsciiPunct(ch) {
  return ch !== undefined && ASCII_PUNCT.has(ch);
}
function isSpaceChar(ch) {
  return ch === undefined || /\s/.test(ch);
}

// ------------------------------------------------------- line/column helpers

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

/** Width in columns of the leading whitespace run (tab = to next multiple of 4). */
function indentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** The substring of `line` starting at visual column `target`; a tab that
 *  straddles the target is replaced by the spaces past it. */
/** Remove up to `target` columns of leading indentation, keeping the rest
 *  of the line byte-for-byte (a straddling tab leaves spaces behind). Used
 *  for literal content: code blocks and fence bodies. */
function sliceCol(line, target) {
  // consume characters whose starting column is before the target; a
  // tab that starts before the target is consumed whole
  let col = 0, i = 0;
  while (i < line.length && col < target) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return line.slice(i);
}

/** Like sliceCol, but the result is re-lexed as block content, so the
 *  leading whitespace is expanded to spaces on the original column grid:
 *  tabs keep the width they had before the slice. */
function sliceColX(line, target) {
  let col = 0, i = 0;
  while (i < line.length && col < target) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const step = 4 - (col % 4);
      if (col + step > target) {
        return ' '.repeat(col + step - target) + expandPrefix(line.slice(i + 1), col + step);
      }
      col += step; i++;
    } else break;
  }
  return expandPrefix(line.slice(i), col);
}

/** Expand the leading spaces/tabs of str into spaces, assuming str[0] sits
 *  at column startCol: tabs keep the width they had on the original grid. */
function expandPrefix(str, startCol) {
  let col = startCol;
  let out = '';
  let i = 0;
  while (i < str.length && (str[i] === ' ' || str[i] === '\t')) {
    if (str[i] === ' ') { out += ' '; col++; }
    else { const step = 4 - (col % 4); out += ' '.repeat(step); col += step; }
    i++;
  }
  return out + str.slice(i);
}

/** Consume up to maxCol columns of leading whitespace; returns [pos, col]. */
function scanIndent(line, maxCol) {
  let pos = 0, col = 0;
  while (pos < line.length) {
    const c = line[pos];
    if (c === ' ') { if (col + 1 > maxCol) break; col++; pos++; } else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w > maxCol) break;
      col += w; pos++;
    } else break;
  }
  return [pos, col];
}

// ------------------------------------------------------------------- inline
//
// Node kinds:
//   t    {s}                 raw text (escaped at render, entities preserved)
//   code {s}                 code span content
//   html {s}                 raw inline HTML, emitted as-is
//   br                       hard line break
//   delim {ch, len, canOpen, canClose}
//   open {img}               unmatched [ or ![ (renders literally)
//   em / strong / del {kids}
//   link {href, title, kids}
//   img  {src, title, kids}  (kids used for the alt text)

function normalizeLabel(raw) {
  // labels match literally (escapes are not resolved), with whitespace
  // collapsed and full Unicode case folding (ß folds to ss)
  return raw.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

/** Skip spaces/tabs/newlines in inline-link syntax; -1 if a blank line or EOF
 *  makes the construct invalid. Returns the new index. */
function skipLinkWs(s, i) {
  let sawNl = false;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') i++;
    else if (c === '\n') {
      if (sawNl) return -1;
      sawNl = true; i++;
      // a second newline after optional spaces is a blank line
      let j = i;
      while (s[j] === ' ' || s[j] === '\t') j++;
      if (s[j] === '\n') return -1;
    } else break;
  }
  return i;
}

/** Parse "(destination title)" starting just after the '('. */
function parseLinkParens(s, i) {
  i = skipLinkWs(s, i);
  if (i < 0) return null;
  if (s[i] === ')') return { dest: '', title: null, end: i + 1 };
  let dest;
  if (s[i] === '<') {
    let j = i + 1;
    while (j < s.length && s[j] !== '>' && s[j] !== '\n') {
      if (s[j] === '\\') j++;
      j++;
    }
    if (s[j] !== '>') return null;
    dest = unescapeStr(s.slice(i + 1, j));
    i = j + 1;
  } else {
    let depth = 0;
    const start = i;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && isAsciiPunct(s[i + 1])) { i += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (c === ' ' || c === '\t' || c === '\n' || c < ' ') break;
      i++;
    }
    dest = unescapeStr(s.slice(start, i));
  }
  const afterDest = i;
  i = skipLinkWs(s, i);
  if (i < 0) return null;
  let title = null;
  const q = s[i];
  if (i > afterDest && (q === '"' || q === "'" || q === '(')) {
    const close = q === '(' ? ')' : q;
    let j = i + 1;
    let ok = false;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\' && isAsciiPunct(s[j + 1])) { j += 2; continue; }
      if (c === close) { ok = true; break; }
      if (q === '(' && c === '(') return null;
      j++;
    }
    if (!ok) return null;
    title = unescapeStr(s.slice(i + 1, j));
    i = skipLinkWs(s, j + 1);
    if (i < 0) return null;
  } else {
    i = afterDest;
    i = skipLinkWs(s, i);
    if (i < 0) return null;
  }
  if (s[i] !== ')') return null;
  return { dest, title, end: i + 1 };
}

/** Parse a reference label starting at s[i] === '['. */
function parseRefLabel(s, i) {
  let j = i + 1;
  while (j < s.length && j - i <= 1000) {
    const c = s[j];
    if (c === '\\' && isAsciiPunct(s[j + 1])) { j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') return { text: s.slice(i + 1, j), end: j + 1 };
    j++;
  }
  return null;
}

const TAG_NAME = '[A-Za-z][A-Za-z0-9-]*';
const ATTR = "\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s\"'=<>`]+|'[^']*'|\"[^\"]*\"))?";
const OPEN_TAG_RE = new RegExp('^<' + TAG_NAME + '(?:' + ATTR + ')*\\s*\\/?>');
const CLOSE_TAG_RE = new RegExp('^</' + TAG_NAME + '\\s*>');
const AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/;
const EMAIL_AUTOLINK_RE = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)>/;

/** Try to match raw inline HTML (tag, comment, PI, declaration, CDATA) at i. */
function matchRawHtml(s, i) {
  const rest = s.slice(i);
  if (rest.startsWith('<!--')) {
    if (rest.startsWith('<!-->')) return '<!-->';
    if (rest.startsWith('<!--->')) return '<!--->';
    const end = rest.indexOf('-->', 4);
    if (end < 0) return null;
    return rest.slice(0, end + 3);
  }
  if (rest.startsWith('<?')) {
    const end = rest.indexOf('?>', 2);
    return end < 0 ? null : rest.slice(0, end + 2);
  }
  if (rest.startsWith('<![CDATA[')) {
    const end = rest.indexOf(']]>', 9);
    return end < 0 ? null : rest.slice(0, end + 3);
  }
  if (/^<![A-Z]/.test(rest)) {
    const end = rest.indexOf('>', 2);
    return end < 0 ? null : rest.slice(0, end + 1);
  }
  let m = OPEN_TAG_RE.exec(rest);
  if (m) return m[0];
  m = CLOSE_TAG_RE.exec(rest);
  if (m) return m[0];
  return null;
}

// --- GFM autolink literals (www., http(s)://, emails, mailto:/xmpp: emails)

const LOCAL_PART = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-");

function trimAutolink(raw) {
  let s = raw;
  for (;;) {
    const before = s;
    s = s.replace(/[?!.,:*_~'"]+$/, '');
    if (s.endsWith(';')) {
      const m = /&[A-Za-z0-9]+;$/.exec(s);
      s = m ? s.slice(0, s.length - m[0].length) : s.slice(0, -1);
    }
    // a trailing ')' is dropped only when it has no matching '('
    while (s.endsWith(')')) {
      let depth = 0;
      let matched = false;
      for (let k = 0; k < s.length - 1; k++) {
        if (s[k] === '(') depth++;
        else if (s[k] === ')') { if (depth > 0) depth--; }
      }
      matched = depth > 0;
      if (matched) break;
      s = s.slice(0, -1);
    }
    if (s === before) return s;
  }
}

/** Parse an email address at i (no prefix). Returns end index or -1. */
function parseEmailAt(s, i, delims) {
  let j = i;
  while (j < s.length && LOCAL_PART.has(s[j])) j++;
  if (j === i || s[j] !== '@') return -1;
  j++;
  let labels = 0;
  for (;;) {
    // one domain label: alnum, then alnum/hyphen, not ending in hyphen
    if (j >= s.length || !/[A-Za-z0-9]/.test(s[j])) return -1;
    let k = j;
    while (k < s.length && /[A-Za-z0-9-]/.test(s[k])) k++;
    let end = k;
    while (end > j && s[end - 1] === '-') end--;
    if (end === j) return -1;
    j = end;
    labels++;
    if (s[j] === '.' && /[A-Za-z0-9]/.test(s[j + 1] ?? '')) { j++; continue; }
    break;
  }
  if (labels < 2) return -1;
  const next = s[j];
  if (next !== undefined && /[A-Za-z0-9-]/.test(next)) return -1;
  if (next === '_') {
    // a trailing underscore can be an emphasis boundary instead of part
    // of the address, but only when a '_' delimiter is actually open
    if (!delims || !delims.some(d => d.ch === '_' && d.canOpen)) return -1;
  }
  return j;
}

/** Try a GFM autolink literal at position i. Returns {href, text, end}. */
function matchAutolinkLiteral(s, i, delims) {
  const prev = i === 0 ? undefined : s[i - 1];
  // www. and http(s):// links (the scheme matches case-insensitively,
  // and the original case is preserved in the output)
  const head8 = s.slice(i, i + 8).toLowerCase();
  if (s.startsWith('www.', i) || head8.startsWith('http://') || head8.startsWith('https://')) {
    if (prev !== undefined && /[A-Za-z0-9]/.test(prev)) return null;
    let j = i;
    while (j < s.length && !/[\s<]/.test(s[j]) && s[j] >= ' ') j++;
    const raw = s.slice(i, j);
    const text = trimAutolink(raw);
    const isWww = text.startsWith('www.');
    const afterScheme = isWww ? text.slice(4) : text.slice(text.indexOf('://') + 3);
    const host = afterScheme.split(/[/?#]/, 1)[0];
    if (host.length === 0) return null;
    if (isWww && !host.includes('.')) return null;
    if (text.length <= (isWww ? 4 : text.indexOf('://') + 3)) return null;
    return { href: isWww ? 'http://' + text : text, text, end: i + text.length };
  }
  // mailto: / xmpp: prefixed emails
  const lower = s.slice(i, i + 7).toLowerCase();
  if (lower.startsWith('mailto:') || lower.startsWith('xmpp:')) {
    const pfx = lower.startsWith('mailto:') ? 7 : 5;
    if (prev !== undefined && LOCAL_PART.has(prev)) return null;
    let end = parseEmailAt(s, i + pfx, delims);
    if (end < 0) return null;
    if (pfx === 5 && s[end] === '/') {
      // xmpp resource part: one segment of [A-Za-z0-9@._~-]
      let k = end + 1;
      while (k < s.length && /[A-Za-z0-9@._~-]/.test(s[k])) k++;
      if (k > end + 1) end = k;
    }
    const text = s.slice(i, end);
    return { href: text, text, end };
  }
  // bare email
  if (prev === undefined || !LOCAL_PART.has(prev)) {
    const end = parseEmailAt(s, i, delims);
    if (end > 0) {
      const text = s.slice(i, end);
      return { href: 'mailto:' + text, text, end };
    }
  }
  return null;
}

const TEXT_STOP_RE = /[\\`\[!<&*_~\n\]]|www\.|[Hh][Tt][Tt][Pp][Ss]?:\/\/|mailto:|xmpp:|[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@/g;

function flanking(s, start, end) {
  const before = start === 0 ? undefined : s[start - 1];
  const after = end >= s.length ? undefined : s[end];
  const beforeWs = isSpaceChar(before), afterWs = isSpaceChar(after);
  const beforeP = isPunctChar(before), afterP = isPunctChar(after);
  const left = !afterWs && (!afterP || beforeWs || beforeP);
  const right = !beforeWs && (!beforeP || afterWs || afterP);
  return [left, right];
}

/** The CommonMark emphasis-matching algorithm over a node array. `delims` is
 *  the delimiter stack (entries reference nodes). Mutates both. */
function processEmphasis(nodes, delims) {
  let di = 0;
  while (di < delims.length) {
    const closer = delims[di];
    if (!closer.canClose || closer.len === 0) { di++; continue; }
    let advanced = false;
    const usedOpeners = [];
    while (closer.len > 0) {
      let oi = -1;
      for (let k = di - 1; k >= 0; k--) {
        const o = delims[k];
        if (o.ch !== closer.ch || !o.canOpen || o.len === 0) continue;
        // a spent opener may still pair with a pure closer, just not
        // with a delimiter that can also open
        if (o.dead && closer.canOpen) continue;
        if ((o.canClose || closer.canOpen) &&
            (o.len + closer.len) % 3 === 0 &&
            (o.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
        oi = k; break;
      }
      if (oi < 0) break;
      const opener = delims[oi];
      usedOpeners.push(opener);
      const use = opener.ch === '~'
        ? Math.min(2, opener.len, closer.len)
        : (opener.len >= 2 && closer.len >= 2 ? 2 : 1);
      const a = nodes.indexOf(opener);
      const b = nodes.indexOf(closer);
      const inner = nodes.splice(a + 1, b - a - 1);
      const kind = opener.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      nodes.splice(a + 1, 0, { k: kind, kids: inner });
      opener.len -= use;
      closer.len -= use;
      delims.splice(oi + 1, di - oi - 1);
      di = oi + 1;
      if (opener.len === 0) { delims.splice(oi, 1); di--; }
      advanced = true;
    }
    // an opener left partially consumed by this closer is spent: a
    // later closer may not reuse its remaining delimiters
    for (const o of usedOpeners) if (o.len > 0) o.dead = true;
    if (!advanced) di++;
    else if (closer.len === 0) di++;
  }
}

function altText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 't' || nd.k === 'code') out += nd.s;
    else if (nd.k === 'br') out += '\n';
    else if (nd.k === 'delim') out += nd.ch.repeat(nd.len);
    else if (nd.k === 'open') out += nd.img ? '![' : '[';
    else if (nd.kids) out += altText(nd.kids);
  }
  return out;
}

function renderNodes(nodes, ctx) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 't': out += escapeHtml(nd.s, false); break;
      case 'code': out += '<code>' + escapeHtml(nd.s, true) + '</code>'; break;
      case 'html': out += nd.s; break;
      case 'br': out += '<br>'; break;
      case 'delim': out += nd.ch.repeat(nd.len); break;
      case 'open': out += nd.img ? '![' : '['; break;
      case 'em': out += '<em>' + renderNodes(nd.kids, ctx) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(nd.kids, ctx) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(nd.kids, ctx) + '</del>'; break;
      case 'link': {
        const clean = nd.href === null ? null : cleanUrl(nd.href);
        if (clean === null) { out += renderNodes(nd.kids, ctx); break; }
        out += '<a href="' + escapeHtml(clean, false) + '"';
        if (nd.title !== null) out += ' title="' + escapeHtml(nd.title, false) + '"';
        out += '>' + renderNodes(nd.kids, ctx) + '</a>';
        break;
      }
      case 'img': {
        const clean = nd.src === null ? null : cleanUrl(nd.src);
        if (clean === null) { out += escapeHtml(altText(nd.kids), false); break; }
        out += '<img src="' + escapeHtml(clean, false) + '" alt="' + escapeHtml(altText(nd.kids), false) + '"';
        if (nd.title !== null) out += ' title="' + escapeHtml(nd.title, false) + '"';
        out += '>';
        break;
      }
    }
  }
  return out;
}

/** Lex inline markup in `src` into a node list. `ctx.defs` maps
 *  normalized reference labels to {dest, title}. */
function lexInline(src, ctx) {
  const nodes = [];
  const delims = [];
  const brackets = [];
  let text = '';
  let i = 0;
  const n = src.length;

  const flushText = () => {
    if (text) { nodes.push({ k: 't', s: text }); text = ''; }
  };

  // after a hard break, the next line's leading spaces/tabs are dropped
  const skipLineSpaces = () => {
    while (src[i] === ' ' || src[i] === '\t') i++;
  };

  // Form a link or image from the kids of the bracket opener at stack
  // position bi, with the given dest/title, ending the construct at endPos.
  function formLink(bi, op, dest, title, endPos) {
    const opIdx = nodes.indexOf(op.node);
    const kids = nodes.splice(opIdx + 1);
    nodes.pop(); // the opener node itself
    // emphasis inside the link text is resolved among itself
    const kidDelims = delims.filter(d => kids.includes(d));
    if (kidDelims.length) {
      processEmphasis(kids, kidDelims);
      for (const d of kidDelims) {
        const at = delims.indexOf(d);
        if (at >= 0) delims.splice(at, 1);
        if (d.len > 0) {
          // leftover delimiters become literal text inside the link
          const nd = d;
          nd.k = 't'; nd.s = nd.ch.repeat(nd.len);
        }
      }
    }
    if (!op.img) {
      // autolink literals are not recognised inside link text
      demoteAutolinks(kids);
      // deactivate all earlier link openers
      for (let k = 0; k < bi; k++) if (!brackets[k].img) brackets[k].active = false;
    }
    brackets.length = bi;
    if (op.img) {
      nodes.push({ k: 'img', src: sanitizeUrl(dest, true), title, kids });
    } else {
      nodes.push({ k: 'link', href: sanitizeUrl(dest, false), title, kids });
    }
    i = endPos;
  }

  function demoteAutolinks(list) {
    for (let k = 0; k < list.length; k++) {
      const nd = list[k];
      if (nd.k === 'link' && nd.auto) list[k] = { k: 't', s: nd.autoText };
      else if (nd.kids) demoteAutolinks(nd.kids);
    }
  }

  // Would a ']' at position rb form a link with the nearest active opener?
  function wouldFormLink(rb) {
    let op = null;
    for (let k = brackets.length - 1; k >= 0; k--) {
      if (brackets[k].active) { op = brackets[k]; break; }
    }
    if (!op) return false;
    if (src[rb + 1] === '(') return parseLinkParens(src, rb + 2) !== null;
    if (src[rb + 1] === '[') {
      const second = parseRefLabel(src, rb + 1);
      if (second) {
        const label = second.text !== '' ? second.text : src.slice(op.contentStart, rb);
        return ctx.defs.has(normalizeLabel(label));
      }
    }
    return ctx.defs.has(normalizeLabel(src.slice(op.contentStart, rb)));
  }

  // In marked, a link text containing a code span whose content itself
  // contains a backtick (a "dirty" span) only forms when the text ends
  // with such a span.
  function linkTextOk(s) {
    let p = 0;
    let anyDirty = false;
    let endsDirty = false;
    while (p < s.length) {
      if (s[p] === '\\' && isAsciiPunct(s[p + 1])) { p += 2; continue; }
      if (s[p] !== '`') { p++; continue; }
      let len = 0;
      while (s[p + len] === '`') len++;
      let q = p + len;
      let closeAt = -1;
      while (q < s.length) {
        if (s[q] === '`') {
          let run = 0;
          while (s[q + run] === '`') run++;
          if (run === len) { closeAt = q; break; }
          q += run;
        } else q++;
      }
      if (closeAt < 0) { p += len; continue; }
      if (s.slice(p + len, closeAt).includes('`')) {
        anyDirty = true;
        endsDirty = closeAt + len === s.length;
      }
      p = closeAt + len;
    }
    return !anyDirty || endsDirty;
  }

  function closeBracket() {
    let bi = -1;
    for (let k = brackets.length - 1; k >= 0; k--) {
      if (brackets[k].active) { bi = k; break; }
    }
    if (bi < 0) return false;
    const op = brackets[bi];
    if (!linkTextOk(src.slice(op.contentStart, i))) {
      brackets.splice(bi, 1);
      return false;
    }
    // inline link: ]( ...)
    if (src[i + 1] === '(') {
      const r = parseLinkParens(src, i + 2);
      if (r) { formLink(bi, op, r.dest, r.title, r.end); return true; }
    }
    // reference forms
    let second = null;
    if (src[i + 1] === '[') second = parseRefLabel(src, i + 1);
    if (second) {
      const label = second.text !== '' ? second.text : src.slice(op.contentStart, i);
      const def = ctx.defs.get(normalizeLabel(label));
      if (def) { formLink(bi, op, def.dest, def.title, second.end); return true; }
      brackets.splice(bi, 1);
      return false;
    }
    const def = ctx.defs.get(normalizeLabel(src.slice(op.contentStart, i)));
    if (def) { formLink(bi, op, def.dest, def.title, i + 1); return true; }
    brackets.splice(bi, 1);
    return false;
  }

  // Find the ']' matching the bracket opened just before `from`, counting
  // nested brackets and skipping escapes, code spans and link destinations.
  function scanBalanced(from) {
    let depth = 1;
    let j = from;
    while (j < n) {
      const cj = src[j];
      if (cj === '\\' && isAsciiPunct(src[j + 1])) { j += 2; continue; }
      if (cj === '`') {
        let len = 0;
        while (src[j + len] === '`') len++;
        let k = j + len;
        let closeAt = -1;
        while (k < n) {
          if (src[k] === '`') {
            let run = 0;
            while (src[k + run] === '`') run++;
            if (run === len) { closeAt = k; break; }
            k += run;
          } else k++;
        }
        j = closeAt >= 0 ? closeAt + len : j + len;
        continue;
      }
      if (cj === '[') { depth++; j++; continue; }
      if (cj === ']') {
        depth--;
        j++;
        if (depth === 0) return j - 1;
        if (src[j] === '(') {
          const r = parseLinkParens(src, j + 1);
          if (r) j = r.end;
        }
        continue;
      }
      j++;
    }
    return -1;
  }

  function pushImage(textStr, dest, title) {
    flushText();
    nodes.push({ k: 'img', src: sanitizeUrl(dest, true), title, kids: lexInline(textStr, ctx) });
  }

  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') { flushText(); nodes.push({ k: 'br' }); i += 2; skipLineSpaces(); } else if (isAsciiPunct(nx)) { flushText(); nodes.push({ k: 't', s: nx }); i += 2; } else { text += c; i++; }
      continue;
    }
    if (c === '`') {
      let len = 0;
      while (src[i + len] === '`') len++;
      // find a closing run of exactly len backticks
      let j = i + len;
      let closeAt = -1;
      while (j < n) {
        if (src[j] === '`') {
          let run = 0;
          while (src[j + run] === '`') run++;
          if (run === len) { closeAt = j; break; }
          j += run;
        } else j++;
      }
      if (closeAt >= 0 && brackets.length > 0) {
        // inside link text: find where the bracket would close
        let bracketEnd = -1;
        let depth = 0;
        for (let k = i + len; k < n; k++) {
          const ck = src[k];
          if (ck === '\\' && isAsciiPunct(src[k + 1])) { k++; continue; }
          if (ck === '[') depth++;
          else if (ck === ']') {
            if (depth === 0) { bracketEnd = k; break; }
            depth--;
          }
        }
        if (bracketEnd >= 0 && closeAt > bracketEnd &&
            src.slice(i + len, closeAt).includes('`')) {
          // a span whose content itself contains backticks does not
          // shield the bracket; a short backtick-free run is plain text
          const open = Math.min(len, 2);
          let k = i + open;
          while (k < n && src[k] !== '`') k++;
          if (k < n) {
            let run = 0;
            while (src[k + run] === '`') run++;
            const end = k + Math.min(run, 2);
            text += src.slice(i, end);
            i = end;
            continue;
          }
          closeAt = -1;
        }
      }
      if (closeAt < 0) { text += '`'.repeat(len); i += len; continue; }
      flushText();
      let content = src.slice(i + len, closeAt).replace(/\n/g, ' ');
      if (content.length > 1 && content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      nodes.push({ k: 'code', s: content });
      i = closeAt + len;
      continue;
    }
    if (c === '<') {
      const rest = src.slice(i);
      let m = AUTOLINK_RE.exec(rest);
      if (m) {
        flushText();
        const url = m[1];
        nodes.push({ k: 'link', href: url, title: null, auto: false, kids: [{ k: 't', s: url }] });
        i += m[0].length;
        continue;
      }
      m = EMAIL_AUTOLINK_RE.exec(rest);
      if (m) {
        flushText();
        const url = m[1];
        nodes.push({ k: 'link', href: 'mailto:' + url, title: null, auto: false, kids: [{ k: 't', s: url }] });
        i += m[0].length;
        continue;
      }
      const html = matchRawHtml(src, i);
      if (html !== null) {
        flushText();
        nodes.push({ k: 'html', s: html });
        // an <a ...> tag (literally "<a" + a space) suppresses autolink
        // literals until an exact </a>, across blocks within one document
        if (/^<a /i.test(html)) ctx.inLink = true;
        else if (/^<\/a>/i.test(html)) ctx.inLink = false;
        i += html.length;
        continue;
      }
      text += c; i++;
      continue;
    }
    if (c === '&') {
      const rest = src.slice(i, i + 12);
      let m = /^&#(\d{1,7});/.exec(rest);
      if (m) { text += decodeNumericRef(parseInt(m[1], 10)); i += m[0].length; continue; }
      m = /^&#[xX]([0-9a-fA-F]{1,6});/.exec(rest);
      if (m) { text += decodeNumericRef(parseInt(m[1], 16)); i += m[0].length; continue; }
      text += c; i++;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      // an image captures its text by balanced-bracket scanning, so a
      // link nested inside the alt text cannot close the image early
      const close = scanBalanced(i + 2);
      if (close >= 0 && linkTextOk(src.slice(i + 2, close))) {
        const textStr = src.slice(i + 2, close);
        let done = false;
        if (src[close + 1] === '(') {
          const r = parseLinkParens(src, close + 2);
          if (r) { pushImage(textStr, r.dest, r.title); i = r.end; done = true; }
        }
        if (!done && src[close + 1] === '[') {
          const second = parseRefLabel(src, close + 1);
          if (second) {
            const label = second.text !== '' ? second.text : textStr;
            const def = ctx.defs.get(normalizeLabel(label));
            if (def) { pushImage(textStr, def.dest, def.title); i = second.end; done = true; }
          }
        }
        if (!done) {
          const def = ctx.defs.get(normalizeLabel(textStr));
          if (def) { pushImage(textStr, def.dest, def.title); i = close + 1; done = true; }
        }
        if (done) continue;
      }
      flushText();
      const node = { k: 'open', img: true };
      nodes.push(node);
      brackets.push({ node, img: true, active: true, contentStart: i + 2 });
      i += 2;
      continue;
    }
    if (c === '[') {
      flushText();
      const node = { k: 'open', img: false };
      nodes.push(node);
      brackets.push({ node, img: false, active: true, contentStart: i + 1 });
      i++;
      continue;
    }
    if (c === ']') {
      flushText();
      if (!closeBracket()) { text += ']'; i++; }
      continue;
    }
    if (c === '*' || c === '_') {
      let len = 0;
      while (src[i + len] === c) len++;
      flushText();
      const [left, right] = flanking(src, i, i + len);
      const node = {
        k: 'delim', ch: c, len,
        canOpen: c === '*' ? left : (left && (!right || isPunctChar(src[i - 1]))),
        canClose: c === '*' ? right : (right && (!left || isPunctChar(src[i + len]))),
      };
      nodes.push(node);
      delims.push(node);
      i += len;
      continue;
    }
    if (c === '~') {
      let len = 0;
      while (src[i + len] === '~') len++;
      if (len > 2) { text += '~'.repeat(len); i += len; continue; }
      flushText();
      const [left, right] = flanking(src, i, i + len);
      const node = { k: 'delim', ch: '~', len, canOpen: left, canClose: right };
      nodes.push(node);
      delims.push(node);
      i += len;
      continue;
    }
    if (c === '\n') {
      // hard break when the pending text ends in 2+ spaces
      let sp = 0;
      while (text[text.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        text = text.slice(0, text.length - sp);
        flushText();
        nodes.push({ k: 'br' });
        i++;
        skipLineSpaces();
      } else {
        text += '\n';
        i++;
      }
      continue;
    }
    // text run: advance to the next special character or autolink candidate
    TEXT_STOP_RE.lastIndex = i;
    const mm = TEXT_STOP_RE.exec(src);
    const j = mm ? mm.index : n;
    if (j === i) {
      let auto = ctx.inLink ? null : matchAutolinkLiteral(src, i, delims);
      if (auto && brackets.length) {
        const rb = src.indexOf(']', i);
        if (rb >= i && rb < auto.end && wouldFormLink(rb)) auto = null;
      }
      if (auto) {
        flushText();
        nodes.push({ k: 'link', href: auto.href, title: null, auto: true, autoText: auto.text, kids: [{ k: 't', s: auto.text }] });
        i = auto.end;
      } else {
        text += c; i++;
      }
      continue;
    }
    text += src.slice(i, j);
    i = j;
  }
  flushText();
  processEmphasis(nodes, delims);
  return nodes;
}

function parseInline(src, ctx) {
  return renderNodes(lexInline(src, ctx), ctx);
}

// ------------------------------------------------------------------- blocks
//
// The block lexer works on an array of lines (no line terminators). It is a
// chunk lexer in marked's spirit: at each block start it tries constructs in
// a fixed order; blockquotes and list items capture their inner lines and
// lex them recursively. Every token records whether a blank line preceded
// it (blankBefore), which drives list tightness.

const TYPE6_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
const COMPLETE_TAG_RE = new RegExp('^(?:<' + TAG_NAME + '(?:' + ATTR + ')*\\s*\\/?>|</' + TAG_NAME + '\\s*>)\\s*$');

function setextLevel(line) {
  const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
  if (!m) return 0;
  return m[1][0] === '=' ? 1 : 2;
}

function isHr(line) {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line);
}

const ATX_RE = /^ {0,3}(#{1,6})(.*)$/;
function matchAtx(line) {
  const m = ATX_RE.exec(line);
  if (!m) return null;
  let rest = m[2];
  if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
  rest = rest.replace(/[ \t]+$/, '');
  rest = rest.replace(/(?:[ \t]+|^)#+$/, '');
  rest = rest.replace(/^[ \t]+/, '');
  return { level: m[1].length, text: rest };
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
function matchFenceStart(line) {
  const m = FENCE_RE.exec(line);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  return { ch: m[1][0], len: m[1].length, indent: line.indexOf(m[1][0]), info: m[2].trim() };
}

function isFenceClose(line, ch, len) {
  const m = FENCE_RE.exec(line);
  return m !== null && m[1][0] === ch && m[1].length >= len && /^[ \t]*$/.test(m[2]);
}

/** Parse a list marker at the start of a line. Returns null or
 *  {ordered, bullet, delim, start, contentIndent, firstContent}. */
function parseMarker(line) {
  let [pos, col] = scanIndent(line, 3);
  if (col > 3 || pos >= line.length) return null;
  const c = line[pos];
  let ordered = false, bullet = '', delim = '', start = 1, markerEndCol;
  if (c === '-' || c === '+' || c === '*') {
    bullet = c;
    markerEndCol = col + 1;
  } else if (c >= '0' && c <= '9') {
    let j = pos;
    while (j < line.length && line[j] >= '0' && line[j] <= '9' && j - pos < 9) j++;
    if (j === pos || j - pos > 9) return null;
    const d = line[j];
    if (d !== '.' && d !== ')') return null;
    ordered = true;
    delim = d;
    start = parseInt(line.slice(pos, j), 10);
    markerEndCol = col + (j - pos) + 1;
    pos = j + 1;
    // note: pos advanced past the delimiter below via shared code
    return finishMarker(line, ordered, bullet, delim, start, markerEndCol, pos);
  } else return null;
  return finishMarker(line, ordered, bullet, delim, start, markerEndCol, pos + 1);
}

function finishMarker(line, ordered, bullet, delim, start, markerEndCol, afterPos) {
  // afterPos = index just past the marker character(s)
  if (afterPos >= line.length) {
    return { ordered, bullet, delim, start, contentIndent: markerEndCol + 1, firstContent: '' };
  }
  const c = line[afterPos];
  if (c !== ' ' && c !== '\t') return null;
  // measure the whitespace run after the marker, in columns
  let col = markerEndCol, p = afterPos;
  while (p < line.length && (line[p] === ' ' || line[p] === '\t')) {
    if (line[p] === ' ') col++;
    else col += 4 - (col % 4);
    p++;
  }
  const spaces = col - markerEndCol;
  if (p >= line.length) {
    // marker followed only by whitespace: blank item start
    return { ordered, bullet, delim, start, contentIndent: markerEndCol + 1, firstContent: '' };
  }
  if (spaces >= 1 && spaces <= 4) {
    return { ordered, bullet, delim, start, contentIndent: markerEndCol + spaces, firstContent: line.slice(p) };
  }
  // 5+ spaces: the content indent is one column past the marker, so the
  // first content is the line one column past the marker's end.
  let firstContent;
  if (line[afterPos] === ' ') firstContent = line.slice(afterPos + 1);
  else firstContent = ' '.repeat(3 - (markerEndCol % 4)) + expandPrefix(line.slice(afterPos + 1), markerEndCol + (4 - (markerEndCol % 4)));
  return { ordered, bullet, delim, start, contentIndent: markerEndCol + 1, firstContent };
}

function sameListType(a, b) {
  if (a.ordered !== b.ordered) return false;
  return a.ordered ? a.delim === b.delim : a.bullet === b.bullet;
}

/** Which HTML block (if any) starts at this line: {type, tag?} or null. */
function htmlBlockStart(line) {
  const [pos, col] = scanIndent(line, 3);
  if (col > 3 || line[pos] !== '<') return null;
  const rest = line.slice(pos);
  let m = /^<(pre|script|style|textarea)(?=[\t ]|\/?>|$)/i.exec(rest);
  if (m) return { type: 1, tag: m[1].toLowerCase() };
  if (rest.startsWith('<!--')) return { type: 2 };
  if (rest.startsWith('<?')) return { type: 3 };
  if (/^<![A-Z]/.test(rest)) return { type: 4 };
  if (rest.startsWith('<![CDATA[')) return { type: 5 };
  m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\t ]|\/?>|$)/.exec(rest);
  if (m && TYPE6_TAGS.has(m[1].toLowerCase())) return { type: 6 };
  if (COMPLETE_TAG_RE.test(rest) && !/^<\/?(script|pre|style|textarea)[\t >/]/i.test(rest)) return { type: 7 };
  return null;
}

function htmlBlockEnded(line, start) {
  const lower = line.toLowerCase();
  switch (start.type) {
    case 1: return lower.includes('</' + start.tag);
    case 2: return line.includes('-->');
    case 3: return line.includes('?>');
    case 4: return line.includes('>');
    case 5: return line.includes(']]>');
    default: return false;
  }
}

/** Parse a link reference definition beginning at lines[i]. On success,
 *  registers it in ctx.defs and returns the number of lines consumed. */
function isTitleStart(c) { return c === '"' || c === "'" || c === '('; }

/** Scan a link title starting at the quote character s[q]. Returns
 *  {title, end} (end just past the closing quote) or null. Titles may span
 *  lines but may not contain a blank line. */
function scanTitle(s, q) {
  const open = s[q];
  const close = open === '(' ? ')' : open;
  let e = q + 1;
  while (e < s.length) {
    const c = s[e];
    if (c === '\\' && isAsciiPunct(s[e + 1])) { e += 2; continue; }
    if (c === close) return { title: unescapeStr(s.slice(q + 1, e)), end: e + 1 };
    if (open === '(' && c === '(') return null;
    if (c === '\n') {
      let k = e + 1;
      while (s[k] === ' ' || s[k] === '\t') k++;
      if (s[k] === '\n') return null; // blank line inside the title
    }
    e++;
  }
  return null;
}

/** Skip spaces/tabs and at most one non-blank line break; -1 on a blank. */
function skipDefWs(s, q) {
  let newlines = 0;
  while (q < s.length) {
    const c = s[q];
    if (c === ' ' || c === '\t') { q++; continue; }
    if (c === '\n') {
      newlines++;
      if (newlines > 1) return -1;
      q++;
      let k = q;
      while (s[k] === ' ' || s[k] === '\t') k++;
      if (s[k] === '\n') return -1;
      continue;
    }
    break;
  }
  return q;
}

function tryDef(lines, i, ctx) {
  const [pos, col] = scanIndent(lines[i], 3);
  if (col > 3 || lines[i][pos] !== '[') return 0;
  const s = lines.slice(i, i + 50).join('\n');
  const p = pos;
  // label: no unescaped '[', no blank line inside
  let j = p + 1;
  let labelEnd = -1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && isAsciiPunct(s[j + 1])) { j += 2; continue; }
    if (c === '[') return 0;
    if (c === ']') { labelEnd = j; break; }
    if (c === '\n') {
      let k = j + 1;
      while (s[k] === ' ' || s[k] === '\t') k++;
      if (s[k] === '\n') return 0;
    }
    j++;
  }
  if (labelEnd < 0 || labelEnd - p > 1000) return 0;
  const label = s.slice(p + 1, labelEnd);
  if (s[labelEnd + 1] !== ':') return 0;
  let q = skipDefWs(s, labelEnd + 2);
  if (q < 0) return 0;
  // destination
  let dest;
  if (s[q] === '<') {
    let e = q + 1;
    while (e < s.length && s[e] !== '>' && s[e] !== '\n') { if (s[e] === '\\') e++; e++; }
    if (s[e] !== '>') return 0;
    dest = unescapeStr(s.slice(q + 1, e));
    q = e + 1;
  } else {
    let depth = 0;
    const start = q;
    while (q < s.length) {
      const c = s[q];
      if (c === '\\' && isAsciiPunct(s[q + 1])) { q += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (c === ' ' || c === '\t' || c === '\n' || c < ' ') break;
      q++;
    }
    if (q === start) return 0;
    dest = unescapeStr(s.slice(start, q));
  }
  const afterDest = q;
  // end of the destination line (spaces/tabs, then a newline or the end)
  let e = afterDest;
  while (s[e] === ' ' || s[e] === '\t') e++;
  const destLineClean = e >= s.length || s[e] === '\n';
  let title = null;
  let endQ = -1;
  if (e > afterDest && isTitleStart(s[e])) {
    // title on the same line as the destination: it must parse cleanly
    const t = scanTitle(s, e);
    if (!t) return 0;
    let a = t.end;
    while (s[a] === ' ' || s[a] === '\t') a++;
    if (a < s.length && s[a] !== '\n') return 0;
    title = t.title;
    endQ = a;
  } else if (destLineClean && s[e] === '\n') {
    // title may begin on the next line; if it does not parse, the
    // definition still stands without a title
    let r = e + 1;
    while (s[r] === ' ' || s[r] === '\t') r++;
    if (isTitleStart(s[r])) {
      const t = scanTitle(s, r);
      if (t) {
        let a = t.end;
        while (s[a] === ' ' || s[a] === '\t') a++;
        if (a >= s.length || s[a] === '\n') { title = t.title; endQ = a; }
      }
    }
    if (endQ < 0) endQ = e;
  } else if (destLineClean) {
    endQ = e;
  } else {
    return 0; // junk after the destination on its own line
  }
  const key = normalizeLabel(label);
  if (key === '') return 0;
  if (!ctx.defs.has(key)) ctx.defs.set(key, { dest, title });
  return s.slice(0, endQ).split('\n').length;
}

// --- tables

/** Split a table row into raw cell strings on unescaped, non-code pipes. */
function splitRow(line) {
  const cells = [];
  let cur = '';
  let spanUntil = -1; // index just past the end of an open code span
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\' && isAsciiPunct(line[i + 1])) {
      // an escaped pipe becomes a literal pipe in the cell text; other
      // escape pairs pass through untouched (and never toggle code state)
      cur += line[i + 1] === '|' ? '|' : c + line[i + 1];
      i += 2;
      continue;
    }
    if (c === '`' && i >= spanUntil) {
      let run = 0;
      while (line[i + run] === '`') run++;
      // a span only shields pipes when a run of exactly the same length
      // closes it before the next unescaped pipe; otherwise the
      // backticks are literal and the pipe still splits
      let j = i + run;
      let closeEnd = -1;
      while (j < line.length) {
        if (line[j] === '\\' && isAsciiPunct(line[j + 1])) { j += 2; continue; }
        if (line[j] === '|') break;
        if (line[j] === '`') {
          let r2 = 0;
          while (line[j + r2] === '`') r2++;
          if (r2 === run) { closeEnd = j + r2; break; }
          j += r2;
        } else j++;
      }
      cur += '`'.repeat(run);
      if (closeEnd >= 0) spanUntil = closeEnd;
      i += run;
      continue;
    }
    if (c === '|' && i >= spanUntil) { cells.push(cur); cur = ''; i++; continue; }
    cur += c;
    i++;
  }
  cells.push(cur);
  if (cells.length > 1 && cells[0].trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map(c => c.trim());
}

const DELIM_CELL_RE = /^\s*:?-+:?\s*$/;

function isTableDelim(line) {
  if (!line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every(c => DELIM_CELL_RE.test(c));
}

function tableRowStops(line) {
  // a line of only spaces ends the table; a tab-only line is an empty row
  if (/^ *$/.test(line)) return true;
  const [pos, col] = scanIndent(line, 3);
  if (col <= 3 && line[pos] === '>') return true;
  if (matchAtx(line) || matchFenceStart(line) || isHr(line)) return true;
  if (parseMarker(line)) return true;
  const hb = htmlBlockStart(line);
  if (hb && hb.type !== 7) return true;
  return false;
}

function tryTable(lines, i, ctx) {
  if (i + 1 >= lines.length || !isTableDelim(lines[i + 1])) return null;
  // a table needs a pipe in the header or the delimiter row (otherwise
  // "Foo\n---" would be a table instead of a setext heading)
  if (!lines[i].includes('|') && !lines[i + 1].includes('|')) return null;
  const header = splitRow(lines[i]);
  const delim = splitRow(lines[i + 1]);
  if (header.length === 0 || header.length !== delim.length) return null;
  const aligns = delim.map(c => {
    const t = c.trim();
    const l = t.startsWith(':'), r = t.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
  });
  const rows = [];
  let j = i + 2;
  while (j < lines.length && !tableRowStops(lines[j])) {
    const cells = splitRow(lines[j]);
    while (cells.length < header.length) cells.push('');
    rows.push(cells.slice(0, header.length));
    j++;
  }
  return [{ type: 'table', header, aligns, rows }, j];
}

// --- blockquote / list capture helpers

/** Would this line start a new block (so it can't be a lazy continuation)? */
function startsInterruptBlock(line) {
  if (matchAtx(line) || matchFenceStart(line) || isHr(line)) return true;
  const [pos, col] = scanIndent(line, 3);
  if (col <= 3 && line[pos] === '>') return true;
  const hb = htmlBlockStart(line);
  if (hb && hb.type !== 7) return true;
  if (parseMarker(line)) return true;
  return false;
}

/** Does this token stream end in a paragraph, looking through any nested
 *  blockquotes and list items on the right edge? (Lazy continuation test.) */
function lastIsPara(tokens) {
  if (!tokens.length) return false;
  const t = tokens[tokens.length - 1];
  if (t.type === 'para') return true;
  if (t.type === 'blockquote') return lastIsPara(t.children);
  if (t.type === 'list') return t.items.length > 0 && lastIsPara(t.items[t.items.length - 1].tokens);
  return false;
}

function lexBlockquote(lines, i, ctx, eolAtEnd) {
  const inner = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    const [pos, col] = scanIndent(line, 3);
    if (col <= 3 && line[pos] === '>') {
      const gtCol = col; // column of the '>' character
      const after = line[pos + 1];
      let stripped;
      if (after === ' ') stripped = expandPrefix(line.slice(pos + 2), gtCol + 2);
      else if (after === '\t') stripped = ' '.repeat(3 - ((gtCol + 1) % 4)) + expandPrefix(line.slice(pos + 2), gtCol + 1 + (4 - ((gtCol + 1) % 4)));
      else stripped = line.slice(pos + 1);
      inner.push(stripped);
      j++;
      continue;
    }
    // a blank line without the quote marker ends the blockquote
    if (isBlankLine(line)) break;
    // lazy continuation: previous inner line non-blank, line starts no
    // block, and the inner content so far ends in a paragraph; the lazy
    // line's own leading whitespace is dropped
    if (inner.length > 0 && inner[inner.length - 1] !== '' && !startsInterruptBlock(line)) {
      const toks = lexLines(inner, ctx, false);
      if (lastIsPara(toks)) {
        inner[inner.length - 1] += '\n' + (indentCols(line) >= 4 ? sliceColX(line, 4) : line);
        j++;
        continue;
      }
    }
    break;
  }
  if (inner.length >= 2 && inner[inner.length - 1].trim() === '' && inner[inner.length - 1] !== '' && inner[inner.length - 2] !== '') {
    inner[inner.length - 2] += '\n' + inner[inner.length - 1];
    inner.pop();
  }
  return [{ type: 'blockquote', children: lexLines(inner, ctx, false) }, j];
}

function lexList(lines, i, ctx, eolAtEnd) {
  const first = parseMarker(lines[i]);
  if (!first) return null;
  const items = [];
  const newItem = (m, blankBefore) => ({
    lines: [m.firstContent],
    blankBefore,
    contentIndent: m.contentIndent,
    startedEmpty: m.firstContent.trim() === '',
    hasContent: m.firstContent.trim() !== '',
  });
  let cur = newItem(first, false);
  items.push(cur);
  let j = i + 1;
  let pendingBlanks = 0;
  let blankStart = -1;
  // while a fence is open inside the current item, every following line
  // belongs to the item (and the fence), whatever its indentation
  let openFence = matchFenceStart(cur.lines[0]);
  // while a fence is open, dedented lines are absorbed only directly
  // after a consumed content line (a blank line resets that)
  let fenceAbsorb = false;
  const trackFence = (contentLine) => {
    if (openFence) {
      if (isFenceClose(contentLine, openFence.ch, openFence.len)) openFence = null;
    } else {
      openFence = matchFenceStart(contentLine);
      fenceAbsorb = false;
    }
  };
  while (j < lines.length) {
    const line = lines[j];
    if (openFence) {
      if (isBlankLine(line)) { cur.lines.push(''); fenceAbsorb = false; j++; continue; }
      // a dedented line ends the item (truncating the fence) unless the
      // fence just consumed a content line on the previous line
      if (indentCols(line) < cur.contentIndent && !fenceAbsorb) break;
      const pushed = sliceColX(line, cur.contentIndent);
      cur.lines.push(pushed);
      cur.hasContent = true;
      trackFence(pushed);
      fenceAbsorb = openFence !== null;
      j++;
      continue;
    }
    if (isBlankLine(line)) {
      if (pendingBlanks === 0) blankStart = j;
      pendingBlanks++;
      j++;
      continue;
    }
    const ind = indentCols(line);
    if (ind >= cur.contentIndent) {
      // an item that began empty and met a blank line before any content
      // is finished: the following lines are not part of it
      if (pendingBlanks > 0 && cur.startedEmpty && !cur.hasContent) { j = blankStart; break; }
      if (pendingBlanks > 0) {
        for (let b = 0; b < pendingBlanks; b++) cur.lines.push('');
        pendingBlanks = 0; blankStart = -1;
      }
      const pushedLine = sliceColX(line, cur.contentIndent);
      cur.lines.push(pushedLine);
      cur.hasContent = true;
      trackFence(pushedLine);
      j++;
      continue;
    }
    // below the content indent: sibling marker, or the list ends
    const m = parseMarker(line);
    if (m && sameListType(first, m) && !isHr(line)) {
      cur = newItem(m, pendingBlanks > 0);
      items.push(cur);
      openFence = matchFenceStart(cur.lines[0]);
      fenceAbsorb = false;
      pendingBlanks = 0; blankStart = -1;
      j++;
      continue;
    }
    if (pendingBlanks === 0 && cur.lines.length > 0 && !startsInterruptBlock(line)) {
      const toks = lexLines(cur.lines, ctx, false, true);
      if (lastIsPara(toks)) {
        cur.lines[cur.lines.length - 1] += '\n' + (indentCols(line) >= 4 ? sliceColX(line, 4) : line);
        cur.hasContent = true;
        j++;
        continue;
      }
    }
    if (pendingBlanks > 0) j = blankStart;
    break;
  }
  // build items and decide tightness
  let loose = false;
  const builtItems = items.map((it, idx) => {
    const tokens = lexLines(it.lines, ctx, false, true);
    if (idx > 0 && it.blankBefore) loose = true;
    for (let t = 1; t < tokens.length; t++) if (tokens[t].blankBefore) loose = true;
    return { tokens };
  });
  return [{ type: 'list', ordered: first.ordered, start: first.start, tight: !loose, items: builtItems }, j];
}

function interruptsParagraph(line, inItem) {
  if (matchAtx(line) || matchFenceStart(line) || isHr(line)) return true;
  const [pos, col] = scanIndent(line, 3);
  if (col <= 3 && line[pos] === '>') return true;
  const hb = htmlBlockStart(line);
  if (hb && hb.type !== 7) return true;
  const m = parseMarker(line);
  // an ordered marker only interrupts a paragraph when it starts at 1,
  // except inside a list item, where any ordered marker interrupts
  if (m && m.firstContent.trim() !== '' && (!m.ordered || m.start === 1 || inItem)) return true;
  return false;
}

function lexLines(lines, ctx, eolAtEnd, inItem = false) {
  const tokens = [];
  let i = 0;
  let blankBefore = false;
  let deepSplitNext = false;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { blankBefore = true; i++; continue; }
    const applyDeep = deepSplitNext;
    deepSplitNext = false;
    let res = null;
    // fenced code
    const fence = matchFenceStart(line);
    if (fence) {
      const content = [];
      let j = i + 1;
      while (j < n && !isFenceClose(lines[j], fence.ch, fence.len)) {
        // marked strips the fence line's indent from the content of
        // backtick fences only; tilde fence content is kept verbatim
        content.push(fence.ch === '`' ? sliceCol(lines[j], fence.indent) : lines[j]);
        j++;
      }
      if (j < n) j++; // consume the closing fence
      // a blank line directly before the closing fence is not content
      if (content.length && content[content.length - 1] === '') content.pop();
      res = [{ type: 'code', lang: fence.info ? unescapeStr(fence.info.split(/\s+/)[0]) : null, text: content.length ? content.join('\n') + '\n' : '' }, j];
    }
    // ATX heading
    if (!res) {
      const atx = matchAtx(line);
      if (atx) res = [{ type: 'heading', level: atx.level, text: atx.text }, i + 1];
    }
    // thematic break
    if (!res && isHr(line)) res = [{ type: 'hr' }, i + 1];
    // blockquote
    if (!res) {
      const [pos, col] = scanIndent(line, 3);
      if (col <= 3 && line[pos] === '>') res = lexBlockquote(lines, i, ctx, eolAtEnd);
    }
    // list
    if (!res) res = lexList(lines, i, ctx, eolAtEnd);
    // HTML block
    if (!res) {
      const hb = htmlBlockStart(line);
      if (hb) {
        let j = i;
        if (hb.type >= 6) {
          while (j < n && !isBlankLine(lines[j])) j++;
        } else {
          while (j < n) { const l = lines[j]; j++; if (htmlBlockEnded(l, hb)) break; }
        }
        const consumed = lines.slice(i, j);
        let text = consumed.join('\n');
        // types 1-5 keep the newline unless the next line is truly
        // empty; types 6-7 unless it is blank
        const nl = hb.type <= 5
          ? (j < n ? lines[j] !== '' : eolAtEnd)
          : (j < n ? !isBlankLine(lines[j]) : eolAtEnd);
        if (nl) text += '\n';
        res = [{ type: 'html', text }, j];
      }
    }
    // link reference definition(s)
    if (!res) {
      const used = tryDef(lines, i, ctx);
      if (used > 0) res = [{ type: 'def' }, i + used];
    }
    // table
    if (!res) res = tryTable(lines, i, ctx);
    // indented code
    if (!res && indentCols(line) >= 4) {
      const content = [];
      let j = i;
      while (j < n && (isBlankLine(lines[j]) || indentCols(lines[j]) >= 4)) {
        content.push(indentCols(lines[j]) >= 4 ? sliceCol(lines[j], 4) : '');
        j++;
      }
      while (content.length && content[content.length - 1].trim() === '') content.pop();
      res = [{ type: 'code', lang: null, text: content.length ? content.join('\n') + '\n' : '' }, j];
    }
    // paragraph (with setext conversion)
    if (!res) {
      const buf = [line];
      let j = i + 1;
      let heading = null;
      let sawDeep = false;
      while (j < n) {
        const l = lines[j];
        if (isBlankLine(l)) break;
        // inside a list item, a continuation line indented 4+ columns is
        // folded into the paragraph with those 4 columns removed, and a
        // shallower line after such a deep line ends the paragraph
        if (inItem && indentCols(l) >= 4) {
          buf.push(sliceColX(l, 4));
          sawDeep = true;
          j++;
          continue;
        }
        if (inItem && sawDeep) break;
        const sx = setextLevel(l);
        if (sx) { heading = sx; j++; break; }
        if (interruptsParagraph(l, inItem)) break;
        buf.push(l);
        j++;
      }
      if (heading) {
        const text = buf.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        res = [{ type: 'heading', level: heading, text }, j];
      } else {
        res = [{ type: 'para', text: buf.join('\n') }, j];
      }
      if (sawDeep && j < n && !isBlankLine(lines[j])) deepSplitNext = true;
    }
    res[0].blankBefore = blankBefore;
    blankBefore = false;
    if (applyDeep) res[0].deepSplit = true;
    tokens.push(res[0]);
    i = res[1];
  }
  return tokens;
}

// ----------------------------------------------------------------- renderer

function renderBlock(tok, ctx, tightPara) {
  switch (tok.type) {
    case 'para':
      return tightPara ? parseInline(tok.text, ctx) : '<p>' + parseInline(tok.text, ctx) + '</p>\n';
    case 'heading':
      return '<h' + tok.level + '>' + parseInline(tok.text, ctx) + '</h' + tok.level + '>\n';
    case 'code': {
      const lang = tok.lang ? ' class="language-' + escapeHtml(tok.lang, false) + '"' : '';
      return '<pre><code' + lang + '>' + escapeHtml(tok.text, true) + '</code></pre>\n';
    }
    case 'html':
      return tok.text;
    case 'hr':
      return '<hr>\n';
    case 'blockquote': {
      let out = '<blockquote>\n';
      for (const child of tok.children) out += renderBlock(child, ctx, false);
      return out + '</blockquote>\n';
    }
    case 'list': {
      const tag = tok.ordered ? 'ol' : 'ul';
      let out = '<' + tag + (tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '') + '>\n';
      for (const item of tok.items) out += '<li>' + renderItem(item, tok.tight, ctx) + '</li>\n';
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      tok.header.forEach((cell, k) => {
        out += '<th' + (tok.aligns[k] ? ' align="' + tok.aligns[k] + '"' : '') + '>' + parseInline(cell, ctx) + '</th>\n';
      });
      out += '</tr>\n</thead>\n';
      if (tok.rows.length) {
        out += '<tbody>';
        for (const row of tok.rows) {
          out += '<tr>\n';
          row.forEach((cell, k) => {
            out += '<td' + (tok.aligns[k] ? ' align="' + tok.aligns[k] + '"' : '') + '>' + parseInline(cell, ctx) + '</td>\n';
          });
          out += '</tr>\n';
        }
        out += '</tbody></table>\n';
      } else {
        out += '</table>\n';
      }
      return out;
    }
    case 'def':
      return '';
    default:
      return '';
  }
}

const TASK_RE = /^\[( |x|X)\] /;

function renderItem(item, tight, ctx) {
  const toks = item.tokens;
  let first = -1; // index of the first token if it carries a task marker
  let box = '';
  let restText = null;
  if (toks.length && toks[0].type === 'para') {
    const text = toks[0].text;
    const m = TASK_RE.exec(text);
    if (m || text === '[ ]' || text === '[x]' || text === '[X]') {
      const checked = m ? m[1] !== ' ' : text[1] !== ' ';
      box = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox">' + (m ? ' ' : '');
      restText = m ? text.slice(4) : '';
      first = 0;
    }
  }
  let out = '';
  for (let k = 0; k < toks.length; k++) {
    if (k === first) {
      // the checkbox leads the paragraph: inside the <p> for loose lists,
      // bare for tight ones
      out += tight
        ? box + parseInline(restText, ctx)
        : '<p>' + box + parseInline(restText, ctx) + '</p>\n';
    } else {
      if (tight && toks[k].deepSplit && k > 0) out += '\n\n';
      out += renderBlock(toks[k], ctx, tight);
    }
  }
  return out;
}

// --------------------------------------------------------------------- main

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const eolAtEnd = src.endsWith('\n');
  const lines = src.split('\n');
  if (eolAtEnd) lines.pop();
  const ctx = { defs: new Map(), inLink: false };
  const tokens = lexLines(lines, ctx, eolAtEnd);
  let out = '';
  for (const t of tokens) out += renderBlock(t, ctx, false);
  return out;
}
