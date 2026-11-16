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
const UNICODE_PUNCT = /\p{P}/u;
function isPunctChar(ch) {
  return ch !== undefined && (ASCII_PUNCT.has(ch) || UNICODE_PUNCT.test(ch));
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
function sliceCol(line, target) {
  let col = 0, i = 0;
  while (i < line.length && col < target) {
    const c = line[i];
    if (c === ' ') { col++; i++; } else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w > target) return ' '.repeat(col + w - target) + line.slice(i + 1);
      col += w; i++;
    } else break;
  }
  return line.slice(i);
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
  return unescapeStr(raw).replace(/\s+/g, ' ').trim().toLowerCase();
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
      if (c === '\\' && isPunctChar(s[i + 1])) { i += 2; continue; }
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
  if (q === '"' || q === "'" || q === '(') {
    const close = q === '(' ? ')' : q;
    let j = i + 1;
    let ok = false;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\' && isPunctChar(s[j + 1])) { j += 2; continue; }
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
    if (c === '\\' && isPunctChar(s[j + 1])) { j += 2; continue; }
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
    const end = rest.indexOf('-->', 4);
    if (end < 0) return null;
    const body = rest.slice(4, end);
    if (body.startsWith('>') || body.startsWith('->') || body.endsWith('-') || body.includes('--')) return null;
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
    let open = 0, close = 0;
    for (let k = 0; k < s.length; k++) {
      if (s[k] === '(') open++;
      else if (s[k] === ')') close++;
    }
    while (close > open && s.endsWith(')')) { s = s.slice(0, -1); close--; }
    if (s === before) return s;
  }
}

/** Parse an email address at i (no prefix). Returns end index or -1. */
function parseEmailAt(s, i) {
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
  if (next !== undefined && /[A-Za-z0-9_-]/.test(next)) return -1;
  return j;
}

/** Try a GFM autolink literal at position i. Returns {href, text, end}. */
function matchAutolinkLiteral(s, i) {
  const prev = i === 0 ? undefined : s[i - 1];
  // www. and http(s):// links
  if (s.startsWith('www.', i) || s.startsWith('http://', i) || s.startsWith('https://', i)) {
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
    let end = parseEmailAt(s, i + pfx);
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
    const end = parseEmailAt(s, i);
    if (end > 0) {
      const text = s.slice(i, end);
      return { href: 'mailto:' + text, text, end };
    }
  }
  return null;
}

