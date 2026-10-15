/* CETG claim form — receipt text parsing.
 * Pure functions: take OCR lines (text + word boxes) and work out the amount paid, the date,
 * the kind of expense and a venue hint. No DOM, no network. Also loadable in Node for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReceiptParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  var MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  var DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  var CUR = 'rm|myr|usd|us\\$|eur|gbp|aud|idr|thb|hkd|jpy|cny|rmb';

  var RE_NEG = /\b(gst|tax|vat|svc|service\s*ch\w*|change|cash|tender\w*|balance|bal|discount|disc|promo\w*|voucher|coupon|rebate|offset|redeem\w*|sub\s*-?\s*total|rounding|deposit|stored\s*value|remaining|points|tip|saved|savings|before|limit|top\s*-?\s*up|refund)\b/;
  var RE_DISC = /\b(discount|disc|promo\w*|voucher|coupon|rebate|offset|redeem\w*|points|saved|savings)\b/;
  var RE_INCL = /\bincl/;
  var RE_STRONG = /\b(grand\s*total|total\s*(amount|paid|fare|charges?|due|payable|price|payment|bill)|amount\s*(paid|due|payable|charged|to\s*pay)|nett?\s*(total|amount|payable)|you\s*pa(id|y)|paid\s*amount|payment\s*amount|trip\s*total|final\s*(fare|amount|total)|total|nett?)\b/;
  var RE_QUALIFIED = /\b(grand|paid|amount|nett?|fare|due|payable|payment|final)\b/;
  // wording for the amount actually handed over, as opposed to a total before vouchers or discounts
  var RE_FINAL = /\b(amount\s*(paid|due|payable|charged|to\s*pay)|nett?|you\s*pa(id|y)|paid\s*amount|payment\s*amount|final\s*(fare|amount|total)|total\s*(paid|payable|due|charged))\b/;
  // cash is rounded to the nearest 5 cents in Singapore: the rounded figure is the one that was paid
  var RE_ROUNDED = /(after\s*rounding|rounded\s*(total|amount)|total\s*\(?\s*rounded)/;
  var RE_TOPUP_AMOUNT = /top\s*-?\s*up\s*(amount|value)/;
  // a row naming how it was paid carries the amount that was actually charged
  var RE_PAY = /\b(visa|master\s*card|amex|american\s*express|nets|paynow|paylah|grab\s*pay|go\s*pay|apple\s*pay|google\s*pay|credit\s*card|debit\s*card|charged\s*to|paid\s*(by|with|via|using)|card\s*ending)\b/;
  var RE_MEDIUM = /\b(fare|fees?|charges?|surcharges?|amount|paid|payment|price|cost|parking)\b/;
  // "Total hours: 5.75", "Distance 12.50": a number that follows a unit word is not money
  var RE_UNIT_BEFORE = /\b(hours?|hrs?|duration|distance|mileage|odometer|km|mins?|minutes|qty|quantity|items?|units?|litres?|liters?|kwh|pax|trips?|rides?)\s*[:=]?\s*\(?\s*$/;
  var RE_UNIT_AFTER = /^\s?(?:%|(?:km|kg|kwh|l|ltr|litres?|liters?|mins?|hrs?|hours?|pts|x|am|pm|a\.m|p\.m)\b)/i;
  var RE_SGD_BEFORE = /(s\$+|\$+|sgd|s5\$?|5\$)\s*\(?\s*$/i;
  var RE_CUR_WORDS = /\b(sgd|usd|myr|rm|eur|gbp|aud)\b|s?\$/g;
  var RE_FOREIGN_BEFORE = new RegExp('\\b(' + CUR + ')\\b', 'i');
  var RE_FOREIGN_AFTER = new RegExp('^\\s?(' + CUR + ')\\b', 'i');

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function iso(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
  function validDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2099) return false;
    var t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  function dayDiff(aIso, bIso) { // a - b in days
    var a = Date.UTC(+aIso.slice(0, 4), +aIso.slice(5, 7) - 1, +aIso.slice(8, 10));
    var b = Date.UTC(+bIso.slice(0, 4), +bIso.slice(5, 7) - 1, +bIso.slice(8, 10));
    return Math.round((a - b) / 86400000);
  }
  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.floor(s.length / 2)];
  }

  /* ---------- rows: merge OCR lines that sit on the same visual row (label left, amount right) ---------- */
  function buildRows(lines) {
    var clean = [];
    (lines || []).forEach(function (l) {
      var words = (l.words || []).filter(function (w) {
        return w && w.text && w.bbox && (w.conf == null || w.conf >= 25) && /[A-Za-z0-9$]/.test(w.text);
      });
      if (!words.length) return;
      var y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
      words.forEach(function (w) {
        y0 = Math.min(y0, w.bbox.y0); y1 = Math.max(y1, w.bbox.y1);
        x0 = Math.min(x0, w.bbox.x0); x1 = Math.max(x1, w.bbox.x1);
      });
      clean.push({ words: words.slice(), x0: x0, x1: x1, y0: y0, y1: y1 });
    });
    var medH = median(clean.map(function (l) { return l.y1 - l.y0; })) || 1;
    clean.sort(function (a, b) { return (a.y0 + a.y1) - (b.y0 + b.y1); });
    var rows = [];
    clean.forEach(function (l) {
      var h = l.y1 - l.y0;
      var target = null;
      if (h <= medH * 2.5) {
        for (var i = rows.length - 1; i >= 0 && i >= rows.length - 6; i--) {
          var r = rows[i];
          var rh = r.y1 - r.y0;
          if (rh > medH * 2.5) continue;
          var ov = Math.min(l.y1, r.y1) - Math.max(l.y0, r.y0);
          var hov = Math.min(l.x1, r.x1) - Math.max(l.x0, r.x0);
          if (ov / Math.min(h, rh) >= 0.55 && hov < Math.min(l.x1 - l.x0, r.x1 - r.x0) * 0.2) { target = r; break; }
        }
      }
      if (target) {
        target.words = target.words.concat(l.words);
        target.x0 = Math.min(target.x0, l.x0); target.x1 = Math.max(target.x1, l.x1);
        target.y0 = Math.min(target.y0, l.y0); target.y1 = Math.max(target.y1, l.y1);
      } else rows.push(l);
    });
    rows.sort(function (a, b) { return (a.y0 + a.y1) - (b.y0 + b.y1); });
    rows.forEach(function (r) {
      r.words.sort(function (a, b) { return a.bbox.x0 - b.bbox.x0; });
      var text = '', spans = [];
      r.words.forEach(function (w) {
        if (text) text += ' ';
        spans.push({ s: text.length, e: text.length + w.text.length, w: w });
        text += w.text;
      });
      r.text = text; r.spans = spans; r.lower = text.toLowerCase();
    });
    return rows;
  }

  function spanBox(row, s, e, withCurrency) {
    var b = null, conf = 100, firstIdx = -1;
    function add(sp) {
      var w = sp.w.bbox;
      b = b ? { x0: Math.min(b.x0, w.x0), y0: Math.min(b.y0, w.y0), x1: Math.max(b.x1, w.x1), y1: Math.max(b.y1, w.y1) } : { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 };
    }
    row.spans.forEach(function (sp, i) {
      if (sp.e > s && sp.s < e) {
        if (firstIdx < 0) firstIdx = i;
        add(sp);
        if (sp.w.conf != null) conf = Math.min(conf, sp.w.conf);
      }
    });
    // take in a currency sign standing on its own just before the number ("$ 13.80")
    if (withCurrency && firstIdx > 0 && /^[(\[]?(s?\$+|sgd|s5\$?|5\$)$/i.test(row.spans[firstIdx - 1].w.text)) add(row.spans[firstIdx - 1]);
    return { box: b, conf: conf };
  }

  /* ---------- amounts ---------- */
  function letters(t) { return t.replace(RE_CUR_WORDS, ' ').replace(/[^a-z]/g, '').length; }
  function findAmounts(rows) {
    var found = [];
    rows.forEach(function (row, ri) {
      var text = row.text, re = /(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})(?!\d)/g, m, prevEnd = 0, first = true, carry = '';
      while ((m = re.exec(text))) {
        var s = m.index, e = s + m[0].length;
        var prev = s > 0 ? text.charAt(s - 1) : '';
        var prev2 = s > 1 ? text.charAt(s - 2) : '';
        if (/[\d.\/]/.test(prev)) continue;
        if (prev === ':' && /\d/.test(prev2)) continue;            // part of a time, "12:30.00"
        if (prev === '-' && /[A-Za-z0-9]/.test(prev2)) continue;    // inside a reference number
        if (prev === ',' && /\d/.test(prev2)) continue;
        var after = text.slice(e);
        if (/^[.,]\d/.test(after)) continue;
        if (RE_UNIT_AFTER.test(after)) continue;                    // 12.50 km, 2.45 PM, 9.00%
        var intPart = m[1].replace(/,/g, '');
        if (intPart.length > 6) continue;
        var cents = parseInt(intPart, 10) * 100 + parseInt(m[2], 10);
        if (!(cents > 0)) continue;
        var before = text.slice(prevEnd, s);
        if (RE_UNIT_BEFORE.test(before.toLowerCase())) { prevEnd = e; first = false; continue; } // hours, distance, quantity
        // An aside in brackets that is still open at this number ("Total fare (incl GST $1.52) $18.40"):
        // the number belongs to the aside, and the label in front of the bracket waits for the next number.
        var open = before.lastIndexOf('('), inAside = open !== -1 && open > before.lastIndexOf(')');
        var ctx = before.toLowerCase(), aside = inAside && RE_NEG.test(ctx.slice(open));
        if (aside) carry = ctx.slice(0, open);
        else if (RE_INCL.test(ctx) && RE_STRONG.test(ctx) && /\b(gst|tax|vat)\b[^a-z]*$/.test(ctx) && /\d[.,]\d{2}(?!\d)/.test(after)) {
          aside = true; carry = ctx.replace(/\bincl.*$/, ''); // "Total incl GST 0.99 12.00": the first figure is the GST
        } else if (carry && letters(ctx) < 2) { ctx = carry + ' ' + ctx; carry = ''; }
        var fromAbove = false;
        if (first && letters(ctx) < 2 && ri > 0) { // a label on its own row with the amount on the row below
          var above = rows[ri - 1];
          if (above && !found.some(function (f) { return f.row === ri - 1; }) && letters(above.lower) >= 3) { ctx = above.lower + ' ' + ctx; fromAbove = true; }
        }
        var sgd = RE_SGD_BEFORE.test(before);
        var foreign = '';
        if (!sgd) {
          var fb = before.slice(-8).match(RE_FOREIGN_BEFORE), fa = after.match(RE_FOREIGN_AFTER);
          foreign = ((fb && fb[1]) || (fa && fa[1]) || '').toUpperCase();
        }
        var label = 'none', score = 0, fin = false, disc = false, pay = false, cash = false, neg = RE_NEG.exec(ctx);
        if (RE_ROUNDED.test(ctx) && !aside) { label = 'total'; score = 12; fin = true; }
        else if (aside || (neg && !(RE_INCL.test(ctx) && RE_STRONG.test(ctx)) && !RE_TOPUP_AMOUNT.test(ctx))) {
          label = 'other'; score = -8; disc = !aside && RE_DISC.test(ctx);
          cash = !aside && /^(cash|tender)/.test(neg[1]) && !/\b(change|balance|bal)\b/.test(ctx);
        }
        else if (RE_STRONG.test(ctx)) { label = 'total'; score = RE_QUALIFIED.test(ctx) ? 12 : 10; if (fromAbove) score -= 1; fin = RE_FINAL.test(ctx); }
        else if (RE_PAY.test(ctx)) { label = 'total'; score = 9; fin = true; pay = true; }
        else if (RE_MEDIUM.test(ctx)) { label = 'item'; score = 4; }
        if (sgd) score += 2;
        if (intPart.length >= 5 && !sgd) score -= 3;
        var sb = spanBox(row, s, e, sgd);
        if (sb.conf < 55) score -= 2;
        // "S$37.40" is sometimes read as "S537.40" (the $ as a 5) or "$837.40" (the S as a $, the $ as an 8):
        // remember the reading without that first digit. A complete "S$" in front means nothing was misread.
        var alt = 0, d0 = intPart.charAt(0), rest = intPart.length > 1 ? parseInt(intPart.slice(1), 10) * 100 + parseInt(m[2], 10) : 0;
        if (rest > 0 && ((/[Ss]/.test(prev) && d0 === '5') || (prev === '$' && !/[Ss]/.test(prev2) && d0 === '8'))) alt = rest;
        found.push({ cents: cents, label: label, score: score, row: ri, box: sb.box, conf: sb.conf, foreign: foreign, fin: fin, disc: disc, pay: pay, cash: cash, alt: alt });
        prevEnd = e; first = false;
      }
    });
    if (!found.length) return [];
    // the misread figure is only set aside when the plain figure also stands as a total or on a payment row
    found.forEach(function (f) {
      if (f.alt && found.some(function (o) { return o !== f && o.cents === f.alt && o.label === 'total'; })) { f.label = 'other'; f.score = -8; f.fin = false; f.pay = false; }
    });

    // group by value
    var byVal = {};
    found.forEach(function (f) { (byVal[f.cents] = byVal[f.cents] || []).push(f); });
    var maxPositive = 0;
    found.forEach(function (f) { if (f.label !== 'other' && f.cents > maxPositive) maxPositive = f.cents; });
    var out = Object.keys(byVal).map(Number).map(function (v) {
      var occ = byVal[v];
      var best = occ.reduce(function (a, b) { return b.score > a.score ? b : a; });
      var score = best.score + Math.min(4, (occ.length - 1) * 2);
      if (v === maxPositive && best.label !== 'other') score += 2;
      return { cents: v, score: score, label: best.label, box: best.box, row: best.row, count: occ.length, foreign: best.foreign, conf: best.conf,
        fin: occ.some(function (o) { return o.fin; }), pay: occ.some(function (o) { return o.pay; }), disc: occ.every(function (o) { return o.disc; }), cash: occ.some(function (o) { return o.cash; }),
        firstRow: Math.min.apply(null, occ.map(function (o) { return o.row; })), lastRow: Math.max.apply(null, occ.map(function (o) { return o.row; })) };
    });
    function subsetSums(values, target, least) { // does some set of at least `least` of these values add up to target?
      var n = values.length;
      if (n < least || n > 10) return false;
      for (var mask = 1; mask < (1 << n); mask++) {
        var sum = 0, bits = 0;
        for (var i = 0; i < n; i++) if (mask & (1 << i)) { sum += values[i]; bits++; }
        if (bits >= least && sum === target) return true;
      }
      return false;
    }
    // a total usually equals the sum of the line items above it
    var items = out.filter(function (c) { return c.label !== 'other'; }).map(function (c) { return c.cents; });
    if (items.length >= 3 && items.length <= 12) {
      out.forEach(function (c) {
        if (c.label === 'other') return;
        if (subsetSums(items.filter(function (v) { return v < c.cents; }), c.cents, 2)) c.score += 4;
      });
    }
    // "Paid by cash $21.50" with no total row: cash that equals the items added up is the total, not money tendered
    if (!out.some(function (c) { return c.label === 'total'; })) {
      out.forEach(function (c) {
        if (c.cash && subsetSums(items.filter(function (v) { return v < c.cents; }), c.cents, 2)) { c.label = 'total'; c.score = 12; c.fin = true; }
      });
    }
    // Vouchers and discounts: what was actually paid is the total less the discount, wherever it is printed.
    var discs = found.filter(function (f) { return f.disc; });
    if (discs.length) {
      var seenDisc = {}, off = 0, firstDisc = Infinity, lastDisc = -1;
      discs.forEach(function (f) {
        firstDisc = Math.min(firstDisc, f.row); lastDisc = Math.max(lastDisc, f.row);
        if (!seenDisc[f.row + ':' + f.cents]) { seenDisc[f.row + ':' + f.cents] = true; off += f.cents; }
      });
      var cuts = [off].concat(discs.map(function (f) { return f.cents; }));
      var plain = out.filter(function (c) { return !c.disc; });
      var parts = out.filter(function (c) { return c.label === 'item' || c.label === 'none'; }).map(function (c) { return c.cents; });
      var totals = out.filter(function (c) { return c.label === 'total'; });
      // 1. an amount that is some other printed figure (or the items added up) less the discount
      var net = plain.filter(function (c) {
        if (c.label === 'other' && !c.fin) return false;
        return cuts.some(function (cut) {
          return plain.some(function (g) { return g !== c && g.cents === c.cents + cut; }) || subsetSums(parts.filter(function (v) { return v !== c.cents; }), c.cents + cut, 1);
        });
      });
      net.sort(function (a, b) { return (b.label === 'total' ? 1 : 0) - (a.label === 'total' ? 1 : 0) || (b.fin ? 1 : 0) - (a.fin ? 1 : 0) || b.lastRow - a.lastRow; });
      var winner = net[0] || null;
      // 2. otherwise a total or payment row printed after the discount and smaller than a total before it
      if (!winner) {
        var later = totals.filter(function (c) { return c.lastRow > lastDisc && totals.some(function (t) { return t.firstRow < firstDisc && t.cents > c.cents; }); });
        later.sort(function (a, b) { return (b.fin ? 1 : 0) - (a.fin ? 1 : 0) || b.lastRow - a.lastRow; });
        winner = later[0] || null;
      }
      // 3. otherwise wording that means "what you paid", when it is smaller than a plain total
      if (!winner) {
        var paid = totals.filter(function (c) { return c.fin && totals.some(function (t) { return t !== c && t.cents > c.cents; }); });
        winner = paid[0] || null;
      }
      if (winner) {
        var top = Math.max.apply(null, out.map(function (c) { return c === winner ? -Infinity : c.score; }));
        if (winner.score < top + 3) winner.score = top + 3;
        winner.label = 'total';
      } else if (totals.length && !totals.some(function (c) { return c.lastRow > lastDisc; })) {
        out.unsure = true; // a total, then a discount, and nothing after it: the amount paid is not printed
      }
    }
    var unsure = !!out.unsure;
    out.sort(function (a, b) { return b.score - a.score || (b.fin ? 1 : 0) - (a.fin ? 1 : 0) || b.lastRow - a.lastRow || b.cents - a.cents; });
    out.unsure = unsure;
    return out;
  }

  /* ---------- dates ---------- */
  function findDates(rows, todayIso) {
    var hits = [];
    var thisYear = todayIso ? +todayIso.slice(0, 4) : 0;
    // o: { inferred: the year was not printed, penalty: points off, us: read month-first, pair: id shared by the two readings of one figure }
    function add(row, ri, s, e, y, mo, d, o) {
      o = o || {};
      if (y < 100) y += 2000;
      if (!validDate(y, mo, d)) return;
      var text = row.lower;
      var around = text.slice(Math.max(0, s - 16), s) + ' | ' + text.slice(e, e + 8);
      var dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      var wm = around.match(/\b(mon|tue|wed|thu|fri|sat|sun)/);
      var score = (o.inferred ? 4 : 5) - (o.penalty || 0);
      if (wm) score += (wm[1] === DOW[dow]) ? 3 : -4;
      var ctx = text.slice(0, s);
      var near = '[^a-z]*(\\w+[^a-z]*){0,2}$';
      if (new RegExp('\\b(exit|paid|payment|picked\\s*up|pick\\s*-?\\s*up|drop\\s*-?\\s*off|trip|ride|ended|departure|check\\s*-?out)\\b' + near).test(ctx)) score += 5;
      else if (new RegExp('\\b(issued|transaction|txn|date)\\b' + near).test(ctx)) score += 2;
      if (new RegExp('\\b(entry|since|member)\\b' + near).test(ctx)) score -= 1;
      // a card's expiry, a due date or a date of birth is never the day of the expense
      if (new RegExp('\\b(expiry|expires|exp|valid|due|birth|dob)\\b' + near).test(ctx)) score -= 9;
      // the day a statement or a print-out was made is not the day of the trip
      if (new RegExp('\\b(statement|printed|print|booked|booking|generated|report|as\\s*at|as\\s*of)\\b' + near).test(ctx)) score -= 4;
      var isoD = iso(y, mo, d);
      if (todayIso) {
        var ago = dayDiff(todayIso, isoD);
        if (ago < -1) score -= 10; else if (ago <= 100) score += 3; else if (ago > 400) score -= 6;
      }
      var sb = spanBox(row, s, e);
      if (sb.conf < 55) score -= 1;
      hits.push({ iso: isoD, score: score, box: sb.box, row: ri, inferred: !!o.inferred, us: !!o.us, pair: o.pair || '' });
    }
    // a day and month with no year: take the most recent year that is not in the future
    function addYearless(row, ri, s, e, mo, d) {
      if (!todayIso) return;
      var y = thisYear;
      if (!validDate(y, mo, d) || dayDiff(todayIso, iso(y, mo, d)) < -1) y -= 1;
      add(row, ri, s, e, y, mo, d, { inferred: true });
    }
    function overlaps(ranges, s, e) { return ranges.some(function (r) { return s < r[1] && e > r[0]; }); }
    var monthAhead = new RegExp('^[\\s\\-\\/.,]{0,3}' + MON + '(?![a-z])', 'i');
    // "Receipt No: 02-09-26", "Ref 2026-09-29-001": figures after a numbering word are not dates
    var RE_REF = /(\b(no|num|number|ref|reference|id|serial)\b|#)[\s.:#\-]*$/i;

    rows.forEach(function (row, ri) {
      var t = row.text, m, re, used = [];
      // 29 Sep 2026, 29-Sep-26, 29 September 2026 (and 29 Sep with no year)
      re = new RegExp('(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-\\/.,]{0,3}' + MON + "(?![a-z])(?:[\\s\\-\\/.,']{0,3}(\\d{4}|\\d{2})(?!\\d))?", 'gi');
      while ((m = re.exec(t))) {
        if (m.index > 0 && /\d/.test(t.charAt(m.index - 1))) continue;
        var d1 = parseInt(m[1], 10), mo1 = MONTHS[m[2].slice(0, 3).toLowerCase()], yr = m[3], end = m.index + m[0].length;
        if (yr) {
          var rest = t.slice(end), y1 = parseInt(yr, 10);
          var notYear = false;
          if (yr.length === 2) {
            // "30 Sep, 14:27" (a time), "1 Sep - 30 Sep" (a range), "30 Sep 25 Tampines Ave" (an address), or a year nowhere near now
            if (/^\s?[:.]\d/.test(rest) || /^\s?(am|pm)\b/i.test(rest) || monthAhead.test(rest)) notYear = true;
            else if (/^\s?[A-Za-z]/.test(rest) && !/^\s?(mon|tue|wed|thu|fri|sat|sun)/i.test(rest)) notYear = true;
            else if (thisYear && (2000 + y1 < thisYear - 6 || 2000 + y1 > thisYear + 1)) notYear = true;
          }
          if (notYear) { end -= yr.length; yr = ''; re.lastIndex = end; }
        }
        // "Picked up at 3 Mar Thoma Road": a house number and a street, not a date
        var street = !yr && /\b(at|from|to|near|blk|block)\s*$/i.test(t.slice(0, m.index)) && /^\s[A-Za-z]{3,}/.test(t.slice(end));
        if (yr) add(row, ri, m.index, end, parseInt(yr, 10), mo1, d1); else if (!street) addYearless(row, ri, m.index, end, mo1, d1);
        used.push([m.index, end]);
      }
      // Sep 29, 2026 (and Sep 29 with no year)
      re = new RegExp(MON + '(?![a-z])\\.?\\s{0,2}(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s{0,2}(\\d{4})(?!\\d))?', 'gi');
      while ((m = re.exec(t))) {
        if (m.index > 0 && /[a-z]/i.test(t.charAt(m.index - 1))) continue;
        var e2 = m.index + m[0].length;
        if (overlaps(used, m.index, e2)) continue;
        var mo2 = MONTHS[m[1].slice(0, 3).toLowerCase()], d2 = parseInt(m[2], 10);
        if (m[3]) add(row, ri, m.index, e2, parseInt(m[3], 10), mo2, d2);
        else if (!/^\s?[:.]\d/.test(t.slice(e2))) addYearless(row, ri, m.index, e2, mo2, d2);
        used.push([m.index, e2]);
      }
      // 2026-09-29
      re = /(20\d{2})([-\/.])(\d{1,2})\2(\d{1,2})(?!\d)/g;
      while ((m = re.exec(t))) {
        if (m.index > 0 && /[\d\-\/.]/.test(t.charAt(m.index - 1))) continue;
        if (/^[-\/.]\d/.test(t.slice(m.index + m[0].length)) || RE_REF.test(t.slice(0, m.index))) continue;
        add(row, ri, m.index, m.index + m[0].length, parseInt(m[1], 10), parseInt(m[3], 10), parseInt(m[4], 10));
      }
      // 29/09/2026, 29-09-26 (day first, as written in Singapore)
      re = /(\d{1,2})([\/\-.])(\d{1,2})\2(20\d{2}|\d{2})(?!\d)/g;
      while ((m = re.exec(t))) {
        if (m.index > 0 && /[\d\/\-.]/.test(t.charAt(m.index - 1))) continue;
        var lead = t.slice(0, m.index), endD = m.index + m[0].length, short = m[4].length === 2, pen = 0;
        if (/^[\/\-.]\d/.test(t.slice(endD)) || RE_REF.test(lead)) continue;
        if (m[2] === '.' && short) { // "Exit time 12.05.26" is a time of day
          if (/\b(time|at)\b[\s:]*$/i.test(lead)) continue;
          if (!/\b(date|dated|on|issued|exit|entry|paid)\b/i.test(lead)) pen = 3;
        }
        var d = parseInt(m[1], 10), mo = parseInt(m[3], 10), y = parseInt(m[4], 10), pair = '';
        if (mo > 12 && d <= 12) { var x = d; d = mo; mo = x; }
        else if (d <= 12 && mo <= 12 && d !== mo) { // could also be month first: offer that reading too, a little behind
          pair = ri + ':' + m.index;
          add(row, ri, m.index, endD, y, d, mo, { penalty: pen + 2, us: true, pair: pair });
        }
        add(row, ri, m.index, endD, y, mo, d, { penalty: pen, pair: pair });
      }
    });
    var by = {};
    hits.forEach(function (h) {
      var g = by[h.iso];
      if (!g) by[h.iso] = { iso: h.iso, score: h.score, box: h.box, count: 1, inferred: h.inferred, us: h.us, pair: h.pair };
      else { g.count++; if (!h.inferred) g.inferred = false; if (h.score > g.score) { g.score = h.score; g.box = h.box; g.us = h.us; g.pair = h.pair; } }
    });
    var out = Object.keys(by).map(function (k) { var g = by[k]; g.score += Math.min(2, g.count - 1); return g; });
    out.sort(function (a, b) { return b.score - a.score || (a.iso < b.iso ? 1 : -1); });
    return out;
  }

  /* ---------- kind of expense + venue hint ---------- */
  var RE_RIDE = /\b(grab|gojek|tada|ryde|comfort\s*del\s*gro|comfortdelgro|cdg|zig|taxi|cab|your ride|picked\s*up|pick\s*-?\s*up|drop\s*-?\s*off|booking id|driver|trip fare|private hire)\b/;
  var RE_PARK = /\b(car\s*park|carpark|parking|season\s*pass|iu\s*no|cashcard)\b/;
  var RE_TRANSIT = /\b(ez\s*-?\s*link|simplygo|mrt|lrt|bus\s*fare|transit|smrt|sbs\s*transit|train\s*fare)\b/;
  var RE_ERP = /\b(erp|toll|tolls)\b/;
  function detectType(lower) {
    // "GrabPay" and "GrabFood" are a wallet and a food order, not a ride
    var t = String(lower || '').replace(/grab\s*(pay|food|mart|express)\w*/g, ' ');
    if (RE_RIDE.test(t)) return 'ride';
    if (RE_PARK.test(t) || (/\bentry\b/.test(t) && /\bexit\b/.test(t))) return 'parking'; // an entry and an exit time
    if (RE_TRANSIT.test(t)) return 'transit';
    if (RE_ERP.test(t)) return 'erp';
    return 'other';
  }
  function venueHint(rows) {
    for (var i = 0; i < rows.length && i < 8; i++) {
      var r = rows[i], ws = r.words;
      if (ws.length < 2 || r.text.length < 8 || r.text.length > 44) continue;
      if (/\d/.test(r.text)) continue;
      if (!ws.every(function (w) { return /^[A-Za-z&'().,\-]+$/.test(w.text) && (w.conf == null || w.conf >= 75); })) continue;
      if (/\b(receipt|invoice|tax|gst|thank|welcome|car\s*park|carpark|parking|total|date|time|customer|copy|pte|ltd|limited)\b/i.test(r.text)) continue;
      return r.text.replace(/[.,:;\-]+$/, '').trim();
    }
    return '';
  }

  /* ---------- public: parse one receipt ---------- */
  function parseReceipt(ocr, todayIso) {
    var rows = buildRows(ocr && ocr.lines);
    var W = (ocr && ocr.w) || 1, H = (ocr && ocr.h) || 1;
    function norm(b) { return b ? [+(b.x0 / W).toFixed(4), +(b.y0 / H).toFixed(4), +(b.x1 / W).toFixed(4), +(b.y1 / H).toFixed(4)] : null; }
    var text = rows.map(function (r) { return r.text; }).join('\n');
    var lower = text.toLowerCase();
    var amounts = findAmounts(rows);
    var dates = findDates(rows, todayIso);
    var type = detectType(lower);
    var best = amounts[0] || null, second = amounts[1] || null;
    var amountConf = 'none';
    if (best) {
      if (best.label === 'total' && (!second || best.score - second.score >= 3)) amountConf = 'high';
      else if (best.score >= 6) amountConf = 'medium';
      else amountConf = 'low';
      if (amounts.unsure) amountConf = 'low'; // a discount with no amount paid printed after it
    }
    var bd = dates[0] || null, dateConf = 'none';
    if (bd && bd.score < 3) bd = null;                 // too doubtful to offer (very old, in the future, or a wrong weekday)
    if (bd) {
      var rival = dates[1] && dates[1].score >= 3 ? dates[1] : null;       // another date on the receipt that could be the one
      var clear = !rival || bd.score - rival.score >= 3;
      if (bd.us) dateConf = 'low';                                           // only makes sense read month-first
      else if (bd.inferred) dateConf = bd.score >= 7 && clear ? 'medium' : 'low'; // the year was not printed
      else dateConf = bd.score >= 8 && clear ? 'high' : (bd.score >= 5 ? 'medium' : 'low');
    }
    var hint = '';
    if (type === 'parking') { var v = venueHint(rows); if (v) hint = 'Parking at ' + v; }
    return {
      type: type,
      amount: best ? best.cents : null,
      amountConf: amountConf,
      amounts: amounts.slice(0, 8).map(function (a) { return { cents: a.cents, score: a.score, label: a.label, box: norm(a.box) }; }),
      date: bd ? bd.iso : null,
      dateConf: dateConf,
      dateInferredYear: !!(bd && bd.inferred),
      dates: dates.slice(0, 4).map(function (d) { return { iso: d.iso, score: d.score, box: norm(d.box) }; }),
      hintTo: hint,
      foreign: best && best.foreign ? best.foreign : '',
      text: text
    };
  }

  return { parseReceipt: parseReceipt, buildRows: buildRows, findAmounts: findAmounts, findDates: findDates, detectType: detectType };
});
