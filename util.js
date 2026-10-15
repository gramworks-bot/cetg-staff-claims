/* CETG claim form — small shared helpers (DOM, money, dates, hashing, files). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.U = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------- DOM ---------- */
  function append(el, c) {
    if (c == null || c === false || c === true) return;
    if (Array.isArray(c)) { for (var i = 0; i < c.length; i++) append(el, c[i]); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  // h('div', {class:'x', onclick: fn, text:'…'}, child, [children])
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') { for (var s in v) el.style[s] = v[s]; }
        else if (k === 'dataset') { for (var d in v) el.dataset[d] = v[d]; }
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'readOnly' || k === 'multiple' || k === 'htmlFor') el[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function icon(name, cls) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  /* ---------- money (integer cents everywhere) ---------- */
  function money(cents) {
    if (cents == null || isNaN(cents)) return '';
    var neg = cents < 0; cents = Math.abs(Math.round(cents));
    var whole = Math.floor(cents / 100), frac = cents % 100;
    var s = String(whole).replace(/\B(?=(\d{3})+$)/g, ',');
    return (neg ? '-' : '') + s + '.' + pad2(frac);
  }
  function moneyS(cents, sym) { return (sym == null ? '$' : sym) + money(cents); }
  // Typed amount -> cents, or null when it cannot be read as money.
  // Accepts "13.8", "1,234.50", "12,50", "1.234,50", "12 50"; refuses negatives, more than 2 decimals,
  // and anything with stray marks such as "37.4013.80" (two amounts run together).
  function parseMoney(str) {
    if (str == null) return null;
    var raw = String(str).trim();
    if (/^[-−(]/.test(raw)) return null;
    var sp = /^\D*(\d[\d ]*) (\d{2})\D*$/.exec(raw);
    var s = (sp && !/[.,]/.test(raw)) ? sp[1].replace(/ /g, '') + '.' + sp[2] : raw.replace(/[^\d.,]/g, '');
    if (!s) return null;
    var lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(','), dec = -1;
    if (lastDot !== -1 && lastComma !== -1) dec = Math.max(lastDot, lastComma);       // the later mark is the decimal one
    else if (lastDot !== -1) dec = lastDot;
    else if (lastComma !== -1 && s.indexOf(',') === lastComma && /,\d{1,2}$/.test(s)) dec = lastComma;
    var wholeRaw = dec === -1 ? s : s.slice(0, dec), frac = dec === -1 ? '' : s.slice(dec + 1);
    // left of the decimal mark: digits only, or digits grouped in threes by the other mark
    var group = dec === -1 ? (wholeRaw.indexOf(',') !== -1 ? ',' : '.') : (s.charAt(dec) === '.' ? ',' : '.');
    if (!/^\d*$/.test(wholeRaw) && !new RegExp('^\\d{1,3}(\\' + group + '\\d{3})+$').test(wholeRaw)) return null;
    var whole = wholeRaw.replace(/[.,]/g, '');
    if (!/^\d{0,2}$/.test(frac) || (!whole && !frac) || whole.length > 7) return null;
    var n = parseInt(whole || '0', 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
    if (!isFinite(n) || n < 0 || n > 99999999) return null;
    return n;
  }

  /* ---------- dates (local calendar dates as 'YYYY-MM-DD', months as 'YYYY-MM') ---------- */
  function isoOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayIso() { return isoOf(new Date()); }
  function parts(iso) { return { y: +iso.slice(0, 4), m: +iso.slice(5, 7), d: +iso.slice(8, 10) }; }
  function validIso(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return false;
    var p = parts(iso), t = new Date(p.y, p.m - 1, p.d);
    return t.getFullYear() === p.y && t.getMonth() === p.m - 1 && t.getDate() === p.d;
  }
  function fmtDate(iso, style) {
    if (!validIso(iso)) return '';
    var p = parts(iso), dow = DOW_SHORT[new Date(p.y, p.m - 1, p.d).getDay()];
    if (style === 'short') return p.d + ' ' + MON_SHORT[p.m - 1];
    if (style === 'plain') return pad2(p.d) + ' ' + MON_SHORT[p.m - 1] + ' ' + p.y;
    return pad2(p.d) + ' ' + MON_SHORT[p.m - 1] + ' ' + p.y + ', ' + dow; // as on the paper form: "29 Sep 2026, Tue"
  }
  // ISO timestamp -> "05 Oct 2026" / "05 Oct 2026, 10:42". With tzo (minutes, as Date#getTimezoneOffset
  // gave it when the stamp was made) the clock time shown is the signer's, whoever opens the file later.
  function fmtStamp(isoTs, withTime, tzo) {
    if (!isoTs) return '';
    var d = new Date(isoTs);
    if (isNaN(d.getTime())) return '';
    var Y, M, D, h, m;
    if (typeof tzo === 'number' && isFinite(tzo)) {
      var t = new Date(d.getTime() - tzo * 60000);
      Y = t.getUTCFullYear(); M = t.getUTCMonth(); D = t.getUTCDate(); h = t.getUTCHours(); m = t.getUTCMinutes();
    } else { Y = d.getFullYear(); M = d.getMonth(); D = d.getDate(); h = d.getHours(); m = d.getMinutes(); }
    var s = pad2(D) + ' ' + MON_SHORT[M] + ' ' + Y;
    if (withTime) s += ', ' + pad2(h) + ':' + pad2(m);
    return s;
  }
  function monthOf(iso) { return iso.slice(0, 7); }
  function monthLabel(ym, short) {
    if (!/^\d{4}-\d{2}$/.test(ym || '')) return '';
    var m = +ym.slice(5, 7);
    return (short ? MON_SHORT : MON_LONG)[m - 1] + ' ' + ym.slice(0, 4);
  }
  function addMonths(ym, n) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + pad2(m + 1);
  }

  /* ---------- ids, hashing, bytes ---------- */
  function uid(prefix) {
    var a = new Uint8Array(9);
    (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.floor(Math.random() * 256); });
    var s = '';
    for (var i = 0; i < a.length; i++) s += (a[i] % 36).toString(36);
    return (prefix || '') + Date.now().toString(36) + s;
  }
  function hex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function utf8(str) { return new TextEncoder().encode(str); }
  // FNV-1a based 128-bit-ish fallback when SubtleCrypto is unavailable (non-secure context)
  function weakHash(bytes) {
    var out = '';
    for (var seed = 0; seed < 4; seed++) {
      var hsh = (0x811c9dc5 ^ (seed * 0x9e3779b1)) >>> 0;
      for (var i = 0; i < bytes.length; i++) { hsh ^= bytes[i]; hsh = Math.imul(hsh, 0x01000193) >>> 0; }
      out += ('00000000' + hsh.toString(16)).slice(-8);
    }
    return 'w' + out;
  }
  // SHA-256 where the browser offers it (https), otherwise the weak "w…" hash. Pass weak=true to check a
  // value that was made with the weak hash.
  function sha256(data, weak) {
    var bytes = typeof data === 'string' ? utf8(data) : (data instanceof Uint8Array ? data : new Uint8Array(data));
    if (weak) return Promise.resolve(weakHash(bytes));
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle.digest('SHA-256', bytes).then(hex, function () { return weakHash(bytes); });
    }
    return Promise.resolve(weakHash(bytes));
  }
  // Can this browser make a real SHA-256? (Only pages opened over https, or on this computer itself, can.)
  function canSha() { return typeof crypto !== 'undefined' && !!(crypto.subtle && crypto.subtle.digest); }
  function shortPrint(hash) { // "4f2a91c3…" -> "4F2A-91C3-0B7D"
    var s = String(hash || '').replace(/^w/, '').slice(0, 12).toUpperCase();
    return s ? s.replace(/(.{4})(?=.)/g, '$1-') : '';
  }
  function bytesToB64(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), s = '', CH = 0x8000;
    for (var i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
    return btoa(s);
  }
  function b64ToBytes(b64) {
    var s = atob(b64), b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }
  function dataUrlToBytes(url) {
    var i = String(url).indexOf(',');
    return b64ToBytes(String(url).slice(i + 1));
  }
  function b64url(str) { return bytesToB64(utf8(str)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function unb64url(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return new TextDecoder().decode(b64ToBytes(s));
  }
  function isPngDataUrl(s) { return typeof s === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s) && s.length < 400000; }
  // One plain address (no display name, no list, nothing that could smuggle extra headers into an
  // email link). The same test wherever an address is typed or read back.
  function isEmail(s) { return typeof s === 'string' && s.length <= 120 && /^[A-Za-z0-9.!$*+\/'^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(s) && s.indexOf('..') === -1; }

  /* ---------- misc ---------- */
  function debounce(fn, ms) {
    var t = null;
    function run() { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { t = null; fn.apply(self, a); }, ms); }
    run.flush = function () { if (t) { clearTimeout(t); t = null; fn(); } };
    return run;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function initials(name) {
    var p = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return 'XX';
    var s = p.length === 1 ? p[0].slice(0, 2) : p[0].charAt(0) + p[p.length - 1].charAt(0);
    return s.toUpperCase().replace(/[^A-Z0-9]/g, 'X');
  }
  function slug(s) { return String(s || '').trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'claim'; }
  function csvCell(v) {
    var s = v == null ? '' : String(v), i = 0, c;
    // Keep spreadsheets from treating text as a formula: also behind leading spaces or invisible
    // characters, and for the full-width forms of = + - @.
    for (; i < s.length; i++) { c = s.charCodeAt(i); if (!(c <= 0x20 || c === 0xA0 || (c >= 0x200B && c <= 0x200D) || c === 0xFEFF)) break; }
    c = s.charCodeAt(i);
    if (c === 0x3D || c === 0x2B || c === 0x2D || c === 0x40 || c === 0xFF1D || c === 0xFF0B || c === 0xFF0D || c === 0xFF20 || /^[\t\r]/.test(s)) s = "'" + s;
    return /[",;\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  return {
    h: h, icon: icon, clear: clear, append: append,
    money: money, moneyS: moneyS, parseMoney: parseMoney,
    isoOf: isoOf, todayIso: todayIso, validIso: validIso, fmtDate: fmtDate, fmtStamp: fmtStamp, monthOf: monthOf, monthLabel: monthLabel, addMonths: addMonths,
    uid: uid, sha256: sha256, canSha: canSha, shortPrint: shortPrint, hex: hex, utf8: utf8,
    bytesToB64: bytesToB64, b64ToBytes: b64ToBytes, dataUrlToBytes: dataUrlToBytes, b64url: b64url, unb64url: unb64url, isPngDataUrl: isPngDataUrl, isEmail: isEmail,
    debounce: debounce, clone: clone, initials: initials, slug: slug, csvCell: csvCell, pad2: pad2
  };
});