const TEXT_STOP_RE = /[\\`\[!<&*_~\n\]]|www\.|https?:\/\/|[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@/g;

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
    while (closer.len > 0) {
      let oi = -1;
      for (let k = di - 1; k >= 0; k--) {
        const o = delims[k];
        if (o.ch !== closer.ch || !o.canOpen || o.len === 0) continue;
        if ((o.canClose || closer.canOpen) &&
            (o.len + closer.len) % 3 === 0 &&
            (o.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
        oi = k; break;
      }
      if (oi < 0) break;
      const opener = delims[oi];
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

/** Parse inline markup in `src` and return HTML. `ctx.defs` maps normalized
 *  reference labels to {dest, title}. */
function parseInline(src, ctx) {
  const nodes = [];
  const delims = [];
  const brackets = [];
  let text = '';
  let i = 0;
  const n = src.length;

  const flushText = () => {
    if (text) { nodes.push({ k: 't', s: text }); text = ''; }
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

  function closeBracket() {
    let bi = -1;
    for (let k = brackets.length - 1; k >= 0; k--) {
      if (brackets[k].active) { bi = k; break; }
    }
    if (bi < 0) return false;
    const op = brackets[bi];
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

  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') { flushText(); nodes.push({ k: 'br' }); i += 2; } else if (isPunctChar(nx)) { text += nx; i += 2; } else { text += c; i++; }
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
      if (html !== null) { flushText(); nodes.push({ k: 'html', s: html }); i += html.length; continue; }
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
      } else {
        text += '\n';
      }
      i++;
      continue;
    }
    // text run: advance to the next special character or autolink candidate
    TEXT_STOP_RE.lastIndex = i;
    const mm = TEXT_STOP_RE.exec(src);
    const j = mm ? mm.index : n;
    if (j === i) {
      const auto = matchAutolinkLiteral(src, i);
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
  return renderNodes(nodes, ctx);
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
  rest = rest.replace(/[ \t]#+$/, '');
  if (/^[ \t]*#+[ \t]*$/.test(rest)) rest = '';
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
  const [pos, col] = scanIndent(line, 3);
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
  else firstContent = ' '.repeat(3 - (markerEndCol % 4)) + line.slice(afterPos + 1);
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
  let m = /^<(pre|script|style|textarea)(?=[\t ]|\/?>)/i.exec(rest);
  if (m) return { type: 1, tag: m[1].toLowerCase() };
  if (rest.startsWith('<!--')) return { type: 2 };
  if (rest.startsWith('<?')) return { type: 3 };
  if (/^<![A-Z]/.test(rest)) return { type: 4 };
  if (rest.startsWith('<![CDATA[')) return { type: 5 };
  m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\t ]|\/?>)/.exec(rest);
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
function tryDef(lines, i, ctx) {
  const [pos, col] = scanIndent(lines[i], 3);
  if (col > 3 || lines[i][pos] !== '[') return 0;
  const s = lines.slice(i, i + 3).join('\n');
  let p = 0;
  // advance to the same '[' in the joined string (first line prefix)
  p = pos;
  // label
  let j = p + 1;
  let labelEnd = -1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && isPunctChar(s[j + 1])) { j += 2; continue; }
    if (c === '[') return 0;
    if (c === ']') { labelEnd = j; break; }
    j++;
  }
  if (labelEnd < 0 || labelEnd - p > 1000) return 0;
  const label = s.slice(p + 1, labelEnd);
  if (s[labelEnd + 1] !== ':') return 0;
  let q = labelEnd + 2;
  const skipSp = () => {
    let newlines = 0;
    while (q < s.length) {
      const c = s[q];
      if (c === ' ' || c === '\t') q++;
      else if (c === '\n') { newlines++; if (newlines > 1) return false; q++; } else break;
    }
    return true;
  };
  if (!skipSp()) return 0;
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
      if (c === '\\' && isPunctChar(s[q + 1])) { q += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (c === ' ' || c === '\t' || c === '\n' || c < ' ') break;
      q++;
    }
    if (q === start) return 0;
    dest = unescapeStr(s.slice(start, q));
  }
  const afterDest = q;
  if (!skipSp()) return 0;
  // optional title
  let title = null;
  const qc = s[q];
  if (qc === '"' || qc === "'" || qc === '(') {
    const close = qc === '(' ? ')' : qc;
    let e = q + 1;
    let ok = false;
    while (e < s.length) {
      const c = s[e];
      if (c === '\\' && isPunctChar(s[e + 1])) { e += 2; continue; }
      if (c === close) { ok = true; break; }
      if (qc === '(' && c === '(') return 0;
      e++;
    }
    if (!ok) return 0;
    title = unescapeStr(s.slice(q + 1, e));
    q = e + 1;
    // after a title, only whitespace to end of line
    while (s[q] === ' ' || s[q] === '\t') q++;
    if (q < s.length && s[q] !== '\n') return 0;
  } else {
    q = afterDest;
    while (s[q] === ' ' || s[q] === '\t') q++;
    if (q < s.length && s[q] !== '\n') return 0;
  }
  const key = normalizeLabel(label);
  if (!ctx.defs.has(key)) ctx.defs.set(key, { dest, title });
  // lines consumed: newlines crossed before q, +1
  let consumed = 1;
  for (let k = 0; k < q; k++) if (s[k] === '\n') consumed++;
  return consumed;
}

// --- tables

/** Split a table row into raw cell strings on unescaped, non-code pipes. */
function splitRow(line) {
  const cells = [];
  let cur = '';
  let inCode = 0; // backtick run length of the open code span, 0 = outside
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\' && (line[i + 1] === '|' || line[i + 1] === '\\')) {
      cur += c + line[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      let run = 0;
      while (line[i + run] === '`') run++;
      cur += '`'.repeat(run);
      if (inCode === 0) inCode = run;
      else if (run === inCode) inCode = 0;
      i += run;
      continue;
    }
    if (c === '|' && inCode === 0) { cells.push(cur); cur = ''; i++; continue; }
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
  if (isBlankLine(line)) return true;
  const [pos, col] = scanIndent(line, 3);
  if (col <= 3 && line[pos] === '>') return true;
  if (matchAtx(line) || matchFenceStart(line) || isHr(line)) return true;
  return false;
}

