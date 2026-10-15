/* CETG claim form — the signed PDF "claim pack".
 * build(): lays the claim out like the paper Staff Reimbursement Claim Form (table, total, signature
 *          blocks, receipt pages) and tucks the claim data inside the PDF so the approver's copy of
 *          this page can open the same file, check it and countersign.
 * read():  opens such a PDF again and returns the claim data plus the receipt images.
 * The fingerprint (shown to people as the "check code") is a checksum over the claim data that was
 * signed. It shows that the data is intact; it does not prove who made the file, and it does not
 * cover the drawn pages, which is why the approver's copy of the form always works from the data.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'));
  else root.ClaimPDF = factory(root.U);
})(typeof self !== 'undefined' ? self : this, function (U) {
  'use strict';

  var injected = null;
  function lib() {
    var L = injected || (typeof PDFLib !== 'undefined' ? PDFLib : null);
    if (!L) throw new Error('PDF library not loaded');
    return L;
  }
  var A4 = [595.28, 841.89], M = 40, CW = A4[0] - 2 * M;
  var ATTACH_NAME = 'cetg-claim.json', TAG = 'CETGReceipt', FORMAT = 2;
  var TYPE_LABEL = { ride: 'Taxi / private hire', parking: 'Parking', transit: 'Public transport', erp: 'ERP / tolls', other: 'Other expense' };
  var MAX = { name: 80, purpose: 200, desc: 300, place: 200, note: 1000, title: 120, ref: 40, lines: 400 };
  // ids are the app's own: a letter, then the time and random part in lower-case letters and digits (never a word such as "constructor")
  var RE_ID = /^[a-z][0-9a-z]{12,40}$/, RE_HASH = /^w?[0-9a-f]{16,64}$/, RE_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
  var RE_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+\-]\d{2}:\d{2})$/;
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /* ---------- hygiene: the very same rules where a claim is signed and where it is read back ---------- */
  // One line of plain text: control and direction-override characters out, runs of white space to one space.
  function clean(v, max) {
    if (typeof v !== 'string') return '';
    var s = v.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ');
    var out = '';
    for (var i = 0; i < s.length; i++) { // unpaired surrogates would not survive being saved and read again
      var c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) { var d = s.charCodeAt(i + 1); if (d >= 0xDC00 && d <= 0xDFFF) { out += s.charAt(i) + s.charAt(i + 1); i++; } continue; }
      if (c >= 0xDC00 && c <= 0xDFFF) continue;
      out += s.charAt(i);
    }
    out = out.trim();
    if (max && out.length > max) {
      out = out.slice(0, max);
      if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
      out = out.trim();
    }
    return out;
  }
  function int(v) { v = Math.round(Number(v)); return isFinite(v) && v > 0 && v <= 9007199254740991 ? v : 0; }
  function tzoOf(v) { return typeof v === 'number' && isFinite(v) && Math.abs(v) <= 900 ? Math.round(v) : null; }
  function stampOf(v) { return typeof v === 'string' && RE_STAMP.test(v) && !isNaN(Date.parse(v)) ? v : ''; }
  function idOf(v) { return typeof v === 'string' && RE_ID.test(v) ? v : ''; }
  function hashOf(v) { return typeof v === 'string' && RE_HASH.test(v) ? v : ''; }
  function sigOf(v) { return U.isPngDataUrl(v) ? v : ''; }
  function emailOf(v) { return typeof v === 'string' && U.isEmail(v) ? v : ''; }
  function typeOf(v) { return typeof v === 'string' && own(TYPE_LABEL, v) ? v : 'other'; }
  function dateOf(v) { return typeof v === 'string' && U.validIso(v) ? v : ''; }
  // Where the amount sits on the receipt image, as fractions of its width and height.
  function hlOf(hl) {
    if (!Array.isArray(hl) || hl.length !== 4) return null;
    var out = [];
    for (var i = 0; i < 4; i++) {
      var n = hl[i];
      if (typeof n !== 'number' || !(n >= 0 && n <= 1)) return null;
      out.push(Math.round(n * 1e4) / 1e4);
    }
    return out[2] > out[0] && out[3] > out[1] ? out : null;
  }

  /* ---------- fingerprint: a checksum over exactly what was signed ---------- */
  function canonical(claim) {
    return JSON.stringify({
      v: FORMAT, series: idOf(claim.series), rev: int(claim.rev), title: clean(claim.formTitle, MAX.title),
      staff: clean(claim.signedName, MAX.name), email: emailOf(claim.staffEmail), month: String(claim.month || ''), purpose: clean(claim.purpose, MAX.purpose),
      lines: (claim.lines || []).map(function (l) {
        var hl = hlOf(l.hl);
        return [dateOf(l.date), clean(l.desc, MAX.desc), clean(l.from, MAX.place), clean(l.to, MAX.place), int(l.amountCents), hashOf(l.receiptHash), typeOf(l.type),
          hl ? hl.map(function (n) { return Math.round(n * 1e4); }).join(',') : ''];
      }),
      total: int(claim.totalCents), signedAt: stampOf(claim.signedAt), tzo: tzoOf(claim.tzo), sig: sigOf(claim.signature)
    });
  }
  // `like` is a fingerprint made earlier: one that starts with "w" was made where the browser had no
  // SHA-256 (a page not opened over https), so it is checked with the same simple hash.
  function fingerprint(claim, like) { return U.sha256(canonical(claim), typeof like === 'string' && like.charAt(0) === 'w'); }

  /* ---------- data read back from a file is untrusted ---------- */
  function sanitize(p) {
    if (!p || typeof p !== 'object' || p.kind !== 'cetg-claim' || p.v !== FORMAT || !p.claim || typeof p.claim !== 'object') return null;
    var c = p.claim;
    if (!Array.isArray(c.lines) || !c.lines.length || c.lines.length > MAX.lines) return null;
    if (typeof c.month !== 'string' || !RE_MONTH.test(c.month)) return null;
    var out = {
      v: FORMAT, kind: 'cetg-claim',
      approverName: clean(p.approverName, MAX.name), generatedAt: stampOf(p.generatedAt),
      claim: {
        // series: one id for a person's claim for a month, kept through unlock and re-signing; rev counts the signings
        series: idOf(c.series), rev: int(c.rev), formTitle: clean(c.formTitle, MAX.title),
        ref: clean(c.ref, MAX.ref), month: c.month, purpose: clean(c.purpose, MAX.purpose),
        staffName: clean(c.staffName, MAX.name), staffEmail: emailOf(c.staffEmail),
        signedAt: stampOf(c.signedAt), tzo: tzoOf(c.tzo), signedName: clean(c.signedName, MAX.name),
        signature: sigOf(c.signature), fingerprint: hashOf(c.fingerprint), totalCents: int(c.totalCents),
        lines: c.lines.map(function (l, i) {
          l = l && typeof l === 'object' ? l : {};
          return {
            n: i + 1, date: dateOf(l.date), desc: clean(l.desc, MAX.desc), from: clean(l.from, MAX.place), to: clean(l.to, MAX.place),
            amountCents: int(l.amountCents), type: typeOf(l.type), receiptId: idOf(l.receiptId), receiptHash: hashOf(l.receiptHash), hl: hlOf(l.hl)
          };
        })
      },
      approval: null
    };
    var a = p.approval;
    if (a && typeof a === 'object' && a.decision === 'approved') {
      out.approval = { decision: 'approved', name: clean(a.name, MAX.name), at: stampOf(a.at), tzo: tzoOf(a.tzo), note: clean(a.note, MAX.note), signature: sigOf(a.signature) };
    }
    return out;
  }

  /* ---------- text Helvetica cannot draw (Chinese, Tamil, emoji and so on) ----------
   * The browser draws it on a canvas and it goes into the PDF as a small picture, so it prints as typed. */
  var K = 4; // canvas pixels per PDF point
  function canPaint() { return typeof document !== 'undefined' && typeof document.createElement === 'function'; }
  function graphemes(s) {
    try {
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        var out = [], it = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)[Symbol.iterator](), r;
        while (!(r = it.next()).done) out.push(r.value.segment);
        return out;
      }
    } catch (e) { /* fall through */ }
    return Array.from ? Array.from(s) : s.split('');
  }
  function picture(text, o) { // o: { size, lh, maxW, bold, css }
    var c = document.createElement('canvas'), ctx = c.getContext && c.getContext('2d');
    if (!ctx) return null;
    var fontCss = (o.bold ? '700 ' : '400 ') + Math.round(o.size * K) + 'px Helvetica, Arial, "Liberation Sans", sans-serif';
    ctx.font = fontCss;
    function w(t) { return ctx.measureText(t).width; }
    var maxPx = o.maxW * K, lines = [], cur = '';
    text.split(' ').filter(Boolean).forEach(function (word) {
      if (w(word) > maxPx) { // a long unbroken run, which is also how text without spaces wraps
        if (cur) { lines.push(cur); cur = ''; }
        graphemes(word).forEach(function (g) { if (cur && w(cur + g) > maxPx) { lines.push(cur); cur = g; } else cur += g; });
        return;
      }
      var t = cur ? cur + ' ' + word : word;
      if (w(t) <= maxPx) cur = t; else { lines.push(cur); cur = word; }
    });
    if (cur) lines.push(cur);
    if (!lines.length) return null;
    var widest = 0;
    lines.forEach(function (ln) { widest = Math.max(widest, w(ln)); });
    var pw = Math.max(1, Math.ceil(Math.min(widest, maxPx)) + 2), ph = Math.ceil(lines.length * o.lh * K);
    c.width = pw; c.height = ph;
    ctx = c.getContext('2d');
    ctx.font = fontCss; ctx.fillStyle = o.css || '#121724'; ctx.textBaseline = 'alphabetic';
    var base = o.lh - 0.22 * o.size;
    lines.forEach(function (ln, i) { ctx.fillText(ln, 1, (i * o.lh + base) * K); });
    var url = c.toDataURL('image/png');
    c.width = c.height = 0; // hand the memory back straight away
    return { url: url, w: pw / K, h: ph / K, rows: lines.length, base: base };
  }

  /* ---------- build ---------- */
  function build(input) {
    var L = lib();
    var rgb = L.rgb, INK = rgb(0.07, 0.09, 0.14), GREY = rgb(0.42, 0.45, 0.52), RULE = rgb(0.25, 0.27, 0.33), FILL = rgb(0.93, 0.94, 0.96), GREEN = rgb(0.07, 0.45, 0.28);
    var INK_CSS = '#121724', GREY_CSS = '#6b7385';
    var claim = input.claim, approval = input.approval || null, receipts = input.receipts || {};
    var lines = claim.lines || [];
    if (!lines.length || lines.length > MAX.lines) return Promise.reject(new Error('A claim holds between 1 and ' + MAX.lines + ' items'));
    var doc, font, bold, ital, charset, page, y;
    var blocks = {}, jobs = [];

    function plain(s) { // -> what Helvetica can draw, and whether anything was lost on the way
      s = String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ');
      var out = '', lossy = false;
      for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i), code = s.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) { i++; out += '?'; lossy = true; continue; }
        if (charset.has(code)) { out += ch; continue; }
        lossy = true;
        var base = ch.normalize ? ch.normalize('NFKD').replace(/[̀-ͯ]/g, '') : '';
        var ok = base && base.split('').every(function (c) { return charset.has(c.charCodeAt(0)); });
        out += ok ? base : '?';
      }
      return { text: out, lossy: lossy };
    }
    function safe(s) { return plain(s).text; }
    function tw(f, s, size) { return f.widthOfTextAtSize(s, size); }
    function wrap(s, f, size, maxW) {
      var words = safe(s).split(/\s+/).filter(Boolean), out = [], cur = '';
      words.forEach(function (w) {
        while (tw(f, w, size) > maxW && w.length > 1) {
          var i = w.length - 1;
          while (i > 1 && tw(f, w.slice(0, i), size) > maxW) i--;
          if (cur) { out.push(cur); cur = ''; }
          out.push(w.slice(0, i)); w = w.slice(i);
        }
        var t = cur ? cur + ' ' + w : w;
        if (tw(f, t, size) <= maxW) cur = t; else { if (cur) out.push(cur); cur = w; }
      });
      if (cur) out.push(cur);
      return out.length ? out : [''];
    }
    // Reserve a piece of text for the layout below. Plain text is wrapped now; anything Helvetica
    // cannot draw becomes a picture first (in a browser), which is why this runs before the layout.
    function want(key, text, o) { // o: { font, size, lh, maxW, bold, css, one }
      text = clean(String(text == null ? '' : text), 2000);
      var p = plain(text);
      function asText() {
        if (!o.one) return { lines: wrap(text, o.font, o.size, o.maxW), size: o.size };
        var size = o.size, t = p.text;
        while (tw(o.font, t, size) > o.maxW && size > 7) size -= 0.5;
        while (tw(o.font, t, size) > o.maxW && t.length > 4) t = t.slice(0, -4) + '...';
        return { lines: [t], size: size };
      }
      if (!p.lossy || !canPaint()) { blocks[key] = asText(); return; }
      jobs.push(Promise.resolve().then(function () {
        var pic = picture(text, { size: o.size, lh: o.lh, maxW: o.one ? 4000 : o.maxW, bold: !!o.bold, css: o.css });
        if (!pic) throw new Error('no canvas');
        return doc.embedPng(U.dataUrlToBytes(pic.url)).then(function (img) {
          var s = o.one ? Math.min(1, o.maxW / pic.w) : 1; // a single line is scaled down to fit
          blocks[key] = { img: img, w: pic.w * s, h: pic.h * s, rows: pic.rows, base: pic.base * s };
        });
      }).catch(function () { blocks[key] = asText(); }));
    }
    function rowsOf(b) { return b.img ? b.rows : b.lines.length; }
    // Draw a reserved block with its first baseline at baseY. o: { font, lh, color, align, width }
    function draw(b, x, baseY, o) {
      o = o || {};
      function at(wd) { return o.align === 'right' ? x + o.width - wd : o.align === 'center' ? x + (o.width - wd) / 2 : x; }
      if (b.img) { page.drawImage(b.img, { x: at(b.w), y: baseY + b.base - b.h, width: b.w, height: b.h }); return; }
      b.lines.forEach(function (ln, i) {
        page.drawText(ln, { x: at(tw(o.font || font, ln, b.size)), y: baseY - i * (o.lh || 12), size: b.size, font: o.font || font, color: o.color || INK });
      });
    }
    function widthOf(b, f) { return b.img ? b.w : Math.max.apply(null, b.lines.map(function (ln) { return tw(f, ln, b.size); })); }
    function txt(s, x, yy, o) { o = o || {}; page.drawText(safe(s), { x: x, y: yy, size: o.size || 10, font: o.font || font, color: o.color || INK }); }
    function newPage() { page = doc.addPage(A4); y = A4[1] - M; }
    function hline(x1, x2, yy, t, c) { page.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness: t || 0.6, color: c || RULE }); }
    function embedSig(dataUrl) {
      if (!U.isPngDataUrl(dataUrl)) return Promise.resolve(null);
      return doc.embedPng(U.dataUrlToBytes(dataUrl)).catch(function () { return null; });
    }

    var COLS = [
      { key: 'n', title: 'S/No', w: 32, align: 'center' },
      { key: 'date', title: 'Date', w: 94 },
      { key: 'desc', title: 'Item Description', w: 157 },
      { key: 'from', title: 'Start', w: 86 },
      { key: 'to', title: 'To', w: 86 },
      { key: 'amt', title: 'Claim $', w: 60, align: 'right' }
    ];
    var FS = 9.5, LH = 12, PAD = 5, FOOT = 26, BOXH = 132, GAP = 12, BW = (CW - GAP) / 2;

    function cellOf(text, w, o) { o = o || {}; return { w: w, b: { lines: [safe(text)], size: FS }, font: o.font, align: o.align }; }
    function rowHeight(cells) { return Math.max.apply(null, cells.map(function (c) { return rowsOf(c.b); })) * LH + 2 * PAD - 2; }
    function drawCells(cells, o) {
      o = o || {};
      var hgt = rowHeight(cells), x = M;
      cells.forEach(function (c) {
        page.drawRectangle({ x: x, y: y - hgt, width: c.w, height: hgt, borderColor: RULE, borderWidth: 0.6, color: o.fill || undefined });
        draw(c.b, x + PAD, y - PAD - FS + 1.5, { font: c.font || font, lh: LH, align: c.align, width: c.w - 2 * PAD });
        x += c.w;
      });
      y -= hgt;
    }
    function headerRow() {
      drawCells(COLS.map(function (c) { return cellOf(c.title, c.w, { font: bold, align: c.align }); }), { fill: FILL });
    }

    return L.PDFDocument.create().then(function (d) {
      doc = d;
      return Promise.all([doc.embedFont(L.StandardFonts.Helvetica), doc.embedFont(L.StandardFonts.HelveticaBold), doc.embedFont(L.StandardFonts.HelveticaOblique)]);
    }).then(function (fs) {
      font = fs[0]; bold = fs[1]; ital = fs[2];
      charset = new Set(font.getCharacterSet());

      /* everything typed by a person is reserved first (see want) */
      want('title', claim.formTitle || 'Staff Reimbursement Claim Form', { font: bold, size: 14, lh: 18, maxW: CW, bold: true, css: INK_CSS, one: true });
      want('purpose', claim.purpose || 'Transport', { font: bold, size: 10.5, lh: 14, maxW: CW, bold: true, css: INK_CSS });
      lines.forEach(function (l, i) {
        want('d' + i, clean(l.desc, MAX.desc) || '-', { font: font, size: FS, lh: LH, maxW: COLS[2].w - 2 * PAD, css: INK_CSS });
        want('f' + i, clean(l.from, MAX.place) || '-', { font: font, size: FS, lh: LH, maxW: COLS[3].w - 2 * PAD, css: INK_CSS });
        want('t' + i, clean(l.to, MAX.place) || '-', { font: font, size: FS, lh: LH, maxW: COLS[4].w - 2 * PAD, css: INK_CSS });
      });
      want('staff', claim.signedName || claim.staffName || '', { font: bold, size: 10, lh: 14, maxW: BW - 20 - tw(font, 'Name of Staff: ', 10), bold: true, css: INK_CSS, one: true });
      want('approver', (approval && approval.name) || input.approverName || '', { font: bold, size: 10, lh: 14, maxW: BW - 20, bold: true, css: INK_CSS, one: true });
      if (approval && approval.note) want('note', 'Approver note: ' + approval.note, { font: font, size: 8.5, lh: 11, maxW: CW, css: GREY_CSS });
      return Promise.all(jobs.concat([embedSig(claim.signature), embedSig(approval && approval.signature)]));
    }).then(function (res) {
      var staffSig = res[res.length - 2], apprSig = res[res.length - 1];
      newPage();

      /* title */
      var tb = blocks.title, twd = widthOf(tb, bold), tx = M + (CW - twd) / 2;
      y -= 14;
      draw(tb, tx, y, { font: bold });
      hline(tx, tx + twd, y - 2.5, 0.9, INK);
      y -= 20;
      var period = 'Claim period: ' + U.monthLabel(claim.month) + (claim.ref ? '    Ref: ' + clean(claim.ref, MAX.ref) : '');
      txt(period, M + (CW - tw(font, safe(period), 9)) / 2, y, { size: 9, color: GREY });
      y -= 24;

      /* purpose */
      txt('Purpose of Claim (to state the project or work related to):', M, y, { size: 10.5 });
      y -= 15;
      draw(blocks.purpose, M, y, { font: bold, lh: 14 });
      y -= rowsOf(blocks.purpose) * 14 + 6;

      /* table */
      headerRow();
      var noReceipt = [];
      lines.forEach(function (l, i) {
        var n = U.pad2(i + 1);
        if (!l.receiptId || !receipts[l.receiptId]) noReceipt.push(n);
        var cells = [
          cellOf(n, COLS[0].w, { align: 'center' }),
          { w: COLS[1].w, b: { lines: wrap(U.fmtDate(l.date) || '-', font, FS, COLS[1].w - 2 * PAD), size: FS } },
          { w: COLS[2].w, b: blocks['d' + i] }, { w: COLS[3].w, b: blocks['f' + i] }, { w: COLS[4].w, b: blocks['t' + i] },
          cellOf('$' + U.money(int(l.amountCents)), COLS[5].w, { font: bold, align: 'right' })
        ];
        if (y - rowHeight(cells) < M + FOOT) { newPage(); headerRow(); }
        drawCells(cells);
      });
      var totalCells = [
        cellOf('Total claim (' + lines.length + ' item' + (lines.length === 1 ? '' : 's') + ')', CW - COLS[5].w, { font: bold, align: 'right' }),
        cellOf('$' + U.money(int(claim.totalCents)), COLS[5].w, { font: bold, align: 'right' })
      ];
      if (y - rowHeight(totalCells) < M + FOOT) { newPage(); headerRow(); }
      drawCells(totalCells, { fill: FILL });
      y -= 10;
      if (noReceipt.length) {
        wrap('No receipt attached for item' + (noReceipt.length > 1 ? 's ' : ' ') + noReceipt.join(', ') + '.', font, 8.5, CW).forEach(function (ln) {
          if (y - 13 < M + FOOT) newPage();
          txt(ln, M, y - 2, { size: 8.5, color: GREY }); y -= 11;
        });
        y -= 2;
      }

      /* declaration */
      var decl = 'I certify that these expenses were incurred on company business, that each amount matches its receipt, and that they have not been claimed elsewhere.';
      var dl = wrap(decl, ital, 8.5, CW);
      if (y - (dl.length * 11 + 10 + BOXH) < M + FOOT) newPage();
      dl.forEach(function (ln) { y -= 11; page.drawText(ln, { x: M, y: y, size: 8.5, font: ital, color: GREY }); });
      y -= 10;

      /* signature blocks */
      var top = y;
      [0, 1].forEach(function (k) { page.drawRectangle({ x: M + k * (BW + GAP), y: top - BOXH, width: BW, height: BOXH, borderColor: RULE, borderWidth: 0.6 }); });
      // left: submitted by
      var lx = M + 10, ly = top - 18;
      txt('Submitted by:', lx, ly, { size: 10, font: bold }); ly -= 17;
      txt('Name of Staff: ', lx, ly, { size: 10 });
      draw(blocks.staff, lx + tw(font, 'Name of Staff: ', 10), ly, { font: bold });
      ly -= 15;
      txt('Date of Claim: ' + (U.fmtStamp(claim.signedAt, false, tzoOf(claim.tzo)) || ''), lx, ly, { size: 10 }); ly -= 8;
      if (staffSig) {
        var s1 = staffSig.scaleToFit(150, 44);
        page.drawImage(staffSig, { x: lx, y: ly - s1.height, width: s1.width, height: s1.height });
      }
      txt(claim.signedAt ? 'Signed electronically ' + U.fmtStamp(claim.signedAt, true, tzoOf(claim.tzo)) : 'Not signed', lx, top - BOXH + 8, { size: 7.5, color: GREY });
      // right: approved by
      var rx = M + BW + GAP + 10, ry = top - 18;
      txt('Approved by:', rx, ry, { size: 10, font: bold }); ry -= 17;
      txt('Name of Authorised Signatory:', rx, ry, { size: 10 }); ry -= 14;
      draw(blocks.approver, rx, ry, { font: bold });
      ry -= 15;
      txt('Date of Approval: ' + (approval ? U.fmtStamp(approval.at, false, tzoOf(approval.tzo)) : ''), rx, ry, { size: 10 });
      if (!approval) hline(rx + tw(font, 'Date of Approval: ', 10), rx + BW - 24, ry - 1.5, 0.5, GREY);
      ry -= 8;
      if (approval) {
        if (apprSig) {
          var s2 = apprSig.scaleToFit(130, 40);
          page.drawImage(apprSig, { x: rx, y: ry - s2.height, width: s2.width, height: s2.height });
        }
        txt('Approved electronically ' + U.fmtStamp(approval.at, true, tzoOf(approval.tzo)), rx, top - BOXH + 8, { size: 7.5, color: GREY });
        // stamp
        var label = 'APPROVED', ssz = 13, deg = 8, th = deg * Math.PI / 180, sw = tw(bold, label, ssz) + 14, sh = ssz + 9;
        var sx = M + CW - sw - 12, sy = top - BOXH + 30;
        page.drawRectangle({ x: sx, y: sy, width: sw, height: sh, borderColor: GREEN, borderWidth: 1.5, rotate: L.degrees(deg), borderOpacity: 0.9 });
        page.drawText(label, { x: sx + 7 * Math.cos(th) - 6 * Math.sin(th), y: sy + 7 * Math.sin(th) + 6 * Math.cos(th), size: ssz, font: bold, color: GREEN, rotate: L.degrees(deg), opacity: 0.9 });
      } else {
        txt('Awaiting approval', rx, top - BOXH + 8, { size: 7.5, color: GREY });
      }
      y = top - BOXH - 12;
      if (blocks.note) {
        var nrows = rowsOf(blocks.note);
        if (y - nrows * 11 < M + FOOT) newPage();
        y -= 11;
        draw(blocks.note, M, y, { font: font, lh: 11, color: GREY });
        y -= (nrows - 1) * 11;
      }

      /* receipts */
      var withR = lines.map(function (l, i) { return { l: l, n: U.pad2(i + 1), r: l.receiptId && receipts[l.receiptId] }; }).filter(function (o) { return o.r; });
      var chain = Promise.resolve();
      if (withR.length) {
        // Four receipts to a page, two across. A long, narrow receipt (a scrolling screenshot) takes a
        // whole column so that it stays readable.
        var cgap = 14, cw = (CW - cgap) / 2, capH = 16, imgH = 318, cellH = capH + imgH + 12, used = [], next = 4, first = true, gridTop = 0;
        var place = function (tall) {
          for (;;) {
            for (var p = next; p < 4; p++) {
              if (used[p] || (tall && (p > 1 || used[p + 2]))) continue;
              used[p] = true; if (tall) used[p + 2] = true;
              next = p + 1;
              return p;
            }
            newPage();
            txt(first ? 'Receipts' : 'Receipts (continued)', M, y - 12, { size: 12, font: bold });
            txt('Numbered to match the S/No on the claim.', M + (first ? 62 : 132), y - 12, { size: 8.5, color: GREY });
            gridTop = y - 30; used = [false, false, false, false]; next = 0; first = false;
          }
        };
        withR.forEach(function (o) {
          chain = chain.then(function () {
            var bytes = o.r.bytes instanceof Uint8Array ? o.r.bytes : new Uint8Array(o.r.bytes);
            return doc.embedJpg(bytes).then(function (img) {
              return img.embed().then(function () {
                try { doc.context.lookup(img.ref).dict.set(L.PDFName.of(TAG), L.PDFString.of(o.l.receiptId)); } catch (e) { /* tagging is best-effort */ }
                return img;
              });
            }, function () { return null; });
          }).then(function (img) {
            var tall = !!img && img.height / img.width > 2.2, p = place(tall);
            var cx = M + (p % 2) * (cw + cgap), cy = gridTop - Math.floor(p / 2) * cellH, room = tall ? imgH + cellH : imgH;
            txt('Receipt ' + o.n, cx, cy - 10, { size: 9.5, font: bold });
            txt(U.fmtDate(o.l.date, 'plain') + '   $' + U.money(int(o.l.amountCents)), cx + tw(bold, 'Receipt ' + o.n, 9.5) + 8, cy - 10, { size: 8.5, color: GREY });
            if (img) {
              var sc = img.scaleToFit(cw - 2, room - 2);
              var ix = cx + 1, iy = cy - capH - sc.height - 1;
              page.drawImage(img, { x: ix, y: iy, width: sc.width, height: sc.height });
              page.drawRectangle({ x: ix - 0.5, y: iy - 0.5, width: sc.width + 1, height: sc.height + 1, borderColor: rgb(0.78, 0.8, 0.85), borderWidth: 0.5 });
            } else {
              txt('This receipt image could not be added.', cx, cy - capH - 14, { size: 8.5, color: GREY });
            }
          });
        });
      }
      return chain;
    }).then(function () {
      /* footers */
      var pages = doc.getPages(), total = pages.length;
      var left = (claim.ref ? clean(claim.ref, MAX.ref) + '   ' : '') + (claim.fingerprint ? 'Check code ' + U.shortPrint(claim.fingerprint) : '');
      pages.forEach(function (p, i) {
        p.drawLine({ start: { x: M, y: M - 6 }, end: { x: M + CW, y: M - 6 }, thickness: 0.4, color: rgb(0.8, 0.82, 0.86) });
        p.drawText(safe(left), { x: M, y: M - 17, size: 7.5, font: font, color: GREY });
        var pg = 'Page ' + (i + 1) + ' of ' + total;
        p.drawText(pg, { x: M + CW - tw(font, pg, 7.5), y: M - 17, size: 7.5, font: font, color: GREY });
      });

      /* data for the approver's copy of the form: written already tidied, so reading it back changes nothing */
      var payload = {
        v: FORMAT, kind: 'cetg-claim', approverName: clean(input.approverName, MAX.name), generatedAt: new Date().toISOString(),
        claim: {
          series: idOf(claim.series), rev: int(claim.rev), formTitle: clean(claim.formTitle, MAX.title),
          ref: clean(claim.ref, MAX.ref), month: String(claim.month || ''), purpose: clean(claim.purpose, MAX.purpose), staffName: clean(claim.staffName, MAX.name), staffEmail: emailOf(claim.staffEmail),
          signedAt: stampOf(claim.signedAt), tzo: tzoOf(claim.tzo), signedName: clean(claim.signedName, MAX.name), signature: sigOf(claim.signature), fingerprint: hashOf(claim.fingerprint), totalCents: int(claim.totalCents),
          lines: lines.map(function (l, i) {
            return { n: i + 1, date: dateOf(l.date), desc: clean(l.desc, MAX.desc), from: clean(l.from, MAX.place), to: clean(l.to, MAX.place), amountCents: int(l.amountCents), type: typeOf(l.type),
              receiptId: (l.receiptId && receipts[l.receiptId]) ? idOf(l.receiptId) : '', receiptHash: hashOf(l.receiptHash), hl: hlOf(l.hl) };
          })
        },
        approval: approval ? { decision: 'approved', name: clean(approval.name, MAX.name), at: stampOf(approval.at), tzo: tzoOf(approval.tzo), note: clean(approval.note, MAX.note), signature: sigOf(approval.signature) } : null
      };
      var who = clean(claim.signedName, MAX.name) || clean(claim.staffName, MAX.name) || 'Staff';
      doc.setTitle((clean(claim.formTitle, MAX.title) || 'Staff Reimbursement Claim') + ' - ' + who + ' - ' + U.monthLabel(claim.month));
      doc.setAuthor(who);
      doc.setSubject('Staff reimbursement claim' + (approval ? ' (approved)' : ''));
      doc.setCreator('CETG Transport & Expense Claim Form');
      doc.setProducer('CETG Transport & Expense Claim Form (pdf-lib)');
      doc.setCreationDate(new Date());
      return doc.attach(U.utf8(JSON.stringify(payload)), ATTACH_NAME, { mimeType: 'application/json', description: 'Claim data used by the CETG claim form to check and approve this claim' });
    }).then(function () {
      return doc.save();
    });
  }

  /* ---------- read ---------- */
  function read(bytes) {
    var L = lib();
    return L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }).then(function (doc) {
      var files = {};
      function walk(node, depth) {
        if (!node || depth > 8) return;
        var arr = node.lookupMaybe(L.PDFName.of('Names'), L.PDFArray);
        if (arr) {
          for (var i = 0; i + 1 < arr.size(); i += 2) {
            try {
              var nameObj = arr.lookup(i), spec = arr.lookup(i + 1, L.PDFDict);
              var ef = spec.lookup(L.PDFName.of('EF'), L.PDFDict);
              var stream = ef.lookup(L.PDFName.of('F'), L.PDFStream);
              var name = nameObj && nameObj.decodeText ? nameObj.decodeText() : String(nameObj);
              if (name !== ATTACH_NAME) continue;
              files[name] = stream instanceof L.PDFRawStream ? L.decodePDFRawStream(stream).decode() : stream.getContents();
            } catch (e) { /* skip a damaged entry */ }
          }
        }
        var kids = node.lookupMaybe(L.PDFName.of('Kids'), L.PDFArray);
        if (kids) for (var k = 0; k < kids.size(); k++) { try { walk(kids.lookup(k, L.PDFDict), depth + 1); } catch (e) { /* skip */ } }
      }
      try {
        var names = doc.catalog.lookupMaybe(L.PDFName.of('Names'), L.PDFDict);
        var efRoot = names && names.lookupMaybe(L.PDFName.of('EmbeddedFiles'), L.PDFDict);
        walk(efRoot, 0);
      } catch (e) { /* no attachments */ }
      var raw = files[ATTACH_NAME];
      if (!raw || raw.length > 8 * 1024 * 1024) return null;
      var payload = null;
      try { payload = sanitize(JSON.parse(new TextDecoder().decode(raw))); } catch (e) { payload = null; }
      if (!payload) return null;
      var wanted = {}, receipts = {};
      payload.claim.lines.forEach(function (l) { if (l.receiptId) wanted[l.receiptId] = true; });
      doc.context.enumerateIndirectObjects().forEach(function (pair) {
        var obj = pair[1];
        if (!(obj instanceof L.PDFRawStream)) return;
        var tag = obj.dict.get(L.PDFName.of(TAG));
        if (!tag) return;
        var id = tag.decodeText ? tag.decodeText() : String(tag);
        if (!own(wanted, id) || own(receipts, id)) return;
        var c = obj.contents;
        if (c && c.length > 3 && c[0] === 0xFF && c[1] === 0xD8) receipts[id] = new Uint8Array(c);
      });
      return { payload: payload, receipts: receipts };
    });
  }

  return {
    build: build, read: read, fingerprint: fingerprint, sanitize: sanitize, clean: clean, hlOf: hlOf, tzoOf: tzoOf, stampOf: stampOf, idOf: idOf, TYPE_LABEL: TYPE_LABEL, MAX: MAX, FORMAT: FORMAT,
    use: function (pdfLib) { injected = pdfLib; }
  };
});