function tryTable(lines, i, ctx) {
  if (i + 1 >= lines.length || !isTableDelim(lines[i + 1])) return null;
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
      if (after === ' ') stripped = line.slice(pos + 2);
      else if (after === '\t') stripped = ' '.repeat(3 - ((gtCol + 1) % 4)) + line.slice(pos + 2);
      else stripped = line.slice(pos + 1);
      inner.push(stripped);
      j++;
      continue;
    }
    if (isBlankLine(line)) {
      // the quote continues only if a later line carries the marker again
      let k = j + 1;
      while (k < lines.length && isBlankLine(lines[k])) k++;
      if (k < lines.length) {
        const [p2, c2] = scanIndent(lines[k], 3);
        if (c2 <= 3 && lines[k][p2] === '>') {
          for (let b = j; b < k; b++) inner.push('');
          j = k;
          continue;
        }
      }
      break;
    }
    // lazy continuation: previous inner line non-blank, line starts no block,
    // and the inner content so far ends in a paragraph
    if (inner.length > 0 && inner[inner.length - 1] !== '' && !startsInterruptBlock(line)) {
      const toks = lexLines(inner, ctx, false);
      if (toks.length > 0 && toks[toks.length - 1].type === 'para') {
        inner.push(line);
        j++;
        continue;
      }
    }
    break;
  }
  return [{ type: 'blockquote', children: lexLines(inner, ctx, false) }, j];
}

function lexList(lines, i, ctx, eolAtEnd) {
  const first = parseMarker(lines[i]);
  if (!first) return null;
  const items = [];
  let cur = { lines: [first.firstContent], blankBefore: false, contentIndent: first.contentIndent };
  items.push(cur);
  let j = i + 1;
  let pendingBlanks = 0;
  let blankStart = -1;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlankLine(line)) {
      if (pendingBlanks === 0) blankStart = j;
      pendingBlanks++;
      j++;
      continue;
    }
    const ind = indentCols(line);
    if (ind >= cur.contentIndent) {
      for (let b = 0; b < pendingBlanks; b++) cur.lines.push('');
      pendingBlanks = 0; blankStart = -1;
      cur.lines.push(sliceCol(line, cur.contentIndent));
      j++;
      continue;
    }
    // below the content indent: sibling marker, or the list ends
    const m = parseMarker(line);
    if (m && sameListType(first, m)) {
      cur = { lines: [m.firstContent], blankBefore: pendingBlanks > 0, contentIndent: m.contentIndent };
      items.push(cur);
      pendingBlanks = 0; blankStart = -1;
      j++;
      continue;
    }
    if (pendingBlanks === 0 && cur.lines.length > 0 && !startsInterruptBlock(line)) {
      const toks = lexLines(cur.lines, ctx, false);
      if (toks.length > 0 && toks[toks.length - 1].type === 'para') {
        cur.lines.push(line);
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
    const tokens = lexLines(it.lines, ctx, false);
    if (idx > 0 && it.blankBefore) loose = true;
    for (let t = 1; t < tokens.length; t++) if (tokens[t].blankBefore) loose = true;
    return { tokens };
  });
  return [{ type: 'list', ordered: first.ordered, start: first.start, tight: !loose, items: builtItems }, j];
}

function interruptsParagraph(line) {
  if (matchAtx(line) || matchFenceStart(line) || isHr(line)) return true;
  const [pos, col] = scanIndent(line, 3);
  if (col <= 3 && line[pos] === '>') return true;
  const hb = htmlBlockStart(line);
  if (hb && hb.type !== 7) return true;
  const m = parseMarker(line);
  if (m && m.firstContent.trim() !== '' && (!m.ordered || m.start === 1)) return true;
  return false;
}

function lexLines(lines, ctx, eolAtEnd) {
  const tokens = [];
  let i = 0;
  let blankBefore = false;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { blankBefore = true; i++; continue; }
    let res = null;
    // fenced code
    const fence = matchFenceStart(line);
    if (fence) {
      const content = [];
      let j = i + 1;
      while (j < n && !isFenceClose(lines[j], fence.ch, fence.len)) {
        content.push(sliceCol(lines[j], fence.indent));
        j++;
      }
      if (j < n) j++; // consume the closing fence
      res = [{ type: 'code', lang: fence.info ? fence.info.split(/\s+/)[0] : null, text: content.length ? content.join('\n') + '\n' : '' }, j];
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
        if (j < n || eolAtEnd) text += '\n';
        res = [{ type: 'html', text }, j];
      }
    }
    // link reference definition(s)
    if (!res) {
      const used = tryDef(lines, i, ctx);
      if (used > 0) {
        // a definition produces no token; mark the following token's
        // blankBefore conservatively and continue
        i += used;
        continue;
      }
    }
    // table
    if (!res) res = tryTable(lines, i, ctx);
    // indented code
    if (!res && indentCols(line) >= 4) {
      const content = [];
      let j = i;
      while (j < n && (isBlankLine(lines[j]) || indentCols(lines[j]) >= 4)) {
        content.push(isBlankLine(lines[j]) ? '' : sliceCol(lines[j], 4));
        j++;
      }
      while (content.length && content[content.length - 1] === '') content.pop();
      res = [{ type: 'code', lang: null, text: content.length ? content.join('\n') + '\n' : '' }, j];
    }
    // paragraph (with setext conversion)
    if (!res) {
      const buf = [line];
      let j = i + 1;
      let heading = null;
      while (j < n) {
        const l = lines[j];
        if (isBlankLine(l)) break;
        const sx = setextLevel(l);
        if (sx) { heading = sx; j++; break; }
        if (interruptsParagraph(l)) break;
        buf.push(l);
        j++;
      }
      if (heading) {
        const text = buf.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        res = [{ type: 'heading', level: heading, text }, j];
      } else {
        res = [{ type: 'para', text: buf.join('\n').replace(/[ \t]+$/, '') }, j];
      }
    }
    res[0].blankBefore = blankBefore;
    blankBefore = false;
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
    default:
      return '';
  }
}

const TASK_RE = /^\[( |x|X)\] /;

function renderItem(item, tight, ctx) {
  let toks = item.tokens;
  let prefix = '';
  if (toks.length && toks[0].type === 'para') {
    const text = toks[0].text;
    const m = TASK_RE.exec(text);
    if (m) {
      const checked = m[1] !== ' ';
      prefix = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
      toks = [{ ...toks[0], text: text.slice(4) }, ...toks.slice(1)];
    } else if (text === '[ ]' || text === '[x]' || text === '[X]') {
      const checked = text[1] !== ' ';
      prefix = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox">';
      toks = [{ ...toks[0], text: '' }, ...toks.slice(1)];
    }
  }
  let out = prefix;
  for (const t of toks) out += renderBlock(t, ctx, tight);
  return out;
}

// --------------------------------------------------------------------- main

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const eolAtEnd = src.endsWith('\n');
  const lines = src.split('\n');
  if (eolAtEnd) lines.pop();
  const ctx = { defs: new Map() };
  const tokens = lexLines(lines, ctx, eolAtEnd);
  let out = '';
  for (const t of tokens) out += renderBlock(t, ctx, false);
  return out;
}
