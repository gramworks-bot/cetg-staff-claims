/* CETG claim form — staff side: receipts in, item details, monthly total, e-sign, send for approval.
 * (In the code a claim "line" is what the screen calls an "item".) */
(function () {
  'use strict';
  var h = U.h, icon = U.icon, toast = UI.toast, field = UI.field, clean = ClaimPDF.clean, MAX = ClaimPDF.MAX;

  var VERSION = '1.3.0';
  var TYPES = [['ride', 'Taxi / private hire'], ['parking', 'Parking'], ['transit', 'Public transport'], ['erp', 'ERP / tolls'], ['other', 'Other expense']];
  var TYPE_LABEL = {}; TYPES.forEach(function (t) { TYPE_LABEL[t[0]] = t[1]; });
  var DEFAULT_TEAM = { formTitle: 'CET Global Staff Reimbursement Claim Form', approverName: 'Thomas Yeo', approverEmail: '', financeEmail: '' };
  var TEAM_KEYS = ['formTitle', 'approverName', 'approverEmail', 'financeEmail'];
  var STATUS_LABEL = { draft: 'Draft', signed: 'Signed', sent: 'Sent for approval', approved: 'Approved' };
  var AUTO_FILE_BACK = 2; // a receipt is filed by its date only for this month and the two before it
  var RE_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/, RE_HASH = /^w?[0-9a-f]{16,64}$/;
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function idOk(v) { return ClaimPDF.idOf(v) !== ''; }
  function table() { return Object.create(null); } // a lookup by id that no id can ever mistake for something built in
  function statusOf(c) { return c && own(STATUS_LABEL, c.status) ? c.status : 'draft'; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  var S = {
    profile: { name: '', email: '', signature: '' },
    team: U.clone(DEFAULT_TEAM),
    flags: {},
    lines: [], claims: {}, approvals: [],
    month: U.monthOf(U.todayIso()), tab: 'claims',
    showNeeds: false, teamOffer: null, pending: [], review: null,
    signing: null,   // the month whose "review and sign" dialog is open
    broken: null,    // why changes are not being saved: 'failed' | 'full' | 'wiped' | 'replaced'
    late: false,     // the saved data turned up after the page had started without it
    newer: false,    // a newer version of the form has been published
    restoring: false
  };
  var $view, $bar;
  var view = { month: null, mode: null, list: null, cards: table(), parts: null };
  var urlCache = table(), saveTimers = table(), inFlight = table(), failedLines = table(), removed = table();
  var readingHere = table();  // receipts this window has asked to read (it may still be waiting its turn behind another window)
  var runningHere = table();  // receipts this window is reading right now
  var failedOps = [], packCache = null, sendDialog = null;

  /* =====================================================================================
   * data helpers
   * ===================================================================================== */
  function claimOf(m) { return S.claims[m] || { month: m, purpose: 'Transport', status: 'draft' }; }
  function isSigned(m) { return statusOf(S.claims[m]) !== 'draft'; }
  // Locked: nothing may be added to, moved into or changed in this month, because it is signed or
  // because its sign dialog is open and what is on screen there is about to be signed.
  function isLocked(m) { return isSigned(m) || S.signing === m; }
  function lineById(id) { for (var i = 0; i < S.lines.length; i++) if (S.lines[i].id === id) return S.lines[i]; return null; }
  function byDate(a, b) {
    var da = a.date || '9999-99-99', db = b.date || '9999-99-99';
    return da < db ? -1 : da > db ? 1 : (a.createdAt || 0) - (b.createdAt || 0);
  }
  function linesOf(m) { return S.lines.filter(function (l) { return l.month === m; }).sort(byDate); }
  function totalOf(ls) { return ls.reduce(function (s, l) { return s + (l.amountCents || 0); }, 0); }
  function isReading(l) { return !!(l.ocr && (l.ocr.state === 'pending' || l.ocr.state === 'running')); }
  function needsOf(l) { // which fields still need attention
    var n = {};
    if (isReading(l)) { n.reading = true; return n; }
    if (l.sample) n.sample = true;
    if (!U.validIso(l.date) || l.date > U.todayIso()) n.date = true;
    if (!(l.amountCents > 0)) n.amt = true;
    if (!clean(l.desc)) n.desc = true;
    if (l.type !== 'other') { if (!clean(l.from)) n.from = true; if (!clean(l.to)) n.to = true; }
    if (!l.verified) n.verified = true;
    return n;
  }
  function hasNeeds(l) { return Object.keys(needsOf(l)).length > 0; }
  function descLabel(l) { return l.type === 'other' ? 'What it was for' : 'Details of travel'; }
  function tickLabel(l) { return l.receiptId ? 'Amount matches the receipt' : 'Amount is correct'; }
  // The words used here are the labels on screen, so the person can find what is being asked for.
  function needsText(l) {
    var n = needsOf(l), out = [];
    if (n.reading) return 'its receipt to finish being read (or tap “Type it in instead”)';
    if (n.sample) out.push('the sample to be removed');
    if (n.date) out.push('Date');
    if (n.amt) out.push('Amount claimed');
    if (n.desc) out.push(descLabel(l));
    if (n.from) out.push('Start');
    if (n.to) out.push('To');
    if (n.verified) out.push('a tick on “' + tickLabel(l) + '”');
    return out.join(', ');
  }
  function approverFirst() { return clean(S.team.approverName).split(' ')[0] || 'the approver'; }
  function amountBox(l) {
    if (!l.ocr || !l.ocr.amounts) return null;
    for (var i = 0; i < l.ocr.amounts.length; i++) {
      var a = l.ocr.amounts[i];
      if (a.cents === l.amountCents && Array.isArray(a.box)) return ClaimPDF.hlOf(a.box.map(function (v) { return Math.min(1, Math.max(0, +v || 0)); }));
    }
    return null;
  }
  function receiptUrl(id) {
    if (!id) return Promise.resolve(null);
    if (urlCache[id]) return Promise.resolve(urlCache[id]);
    return Store.get('receipts', id).then(function (r) {
      if (!r || !r.bytes) return null;
      if (!urlCache[id]) urlCache[id] = URL.createObjectURL(new Blob([r.bytes], { type: 'image/jpeg' }));
      return urlCache[id];
    }, function () { return null; });
  }
  function dropUrl(id) { if (urlCache[id]) { URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; } }

  // The claim as it goes on paper: used for the on-screen sheet, the check code and the PDF.
  // Once a month is signed, the name, email, form title and items are the ones it was signed with:
  // the signed claim carries its own copy of the items, so nothing done later can change what was signed.
  function modelFrom(c, ls) {
    var signed = statusOf(c) !== 'draft';
    var name = signed ? (c.signedName || '') : clean(S.profile.name, MAX.name);
    var lines = signed && Array.isArray(c.signedLines) && c.signedLines.length ? c.signedLines : ls.map(function (l, i) {
      return { n: i + 1, id: l.id, date: l.date || '', desc: clean(l.desc, MAX.desc), from: clean(l.from, MAX.place), to: clean(l.to, MAX.place), amountCents: l.amountCents || 0,
        type: own(TYPE_LABEL, l.type) ? l.type : 'other', receiptId: l.receiptId || '', receiptHash: l.receiptHash || '', hl: amountBox(l) };
    });
    return {
      series: c.series || '', rev: c.rev || 0, formTitle: signed ? (c.formTitle || '') : clean(S.team.formTitle, MAX.title),
      ref: c.ref || (name ? U.initials(name) + '-' + c.month : ''), month: c.month, purpose: clean(c.purpose, MAX.purpose) || 'Transport',
      staffName: name, staffEmail: signed ? (c.staffEmail || '') : (U.isEmail(S.profile.email) ? S.profile.email : ''),
      signedAt: c.signedAt || '', tzo: ClaimPDF.tzoOf(c.tzo), signedName: c.signedName || '', signature: c.signature || '', fingerprint: c.fingerprint || '',
      totalCents: lines.reduce(function (s, l) { return s + (l.amountCents || 0); }, 0), lines: lines
    };
  }
  function modelOf(m) { return modelFrom(claimOf(m), linesOf(m)); }
  function pdfName(model, approved) { return 'CETG-Claim_' + U.slug(model.signedName || model.staffName || 'staff') + '_' + model.month + (approved ? '_APPROVED' : '') + '.pdf'; }

  /* =====================================================================================
   * saving (everything is kept in this browser; a save that fails is never passed off as done)
   * ===================================================================================== */
  function storeFail(e) {
    var kind = e && e.replaced ? 'replaced' : e && e.wiped ? 'wiped' : (e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message || ''))) ? 'full' : 'failed');
    if (S.broken === 'wiped' || S.broken === 'replaced' || S.broken === kind) return;
    S.broken = kind;
    refreshBanners();
    renderBar();
    // The note is at the top of the page; on the long approver screens a message points to it.
    if (S.tab === 'approve') toast('Changes are not being saved on this device. See the note at the top of the page.', { bad: true, ms: 9000 });
  }
  function lockedElsewhere(m) {
    toast((m ? U.monthLabel(m) : 'That month') + ' was signed in another window, so it can no longer be changed here.', { bad: true, ms: 9000 });
    resync();
  }
  function changedElsewhere() {
    toast('This claim was changed in another window. Showing the latest.', { bad: true, ms: 8000 });
    return resync(true);
  }
  // Everything this form had saved was replaced (a backup restored) or erased in another window.
  // With nothing under way here the page simply starts again from what is saved now; in the middle of
  // typing, with a dialog open, or with claims open for approval, it says what happened and leaves
  // the reload to the person.
  function handleReplaced() {
    var ae = document.activeElement;
    var typing = !!ae && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && !/^(checkbox|radio|button|file)$/.test(ae.type)));
    var busy = UI.anyModal() || typing || Object.keys(saveTimers).length > 0 || S.pending.length > 0;
    if (!busy && !S.broken) { location.reload(); return; }
    storeFail({ replaced: true });
  }
  // The item someone is typing in can be filed under another month by a read that finished in another
  // window. The page then goes to that month with it, and the caret stays in the same box.
  function focusedLine() {
    var ae = document.activeElement, card = ae && ae.closest ? ae.closest('.line') : null, l = card && card._line;
    return l && S.lines.indexOf(l) !== -1 ? { line: l, month: l.month, field: (ae.dataset && ae.dataset.f) || '' } : null;
  }
  function keepWith(f) { // f: what focusedLine() said before the data changed. True when the page moved with the item.
    if (!f || S.tab !== 'claims' || UI.anyModal() || S.lines.indexOf(f.line) === -1 || f.line.month === f.month || S.month !== f.month) return false;
    S.month = f.line.month;
    renderClaims();
    var card = view.cards[f.line.id], el = card && f.field ? card.querySelector('[data-f="' + f.field + '"]') : null;
    if (el) { try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } showCard(card); }
    toast('This item is now under ' + U.monthLabel(S.month) + ', the month on its receipt.', { ms: 8000 });
    return true;
  }
  // Write one line now. Resolves true when it is safely stored.
  function writeLine(l) {
    if (removed[l.id]) return Promise.resolve(false);
    var f = focusedLine();
    inFlight[l.id] = (inFlight[l.id] || 0) + 1;
    return Store.putLine(l, { mine: !!runningHere[l.id] }).then(function (merged) {
      delete failedLines[l.id];
      // storage already held this receipt's finished read (from another window): the line now carries it
      if (merged && !keepWith(f) && S.tab === 'claims') renderClaims();
      return true;
    }, function (e) {
      if (e && e.locked) { lockedElsewhere(e.month); return false; }
      failedLines[l.id] = true; storeFail(e); return false;
    }).then(function (ok) { if (!--inFlight[l.id]) delete inFlight[l.id]; return ok; });
  }
  // Typing is saved a moment after the last keystroke; ticks, dates and anything else are saved at once.
  function saveLine(l, now) {
    l.updatedAt = Date.now(); packCache = null;
    clearTimeout(saveTimers[l.id]); delete saveTimers[l.id];
    if (S.restoring) return Promise.resolve(false);
    if (now) return writeLine(l);
    saveTimers[l.id] = setTimeout(function () { delete saveTimers[l.id]; writeLine(l); }, 250);
    return Promise.resolve(true);
  }
  function flushSaves() {
    var jobs = [];
    Object.keys(saveTimers).forEach(function (id) {
      clearTimeout(saveTimers[id]); delete saveTimers[id];
      var l = lineById(id);
      if (l && !S.restoring) jobs.push(writeLine(l));
    });
    return Promise.all(jobs);
  }
  function saveProfile() { return Store.kvSet('profile', S.profile).catch(storeFail); }
  function saveTeam() { packCache = null; return Store.kvSet('team', S.team).catch(storeFail); }
  function saveFlags() { return Store.kvSet('flags', S.flags).catch(function () { /* cosmetic */ }); }
  // Something other than a line edit could not be stored (a removal, an approver's decision): keep it to try again.
  function failedOp(run) { failedOps.push(run); }
  // "Try again" on the not-saving note: write everything this page holds that may not have reached
  // storage, then read storage back so the page shows what is really there.
  function retrySaves() {
    var ops = failedOps.slice(), jobs = [Store.kvSet('profile', S.profile), Store.kvSet('team', S.team), Store.kvSet('flags', S.flags)];
    S.lines.forEach(function (l) { if (!isSigned(l.month) && !removed[l.id]) jobs.push(Store.putLine(l)); });
    ops.forEach(function (run) { jobs.push(run()); });
    return Promise.all(jobs).then(function () {
      failedOps = failedOps.filter(function (run) { return ops.indexOf(run) === -1; });
      failedLines = table(); S.broken = null;
      return resync(true).then(function () { toast('Saved. What you see is what is stored on this device.'); });
    }, function (e) {
      if (e && e.locked) return lockedElsewhere(e.month);
      if (e && (e.wiped || e.replaced)) return storeFail(e);
      toast('Still not saving. Free up some space on this device, or reload the page.', { bad: true, ms: 9000 });
    });
  }

  /* ---------- what is in storage -> this page (start-up, and again when another tab changed something) ---------- */
  function loadAll() {
    return Promise.all([Store.kvGet('profile', null), Store.kvGet('team', null), Store.kvGet('flags', null), Store.all('lines'), Store.all('claims'), Store.all('approvals')]);
  }
  // Refresh a line object in place from another copy of it (cards and receipt reads hold on to the object).
  function copyInto(cur, src) {
    Object.keys(cur).forEach(function (k) { delete cur[k]; });
    Object.keys(src).forEach(function (k) { cur[k] = src[k]; });
  }
  function adopt(r) {
    // Settings are refreshed in place: an open dialog may be holding on to these objects.
    var p = r[0] && typeof r[0] === 'object' ? r[0] : {};
    S.profile.name = clean(p.name, MAX.name); S.profile.email = U.isEmail(p.email) ? p.email : ''; S.profile.signature = U.isPngDataUrl(p.signature) ? p.signature : '';
    var t = r[1] && typeof r[1] === 'object' ? r[1] : {};
    TEAM_KEYS.forEach(function (k) { S.team[k] = typeof t[k] === 'string' ? clean(t[k], 120) : DEFAULT_TEAM[k]; });
    ['approverEmail', 'financeEmail'].forEach(function (k) { if (S.team[k] && !U.isEmail(S.team[k])) S.team[k] = ''; });
    var f = r[2] && typeof r[2] === 'object' ? r[2] : {};
    Object.keys(S.flags).forEach(function (k) { delete S.flags[k]; });
    Object.keys(f).forEach(function (k) { S.flags[k] = f[k]; });
    // Lines: the objects already on this page are kept and refreshed.
    var byId = table(), seen = table(), next = [];
    S.lines.forEach(function (l) { byId[l.id] = l; });
    (r[3] || []).forEach(function (stored) {
      if (!stored || !idOk(stored.id) || !RE_MONTH.test(stored.month || '')) return;
      if (removed[stored.id] || seen[stored.id]) return; // being removed here right now
      seen[stored.id] = true;
      var cur = byId[stored.id];
      if (!cur) { next.push(stored); return; }
      if (saveTimers[cur.id] || inFlight[cur.id]) { next.push(cur); return; } // a newer edit from this page is on its way to storage
      var mine = readingHere[cur.id] && isReading(stored) ? cur.ocr : null;   // this page is reading that receipt right now
      copyInto(cur, stored);
      if (mine) cur.ocr = mine;
      next.push(cur);
    });
    S.lines.forEach(function (l) { if (!seen[l.id] && (saveTimers[l.id] || inFlight[l.id]) && !removed[l.id]) next.push(l); }); // made here, not stored yet
    S.lines = next;
    S.claims = {};
    (r[4] || []).forEach(function (c) { if (c && RE_MONTH.test(c.month || '')) { c.status = statusOf(c); S.claims[c.month] = c; } });
    S.approvals = (r[5] || []).filter(function (a) { return a && idOk(a.id); });
  }
  var syncing = false, syncAgain = false, stale = false, syncedAt = 0;
  // quiet: after the person's own action; otherwise another tab changed something.
  function resync(quiet) {
    if (S.restoring || S.broken === 'wiped' || S.broken === 'replaced' || Store.isMemoryOnly()) return Promise.resolve();
    if (syncing) { syncAgain = true; return Promise.resolve(); }
    syncing = true; stale = false;
    return Store.epochChanged().then(function (gone) {
      if (gone) { handleReplaced(); return; }
      var f = focusedLine();
      return flushSaves().then(loadAll).then(function (r) {
        adopt(r);
        packCache = null; syncedAt = Date.now();
        // an open "send" dialog must not go on handing out a PDF of a version that has since been replaced
        if (sendDialog && (claimOf(sendDialog.month).fingerprint || '') !== sendDialog.fp) {
          var d = sendDialog; sendDialog = null; d.close();
          if (!quiet) toast('This claim was changed in another window. Showing the latest.', { bad: true, ms: 8000 });
        }
        // The approver's review screen holds a signature being drawn and notes being typed: it is left alone.
        if (S.tab === 'approve' && S.review) { paintTabs(); refreshBanners(); } else if (!keepWith(f)) render();
        resumeReads(); // a receipt left "being read" by a window that has since gone is read here
      });
    }).then(null, function () { /* storage trouble is reported where it is written */ }).then(function () {
      syncing = false;
      if (syncAgain) { syncAgain = false; return resync(quiet); }
    });
  }

  /* =====================================================================================
   * images + reading receipts
   * ===================================================================================== */
  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { resolve({ img: img, w: img.naturalWidth, h: img.naturalHeight, done: function () { URL.revokeObjectURL(url); img.onerror = null; img.removeAttribute('src'); } }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('This file could not be opened as an image')); };
      img.src = url;
    });
  }
  function blobBytes(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (resolve, reject) { var fr = new FileReader(); fr.onload = function () { resolve(fr.result); }; fr.onerror = function () { reject(fr.error); }; fr.readAsArrayBuffer(blob); });
  }
  // Every receipt is kept as a JPEG, normally no bigger than 1800px on its long side: sharp enough to read, small enough to email.
  function toJpeg(src) {
    if (!src.w || !src.h) return Promise.reject(new Error('Empty image'));
    var long = Math.max(src.w, src.h), short = Math.min(src.w, src.h), s = Math.min(1, 1800 / long);
    // a long scrolling screenshot would become a thin unreadable strip at 1800px, so it keeps up to 900px across (4 megapixels at most)
    if (long / short > 2.6) s = Math.min(1, Math.max(s, Math.min(900 / short, Math.sqrt(4e6 / (src.w * src.h)))));
    var cw = Math.max(1, Math.round(src.w * s)), ch = Math.max(1, Math.round(src.h * s));
    var c = document.createElement('canvas'); c.width = cw; c.height = ch;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src.img, 0, 0, cw, ch);
    var q = long < 1100 ? 0.93 : 0.85; // small screenshots keep more detail so the text still reads cleanly
    return new Promise(function (resolve, reject) {
      c.toBlob(function (b) {
        UI.freeCanvas(c);
        if (!b) return reject(new Error('Could not prepare this image'));
        blobBytes(b).then(function (buf) { resolve({ bytes: buf, w: cw, h: ch }); }, reject);
      }, 'image/jpeg', q);
    });
  }
  function isImageFile(f) { return /^image\//.test(f.type || '') || /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(f.name || ''); }
  function isPdfFile(f) { return f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''); }
  // Ask the browser to keep this site's data. Firefox shows a permission question for this, so there
  // it is only asked from the button in Settings, where the reason is explained.
  function keepData() { if (!/Firefox\//.test(navigator.userAgent)) Store.persist(); }

  // Where a new line goes: the month on screen, unless that is signed; then this calendar month
  // (or the first one after it that is still open).
  function openMonthFor() {
    if (!isLocked(S.month)) return S.month;
    var m = U.monthOf(U.todayIso());
    for (var i = 0; i < 24 && isLocked(m); i++) m = U.addMonths(m, 1);
    return m;
  }

  var batch = null;    // collects what happened while a batch of receipts is read, for one summary message
  var attachTo = null; // a typed line waiting for its receipt from the "attach" file picker
  function addFiles(fileList, o) {
    o = o || {};
    var files = Array.prototype.slice.call(fileList || []);
    var pdfs = files.filter(isPdfFile), imgs = files.filter(function (f) { return !isPdfFile(f) && isImageFile(f); });
    if (pdfs.length && window.App.openPdfs) window.App.openPdfs(pdfs);
    if (!imgs.length) { if (!pdfs.length && files.length) toast('Add receipt screenshots or photos (PNG or JPG).', { bad: true }); return Promise.resolve(); }
    if (S.tab !== 'claims') { toast('Receipt images go under “My claims”.'); return Promise.resolve(); }
    if (S.broken === 'wiped' || S.broken === 'replaced') { toast('Reload the page before adding receipts.', { bad: true }); return Promise.resolve(); }
    var shown = S.month, filed = {}, added = 0, p = Promise.resolve();
    imgs.forEach(function (f) { p = p.then(function () { return addReceipt(f, o).then(function (line) { if (line) { added++; filed[line.month] = true; } }); }); });
    return p.then(function () {
      if (!added) return;
      keepData();
      // A new receipt never goes into a signed month. Say where it went, and show it.
      var months = Object.keys(filed).sort();
      if (!o.attachTo && S.month === shown && !filed[shown] && months.length) {
        var went = months[months.length - 1];
        toast(U.monthLabel(shown) + ' is already signed, so ' + (added > 1 ? 'these receipts are' : 'this receipt is') + ' under ' + U.monthLabel(went) + '.', { ms: 8000 });
        goMonth(went);
      }
    });
  }

  // Resolves to the line that now carries the receipt, or null when nothing was added.
  function addReceipt(file, o) {
    var src = null, target = (o && o.attachTo) || null, label = '“' + (file.name || 'That file') + '”';
    return loadImage(file).then(function (s) {
      src = s;
      return toJpeg(s);
    }).then(function (jpg) {
      src.done(); src = null;
      return U.sha256(jpg.bytes).then(function (hash) {
        var dup = S.lines.filter(function (l) { return l.receiptHash === hash && l !== target; })[0];
        if (dup) {
          toast('That receipt is already in ' + U.monthLabel(dup.month) + '.', { action: 'Show', onAction: function () { goMonth(dup.month, dup.id); } });
          return null;
        }
        if (target && (S.lines.indexOf(target) === -1 || isLocked(target.month) || target.receiptId)) {
          toast('A receipt cannot be added to that item any more (it already has one, or its month is signed).', { bad: true });
          return null;
        }
        var rid = U.uid('r');
        return Store.put('receipts', { id: rid, bytes: jpg.bytes, type: 'image/jpeg', w: jpg.w, h: jpg.h, hash: hash, addedAt: Date.now() }).then(function () {
          var line = target;
          if (line) {
            line.receiptId = rid; line.receiptHash = hash; line.verified = false;
          } else {
            line = { id: U.uid('l'), month: openMonthFor(), date: '', amountCents: null, type: 'other', desc: '', from: '', to: '', verified: false,
              receiptId: rid, receiptHash: hash, createdAt: Date.now(), updatedAt: Date.now() };
            if (o && o.sample) line.sample = true;
            S.lines.push(line);
          }
          line.ocr = { state: 'pending' };
          return saveLine(line, true).then(function () {
            if (S.tab === 'claims') renderClaims();
            queueOcr(line, { fresh: true });
            return line;
          });
        }, function (e) {
          storeFail(e);
          toast(label + ' could not be saved on this device.', { bad: true });
          return null;
        });
      });
    }).catch(function () {
      if (src) src.done();
      var heic = /\.(heic|heif)$/i.test(file.name || '');
      toast(label + ' could not be opened.' + (heic ? ' Take a screenshot of the photo and add the screenshot instead.' : ' Use a PNG or JPG image.'), { bad: true });
      return null;
    });
  }

  // The fields a person can change on a line: used to tell whether anything was typed while a save was on its way.
  function typedState(l) { return JSON.stringify([l.date, l.amountCents, l.type, l.desc, l.from, l.to, l.verified, l.month, l.receiptId]); }
  // Apply a change to the stored copy of a line, then bring this page's copy in line with storage.
  // The stored copy may hold details typed in another tab while this one was in the background;
  // writing this page's whole (older) line over it would wipe them, so only the change goes in.
  function patchStored(line, change) {
    var id = line.id, first = Promise.resolve();
    if (saveTimers[id]) { clearTimeout(saveTimers[id]); delete saveTimers[id]; first = writeLine(line); } // typing from this page goes in first
    return first.then(function () {
      var before = typedState(line);
      inFlight[id] = (inFlight[id] || 0) + 1;
      return Store.patchLine(id, change).then(function (stored) {
        if (!--inFlight[id]) delete inFlight[id];
        if (typedState(line) === before && !saveTimers[id]) copyInto(line, stored); // nothing typed here meanwhile: take the stored line whole
        else change(line);                                                          // typing went on: keep it and make the same change here
        delete failedLines[id];
        return true;
      }, function (e) {
        if (!--inFlight[id]) delete inFlight[id];
        if (e && e.gone) { // removed in another tab while its receipt was being read
          S.lines = S.lines.filter(function (x) { return x !== line; });
          return false;
        }
        change(line);
        if (e && e.locked) { lockedElsewhere(e.month); return false; }
        failedLines[id] = true; storeFail(e);
        return false;
      });
    });
  }

  // "Being read", carrying over what an earlier read of the same receipt had filled in.
  function pendingOcr(was) {
    var o = { state: 'pending' };
    if (was && was.filledAmount) o.filledAmount = true;
    if (was && was.filledDate) o.filledDate = true;
    return o;
  }
  // Read a line's receipt. o.fresh: the line was stored a moment ago, already saying "being read".
  // o.resume: a read that was under way is being picked up again (after a reload, or because the
  // window that was reading it may have gone). Neither: the person asked for the receipt to be read again.
  function queueOcr(line, o) {
    o = o || {};
    if (!batch) batch = { moved: {}, kept: 0, n: 0, pending: 0 };
    var mine = batch, rid = line.receiptId, id = line.id, first = Promise.resolve();
    mine.pending++;
    readingHere[id] = rid;
    if (!isReading(line)) {
      line.ocr = pendingOcr(line.ocr);
      // every window, and a reload, should see it as being read again
      if (!o.fresh && !o.resume) first = patchStored(line, function (l) { l.ocr = pendingOcr(l.ocr); l.updatedAt = Date.now(); });
    }
    // still the receipt this read was started for, and nobody has pressed "Type it in instead"
    function current() { return S.lines.indexOf(line) !== -1 && line.receiptId === rid && readingHere[id] === rid; }
    function finish() {
      delete runningHere[id];
      if (readingHere[id] === rid) delete readingHere[id];
      mine.pending--;
      if (mine.pending <= 0 && batch === mine) { batch = null; batchDone(mine); }
    }
    function run() {
      runningHere[id] = true;
      return OCR.read(function () {
        if (!current()) throw new Error('not wanted any more'); // its turn came after the line had gone: skip the work
        line.ocr.state = 'running';
        return Store.get('receipts', rid).then(function (r) {
          if (!r || !r.bytes) throw new Error('missing receipt');
          return loadImage(new Blob([r.bytes], { type: 'image/jpeg' }));
        });
      }, U.todayIso(), function (p, label) {
        if (!current() || !isReading(line)) return;
        line.ocr.p = p; line.ocr.label = label;
        var card = view.cards[line.id];
        if (card && card._paint) card._paint();
      }).then(function (res) {
        if (current()) return applyOcr(line, res);
      }, function () {
        if (!current()) return;
        return patchStored(line, function (l) { l.ocr = { state: 'failed' }; l.updatedAt = Date.now(); }).then(function () {
          UI.say('A receipt could not be read. Type its date and amount.');
          if (S.tab === 'claims') renderClaims();
        });
      }).catch(function (e) { if (window.console) console.warn(e); }).then(finish);
    }
    // Before reading: unless the receipt was only just added here, look at what is stored. Another
    // window may have finished the read in the meantime, and then there is nothing left to do.
    function start(waited) {
      began = true;
      if (!current()) return finish();
      if (o.fresh && !waited) return run();
      return Store.get('lines', id).then(function (stored) {
        if (!current() || !stored) return finish();
        var st = stored.ocr ? stored.ocr.state : '';
        if (st === 'done' || (st === 'failed' && o.resume)) { finish(); return resync(true); }
        return run();
      }, function () { return current() ? run() : finish(); });
    }
    // With the form open in two windows, only one of them reads a given receipt. A window that finds
    // another one at it waits its turn: by then the read is usually done and stored; if that window
    // was closed instead, this one reads. Where the browser has no locks, or will not hand one out
    // (some refuse when a site may not keep data), each window simply reads for itself.
    var locks = null, began = false;
    try { locks = !Store.isMemoryOnly() && navigator.locks && navigator.locks.request ? navigator.locks : null; } catch (e) { locks = null; }
    function viaLock() {
      var name = 'cetg-read-' + rid, got = false;
      return locks.request(name, { ifAvailable: true }, function (lock) {
        if (!lock) return null;
        got = true;
        return start(false);
      }).then(function () {
        if (got) return;
        if (S.tab === 'claims') renderClaims(); // shows "Waiting to be read"
        return locks.request(name, function () { return start(true); });
      });
    }
    first.then(function () {
      if (!locks) return start(false);
      var p;
      try { p = viaLock(); } catch (e) { p = Promise.reject(e); }
      return p.then(null, function (e) { if (began) throw e; return start(false); }); // no lock to be had: read without one
    }).catch(function (e) { if (window.console) console.warn(e); if (readingHere[id] === rid && !runningHere[id]) finish(); });
  }
  // "Type it in instead": stop waiting for the reader on this line.
  function skipOcr(line) {
    if (!isReading(line)) return;
    delete readingHere[line.id];
    patchStored(line, function (l) { l.ocr = { state: 'failed', skipped: true }; l.updatedAt = Date.now(); }).then(function () {
      if (S.tab === 'claims') renderClaims();
    });
  }

  function applyOcr(line, res) {
    // only what is still empty is filled in: anything typed while the receipt was being read is kept
    function fill(l) {
      var was = l.ocr || {};
      l.ocr = { state: 'done', amounts: res.amounts || [], dates: res.dates || [], amountConf: res.amountConf, dateConf: res.dateConf, hintTo: res.hintTo || '', foreign: res.foreign || '' };
      // what an earlier read of this receipt filled in still counts as "read from the receipt"
      if (was.filledAmount) l.ocr.filledAmount = true;
      if (was.filledDate) l.ocr.filledDate = true;
      if (l.amountCents == null && res.amount != null) { l.amountCents = res.amount; l.ocr.filledAmount = true; }
      if (!l.date && res.date) { l.date = res.date; l.ocr.filledDate = true; }
      if (!l.typeTouched && res.type && own(TYPE_LABEL, res.type)) l.type = res.type;
      l.updatedAt = Date.now();
    }
    if (batch) batch.n++;
    return patchStored(line, fill).then(function () {
      if (S.lines.indexOf(line) === -1) { if (S.tab === 'claims') renderClaims(); return; }
      var was = line.month;
      fileByDate(line);
      if (line.month !== was) saveLine(line, true);
      UI.say('Receipt read: ' + (line.amountCents != null ? '$' + U.money(line.amountCents) : 'no amount found') + (line.date ? ', ' + U.fmtDate(line.date, 'plain') : '') + '. Check it against the receipt.');
      if (S.tab === 'claims') renderClaims();
    });
  }
  // File the line under the month on its receipt, when the reader is reasonably sure of the date and
  // that is a recent month whose claim is still open.
  function fileByDate(line) {
    if (!line.date || line.monthTouched || !line.ocr || !line.ocr.filledDate || line.ocr.dateConf === 'low') return;
    var want = U.monthOf(line.date), now = U.monthOf(U.todayIso());
    if (want === line.month || want > now || want < U.addMonths(now, -AUTO_FILE_BACK)) return; // an odd date stays put; the line says so
    if (isLocked(want)) { if (batch) { batch.kept++; batch.keptWant = want; batch.keptIn = line.month; batch.keptSigned = isSigned(want); } return; }
    var card = view.cards[line.id];
    if (card && card.contains(document.activeElement)) return; // being edited right now: its own note offers the move
    var was = line.month;
    line.month = want;
    if (batch) batch.moved[want] = (batch.moved[want] || 0) + 1;
    if (S.month === was && linesOf(was).length === 0 && !UI.anyModal()) { S.month = want; if (batch) batch.switched = want; }
  }
  function batchDone(b) {
    var months = Object.keys(b.moved).sort().reverse(), total = months.reduce(function (s, m) { return s + b.moved[m]; }, 0);
    if (months.length === 1 && months[0] === S.month) {
      if (b.switched === S.month) toast('Filed under ' + U.monthLabel(S.month) + ', the month on the receipt' + (total > 1 ? 's' : '') + '.');
    } else if (months.length) {
      var target = months.filter(function (m) { return m !== S.month; })[0];
      toast(plural(total, 'receipt') + (total > 1 ? ' were' : ' was') + ' filed by date: ' + months.map(function (m) { return b.moved[m] + ' under ' + U.monthLabel(m); }).join(', ') + '.',
        { action: 'Show ' + U.monthLabel(target, true), onAction: function () { goMonth(target); }, ms: 10000 });
    }
    if (b.kept) {
      toast(U.monthLabel(b.keptWant) + (b.keptSigned ? ' is already signed' : ' is being signed') + ', so ' + (b.kept > 1 ? b.kept + ' receipts stay' : 'the receipt stays') + ' in ' + U.monthLabel(b.keptIn) + '.', { ms: 8000 });
    }
  }

  function sampleReceiptFile() {
    var d = new Date(); d.setDate(d.getDate() - 2);
    var dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()], mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    var ds = dow + ', ' + U.pad2(d.getDate()) + ' ' + mon + ' ' + d.getFullYear();
    var c = document.createElement('canvas'); c.width = 760; c.height = 640;
    var x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#1b1b1b'; x.textBaseline = 'top';
    function center(t, y, f) { x.font = f; x.fillText(t, (c.width - x.measureText(t).width) / 2, y); }
    function left(t, y) { x.font = '26px "Courier New", Courier, monospace'; x.fillText(t, 48, y); }
    center('SAMPLE CAR PARK', 50, 'bold 34px "Courier New", Courier, monospace');
    center('1 Example Road', 100, '26px "Courier New", Courier, monospace');
    center('Singapore 000000', 136, '26px "Courier New", Courier, monospace');
    center('Carpark e-Receipt No: 00-0000-00000', 186, '26px "Courier New", Courier, monospace');
    left('Entry : ' + ds + '  Time : 09:02:11', 262);
    left('Exit  : ' + ds + '  Time : 12:40:53', 304);
    left('Entry ID   : 0000000000', 346);
    left('Total Amount : $ 6.40, 9% GST ($ 0.53)', 400);
    left('THANK YOU. HAVE A NICE DAY.', 470);
    center('SAMPLE ONLY - NOT A REAL RECEIPT', 556, 'bold 22px "Courier New", Courier, monospace');
    return new Promise(function (resolve) { c.toBlob(function (b) { UI.freeCanvas(c); resolve(new File([b], 'sample-receipt.png', { type: 'image/png' })); }, 'image/png'); });
  }

  /* =====================================================================================
   * My claims view
   * The page is built once per month and after that updated in place, so a field someone is
   * typing in is never rebuilt underneath them when a receipt finishes reading.
   * ===================================================================================== */
  function flash(card) { card.classList.add('flag'); setTimeout(function () { card.classList.remove('flag'); }, 2600); }
  // A tall card is shown from its top; a short one in the middle of the screen.
  function showCard(c) { UI.scrollTo(c, c.offsetHeight > window.innerHeight * 0.6 ? 'start' : 'center'); }
  function goMonth(m, lineId) {
    S.month = m; S.tab = 'claims'; paintTabs(); renderClaims();
    var c = lineId ? view.cards[lineId] : null;
    if (c) { showCard(c); flash(c); } else window.scrollTo(0, 0);
    var n = linesOf(m).length, st = statusOf(S.claims[m]);
    UI.say(U.monthLabel(m) + ': ' + (n ? plural(n, 'item') + (st !== 'draft' ? ', ' + STATUS_LABEL[st].toLowerCase() : '') : 'no items yet') + '.');
  }

  function monthOptions() {
    var set = table(), now = U.monthOf(U.todayIso());
    for (var i = -12; i <= 1; i++) set[U.addMonths(now, i)] = true;
    S.lines.forEach(function (l) { set[l.month] = true; });
    Object.keys(S.claims).forEach(function (m) { set[m] = true; });
    set[S.month] = true;
    return Object.keys(set).sort().reverse();
  }
  function monthBar(m) {
    var st = statusOf(S.claims[m]), count = linesOf(m).length, sig = [m, st, count ? 1 : 0];
    var sel = h('select', { id: 'month-select', 'aria-label': 'Claim month' });
    monthOptions().forEach(function (mm) {
      var n = S.lines.filter(function (l) { return l.month === mm; }).length, s2 = statusOf(S.claims[mm]);
      var label = U.monthLabel(mm) + (n && mm !== m ? '  (' + plural(n, 'item') + (s2 !== 'draft' ? ', ' + STATUS_LABEL[s2].toLowerCase() : '') + ')' : '');
      sig.push(label);
      sel.appendChild(h('option', { value: mm, text: label }));
    });
    sel.value = m;
    sel.addEventListener('change', function () { goMonth(sel.value); var s = document.getElementById('month-select'); if (s) s.focus(); });
    var el = h('div', { class: 'monthbar' },
      h('div', { class: 'monthnav' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous month', dataset: { nav: 'prev' }, onclick: function () { goMonth(U.addMonths(m, -1)); refocus('prev'); } }, icon('left')),
        sel,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next month', dataset: { nav: 'next' }, onclick: function () { goMonth(U.addMonths(m, 1)); refocus('next'); } }, icon('right'))),
      count || st !== 'draft' ? h('span', { class: 'pill ' + st, text: STATUS_LABEL[st] }) : null);
    el._sig = sig.join('|');
    return el;
  }
  function refocus(nav) { var b = view.parts && view.parts.monthbar.querySelector('[data-nav="' + nav + '"]'); if (b) b.focus(); }
  function refreshMonthBar() {
    var slot = view.parts.monthbar, old = slot.firstChild, next = monthBar(S.month);
    if (old && old._sig === next._sig) return;
    var hadFocus = old && old.contains(document.activeElement) && document.activeElement.id === 'month-select';
    U.clear(slot); slot.appendChild(next);
    if (hadFocus) { var s = next.querySelector('select'); if (s) s.focus(); }
  }

  /* ---------- notes at the top ---------- */
  function reloadBtn(label) { return h('button', { type: 'button', class: 'btn sm', text: label || 'Reload the page', onclick: function () { location.reload(); } }); }
  // Notes about saving and about the form itself. Shown on both tabs.
  function storageBanners() {
    var out = [];
    if (S.broken) {
      var gone = S.broken === 'wiped' || S.broken === 'replaced';
      var msg = S.broken === 'wiped' ? 'What this form had saved in the browser was cleared while the page was open (for example by “Clear browsing data”). Reload the page to carry on. What is on screen now cannot be saved.'
        : S.broken === 'replaced' ? 'The claims saved by this form were replaced or erased in another window (a backup was restored, or everything was erased). Reload the page to see what is saved now. Changes made on this page since then cannot be saved.'
          : S.broken === 'full' ? 'This device is out of storage space, so your latest changes are not being saved. Free up some space, then press “Try again”.'
            : 'Your latest changes are not being saved on this device. Press “Try again”. If that does not help, reload the page.';
      out.push(h('div', { class: 'banner bad', role: 'alert' }, icon('alert'), h('div', null, h('b', { text: 'Not saving' }), h('div', { text: msg }),
        h('div', { class: 'btn-row' }, !gone ? h('button', { type: 'button', class: 'btn sm primary', id: 'btn-retry-save', text: 'Try again', onclick: retrySaves }) : null, reloadBtn()))));
    }
    if (S.late) {
      out.push(h('div', { class: 'banner warn', role: 'alert' }, icon('alert'), h('div', null, h('b', { text: 'Your saved claims are ready now' }),
        h('div', { text: 'They took too long to open, so the form started without them. Reload the page to see them. Anything entered since the page opened is not kept.' }),
        h('div', { class: 'btn-row' }, reloadBtn()))));
    } else if (Store.isMemoryOnly()) {
      out.push(h('div', { class: 'banner warn' }, icon('alert'), h('div', null, 'This browser is not letting the form save anything (it may be a private window). Whatever you enter will be gone when you close the tab.')));
    }
    if (S.newer) {
      out.push(h('div', { class: 'banner' }, icon('info'), h('div', null, h('b', { text: 'A newer version of this form is ready' }),
        h('div', { text: 'Reload the page to get it. Your saved claims stay as they are.' }),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn sm', id: 'btn-update', text: 'Reload now', onclick: reloadForUpdate })))));
    }
    return out.concat(folderBanners());
  }
  function storageSig() { return [S.broken || '', S.late ? 'late' : '', Store.isMemoryOnly() ? 'mem' : '', S.newer ? 'new' : '', folderSig()].join('|'); }
  function claimBanners() {
    var out = storageBanners();
    if (location.protocol === 'file:') {
      out.push(h('div', { class: 'banner warn' }, icon('alert'), h('div', null, 'You have opened the form as a file on this computer. It works best from its web link: opened this way, receipts cannot be read automatically, so amounts and dates have to be typed in.')));
    }
    if (S.teamOffer) {
      var t = S.teamOffer;
      out.push(h('div', { class: 'banner' }, icon('info'), h('div', null,
        h('b', { text: 'Use your team’s settings?' }),
        h('div', { class: 'small', text: ['Approver: ' + (t.approverName || S.team.approverName || '-') + (t.approverEmail ? ' (' + t.approverEmail + ')' : ''), t.financeEmail ? 'Copy to: ' + t.financeEmail : '',
          t.formTitle && t.formTitle !== S.team.formTitle ? 'Form title: ' + t.formTitle : ''].filter(Boolean).join('  ·  ') }),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn sm primary', text: 'Use these', onclick: function () { applyTeam(t); S.teamOffer = null; render(); toast('Team settings saved on this device.'); } }),
          h('button', { type: 'button', class: 'btn sm', text: 'Not now', onclick: function () { S.teamOffer = null; render(); } })))));
    }
    return out;
  }
  function refreshBanners() {
    if (S.tab !== 'claims') { if (window.App && window.App.refreshApproveBanners) window.App.refreshApproveBanners(); return; }
    if (!view.parts) return;
    var sig = storageSig() + '|' + (S.teamOffer ? JSON.stringify(S.teamOffer) : '');
    if (view.parts.bannerSig === sig) return;
    view.parts.bannerSig = sig;
    U.clear(view.parts.banners); U.append(view.parts.banners, claimBanners());
  }

  /* ---------- advice about where the data lives (both tabs) ----------
   * Everything is kept by the browser, and some browsers clear what a site has saved when the site
   * has not been used for a while. The advice can be put away for the visit, not for good. */
  var tipHidden = {};
  function isDesktopSafari() {
    var ua = navigator.userAgent;
    return /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\/|Firefox\/|CriOS|FxiOS|EdgiOS|Android/.test(ua) && !UI.isIos();
  }
  // Opened inside a chat or mail app's own little browser, where downloads and saved data are unreliable.
  function isInAppBrowser() { return /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|GSA\/|; wv\)/.test(navigator.userAgent); }
  function hasData() { return S.lines.length > 0 || Object.keys(S.claims).length > 0 || S.approvals.length > 0; }
  function backedUpLately() {
    var week = 7 * 24 * 3600 * 1000;
    if (folder.handle && folder.state === 'ok' && folder.lastAt && Date.now() - folder.lastAt < week) return true; // the claims folder is a backup kept up to date
    return !!S.flags.lastBackup && Date.now() - S.flags.lastBackup < week;
  }
  function tipKinds() {
    var out = [], data = hasData();
    if (isInAppBrowser() && !tipHidden.inapp) out.push('inapp');
    if (UI.isIos() && !UI.isStandalone()) { if (!tipHidden.ios && !(data && backedUpLately())) out.push(data ? 'ios-data' : 'ios-new'); }
    else if (isDesktopSafari() && !UI.isStandalone() && data && !backedUpLately() && !tipHidden.safari) out.push('safari');
    if (canInstall() && data && !tipHidden.install) out.push('install');
    if (folderOffer() && !tipHidden.folder) out.push('folder');
    return out;
  }
  function tipSig() { return tipKinds().join('|'); }
  function tipBanners() {
    function hide(key) { return h('button', { type: 'button', class: 'btn sm', text: 'Hide for now', onclick: function () { tipHidden[key] = true; refreshTips(); } }); }
    return tipKinds().map(function (k) {
      if (k === 'inapp') {
        return h('div', { class: 'banner warn', dataset: { tip: k } }, icon('alert'), h('div', null,
          'This page is open inside another app (for example from a chat or an email). Files may not download or share from here, and what you enter may not be kept. Open the link in Safari or Chrome instead.',
          h('div', { class: 'btn-row' }, hide('inapp'))));
      }
      if (k === 'safari') {
        return h('div', { class: 'banner', dataset: { tip: k } }, icon('info'), h('div', null,
          'Safari clears what a website has saved when the site has not been used for 7 days. Open this form at least once a week, and download a backup in Settings now and then.',
          h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn sm', text: 'Open Settings', onclick: function () { openSettings(); } }), hide('safari'))));
      }
      if (k === 'install') {
        return h('div', { class: 'banner', dataset: { tip: k } }, icon('info'), h('div', null,
          h('b', { text: 'Install this form as an app' }),
          h('div', { text: 'It then opens from its own icon, like any other app, and works without internet. Your claims stay on this device either way.' }),
          h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn sm primary', id: 'btn-install', text: 'Install', onclick: function () { installApp(); } }), hide('install'))));
      }
      if (k === 'folder') {
        return h('div', { class: 'banner', dataset: { tip: k } }, icon('info'), h('div', null,
          h('b', { text: 'Keep a copy of your claims in a folder' }),
          h('div', { text: 'Choose a folder on this computer (OneDrive works well) and the form writes every item, receipt and signed PDF there as you go. If the browser ever loses its copy, the folder brings it back.' }),
          h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn sm primary', id: 'btn-folder-tip', text: 'Choose a folder', onclick: function () { chooseFolder(); } }),
            h('button', { type: 'button', class: 'btn sm', text: 'Not now', onclick: function () { S.flags.noFolderTip = true; saveFlags(); refreshTips(); } }))));
      }
      var text = k === 'ios-data'
        ? 'Keep your claims safe on iPhone or iPad: Safari clears what a website has saved when the site has not been used for 7 days. Download a backup in Settings, add this page to your Home Screen (Share, then “Add to Home Screen”), open it from there and restore the backup. The Home Screen copy keeps its own data and is not cleared that way.'
        : 'On iPhone or iPad, add this page to your Home Screen before you start (Share, then “Add to Home Screen”) and always open it from there. Safari clears what a website has saved when the site has not been used for 7 days; the Home Screen copy keeps its own data and is not cleared that way.';
      return h('div', { class: 'banner', dataset: { tip: k } }, icon('info'), h('div', null, text, h('div', { class: 'btn-row' }, hide('ios'))));
    });
  }
  function refreshTips() {
    if (S.tab !== 'claims') { if (window.App && window.App.refreshApproveBanners) window.App.refreshApproveBanners(); return; }
    if (!view.parts) return;
    var sig = tipSig();
    if (view.parts.tipSig === sig) return;
    view.parts.tipSig = sig;
    U.clear(view.parts.tips); U.append(view.parts.tips, tipBanners());
  }

  function addZone(empty) {
    var first = approverFirst(), touch = UI.isTouch(), pasteKey = /Mac/.test(navigator.platform || '') ? '⌘V' : 'Ctrl+V';
    var z = h('section', { class: 'addzone' + (empty ? ' empty' : ''), 'aria-label': 'Add receipts' },
      empty ? h('h2', { text: 'Add your receipts for ' + U.monthLabel(S.month) }) : null,
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary' + (empty ? ' big' : ''), id: 'btn-add', onclick: function () { document.getElementById('pick-images').click(); } }, icon('upload'), 'Add receipts'),
        touch ? h('button', { type: 'button', class: 'btn', onclick: function () { document.getElementById('pick-camera').click(); } }, icon('camera'), 'Take photo') : null,
        h('button', { type: 'button', class: 'btn', id: 'btn-manual', onclick: addManualLine }, icon('plus'), 'Item without receipt')),
      h('p', { text: touch ? 'Pick screenshots or photos of your receipts. The amount and date are read on this device, so nothing is uploaded.'
        : 'Choose screenshots, drag them onto this page, or paste one with ' + pasteKey + '. The amount and date are read on this device, so nothing is uploaded.' }));
    if (empty) {
      z.appendChild(h('ol', { class: 'steps' },
        h('li', null, h('div', null, h('b', { text: 'Add each receipt' }), 'Grab, taxi, parking, MRT or any other expense. The amount and date are filled in for you to check.')),
        h('li', null, h('div', null, h('b', { text: 'Add the trip details' }), 'Type what the trip was for, where it started and ended, then tick that the amount is right.')),
        h('li', null, h('div', null, h('b', { text: 'Sign at month end' }), 'The month is totalled for you. Sign on screen and send the PDF to ' + first + '.'))));
      z.appendChild(h('p', null, 'New here? ', h('button', { type: 'button', class: 'link', id: 'btn-sample', text: 'Try it with a sample receipt', onclick: function () {
        sampleReceiptFile().then(function (f) { addFiles([f], { sample: true }); });
      } }), '.'));
      z.appendChild(h('p', { class: 'small', id: 'officer-line' }, 'Your claims go to ', h('b', { text: S.team.approverName || 'your reporting officer' }), ' for approval. ',
        h('button', { type: 'button', class: 'link', id: 'btn-officer', text: 'Change', onclick: openSettings }), '.'));
      if (!hasData()) {
        var ways = [];
        if (folderSupported()) ways.push(h('button', { type: 'button', class: 'link', id: 'btn-recover-folder', text: 'your claims folder', onclick: function () { folder.handle ? restoreFromFolder(folder.handle) : chooseFolder(); } }));
        ways.push(h('button', { type: 'button', class: 'link', id: 'btn-recover-backup', text: 'a backup file', onclick: function () { document.getElementById('pick-backup').click(); } }));
        ways.push(h('button', { type: 'button', class: 'link', id: 'btn-recover-pdf', text: 'the PDFs you sent', onclick: function () { document.getElementById('pick-bringback').click(); } }));
        var line = h('p', { class: 'small', id: 'recover-line' }, 'Had claims before? Bring them back from ');
        ways.forEach(function (w, i) { if (i) line.appendChild(document.createTextNode(i === ways.length - 1 ? ' or ' : ', ')); line.appendChild(w); });
        line.appendChild(document.createTextNode('.'));
        z.appendChild(line);
      }
    }
    return z;
  }

  function addManualLine() {
    if (S.broken === 'wiped' || S.broken === 'replaced') { toast('Reload the page before adding items.', { bad: true }); return; }
    var m = openMonthFor();
    var line = { id: U.uid('l'), month: m, date: '', amountCents: null, type: 'transit', typeTouched: true, desc: '', from: '', to: '', verified: false, receiptId: '', receiptHash: '', ocr: { state: 'none' }, createdAt: Date.now(), updatedAt: Date.now() };
    S.lines.push(line);
    saveLine(line, true);
    if (m !== S.month) { toast(U.monthLabel(S.month) + ' is already signed, so the new item is under ' + U.monthLabel(m) + '.', { ms: 8000 }); S.month = m; }
    renderClaims();
    var c = view.cards[line.id];
    if (c) { showCard(c); var d = c.querySelector('[data-f="date"]'); if (d) d.focus({ preventScroll: true }); }
  }

  function suggestions(kind, l) {
    var counts = table();
    S.lines.forEach(function (x) {
      if (x.id === l.id) return;
      (kind === 'desc' ? [x.desc] : [x.from, x.to]).forEach(function (v) {
        v = clean(v, 300); if (!v) return;
        var k = v.toLowerCase();
        if (!counts[k]) counts[k] = { v: v, n: 0, t: 0 };
        counts[k].n++; counts[k].t = Math.max(counts[k].t, x.updatedAt || 0);
      });
    });
    var arr = Object.keys(counts).map(function (k) { return counts[k]; }).sort(function (a, b) { return b.n - a.n || b.t - a.t; }).map(function (o) { return o.v; });
    if (kind === 'place' && !arr.some(function (v) { return v.toLowerCase() === 'home'; })) arr.push('Home');
    return arr.slice(0, 6);
  }

  /* ---------- one item card ---------- */
  function lineCard(l) {
    var card = h('article', { class: 'line', tabindex: '-1', dataset: { id: l.id } }), no = '';
    card._line = l;
    var noEl = h('div', { class: 'line-no' });

    function makeThumb() {
      var t;
      if (l.receiptId) {
        var img = h('img', { alt: '' });
        receiptUrl(l.receiptId).then(function (u) { if (u) img.src = u; });
        t = h('button', { type: 'button', class: 'thumb', title: 'Open receipt', onclick: function () { openLineViewer(l.month, l.id); } }, img, h('span', { class: 'zoom' }, icon('zoom', 'sm')));
      } else {
        t = h('button', { type: 'button', class: 'thumb none', title: 'Attach a receipt', onclick: function () { attachTo = l; document.getElementById('pick-attach').click(); } }, 'Add receipt');
      }
      t._rid = l.receiptId || '';
      return t;
    }
    var thumb = makeThumb();

    /* fields */
    var date = h('input', { type: 'date', value: l.date || '', max: U.todayIso(), dataset: { f: 'date' } });
    var dateEcho = h('small', { class: 'hint echo' }); // the date in words, so day and month cannot be mixed up
    var amt = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', id: 'amt-' + l.id, value: l.amountCents != null ? U.money(l.amountCents) : '', dataset: { f: 'amt' } });
    var type = h('select', { dataset: { f: 'type' } });
    TYPES.forEach(function (t) { type.appendChild(h('option', { value: t[0], text: t[1] })); });
    type.value = own(TYPE_LABEL, l.type) ? l.type : 'other';
    var desc = h('textarea', { rows: '1', maxlength: String(MAX.desc), autocomplete: 'off', dataset: { f: 'desc' } }); // one row that grows with the text
    desc.value = l.desc || '';
    var from = h('input', { type: 'text', value: l.from || '', maxlength: String(MAX.place), autocomplete: 'off', dataset: { f: 'from' } });
    var to = h('input', { type: 'text', value: l.to || '', maxlength: String(MAX.place), autocomplete: 'off', dataset: { f: 'to' } });
    var fDate = h('label', { class: 'field f-date' }, h('span', { text: 'Date' }), date, dateEcho);
    var cands = h('div', { class: 'chips', hidden: true }), candSig = null;
    var fAmt = h('div', { class: 'field f-amt' }, h('label', { class: 'lbl', for: amt.id, text: 'Amount claimed ($)' }), h('div', { class: 'money' }, h('i', { text: '$', 'aria-hidden': 'true' }), amt), cands);
    var fType = field('Type', type, { cls: 'f-type' });
    var fDesc = field(descLabel(l), desc);
    var fFrom = field('Start', from), fTo = field('To', to);
    var swap = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Swap start and end', title: 'Swap start and end' }, icon('swap'));
    var sugg = h('div', { class: 'chips', hidden: true });
    var chk = h('input', { type: 'checkbox', checked: !!l.verified, dataset: { f: 'ok' } });
    var chkText = h('span');
    var check = h('label', { class: 'check' }, chk, chkText);
    // While the receipt is being read: built once and updated in place, so its link is never rebuilt under a tap.
    var readText = h('span'), readBar = h('i');
    var readBox = h('div', { class: 'readbox', hidden: true },
      h('div', { class: 'reading' }, h('span', { class: 'spin' }), readText, h('span', { class: 'meter' }, readBar)),
      h('div', null, h('button', { type: 'button', class: 'link', dataset: { act: 'skip-read' }, text: 'Type it in instead', onclick: function () {
        skipOcr(l);
        try { (l.date ? amt : date).focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      } })));
    var noteList = h('div', { class: 'notes' }), noteSig = null;
    var note = h('div', { class: 'note' }, readBox, noteList);
    var removeSlot = h('span', null);
    var removeBtn = h('button', { type: 'button', class: 'link danger', text: 'Remove' });
    removeSlot.appendChild(removeBtn);

    function mark(fieldEl, input, need) {
      var on = !!(S.showNeeds && need);
      fieldEl.classList.toggle('need', on);
      if (on) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
    function grow() { // the details box grows with what is typed in it
      if (!desc.isConnected) return;
      desc.style.height = 'auto';
      desc.style.height = Math.min(200, desc.scrollHeight + 2) + 'px';
    }
    function paint() {
      var needs = needsOf(l), reading = isReading(l), hasReceipt = !!l.receiptId, ocr = l.ocr || {}, other = l.type === 'other';
      mark(fDate, date, needs.date); mark(fAmt, amt, needs.amt); mark(fDesc, desc, needs.desc); mark(fFrom, from, needs.from); mark(fTo, to, needs.to);
      var needTick = !!(S.showNeeds && needs.verified && !needs.amt);
      check.classList.toggle('on', !!l.verified);
      check.classList.toggle('need', needTick);
      if (needTick) chk.setAttribute('aria-invalid', 'true'); else chk.removeAttribute('aria-invalid');
      chk.checked = !!l.verified;
      chkText.textContent = l.verified ? 'Amount checked' : tickLabel(l);
      fDesc.firstChild.textContent = descLabel(l);
      desc.placeholder = other ? 'e.g. Printing for a workshop' : 'e.g. Client meeting';
      from.placeholder = other ? 'Optional' : 'e.g. Home';
      to.placeholder = other ? 'Optional' : 'e.g. Eunos Rd 8';
      dateEcho.textContent = U.fmtDate(l.date) || '';
      if (reading) card.setAttribute('aria-busy', 'true'); else card.removeAttribute('aria-busy');

      // other amounts found on the receipt (rebuilt only when they change, so a tap on one always lands)
      var others = reading ? [] : (ocr.amounts || []).filter(function (a) { return a.cents !== l.amountCents; }).slice(0, 5);
      var cs = others.map(function (a) { return a.cents; }).join(',');
      if (cs !== candSig) {
        candSig = cs;
        U.clear(cands);
        cands.hidden = !others.length;
        if (others.length) {
          cands.appendChild(h('span', { text: 'Other amounts on the receipt (' + (UI.isTouch() ? 'tap' : 'click') + ' to use):' }));
          others.forEach(function (a) {
            cands.appendChild(h('button', { type: 'button', class: 'chip num', text: U.money(a.cents), title: 'Use ' + U.money(a.cents) + ' instead', 'aria-label': 'Use $' + U.money(a.cents) + ' instead',
              onclick: function () { amt.value = U.money(a.cents); setAmount(a.cents, true); try { chk.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }));
          });
        }
      }

      // what the person should know about this item
      readBox.hidden = !reading;
      if (reading) {
        var pct = Math.round((ocr.p || 0) * 100);
        readText.textContent = ocr.state === 'pending' ? 'Waiting to be read' : (ocr.label || 'Reading') + ' ' + pct + '%';
        readBar.style.width = pct + '%';
        if (noteSig !== '') { noteSig = ''; U.clear(noteList); }
        return;
      }
      var list = [], today = U.todayIso(), thisMonth = U.monthOf(today);
      function say(key, msg, warn) { list.push({ k: key, make: function () { return h('div', { class: warn ? 'warn' : null, text: msg }); } }); }
      if (l.sample) say('sample', 'Sample receipt. Remove this item before you sign.', true);
      if (ocr.state === 'failed') {
        list.push({ k: 'failed' + (ocr.skipped ? 1 : 0), make: function () {
          return h('div', { class: 'warn' }, ocr.skipped ? 'Not read. Type the date and amount, or ' : 'This receipt could not be read. Type the date and amount, or ',
            h('button', { type: 'button', class: 'link', dataset: { act: 'read-again' }, text: ocr.skipped ? 'read it now' : 'try again', onclick: function () { queueOcr(l); paint(); renderBar(); } }), '.');
        } });
      }
      if (U.validIso(l.date) && l.date > today) say('future', 'This date is in the future. Check it.', true);
      else if (U.validIso(l.date) && U.monthOf(l.date) !== l.month) {
        var otherM = U.monthOf(l.date), old = otherM < U.addMonths(thisMonth, -AUTO_FILE_BACK);
        var canMove = !isLocked(otherM) && otherM <= thisMonth, signedThere = isSigned(otherM);
        list.push({ k: ['month', l.date, l.month, canMove, signedThere].join(), make: function () {
          var row = h('div', { class: 'warn' }, 'Dated ' + U.fmtDate(l.date, 'plain') + ', outside ' + U.monthLabel(l.month) + '.' + (old ? ' Check the year. ' : ' '));
          if (canMove) {
            row.appendChild(h('button', { type: 'button', class: 'link', dataset: { act: 'move-month' }, text: 'Move to ' + U.monthLabel(otherM), onclick: function () {
              if (isLocked(otherM) || isLocked(l.month)) return;
              l.month = otherM; l.monthTouched = true; saveLine(l, true); renderClaims();
              toast('Moved to ' + U.monthLabel(otherM) + '.', { action: 'Show', onAction: function () { goMonth(otherM, l.id); } });
            } }));
          } else if (signedThere) row.appendChild(document.createTextNode(U.monthLabel(otherM) + ' is already signed.'));
          return row;
        } });
      }
      if (ocr.foreign) say('foreign' + ocr.foreign, 'This receipt looks like it is in ' + ocr.foreign + '. Enter the amount you are claiming in $.', true);
      if (ocr.state === 'done' && !l.verified) {
        // the date was read from the receipt, the reader was not sure of it, and nobody has confirmed it yet
        if (ocr.filledDate && !l.dateTouched && ocr.dateConf !== 'high' && U.validIso(l.date)) say('date' + l.date, 'Check the date: it was read as ' + U.fmtDate(l.date, 'plain') + '.', true);
        var top = (ocr.amounts || [])[0], same = !!top && top.cents === l.amountCents;
        if (ocr.amountConf === 'none' || !top) say('none', 'No amount found on this receipt. Type it in.', true);
        else if (!same && ocr.amountConf === 'high' && l.amountCents > 0) say('differs' + top.cents, 'The receipt total reads $' + U.money(top.cents) + '. Check the amount.', true);
        else if (same && ocr.amountConf === 'low') say('low', 'Not sure this is the total. Check it against the receipt.', true);
        else if (same && ocr.amountConf === 'medium') say('medium', 'This is probably the total. Check it against the receipt.', true);
        else if (!list.length) say('read', 'Read from the receipt. Check the amount, then tick it.');
      }
      if (!hasReceipt && !list.length) say('norcpt', 'No receipt attached.');
      list = list.slice(0, 3);
      var sig = list.map(function (n) { return n.k; }).join('|') || '-';
      if (sig !== noteSig) {
        noteSig = sig;
        U.clear(noteList);
        list.forEach(function (n) { noteList.appendChild(n.make()); });
      }
    }
    card._paint = paint;
    card._setNo = function (n) {
      no = U.pad2(n);
      noEl.textContent = no;
      card.setAttribute('aria-label', 'Item ' + no);
      thumb.setAttribute('aria-label', l.receiptId ? 'Open receipt ' + no : 'Attach a receipt to item ' + no);
    };
    // Bring the fields in line with the data. A field someone is in is left alone, with one exception:
    // an empty amount field takes the amount just read from the receipt, selected, so that typing
    // replaces it instead of being added to it.
    card._sync = function () {
      var ae = document.activeElement;
      if ((l.receiptId || '') !== thumb._rid) {
        var t = makeThumb(), had = thumb === ae;
        card.replaceChild(t, thumb); thumb = t;
        if (no) card._setNo(parseInt(no, 10));
        if (had) { try { t.focus({ preventScroll: true }); } catch (e) { /* ignore */ } ae = document.activeElement; }
      }
      function put(el, v) {
        if (el === ae) { if (el === amt && el.value === '' && v !== '') { el.value = v; try { el.select(); } catch (e) { /* ignore */ } } return; }
        if (el.value !== v) el.value = v;
      }
      put(date, l.date || '');
      put(amt, l.amountCents != null ? U.money(l.amountCents) : '');
      if (type !== ae) type.value = own(TYPE_LABEL, l.type) ? l.type : 'other';
      put(desc, l.desc || ''); put(from, l.from || ''); put(to, l.to || '');
      grow();
      paint();
    };

    function changed(now) { saveLine(l, !!now); paint(); renderBar(); }
    function setAmount(cents, now) {
      if (cents === l.amountCents) return;
      l.amountCents = cents;
      if (l.verified) l.verified = false; // a changed amount has to be checked again
      changed(now);
    }
    date.addEventListener('focus', function () { date.max = U.todayIso(); }); // the page may have been open since yesterday
    date.addEventListener('change', function () {
      var v = date.value;
      l.date = (U.validIso(v) && v >= '2000-01-01') ? v : '';
      l.dateTouched = true;
      changed(true);
    });
    // Once the date field is left, the list goes back into date order (this card stays where it is on screen).
    date.addEventListener('blur', function () { setTimeout(settle, 0); });
    amt.addEventListener('input', function () { setAmount(U.parseMoney(amt.value)); });
    amt.addEventListener('blur', function () {
      if (amt.value.trim() && l.amountCents == null) toast('That amount could not be read. Type it like 13.80.', { bad: true });
      amt.value = l.amountCents != null ? U.money(l.amountCents) : '';
      if (saveTimers[l.id]) saveLine(l, true);
    });
    type.addEventListener('change', function () { l.type = type.value; l.typeTouched = true; changed(true); });
    desc.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) e.preventDefault(); }); // one run of text, as on the form
    desc.addEventListener('input', function () {
      if (/[\r\n]/.test(desc.value)) desc.value = desc.value.replace(/[\r\n]+/g, ' '); // pasted text
      l.desc = desc.value; grow(); changed();
    });
    from.addEventListener('input', function () { l.from = from.value; changed(); });
    to.addEventListener('input', function () { l.to = to.value; changed(); });
    swap.addEventListener('click', function () { var a = from.value; from.value = to.value; to.value = a; l.from = from.value; l.to = to.value; changed(true); });
    chk.addEventListener('change', function () {
      if (chk.checked && !(l.amountCents > 0)) { chk.checked = false; toast('Enter the amount first.'); amt.focus(); return; }
      l.verified = chk.checked; changed(true);
    });
    removeBtn.addEventListener('click', function () {
      UI.confirmInline(removeSlot, 'Remove item ' + no + '?', 'Remove', function () { removeLine(l); }, { noLabel: 'Keep' });
    });
    // When focus leaves this card, put the list back in date order (never while someone is in the card).
    card.addEventListener('focusout', function () { setTimeout(function () { if (!card.contains(document.activeElement)) settle(); }, 0); });

    /* suggestions from earlier claims: tap targets only, so they are not tab stops that vanish */
    var hideT = null;
    function showSugg(kind, input, set) {
      clearTimeout(hideT);
      var list = suggestions(kind, l);
      if (kind === 'place' && input === to && l.ocr && l.ocr.hintTo) list = [l.ocr.hintTo].concat(list.filter(function (v) { return v !== l.ocr.hintTo; }));
      list = list.filter(function (v) { return v !== input.value; }).slice(0, 6);
      U.clear(sugg);
      sugg.hidden = !list.length;
      if (!list.length) return;
      sugg.appendChild(h('span', { text: kind === 'desc' ? 'Used before:' : 'Places:' }));
      list.forEach(function (v) {
        var b = h('button', { type: 'button', class: 'chip', text: v, title: v, tabindex: '-1' });
        b.addEventListener('pointerdown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function () { input.value = v; set(v); showSugg(kind, input, set); });
        sugg.appendChild(b);
      });
    }
    function wire(input, kind, set) {
      input.addEventListener('focus', function () { showSugg(kind, input, set); });
      input.addEventListener('blur', function () { if (saveTimers[l.id]) saveLine(l, true); hideT = setTimeout(function () { sugg.hidden = true; }, 180); });
    }
    wire(desc, 'desc', function (v) { l.desc = v; grow(); changed(true); });
    wire(from, 'place', function (v) { l.from = v; changed(true); });
    wire(to, 'place', function (v) { l.to = v; changed(true); });

    card.appendChild(noEl);
    card.appendChild(thumb);
    card.appendChild(h('div', { class: 'line-head' }, fDate, fAmt, fType));
    card.appendChild(h('div', { class: 'line-body' }, fDesc, h('div', { class: 'route' }, fFrom, swap, fTo), sugg, h('div', { class: 'line-foot' }, check, note, removeSlot)));
    paint();
    setTimeout(grow, 0);
    return card;
  }

  // Make the cards on screen match the items of this month: add, drop, renumber, re-sort.
  // The card that has focus is never moved or rebuilt; the others move around it and the page is
  // scrolled so that it stays where it was.
  function refreshLines() {
    var list = view.list;
    if (!list) return;
    var ls = linesOf(S.month), keep = table(), order = [], ae = document.activeElement, pinned = null;
    Object.keys(view.cards).forEach(function (id) { if (view.cards[id].contains(ae)) pinned = view.cards[id]; });
    var top0 = pinned ? pinned.getBoundingClientRect().top : 0;
    ls.forEach(function (l, i) {
      var card = view.cards[l.id];
      if (!card || card._line !== l) { if (card && card.parentNode) card.parentNode.removeChild(card); card = view.cards[l.id] = lineCard(l); }
      card._setNo(i + 1); card._sync();
      keep[l.id] = true; order.push(card);
    });
    Object.keys(view.cards).forEach(function (id) {
      if (keep[id]) return;
      var c = view.cards[id];
      if (c.parentNode) c.parentNode.removeChild(c);
      delete view.cards[id];
    });
    var same = list.children.length === order.length && order.every(function (c, i) { return list.children[i] === c; });
    if (!same) {
      var pi = pinned ? order.indexOf(pinned) : -1;
      if (pi === -1) order.forEach(function (c) { list.appendChild(c); });
      else {
        order.slice(0, pi).forEach(function (c) { list.insertBefore(c, pinned); });
        order.slice(pi + 1).forEach(function (c) { list.appendChild(c); });
      }
    }
    if (pinned && document.contains(pinned)) {
      var d = pinned.getBoundingClientRect().top - top0;
      if (Math.abs(d) > 1) window.scrollBy(0, d);
    }
  }
  function settle() { if (S.tab === 'claims' && view.mode === 'lines' && view.month === S.month && !isSigned(S.month)) { refreshLines(); renderBar(); } }

  function removeLine(l) {
    if (isLocked(l.month)) return;
    var id = l.id, ls = linesOf(l.month), at = ls.indexOf(l), next = ls[at + 1] || ls[at - 1] || null;
    S.lines = S.lines.filter(function (x) { return x !== l; });
    clearTimeout(saveTimers[id]); delete saveTimers[id]; delete failedLines[id]; delete readingHere[id];
    // Until storage has dropped it too, a re-read of storage must not bring the item back on screen.
    removed[id] = true;
    function drop() { return Store.delLine(id).then(function () { delete removed[id]; }); }
    drop().catch(function (e) {
      if (e && e.locked) { delete removed[id]; lockedElsewhere(e.month); return; }
      storeFail(e);
      failedOp(drop); // "Try again" on the not-saving note removes it for good
    });
    if (l.receiptId) dropUrl(l.receiptId);
    packCache = null;
    renderClaims();
    UI.say('Item removed.');
    // focus goes to the item that took its place (or to "Add receipts" when none is left), and that is shown
    var target = (next && view.cards[next.id]) || document.getElementById('btn-add');
    if (target) { try { target.focus(); } catch (e) { /* ignore */ } }
  }

  function openLineViewer(m, startId, readOnly) {
    var all = linesOf(m), ls = all.filter(function (l) { return l.receiptId; }), fixed = readOnly || isLocked(m);
    var items = ls.map(function (l) {
      var n = U.pad2(all.indexOf(l) + 1);
      return {
        getUrl: function () { return receiptUrl(l.receiptId); },
        title: 'Receipt ' + n,
        amount: l.amountCents != null ? U.moneyS(l.amountCents) : 'No amount yet',
        sub: [U.fmtDate(l.date) || 'No date yet', TYPE_LABEL[l.type] || '', clean(l.desc)].filter(Boolean).join('  ·  '),
        box: amountBox(l),
        verify: fixed ? null : { get: function () { return !!l.verified; }, set: function (v) { if (v && !(l.amountCents > 0)) { toast('Enter the amount first.'); return; } l.verified = v; saveLine(l, true); }, label: 'Amount matches', onLabel: 'Amount checked' }
      };
    });
    var idx = 0; ls.forEach(function (l, i) { if (l.id === startId) idx = i; });
    UI.viewer(items, idx, { onClose: function () { if (S.tab === 'claims') renderClaims(); } });
  }

  /* ---------- the paper sheet ---------- */
  // A box that scrolls sideways is a tab stop only while it really scrolls.
  function scrollTab(el) {
    var seen = false;
    function fit() {
      if (!document.contains(el)) { if (seen) window.removeEventListener('resize', fit); return; }
      seen = true;
      if (el.scrollWidth > el.clientWidth + 1) el.setAttribute('tabindex', '0'); else el.removeAttribute('tabindex');
    }
    setTimeout(fit, 0);
    window.addEventListener('resize', fit);
    return el;
  }
  // The table keeps its roles spelt out: on a phone it is laid out as blocks, and some browsers then
  // stop telling screen readers that it is a table.
  function sheetEl(model, o) {
    o = o || {};
    function th(t, cls) { return h('th', { class: cls || null, text: t, scope: 'col', role: 'columnheader' }); }
    function cell(cls, text, child) { return h('td', { class: cls || null, role: 'cell', text: text == null ? null : text }, child || null); }
    var tbody = h('tbody', { role: 'rowgroup' });
    model.lines.forEach(function (l, i) {
      var rc;
      if (l.receiptId && o.thumbUrl) {
        var img = h('img', { alt: '' });
        o.thumbUrl(l).then(function (u) { if (u) img.src = u; });
        rc = h('button', { type: 'button', class: 'rcpt', 'aria-label': 'Open receipt ' + U.pad2(i + 1), title: 'Open receipt', onclick: function () { if (o.onThumb) o.onThumb(l, i); } }, img);
      } else rc = h('span', { class: 'norcpt', text: l.receiptId ? '' : 'none' });
      tbody.appendChild(h('tr', { role: 'row' },
        cell('c', U.pad2(i + 1)), cell('', U.fmtDate(l.date) || '-'), cell('', l.desc || '-'), cell('', l.from || '-'), cell('', l.to || '-'),
        cell('r amt', '$' + U.money(l.amountCents)), cell('c', null, rc)));
    });
    tbody.appendChild(h('tr', { class: 'total', role: 'row' },
      h('td', { class: 'r', colspan: '5', role: 'cell', 'aria-colspan': '5', text: 'Total claim (' + plural(model.lines.length, 'item') + ')' }),
      cell('r amt', '$' + U.money(model.totalCents)), cell('', '')));
    var ap = o.approval || null;
    var nameB = h('b', { text: model.signedName || model.staffName || '' }), purposeB = h('b', { text: model.purpose || 'Transport' });
    var left = h('div', { class: 'sign' }, h('b', { class: 'h', text: 'Submitted by:' }),
      h('div', null, 'Name of Staff: ', nameB),
      h('div', { text: 'Date of Claim: ' + (U.fmtStamp(model.signedAt, false, model.tzo) || '') }),
      U.isPngDataUrl(model.signature) ? h('img', { src: model.signature, alt: 'Signature of ' + (model.signedName || 'staff') }) : null,
      h('div', { class: 'meta', text: model.signedAt ? 'Signed electronically ' + U.fmtStamp(model.signedAt, true, model.tzo) : 'Not signed yet' }));
    var right = h('div', { class: 'sign' }, h('b', { class: 'h', text: 'Approved by:' }),
      h('div', { text: 'Name of Authorised Signatory:' }), h('div', null, h('b', { text: (ap && ap.name) || o.approverName || '' })),
      h('div', { text: 'Date of Approval: ' + (ap ? U.fmtStamp(ap.at, false, ap.tzo) : '') }),
      ap && U.isPngDataUrl(ap.signature) ? h('img', { src: ap.signature, alt: 'Signature of ' + (ap.name || 'approver') }) : null,
      h('div', { class: 'meta', text: ap ? (ap.manual ? 'Approval recorded by the claimant' : 'Approved electronically ' + U.fmtStamp(ap.at, true, ap.tzo)) : 'Awaiting approval' }),
      ap && !ap.manual ? h('span', { class: 'stamp', text: 'APPROVED' }) : null);
    var sheet = h('div', { class: 'sheet' },
      h('h3', { text: model.formTitle || o.formTitle || 'Staff Reimbursement Claim Form' }),
      h('div', { class: 'period', text: 'Claim period: ' + U.monthLabel(model.month) + (model.ref ? '  ·  Ref ' + model.ref : '') }),
      h('div', { class: 'purpose' }, 'Purpose of Claim (to state the project or work related to):', purposeB),
      h('table', { role: 'table' }, h('thead', { role: 'rowgroup' }, h('tr', { role: 'row' }, th('S/No', 'c'), th('Date'), th('Item Description'), th('Start'), th('To'), th('Claim $', 'r'), th('Receipt', 'c'))), tbody),
      h('div', { class: 'decl', text: 'I certify that these expenses were incurred on company business, that each amount matches its receipt, and that they have not been claimed elsewhere.' }),
      h('div', { class: 'signs' }, left, right));
    var wrap = scrollTab(h('div', { class: 'sheet-scroll', role: 'group', 'aria-label': 'The claim form' }, sheet));
    wrap._name = nameB; wrap._purpose = purposeB; // so the sign dialog can show the name and purpose as they are typed
    return wrap;
  }
  function monthSheet(m) {
    var c = claimOf(m), model = modelOf(m);
    return sheetEl(model, { approverName: S.team.approverName, approval: statusOf(c) === 'approved' ? c.approval : null,
      thumbUrl: function (l) { return receiptUrl(l.receiptId); }, onThumb: function (l) { openLineViewer(m, l.id); } });
  }

  function statusPanel(m, c) {
    var first = approverFirst(), slot = h('div', { class: 'btn-row' }), st = statusOf(c);
    function unlockBtn(label) {
      var holder = h('span', null);
      holder.appendChild(h('button', { type: 'button', class: 'btn', dataset: { act: 'unlock' }, onclick: function () {
        UI.confirmInline(holder, st === 'approved' ? 'Reopen this approved claim? Your signature and the approval are removed.' : 'Unlock to edit? Your signature is removed and you sign again afterwards.', 'Unlock', function () { unlockClaim(m); });
      } }, icon('unlock'), label || 'Unlock to edit'));
      return holder;
    }
    function pickPdf() { document.getElementById('pick-pdf').click(); }
    var dl = h('button', { type: 'button', class: 'btn', id: 'btn-download', onclick: function () { downloadPack(m); } }, icon('download'), st === 'approved' && c.approvedPdf ? 'Download approved PDF' : 'Download PDF');
    var info, cls = 'banner';
    var meta = 'Ref ' + (c.ref || '-') + '  ·  Check code ' + (U.shortPrint(c.fingerprint) || '-');
    if (st === 'signed') {
      info = h('div', null, h('b', { text: 'Signed on ' + U.fmtStamp(c.signedAt, true, c.tzo) + '. Now send it to ' + first + '.' }), h('div', { class: 'small muted', text: meta }));
      U.append(slot, [h('button', { type: 'button', class: 'btn primary', id: 'btn-send', onclick: function () { openSend(m); } }, icon('send'), 'Send to ' + first), dl, unlockBtn()]);
    } else if (st === 'sent') {
      info = h('div', null, h('b', { text: 'Marked as sent to ' + (S.team.approverName || 'the approver') + ' on ' + U.fmtStamp(c.sentAt) + '.' }),
        h('div', { class: 'small', text: 'When the approved PDF comes back, add it here to close the month.' }), h('div', { class: 'small muted', text: meta }));
      U.append(slot, [h('button', { type: 'button', class: 'btn primary', id: 'btn-add-approved', onclick: pickPdf }, icon('file'), 'Add approved PDF'),
        h('button', { type: 'button', class: 'btn', id: 'btn-mark-approved', onclick: function () { openManualApproval(m); } }, icon('check'), 'Mark as approved'),
        h('button', { type: 'button', class: 'btn', onclick: function () { openSend(m); } }, icon('send'), 'Send again'), dl, unlockBtn()]);
    } else {
      cls = 'banner ok';
      var ap = c.approval || {};
      // the name is the one on the approval itself, never one assumed from the settings
      info = h('div', null, h('b', { text: (ap.name ? 'Approved by ' + ap.name + ' on ' : 'Approved on ') + U.fmtStamp(ap.at, false, ap.tzo) + '.' }),
        ap.manual ? h('div', { class: 'small', text: 'Recorded by you. Add the approved PDF to keep the approved copy here.' }) : null,
        ap.note ? h('div', { class: 'small', text: 'Note: ' + ap.note }) : null, h('div', { class: 'small muted', text: meta }));
      U.append(slot, [dl, ap.manual ? h('button', { type: 'button', class: 'btn', onclick: pickPdf }, icon('file'), 'Add approved PDF') : null, unlockBtn('Reopen')]);
    }
    return h('div', { class: cls }, icon(st === 'approved' ? 'check' : 'lock'), h('div', null, info, slot));
  }

  /* ---------- putting the claims view on screen ---------- */
  function modeOf(m) { return isSigned(m) ? 'locked' : (linesOf(m).length ? 'lines' : 'empty'); }
  function bodySig(m, mode) {
    if (mode !== 'locked') return mode + '|' + approverFirst();
    var c = claimOf(m), ap = c.approval || {};
    return [mode, c.status, c.fingerprint, c.sentAt, ap.at, ap.name, ap.manual, c.approvedPdf, S.team.approverName].join('|');
  }
  function buildClaims() {
    var m = S.month, mode = modeOf(m), ls = linesOf(m);
    var parts = { root: h('div', { class: 'stack' }), monthbar: h('div', null), banners: h('div', { class: 'banners' }), tips: h('div', { class: 'banners' }), body: h('div', { class: 'stack' }) };
    U.append(parts.root, [parts.monthbar, parts.banners, parts.tips, parts.body]);
    view = { month: m, mode: mode, sig: bodySig(m, mode), list: null, cards: table(), parts: parts };
    parts.monthbar.appendChild(monthBar(m));
    if (mode === 'locked') {
      parts.body.appendChild(statusPanel(m, claimOf(m)));
      parts.body.appendChild(monthSheet(m));
    } else {
      parts.body.appendChild(addZone(mode === 'empty'));
      if (mode === 'lines') {
        view.list = h('div', { class: 'lines' });
        ls.forEach(function (l, i) { var card = view.cards[l.id] = lineCard(l); card._setNo(i + 1); view.list.appendChild(card); });
        parts.body.appendChild(view.list);
      }
    }
    U.clear($view);
    $view.appendChild(parts.root);
    refreshBanners(); refreshTips();
  }
  function renderClaims(force) {
    if (S.tab !== 'claims' || !$view) return;
    var m = S.month, mode = modeOf(m);
    var live = !!view.parts && view.parts.root.parentNode === $view;
    if (force || !live || view.month !== m || view.mode !== mode || view.sig !== bodySig(m, mode)) {
      var y = window.scrollY, sameMonth = live && view.month === m;
      buildClaims();
      if (sameMonth) window.scrollTo(0, y);
    } else {
      refreshMonthBar(); refreshBanners(); refreshTips();
      if (mode === 'lines') refreshLines();
    }
    renderBar();
  }

  /* ---------- the bar at the bottom: running total and the next step ---------- */
  var bar = null;
  // --bar-h tells the page how much room the bar takes; nothing when it is not pinned to the screen edge.
  function setBarHeight() {
    var hgt = 0;
    if ($bar && !$bar.hidden) { try { if (getComputedStyle($bar).position === 'fixed') hgt = $bar.offsetHeight; } catch (e) { hgt = $bar.offsetHeight; } }
    document.documentElement.style.setProperty('--bar-h', hgt + 'px');
  }
  function renderBar() {
    if (!$bar) return;
    var m = S.month, ls = S.tab === 'claims' ? linesOf(m) : [];
    if (!ls.length) { $bar.hidden = true; setBarHeight(); return; }
    if (!bar) {
      bar = { total: h('b', { id: 'bar-total' }), sub: h('span', { id: 'bar-sub' }), slot: h('div', { class: 'bar-act' }), key: '' };
      U.clear($bar);
      $bar.appendChild(h('div', { class: 'bar-in' }, h('div', { class: 'sum' }, bar.total, bar.sub), bar.slot));
    }
    var c = claimOf(m), st = statusOf(c), signed = st !== 'draft';
    var open = ls.filter(hasNeeds).length, reading = ls.filter(isReading).length;
    var sub = plural(ls.length, 'item'), warn = false, kind, label, first = approverFirst();
    if (S.broken) { sub += '  ·  not saving (see the note at the top)'; warn = true; }
    else if (signed) sub += '  ·  ' + U.monthLabel(m, true) + '  ·  ' + STATUS_LABEL[st].toLowerCase();
    else if (reading) sub += '  ·  reading ' + plural(reading, 'receipt');
    else if (open) { sub += '  ·  ' + open + (open === 1 ? ' needs' : ' need') + ' attention'; warn = true; }
    else sub += '  ·  ready to sign';
    if (!signed) { kind = 'review'; label = 'Review & sign'; }
    else if (st === 'signed') { kind = 'send'; label = 'Send to ' + first; }
    else { kind = 'download'; label = 'Download PDF'; }
    bar.total.textContent = U.moneyS(signed ? modelOf(m).totalCents : totalOf(ls));
    bar.sub.textContent = sub;
    bar.sub.className = warn ? 'warn' : '';
    // The button is only replaced when it becomes a different button, so a click that is under way is never lost.
    if (bar.key !== kind + '|' + label) {
      bar.key = kind + '|' + label;
      var btn = kind === 'review' ? h('button', { type: 'button', class: 'btn primary big', id: 'btn-review', onclick: reviewAndSign }, icon('pen'), label)
        : kind === 'send' ? h('button', { type: 'button', class: 'btn primary big', id: 'btn-bar-send', onclick: function () { openSend(S.month); } }, icon('send'), label)
          : h('button', { type: 'button', class: 'btn big', id: 'btn-bar-download', onclick: function () { downloadPack(S.month); } }, icon('download'), label);
      U.clear(bar.slot); bar.slot.appendChild(btn);
    }
    $bar.hidden = false;
    setBarHeight();
  }

  /* =====================================================================================
   * review, sign, send
   * ===================================================================================== */
  function reviewAndSign() {
    var m = S.month, ls = linesOf(m);
    if (!ls.length || isSigned(m)) return;
    if (S.broken) { toast('Changes are not being saved right now, so the claim cannot be signed yet. See the note at the top of the page.', { bad: true, ms: 9000 }); window.scrollTo(0, 0); return; }
    if (ls.length > MAX.lines) {
      toast('One claim can hold up to ' + MAX.lines + ' items, and ' + U.monthLabel(m) + ' has ' + ls.length + '. Remove some, or move them to another month.', { bad: true, ms: 10000 });
      return;
    }
    var bad = ls.filter(hasNeeds);
    if (bad.length) {
      S.showNeeds = true;
      renderClaims();
      var first = bad[0], n = U.pad2(ls.indexOf(first) + 1), card = view.cards[first.id];
      if (card) {
        flash(card); showCard(card);
        var el = card.querySelector('[aria-invalid="true"]') || card.querySelector('[data-f="ok"]');
        if (el && !isReading(first)) { try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      }
      toast('Item ' + n + ' still needs: ' + needsText(first) + (bad.length > 1 ? ' (and ' + plural(bad.length - 1, 'more item') + ')' : '') + '.');
      return;
    }
    flushSaves().then(function () { if (!S.broken && !isSigned(m) && S.month === m && !UI.anyModal()) openSign(m); });
  }

  // Three ways to sign: the saved signature, drawing one, or typing a name (for anyone who cannot draw
  // with a pointer). o.onChange is told whenever the person does something with the signature.
  function signatureChooser(saved, getName, o) {
    o = o || {};
    var wrap = h('div', { class: 'section' }), pad = null, typed = null, typedEdited = false, showTyped = null, mode = saved ? 'saved' : 'draw';
    function touched() { if (o.onChange) o.onChange(); }
    function swap(text, to) {
      return h('button', { type: 'button', class: 'btn sm', text: text, onclick: function () {
        mode = to; draw(); touched();
        var f = wrap.querySelector('input, button');
        if (f) { try { f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      } });
    }
    function draw() {
      U.clear(wrap); pad = null; typed = null; showTyped = null;
      if (mode === 'saved') {
        wrap.appendChild(h('div', { class: 'sigsaved' }, h('div', { class: 'sigimg' }, h('img', { src: saved, alt: 'Your saved signature' })),
          h('div', null, h('div', { text: 'Your saved signature' }), h('div', { class: 'btn-row' }, swap('Draw a new one', 'draw'), swap('Type it instead', 'type')))));
      } else if (mode === 'draw') {
        pad = UI.sigPad();
        pad.onChange = touched;
        wrap.appendChild(pad.el);
        wrap.appendChild(h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn sm', text: 'Clear', onclick: function () { pad.clear(); } }),
          saved ? swap('Use my saved signature', 'saved') : null,
          swap('Type it instead', 'type'),
          h('span', { class: 'hint', text: 'Draw with your finger, a stylus or the mouse.' })));
      } else {
        typedEdited = false;
        typed = h('input', { type: 'text', maxlength: '60', autocomplete: 'off', value: (getName && getName()) || '', dataset: { sig: 'typed' } });
        var preview = h('div', { class: 'sigimg typed' }), input = typed;
        showTyped = function () {
          U.clear(preview);
          var u = UI.typedSig(input.value);
          preview.appendChild(u ? h('img', { src: u, alt: 'Typed signature: ' + clean(input.value, 60) }) : h('span', { class: 'hint', text: 'Your typed signature appears here.' }));
        };
        typed.addEventListener('input', function () { typedEdited = true; showTyped(); });
        wrap.appendChild(field('Type your name to sign', typed));
        wrap.appendChild(preview);
        wrap.appendChild(h('div', { class: 'btn-row' }, swap('Draw it instead', 'draw'), saved ? swap('Use my saved signature', 'saved') : null));
        showTyped();
        var mine = showTyped;
        UI.sigFont().then(function () { if (showTyped === mine) mine(); }); // drawn again once the handwriting face has arrived
      }
    }
    UI.sigFont(); // fetch the handwriting face now, so it is there if "Type it instead" is chosen
    draw();
    return {
      el: wrap,
      // '' when there is nothing to sign with; something that is not a usable picture when it could not be made
      value: function () { return mode === 'saved' ? saved : mode === 'draw' ? (pad && !pad.isEmpty() ? (pad.toDataUrl() || 'unusable') : '') : UI.typedSig(typed ? typed.value : ''); },
      ready: function () { return mode === 'type' ? UI.sigFont() : Promise.resolve(true); },
      isNew: function () { return mode !== 'saved'; },
      mode: function () { return mode; },
      // the typed signature follows the name field until it has been edited itself
      nameChanged: function () { if (mode === 'type' && typed && !typedEdited) { typed.value = (getName && getName()) || ''; if (showTyped) showTyped(); } }
    };
  }

  // Everything that is shown for review and then signed. If this changes while the dialog is open, the person looks again.
  function linesKey(model) {
    return JSON.stringify([model.formTitle, model.totalCents, model.lines.map(function (l) { return [l.id, l.date, l.desc, l.from, l.to, l.amountCents, l.type, l.receiptHash, l.hl]; })]);
  }

  function openSign(m) {
    var c = claimOf(m), reviewed = '';
    S.signing = m; // from here until the dialog closes, nothing can be filed into this month
    var purpose = h('input', { type: 'text', value: c.purpose || 'Transport', maxlength: String(MAX.purpose), id: 'sign-purpose' });
    var name = h('input', { type: 'text', value: S.profile.name || '', maxlength: String(MAX.name), autocomplete: 'name', id: 'sign-name' });
    var email = h('input', { type: 'email', value: S.profile.email || '', maxlength: '120', autocomplete: 'email', id: 'sign-email', placeholder: 'Optional' });
    var agree = h('input', { type: 'checkbox', id: 'sign-agree' });
    var remember = h('input', { type: 'checkbox', id: 'sign-remember', checked: true });
    var err = UI.alertBox();
    var sig = signatureChooser(U.isPngDataUrl(S.profile.signature) ? S.profile.signature : '', function () { return clean(name.value, 60); }, { onChange: err.hide });
    var sheetSlot = h('div', null);
    var signBtn = h('button', { type: 'button', class: 'btn primary', id: 'btn-sign' }, icon('pen'), 'Sign claim');
    var sheetNode = null;
    function paintSheet() {
      var model = modelOf(m);
      reviewed = linesKey(model);
      model.purpose = clean(purpose.value, MAX.purpose) || 'Transport';
      model.staffName = clean(name.value, MAX.name);
      sheetNode = sheetEl(model, { approverName: S.team.approverName, thumbUrl: function (l) { return receiptUrl(l.receiptId); }, onThumb: function (l) { openLineViewer(m, l.id, true); } });
      U.clear(sheetSlot);
      sheetSlot.appendChild(sheetNode);
    }
    paintSheet();
    // the preview follows the name and purpose as they are typed
    purpose.addEventListener('input', function () { sheetNode._purpose.textContent = clean(purpose.value, MAX.purpose) || 'Transport'; });
    name.addEventListener('input', function () { sheetNode._name.textContent = clean(name.value, MAX.name); sig.nameChanged(); });
    var dlg = UI.modal({
      title: 'Review and sign ' + U.monthLabel(m),
      body: [
        h('p', { class: 'muted', text: 'This is the claim as it will appear on the form. Check each item, then sign.' }),
        sheetSlot,
        h('div', { class: 'section' }, field('Purpose of claim (the project or work it relates to)', purpose)),
        h('div', { class: 'grid2' }, field('Your name', name), field('Your email', email, { hint: 'So ' + approverFirst() + ' can send the approved copy back to you.' })),
        h('div', { class: 'section' }, h('h3', { text: 'Your signature' }), sig.el,
          h('label', { class: 'tick' }, remember, h('span', { text: 'Remember my signature on this device' }))),
        h('label', { class: 'tick' }, agree, h('span', { text: 'I confirm these expenses were incurred on company business, each amount matches its receipt, and none has been claimed elsewhere.' }))
      ],
      // the message sits with the buttons, so it is in view wherever the dialog is scrolled to
      foot: [err, h('button', { type: 'button', class: 'btn', text: 'Back to editing', onclick: function () { dlg.close(); } }), signBtn],
      onClose: function () { if (S.signing === m) S.signing = null; renderClaims(); }
    });
    err.watch(dlg.body);
    function stop(msg, el) { signBtn.disabled = false; err.show(msg, el); }
    signBtn.addEventListener('click', function () {
      err.hide();
      var nm = clean(name.value, MAX.name), em = email.value.trim();
      if (!nm) return stop('Enter your name.', name);
      if (em && !U.isEmail(em)) return stop('That email address does not look right.', email);
      signBtn.disabled = true;
      sig.ready().then(function () {
        if (!dlg.isOpen()) return;
        var s = sig.value();
        if (!s) return stop(sig.mode() === 'type' ? 'Type your name to sign.' : 'Draw your signature in the box, or choose “Type it instead”.');
        if (!U.isPngDataUrl(s)) return stop('That signature could not be used. Clear it and sign again, a little more simply.');
        if (!agree.checked) return stop('Tick the confirmation to sign.', agree);
        if (S.broken) return stop('Changes are not being saved on this device right now, so the claim cannot be signed. Close this and see the note at the top of the page.');
        // What gets signed has to be exactly what is shown above.
        var ls = linesOf(m), stillGood = ls.length > 0 && ls.length <= MAX.lines && !ls.some(hasNeeds);
        if (!stillGood || linesKey(modelOf(m)) !== reviewed) {
          paintSheet();
          return stop(stillGood ? 'The claim changed while this was open. Check it above again, then sign.' : 'An item needs attention again. Go back to editing and check the items.');
        }
        ls.forEach(function (l) { l.desc = clean(l.desc, MAX.desc); l.from = clean(l.from, MAX.place); l.to = clean(l.to, MAX.place); }); // as it will be printed
        var now = new Date(), draft = claimOf(m);
        // series: one id for this person's claim for this month, kept through unlocking and signing again.
        // rev: how many times it has been signed. Both are part of what is signed, so the approver's
        // copy of the form can tell a newer version of the same claim from an older one.
        var cl = { month: m, purpose: clean(purpose.value, MAX.purpose) || 'Transport', status: 'signed', signedAt: now.toISOString(), tzo: Math.round(now.getTimezoneOffset()),
          signedName: nm, staffEmail: em, signature: s, ref: U.initials(nm) + '-' + m,
          series: idOk(draft.series) ? draft.series : U.uid('s'), rev: (draft.rev > 0 ? Math.round(draft.rev) : 0) + 1, formTitle: clean(S.team.formTitle, MAX.title) };
        var model = modelFrom(cl, ls);
        cl.signedLines = model.lines; // the signed claim carries its own copy of the items
        return ClaimPDF.fingerprint(model).then(function (fp) {
          cl.fingerprint = fp;
          return Store.signClaim(cl, ls);
        }).then(function () {
          ls.forEach(function (l) { clearTimeout(saveTimers[l.id]); delete saveTimers[l.id]; });
          S.claims[m] = cl; packCache = null;
          S.profile.name = nm; S.profile.email = em;
          if (remember.checked) S.profile.signature = s; else if (sig.isNew()) S.profile.signature = '';
          saveProfile();
          S.showNeeds = false;
          dlg.close();
          window.scrollTo(0, 0);
          openSend(m);
        }, function (e) {
          signBtn.disabled = false;
          if (e && e.stale) { dlg.close(); changedElsewhere(); return; }
          storeFail(e);
          err.show(e && (e.replaced || e.wiped) ? 'The claim is not signed: what this form had saved was replaced or cleared in another window. Close this and reload the page.'
            : 'Your signature could not be saved on this device, so the claim is not signed. Check that the device has free storage, then try again.');
        });
      });
    });
  }

  // Move a claim to its next state, but only from the state (and the signed version) this page believes it is in.
  function moveClaim(next, from, extra) {
    var o = extra || {};
    o.fp = claimOf(next.month).fingerprint || '';
    return Store.setClaim(next, from, o).then(function () {
      S.claims[next.month] = next; packCache = null;
      return true;
    }, function (e) {
      if (e && e.stale) changedElsewhere();
      else { storeFail(e); toast('That could not be saved on this device. See the note at the top of the page.', { bad: true, ms: 8000 }); }
      return false;
    });
  }
  function unlockClaim(m) {
    var c = claimOf(m);
    // The draft remembers which claim this is (series), how many times it has been signed (rev) and
    // the version just unlocked, so an approval of an old version that turns up later is recognised.
    var draft = { month: m, purpose: c.purpose || 'Transport', status: 'draft', unlockedFrom: c.fingerprint || '' };
    if (idOk(c.series)) { draft.series = c.series; draft.rev = c.rev > 0 ? Math.round(c.rev) : 0; }
    moveClaim(draft, ['signed', 'sent', 'approved'], { kvDel: ['approved:' + m] }).then(function (ok) {
      if (!ok) return;
      renderClaims();
      toast('Unlocked. Edit the items, then sign again.');
      var add = document.getElementById('btn-add');
      if (add) { try { add.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    });
  }

  // Build (or reuse) the signed PDF for a month.
  function buildPack(m) {
    var c = claimOf(m), model = modelOf(m), key = [m, c.fingerprint || '', S.team.approverName || ''].join('|');
    if (packCache && packCache.key === key) return Promise.resolve(packCache);
    return ClaimPDF.fingerprint(model, c.fingerprint).then(function (fp) {
      if (!c.fingerprint || fp !== c.fingerprint) { var e = new Error('The claim no longer matches its signature'); e.mismatch = true; throw e; }
      return UI.needPdfLib();
    }).then(function () {
      var receipts = table(), p = Promise.resolve();
      model.lines.forEach(function (l, i) {
        if (!l.receiptId) return;
        p = p.then(function () { return Store.get('receipts', l.receiptId); }).then(function (r) {
          if (!r || !r.bytes) { var e = new Error('Receipt image missing'); e.missing = U.pad2(i + 1); throw e; }
          receipts[l.receiptId] = { bytes: new Uint8Array(r.bytes) };
        });
      });
      return p.then(function () {
        return ClaimPDF.build({ approverName: S.team.approverName, claim: model, approval: null, receipts: receipts });
      });
    }).then(function (bytes) {
      packCache = { key: key, bytes: bytes, filename: pdfName(model, false), model: model };
      folderKeepPdf('signed-' + m + '.pdf', bytes); // a copy in the claims folder, when there is one
      return packCache;
    });
  }
  function packError(e) {
    if (e && e.mismatch) return 'This claim no longer matches what was signed. Unlock it, check the items and sign again.';
    if (e && e.missing) return 'The receipt image for item ' + e.missing + ' is no longer on this device. Unlock the claim, add the receipt again and sign again.';
    return 'The PDF could not be created. Check your connection, reload the page and try again.';
  }
  function downloadPack(m) {
    var c = claimOf(m);
    function fresh() { return buildPack(m).then(function (p) { UI.download(p.bytes, p.filename, 'application/pdf'); }, function (e) { toast(packError(e), { bad: true, ms: 9000 }); }); }
    if (statusOf(c) === 'approved' && c.approvedPdf) {
      return Store.kvGet('approved:' + m, null).then(function (bytes) {
        if (bytes) { UI.download(new Uint8Array(bytes), pdfName(modelOf(m), true), 'application/pdf'); return; }
        return fresh();
      }, fresh);
    }
    return fresh();
  }

  function submitEmail(model) {
    var first = approverFirst(), who = model.signedName || model.staffName;
    var lines = model.lines.map(function (l, i) { return U.pad2(i + 1) + '  ' + U.fmtDate(l.date, 'plain') + '  ' + l.desc + '  $' + U.money(l.amountCents); });
    var site = location.origin && location.origin !== 'null' && /^https?:$/.test(location.protocol) ? location.origin + location.pathname : '';
    var head = 'Hi ' + first + ',\n\nAttached is my transport and expense claim for ' + U.monthLabel(model.month) + ' for your approval.\n\nTotal: $' + U.money(model.totalCents) + ' (' + plural(model.lines.length, 'item') + ')\n';
    // An approver who keeps the form on their phone's Home Screen should open it from there (a link
    // would open a separate copy in the browser), so the words come first and the link second.
    var tail = '\nTo approve: save the attached PDF, open the claim form where you normally use it, choose Approver and open the PDF there. Each item is shown beside its receipt.'
      + (site ? '\nThe form: ' + site + '#approve' : '') + '\n\nThanks,\n' + who;
    var body = head + lines.join('\n') + '\n' + tail;
    if (encodeURIComponent(body).length > 1700) body = head + tail; // keep the email link short enough for every mail app
    return { to: S.team.approverEmail || '', cc: S.team.financeEmail || '', subject: 'Claim for approval - ' + who + ' - ' + U.monthLabel(model.month) + ' - $' + U.money(model.totalCents), body: body };
  }

  function openSend(m) {
    var first = approverFirst(), pack = null, emailRow = null, fp = claimOf(m).fingerprint || '';
    var status = h('div', { class: 'reading', role: 'status' }, h('span', { class: 'spin' }), h('span', { text: 'Preparing the signed PDF' }));
    var actions = h('div', { class: 'section' });
    var toInput = h('input', { type: 'email', value: S.team.approverEmail || '', placeholder: first + '’s email address', maxlength: '120', autocomplete: 'off', id: 'send-to' });
    var toHint = h('small', { class: 'hint warn', hidden: true, role: 'alert' });
    var sentBtn = h('button', { type: 'button', class: 'btn primary', id: 'btn-mark-sent', text: 'I’ve sent it', disabled: true });
    var me = { month: m, fp: fp, close: function () { dlg.close(); } };
    var dlg = UI.modal({
      title: 'Send to ' + (S.team.approverName || 'the approver'), narrow: true,
      body: [status, actions],
      foot: [h('button', { type: 'button', class: 'btn', text: 'Not yet', onclick: function () { dlg.close(); } }), sentBtn],
      onClose: function () { if (sendDialog === me) sendDialog = null; renderClaims(); }
    });
    sendDialog = me; // so that a re-read of storage can close this if the claim has been signed again elsewhere
    // Nothing here may hand out, or mark as sent, a version of the claim that has since been replaced.
    function current() {
      if (isSigned(m) && (claimOf(m).fingerprint || '') === fp) return true;
      dlg.close(); changedElsewhere();
      return false;
    }
    sentBtn.addEventListener('click', function () {
      if (!current()) return;
      var cl = claimOf(m);
      if (statusOf(cl) !== 'signed') { dlg.close(); return; } // already marked as sent (this is "Send again")
      var next = U.clone(cl);
      next.status = 'sent'; next.sentAt = new Date().toISOString();
      sentBtn.disabled = true;
      moveClaim(next, ['signed']).then(function (ok) { dlg.close(); if (ok) toast('Marked as sent to ' + first + '.'); });
    });
    // The address is saved as soon as it is valid; the email buttons are updated in place.
    function useAddress() {
      var v = toInput.value.trim(), ok = !v || U.isEmail(v);
      toHint.hidden = ok; toHint.textContent = ok ? '' : 'That email address does not look right.';
      if (ok) toInput.removeAttribute('aria-invalid'); else toInput.setAttribute('aria-invalid', 'true');
      if (!ok || v === (S.team.approverEmail || '')) return;
      S.team.approverEmail = v; saveTeam();
      if (emailRow && pack) emailRow.update(submitEmail(pack.model));
    }
    toInput.addEventListener('input', function () { if (!toInput.value.trim() || U.isEmail(toInput.value.trim())) useAddress(); });
    toInput.addEventListener('change', useAddress);
    buildPack(m).then(function (p) {
      if (!dlg.isOpen()) return;
      pack = p;
      U.clear(status); status.className = 'small muted';
      status.textContent = U.monthLabel(m) + '  ·  ' + plural(p.model.lines.length, 'item') + '  ·  $' + U.money(p.model.totalCents) + '  ·  ' + p.filename + ' (' + Math.max(1, Math.round(p.bytes.length / 1024)) + ' KB)';
      var shareable = UI.canShare(p.bytes, p.filename);
      if (shareable) {
        actions.appendChild(h('div', { class: 'section' },
          h('button', { type: 'button', class: 'btn big' + (UI.isTouch() ? ' primary' : ''), id: 'btn-share', onclick: function () {
            if (!current()) return;
            var mail = submitEmail(p.model);
            UI.share(p.bytes, p.filename, mail.subject, mail.body).then(function () { toast('Shared. Tap “I’ve sent it” once it has gone.'); }, function (e) { if (e && e.name !== 'AbortError') toast('Sharing did not work here. Download the PDF instead.', { bad: true }); });
          } }, icon('share'), 'Share the PDF'),
          h('p', { class: 'hint', text: 'Pick Mail or WhatsApp and choose ' + first + '. The signed PDF is attached for you.' })));
      }
      emailRow = UI.emailButtons(submitEmail(p.model));
      actions.appendChild(h('div', { class: 'section' },
        h('h3', { text: shareable ? 'Or send it by email yourself' : 'Send it by email' }),
        h('ol', { class: 'steps one' },
          h('li', null, h('div', null, h('b', { text: 'Download the signed PDF' }),
            h('div', { class: 'btn-row gap-top' }, h('button', { type: 'button', class: 'btn' + (shareable && UI.isTouch() ? '' : ' primary'), id: 'btn-dl-send', onclick: function () { if (current()) UI.download(p.bytes, p.filename, 'application/pdf'); } }, icon('download'), 'Download PDF')))),
          h('li', null, h('div', null, h('b', { text: 'Email it to ' + first + ' with the PDF attached' }),
            h('div', { class: 'gap-top' }, field(first + '’s email', toInput), toHint), h('div', { class: 'gap-top' }, emailRow),
            h('p', { class: 'hint gap-top', text: 'The email is written for you. Attach the PDF you just downloaded before you send it.' }))))));
      sentBtn.disabled = false;
    }, function (e) {
      if (!dlg.isOpen()) return;
      U.clear(status); status.className = 'banner bad'; status.setAttribute('role', 'alert');
      status.appendChild(icon('alert')); status.appendChild(h('div', { text: packError(e) }));
    });
  }

  function openManualApproval(m) {
    var date = h('input', { type: 'date', value: U.todayIso(), max: U.todayIso() });
    var name = h('input', { type: 'text', value: S.team.approverName || '', maxlength: String(MAX.name) });
    var okBtn = h('button', { type: 'button', class: 'btn primary', id: 'btn-manual-ok', text: 'Mark as approved' });
    var err = UI.alertBox();
    var dlg = UI.modal({
      title: 'Mark ' + U.monthLabel(m) + ' as approved', narrow: true,
      body: [h('p', { class: 'muted', text: 'Use this when the approval came by email or message. If you have the approved PDF, add that instead so the approved copy is kept here.' }),
        h('div', { class: 'grid2' }, field('Approved by', name), field('Date approved', date))],
      foot: [err, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: function () { dlg.close(); } }), okBtn],
      onClose: function () { renderClaims(); }
    });
    err.watch(dlg.body);
    okBtn.addEventListener('click', function () {
      if (!U.validIso(date.value) || date.value > U.todayIso()) { err.show('Choose the date it was approved: today or earlier.', date); return; }
      if (!clean(name.value, MAX.name)) { err.show('Enter who approved it.', name); return; }
      var at = new Date(date.value + 'T12:00:00'), next = U.clone(claimOf(m));
      next.status = 'approved';
      next.approval = { name: clean(name.value, MAX.name), at: at.toISOString(), tzo: Math.round(at.getTimezoneOffset()), manual: true };
      okBtn.disabled = true;
      moveClaim(next, ['signed', 'sent']).then(function () { dlg.close(); });
    });
  }

  // An approved PDF came back: close the matching month and keep the file. Resolves true when it is stored.
  function importApproved(pack, bytes) {
    var fp = pack.payload.claim.fingerprint, m = null;
    Object.keys(S.claims).forEach(function (k) { if (S.claims[k].fingerprint && S.claims[k].fingerprint === fp) m = k; });
    if (!m) return Promise.resolve(false);
    var ap = pack.payload.approval, next = U.clone(S.claims[m]), kv = {};
    next.status = 'approved';
    next.approval = { name: ap.name, at: ap.at, tzo: ap.tzo, note: ap.note || '', signature: ap.signature || '' };
    next.approvedPdf = true;
    kv['approved:' + m] = bytes;
    return moveClaim(next, ['signed', 'sent', 'approved'], { kvSet: kv }).then(function (ok) {
      if (!ok) return false;
      goMonth(m);
      toast(U.monthLabel(m) + ' is approved. The approved PDF is saved here.');
      return true;
    });
  }
  function ownsFingerprint(fp) { return !!fp && Object.keys(S.claims).some(function (k) { return S.claims[k].fingerprint === fp; }); }
  // A PDF of this person's own claim for a month, but not of the version that is on this device now
  // (the claim was unlocked, and perhaps signed again, since that PDF was made).
  function isOlderVersion(claim) {
    var c = S.claims[claim.month];
    if (!c || !claim.fingerprint || c.fingerprint === claim.fingerprint) return false;
    if (idOk(c.series) && c.series === claim.series) return true;
    return !!c.unlockedFrom && c.unlockedFrom === claim.fingerprint;
  }

  /* =====================================================================================
   * settings, team link
   * ===================================================================================== */
  function teamLink() {
    var data = {};
    TEAM_KEYS.forEach(function (k) { data[k] = S.team[k] || ''; });
    var base = location.origin && location.origin !== 'null' ? location.origin + location.pathname : location.href.split('#')[0];
    return base + '#team=' + U.b64url(JSON.stringify(data));
  }
  // Team settings from a team link (or from text that contains one). Nothing is applied here.
  function parseTeam(text) {
    var mm = /[#&?]team=([A-Za-z0-9_\-]+)/.exec(String(text || ''));
    if (!mm || mm[1].length > 4000) return null;
    try {
      var o = JSON.parse(U.unb64url(mm[1])), out = {};
      if (!o || typeof o !== 'object') return null;
      TEAM_KEYS.forEach(function (k) { if (typeof o[k] === 'string') out[k] = clean(o[k], 120); });
      ['approverEmail', 'financeEmail'].forEach(function (k) { if (out[k] && !U.isEmail(out[k])) out[k] = ''; });
      return out;
    } catch (e) { return null; }
  }
  function teamDiffers(t) { return TEAM_KEYS.some(function (k) { return !!t[k] && t[k] !== (S.team[k] || ''); }); }
  function applyTeam(t) { TEAM_KEYS.forEach(function (k) { if (t[k]) S.team[k] = t[k]; }); return saveTeam(); }
  function readTeamHash() { var t = parseTeam(location.hash); return t && teamDiffers(t) ? t : null; }
  function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  function openSettings() {
    var name = h('input', { type: 'text', value: S.profile.name || '', maxlength: String(MAX.name), autocomplete: 'name' });
    var email = h('input', { type: 'email', value: S.profile.email || '', maxlength: '120', autocomplete: 'email', placeholder: 'Optional' });
    var title = h('input', { type: 'text', value: S.team.formTitle || '', maxlength: String(MAX.title) });
    var apName = h('input', { type: 'text', value: S.team.approverName || '', maxlength: String(MAX.name) });
    var apEmail = h('input', { type: 'email', value: S.team.approverEmail || '', maxlength: '120', placeholder: 'name@company.com' });
    var fin = h('input', { type: 'email', value: S.team.financeEmail || '', maxlength: '120', placeholder: 'Optional' });
    // Each box is saved when it is left. An address that does not look right is not saved, and the
    // box says so underneath until it is put right.
    var commits = [];
    function bind(label, input, obj, key, save, isEmail) {
      var hint = isEmail ? h('small', { class: 'hint warn', hidden: true, role: 'alert', text: 'That email address does not look right, so it has not been saved.' }) : null;
      function commit() {
        var v = isEmail ? input.value.trim() : clean(input.value, 120);
        if (isEmail && v && !U.isEmail(v)) { input.setAttribute('aria-invalid', 'true'); hint.hidden = false; return; }
        input.removeAttribute('aria-invalid');
        if (hint) hint.hidden = true;
        if (obj[key] === v) return;
        obj[key] = v; save();
      }
      input.addEventListener('change', commit);
      commits.push(commit); // also run when the dialog closes, for a box that was still being typed in
      if (isEmail) input.addEventListener('input', function () { var v = input.value.trim(); if (!v || U.isEmail(v)) { input.removeAttribute('aria-invalid'); hint.hidden = true; } });
      return h('div', null, field(label, input), hint);
    }
    var fName = bind('Your name', name, S.profile, 'name', saveProfile), fEmail = bind('Your email', email, S.profile, 'email', saveProfile, true);
    var fTitle = bind('Title printed on the claim form', title, S.team, 'formTitle', saveTeam), fApName = bind('Your reporting officer (approver)', apName, S.team, 'approverName', saveTeam);
    var fApEmail = bind('Reporting officer’s email', apEmail, S.team, 'approverEmail', saveTeam, true), fFin = bind('Copy emails to (finance)', fin, S.team, 'financeEmail', saveTeam, true);

    var sigSlot = h('div', null);
    function paintSig() {
      U.clear(sigSlot);
      if (U.isPngDataUrl(S.profile.signature)) {
        var holder = h('span', null);
        holder.appendChild(h('button', { type: 'button', class: 'link danger', text: 'Remove it', onclick: function () { UI.confirmInline(holder, 'Remove your saved signature?', 'Remove', function () { S.profile.signature = ''; saveProfile(); paintSig(); }); } }));
        sigSlot.appendChild(h('div', { class: 'sigsaved' }, h('div', { class: 'sigimg' }, h('img', { src: S.profile.signature, alt: 'Your saved signature' })), h('div', null, h('div', { text: 'Saved signature' }), holder)));
      } else sigSlot.appendChild(h('p', { class: 'hint', text: 'No signature saved yet. You make one the first time you sign.' }));
    }
    paintSig();

    // A team link cannot be opened inside a Home Screen copy of the form, so it can be pasted here instead.
    var linkBox = h('input', { type: 'text', autocomplete: 'off', placeholder: 'Paste the team link here', id: 'team-paste', 'aria-label': 'Team link from a colleague' });
    function useLink() {
      var t = parseTeam(linkBox.value);
      if (!t || !TEAM_KEYS.some(function (k) { return !!t[k]; })) { toast('That is not a team link from this form.', { bad: true }); linkBox.focus(); return; }
      applyTeam(t);
      title.value = S.team.formTitle || ''; apName.value = S.team.approverName || ''; apEmail.value = S.team.approverEmail || ''; fin.value = S.team.financeEmail || '';
      linkBox.value = '';
      toast('Team settings saved on this device.');
    }
    linkBox.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); useLink(); } });

    var storeNote = h('p', { class: 'hint', id: 'store-note', text: 'Your claims and receipts are kept in this browser on this device only.' });
    var keepSlot = h('div', null);
    // the offline copy and, where the browser offers it, installing the form as an app
    var offSlot = h('div', null);
    function paintOffline() {
      U.clear(offSlot);
      var note = offlineNote();
      if (note) offSlot.appendChild(h('p', { class: 'hint', id: 'offline-note', text: note + (UI.isStandalone() ? ' It is installed as an app on this device.' : '') }));
      if (canInstall()) {
        offSlot.appendChild(h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', id: 'btn-install-settings', onclick: function () { installApp().then(paintOffline); } }, icon('download'), 'Install as an app'),
          h('span', { class: 'hint', text: 'Opens from its own icon, like any other app, and works without internet.' })));
      } else if (UI.isIos() && !UI.isStandalone()) {
        offSlot.appendChild(h('p', { class: 'hint', text: 'On iPhone or iPad: tap Share, then “Add to Home Screen”, and open the form from there.' }));
      }
    }
    paintOffline();
    function paintStore() {
      Promise.all([Store.persisted(), Store.usage()]).then(function (r) {
        var kept = r[0], used = r[1];
        U.clear(keepSlot);
        if (Store.isMemoryOnly()) { storeNote.textContent = 'This browser is not saving anything (it may be a private window).'; return; }
        storeNote.textContent = 'Your claims and receipts are kept in this browser on this device only' + (used ? ' (about ' + fmtBytes(used) + ' so far)' : '') + '. '
          + (kept ? 'The browser has agreed to keep them.' : 'Download a backup now and then, especially before clearing browser data.');
        if (!kept && navigator.storage && navigator.storage.persist) {
          keepSlot.appendChild(h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', id: 'btn-keep', onclick: function () {
            Store.persist().then(function (yes) {
              toast(yes ? 'Done. The browser will keep what this form saves.' : 'The browser did not agree this time. Keep a backup instead.', { bad: !yes });
              paintStore();
            });
          } }, icon('lock'), 'Keep my data safe'),
            h('span', { class: 'hint', text: 'Asks the browser not to clear this form’s data when the device runs low on space.' })));
        }
      });
    }
    paintStore();
    var eraseSlot = h('span', null);
    eraseSlot.appendChild(h('button', { type: 'button', class: 'btn danger', id: 'btn-erase', text: 'Erase this form’s saved claims', onclick: function () {
      UI.confirmInline(eraseSlot, 'Erase all claims, receipts and settings that this form has saved on this device? This cannot be undone.', 'Erase', eraseAll);
    } }));
    var dlg = UI.modal({
      title: 'Settings',
      body: [
        h('div', { class: 'section' }, h('h3', { text: 'You' }), h('div', { class: 'grid2' }, fName, fEmail), sigSlot),
        h('div', { class: 'section' }, h('h3', { text: 'Your reporting officer' }),
          h('p', { class: 'hint', text: 'Each unit or department has its own reporting officer. Your claims are sent to the one named here; a colleague in another unit names theirs.' }),
          h('div', { class: 'grid2' }, fApName, fApEmail, fFin),
          fTitle,
          h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', id: 'btn-team-link', onclick: function () {
            UI.copyText(teamLink()).then(function (ok) { toast(ok ? 'Team link copied. Send it to your colleagues.' : 'Could not copy the link.', { bad: !ok }); });
          } }, icon('copy'), 'Copy team link')),
          h('p', { class: 'hint', text: 'Colleagues who open the team link get the same reporting officer in their own copy of the form: one link per unit.' }),
          h('div', { class: 'paste-row' }, linkBox, h('button', { type: 'button', class: 'btn', id: 'btn-team-paste', text: 'Use link', onclick: useLink })),
          h('p', { class: 'hint', text: 'Sent a team link? Paste it above. Handy when the form is on your Home Screen, where links open in the browser instead.' })),
        h('div', { class: 'section' }, h('h3', { text: 'This device' }), offSlot, storeNote, keepSlot,
          h('div', { class: 'btn-row' },
            h('button', { type: 'button', class: 'btn', id: 'btn-backup', onclick: backup }, icon('download'), 'Download backup'),
            h('button', { type: 'button', class: 'btn', id: 'btn-restore', onclick: function () { document.getElementById('pick-backup').click(); } }, icon('upload'), 'Restore backup'),
            h('button', { type: 'button', class: 'btn', id: 'btn-bringback', onclick: function () { document.getElementById('pick-bringback').click(); } }, icon('file'), 'Bring back a month from its PDF')),
          h('p', { class: 'hint', text: 'Lost a month? The signed PDF you sent (or the approved one that came back) brings it back here, receipts included.' }),
          h('div', null, eraseSlot)),
        h('div', { class: 'section' }, h('h3', { text: 'Claims folder' }), folderSettings()),
        h('p', { class: 'hint', text: 'CETG Transport & Expense Claim Form, version ' + VERSION + '. Receipts are read on your device. Nothing is uploaded to a server.' })
      ],
      foot: [h('button', { type: 'button', class: 'btn primary', text: 'Done', onclick: function () { dlg.close(); } })],
      onClose: function () { commits.forEach(function (c) { c(); }); render(); }
    });
  }

  /* =====================================================================================
   * backup: one file, written and read back piece by piece
   * Line 1 holds everything except the pictures and PDFs. Each of those follows on a line of its own
   * ({"t":"r",...} a receipt image, {"t":"k",...} a kept PDF), and the last line says how many there
   * were, so a file that was cut short is recognised. No single piece is ever bigger than one picture.
   * ===================================================================================== */
  function b64Of(v) {
    if (v instanceof ArrayBuffer) return U.bytesToB64(new Uint8Array(v));
    if (ArrayBuffer.isView(v)) return U.bytesToB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    return null;
  }
  var RE_BIN_KEY = /^(approved|apdf):/; // kept PDFs
  // "2 items, 1 receipt and 3 decisions": what a backup holds, leaving out decisions where there are none.
  function holds(items, receipts, decisions) {
    var parts = [plural(items, 'item'), plural(receipts, 'receipt')];
    if (decisions) parts.push(plural(decisions, 'decision'));
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }
  function backup() {
    if (Store.isMemoryOnly()) { toast('This browser is not saving anything, so there is nothing to back up.', { bad: true }); return Promise.resolve(); }
    return flushSaves().then(function () {
      return Promise.all([Store.all('lines'), Store.all('claims'), Store.all('approvals'), Store.keys('kv'), Store.keys('receipts')]);
    }).then(function (r) {
      var head = { app: 'cetg-claims', v: 3, exportedAt: new Date().toISOString(), lines: r[0], claims: r[1], approvals: r[2], kv: [] };
      var parts = [], size = 0, count = 0, pics = 0, p = Promise.resolve();
      // each piece is handed to the browser as it is made, so the pieces never pile up as one huge text
      function push(obj) { var s = JSON.stringify(obj) + '\n'; size += s.length; parts.push(new Blob([s])); }
      var keys = r[3].filter(function (k) { return typeof k === 'string' && k !== 'born' && k !== FOLDER_KEY; });
      keys.filter(function (k) { return !RE_BIN_KEY.test(k); }).forEach(function (k) {
        p = p.then(function () { return Store.kvGet(k, null); }).then(function (v) { if (v != null && b64Of(v) === null) head.kv.push({ k: k, v: v }); });
      });
      p = p.then(function () { push(head); });
      keys.filter(function (k) { return RE_BIN_KEY.test(k); }).forEach(function (k) {
        p = p.then(function () { return Store.kvGet(k, null); }).then(function (v) {
          var b = v ? b64Of(v) : null;
          if (b) { push({ t: 'k', k: k, b64: b }); count++; }
        });
      });
      r[4].forEach(function (id) {
        p = p.then(function () { return Store.get('receipts', id); }).then(function (x) {
          var b = x ? b64Of(x.bytes) : null;
          if (b) { push({ t: 'r', id: x.id, w: x.w, h: x.h, hash: x.hash, addedAt: x.addedAt, b64: b }); count++; pics++; }
        });
      });
      return p.then(function () {
        push({ t: 'end', n: count });
        UI.download(new Blob(parts, { type: 'application/json' }), 'cetg-claims-backup-' + U.todayIso() + '.json');
        S.flags.lastBackup = Date.now(); saveFlags();
        toast('Backup file made: ' + holds(r[0].length, pics, r[2].length) + ' (' + fmtBytes(size) + '). '
          + (UI.isIos() && UI.isStandalone() ? 'Choose “Save to Files” to keep it.' : 'Look for it in your Downloads.')
          + (size > 500 * 1048576 ? ' It is a large file: restore it on a computer rather than a phone.' : ''), { ms: 9000 });
        refreshTips();
      });
    }).catch(function (e) {
      if (window.console) console.warn(e);
      toast('The backup could not be made. Nothing was changed.', { bad: true });
    });
  }

  /* ---------- reading a backup file ---------- */
  function blobText(blob) {
    if (blob.text) return blob.text();
    return new Promise(function (resolve, reject) { var fr = new FileReader(); fr.onload = function () { resolve(String(fr.result)); }; fr.onerror = function () { reject(fr.error); }; fr.readAsText(blob); });
  }
  // Calls onLine(text) for each line of a file, reading it a few megabytes at a time.
  function eachLine(file, onLine) {
    var CH = 4 * 1024 * 1024, pos = 0, dec = new TextDecoder(), carry = [];
    function step() {
      if (pos >= file.size) {
        var rest = carry.join('') + dec.decode();
        carry = [];
        if (rest) onLine(rest);
        return Promise.resolve();
      }
      return blobBytes(file.slice(pos, pos + CH)).then(function (buf) {
        pos += CH;
        var text = dec.decode(new Uint8Array(buf), { stream: true }), from = 0, nl;
        while ((nl = text.indexOf('\n', from)) !== -1) {
          carry.push(text.slice(from, nl));
          var line = carry.join('');
          carry = [];
          from = nl + 1;
          onLine(line);
        }
        if (from < text.length) carry.push(text.slice(from));
        return step();
      });
    }
    return step();
  }
  // Packed bytes -> bytes, or null when the packing is damaged.
  function unpack(b64) {
    if (typeof b64 !== 'string' || !b64 || b64.length % 4 !== 0) return null;
    try { return U.b64ToBytes(b64); } catch (e) { return null; }
  }
  // A backup written line by line -> one object in the shape readBackup() checks, pictures already unpacked.
  function readLines(file) {
    var d = null, n = 0, ended = false;
    return eachLine(file, function (line) {
      if (!line) return;
      var x;
      try { x = JSON.parse(line); } catch (e) { if (!d) throw new Error('not a backup'); return; } // a damaged piece is left out
      if (!d) {
        if (!x || typeof x !== 'object' || x.app !== 'cetg-claims' || x.v !== 3) throw new Error('not a backup');
        d = x; d.receipts = []; d.kv = Array.isArray(d.kv) ? d.kv : [];
        return;
      }
      if (!x || typeof x !== 'object') return;
      if (x.t === 'end') { ended = x.n === n; return; }
      if (x.t !== 'r' && x.t !== 'k') return;
      n++;
      var bytes = unpack(x.b64);
      x.b64 = '';
      if (!bytes) return;
      if (x.t === 'r') d.receipts.push({ id: x.id, w: x.w, h: x.h, hash: x.hash, addedAt: x.addedAt, bytes: bytes });
      else d.kv.push({ k: x.k, bytes: bytes });
    }).then(function () {
      if (!d) return null;
      d.cut = !ended; // the last line is missing: the file did not finish downloading, or was cut short
      return d;
    });
  }
  function fileText(file) { return blobText(file); }
  function restore(file) {
    if (Store.isMemoryOnly()) {
      toast('This browser is not saving anything right now (it may be a private window), so a backup cannot be restored here. Open the form in a normal window and try again.', { bad: true, ms: 12000 });
      return;
    }
    if (S.broken === 'wiped' || S.broken === 'replaced') { toast('Reload the page before restoring a backup.', { bad: true }); return; }
    var big = file.size > 30 * 1048576, done = big ? toast('Reading the backup…', { ms: 600000 }) : null;
    blobText(file.slice(0, 64)).then(function (start) {
      if (/^\{"app":"cetg-claims","v":3,/.test(start)) return readLines(file);
      // an older backup is one single piece of text, which a browser can only take up to a certain size
      if (file.size > 450 * 1048576) { var e = new Error('too large'); e.tooLarge = true; throw e; }
      return fileText(file).then(function (text) { try { return JSON.parse(text); } catch (x) { return null; } });
    }).then(function (d) {
      if (done) done();
      var data = d ? readBackup(d) : null;
      if (data) confirmRestore(data); else toast('That is not a backup from this claim form.', { bad: true });
    }, function (e) {
      if (done) done();
      if (e && e.message === 'not a backup') { toast('That is not a backup from this claim form.', { bad: true }); return; }
      toast(e && e.tooLarge ? 'That backup file is too large for this browser to read (' + fmtBytes(file.size) + '). Nothing was changed.'
        : 'That backup file could not be read here' + (big ? ' (' + fmtBytes(file.size) + '). Try restoring it on a computer.' : '.') + ' Nothing was changed.', { bad: true, ms: 10000 });
    });
  }

  /* ---------- restore: the whole file is checked first, then everything is replaced in one step ---------- */
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function intIn(v, max) { v = Math.round(num(v)); return v > 0 && v <= max ? v : 0; }
  var CONF = ['high', 'medium', 'low', 'none'];
  function cleanLine(x) {
    if (!x || typeof x !== 'object' || !idOk(x.id) || typeof x.month !== 'string' || !RE_MONTH.test(x.month)) return null;
    var ocr = x.ocr && typeof x.ocr === 'object' ? x.ocr : {}, rid = idOk(x.receiptId) ? x.receiptId : '';
    var state = rid ? (ocr.state === 'done' || ocr.state === 'failed' ? ocr.state : 'pending') : 'none';
    var out = {
      id: x.id, month: x.month, date: typeof x.date === 'string' && U.validIso(x.date) ? x.date : '',
      amountCents: typeof x.amountCents === 'number' && isFinite(x.amountCents) && x.amountCents >= 0 && x.amountCents <= 99999999 ? Math.round(x.amountCents) : null,
      type: typeof x.type === 'string' && own(TYPE_LABEL, x.type) ? x.type : 'other',
      desc: clean(x.desc, MAX.desc), from: clean(x.from, MAX.place), to: clean(x.to, MAX.place), verified: x.verified === true,
      receiptId: rid, receiptHash: rid && typeof x.receiptHash === 'string' && RE_HASH.test(x.receiptHash) ? x.receiptHash : '',
      ocr: { state: state }, createdAt: num(x.createdAt), updatedAt: num(x.updatedAt)
    };
    ['typeTouched', 'monthTouched', 'dateTouched', 'sample'].forEach(function (k) { if (x[k] === true) out[k] = true; });
    if (state === 'failed' && ocr.skipped === true) out.ocr.skipped = true;
    if (state === 'done') {
      out.ocr.amounts = (Array.isArray(ocr.amounts) ? ocr.amounts : []).slice(0, 80).map(function (a) {
        a = a && typeof a === 'object' ? a : {};
        return { cents: Math.round(num(a.cents)), score: num(a.score), label: clean(a.label, 12), box: Array.isArray(a.box) ? a.box.slice(0, 4).map(num) : null };
      }).filter(function (a) { return a.cents > 0; });
      out.ocr.dates = [];
      out.ocr.amountConf = CONF.indexOf(ocr.amountConf) !== -1 ? ocr.amountConf : 'low';
      out.ocr.dateConf = CONF.indexOf(ocr.dateConf) !== -1 ? ocr.dateConf : 'low';
      out.ocr.hintTo = clean(ocr.hintTo, MAX.place);
      out.ocr.foreign = typeof ocr.foreign === 'string' && /^[A-Z$]{1,4}$/.test(ocr.foreign) ? ocr.foreign : '';
      if (ocr.filledAmount === true) out.ocr.filledAmount = true;
      if (ocr.filledDate === true) out.ocr.filledDate = true;
    }
    return out;
  }
  function cleanClaim(x) {
    if (!x || typeof x !== 'object' || typeof x.month !== 'string' || !RE_MONTH.test(x.month)) return null;
    var st = statusOf(x), draft = { month: x.month, purpose: clean(x.purpose, MAX.purpose) || 'Transport', status: 'draft' };
    if (typeof x.unlockedFrom === 'string' && RE_HASH.test(x.unlockedFrom)) draft.unlockedFrom = x.unlockedFrom;
    if (idOk(x.series)) { draft.series = x.series; draft.rev = intIn(x.rev, 1e6); }
    if (st === 'draft') return draft;
    // the signed part goes through the same checks as a claim read back from a PDF
    var manual = !!(x.approval && x.approval.manual === true);
    var p = ClaimPDF.sanitize({ v: ClaimPDF.FORMAT, kind: 'cetg-claim',
      claim: { series: x.series, rev: x.rev, formTitle: x.formTitle, ref: x.ref, month: x.month, purpose: x.purpose, staffName: x.signedName, staffEmail: x.staffEmail, signedAt: x.signedAt, tzo: x.tzo,
        signedName: x.signedName, signature: x.signature, fingerprint: x.fingerprint, totalCents: 0, lines: x.signedLines },
      approval: x.approval && typeof x.approval === 'object' ? { decision: 'approved', name: x.approval.name, at: x.approval.at, tzo: x.approval.tzo, note: x.approval.note, signature: x.approval.signature } : null });
    if (!p || !p.claim.fingerprint || !p.claim.signedAt || !p.claim.signedName) return draft; // not a usable signature: the month comes back as a draft
    var c = p.claim, out = { month: c.month, purpose: c.purpose || 'Transport', status: st, signedAt: c.signedAt, tzo: c.tzo, signedName: c.signedName, staffEmail: c.staffEmail,
      signature: c.signature, ref: c.ref, fingerprint: c.fingerprint, series: c.series, rev: c.rev, formTitle: c.formTitle,
      signedLines: c.lines.map(function (l, i) { var src = x.signedLines[i] || {}; l.id = idOk(src.id) ? src.id : ''; return l; }) };
    if (st !== 'signed' && ClaimPDF.stampOf(x.sentAt)) out.sentAt = x.sentAt;
    if (st === 'approved') {
      if (!p.approval || !p.approval.at) { out.status = out.sentAt ? 'sent' : 'signed'; return out; }
      out.approval = { name: p.approval.name, at: p.approval.at, tzo: p.approval.tzo, note: p.approval.note, signature: p.approval.signature };
      if (manual) out.approval.manual = true;
      if (x.approvedPdf === true) out.approvedPdf = true;
    }
    return out;
  }
  function cleanApproval(x) {
    if (!x || typeof x !== 'object' || !idOk(x.id) || typeof x.month !== 'string' || !RE_MONTH.test(x.month)) return null;
    var out = { id: x.id, fingerprint: typeof x.fingerprint === 'string' && RE_HASH.test(x.fingerprint) ? x.fingerprint : '', series: idOk(x.series) ? x.series : '', rev: intIn(x.rev, 1e6),
      signedAt: ClaimPDF.stampOf(x.signedAt), ref: clean(x.ref, MAX.ref), formTitle: clean(x.formTitle, MAX.title),
      staffName: clean(x.staffName, MAX.name), staffEmail: U.isEmail(x.staffEmail) ? x.staffEmail : '', month: x.month,
      totalCents: Math.max(0, Math.round(num(x.totalCents))), lineCount: Math.max(0, Math.round(num(x.lineCount))),
      decision: x.decision === 'approved' ? 'approved' : 'returned', decidedAt: ClaimPDF.stampOf(x.decidedAt), tzo: ClaimPDF.tzoOf(x.tzo),
      approver: clean(x.approver, MAX.name), note: clean(x.note, MAX.note),
      lines: (Array.isArray(x.lines) ? x.lines : []).slice(0, MAX.lines).map(function (l) {
        l = l && typeof l === 'object' ? l : {};
        return { date: typeof l.date === 'string' && U.validIso(l.date) ? l.date : '', desc: clean(l.desc, MAX.desc), from: clean(l.from, MAX.place), to: clean(l.to, MAX.place),
          type: typeof l.type === 'string' && own(TYPE_LABEL, l.type) ? l.type : 'other', amountCents: Math.max(0, Math.round(num(l.amountCents))) };
      }) };
    ['superseded', 'withdrawn', 'hasPdf', 'untrusted'].forEach(function (k) { if (x[k] === true) out[k] = true; });
    var rp = x.replaces && typeof x.replaces === 'object' ? x.replaces : null;
    if (rp && ClaimPDF.stampOf(rp.decidedAt)) out.replaces = { totalCents: Math.max(0, Math.round(num(rp.totalCents))), decidedAt: rp.decidedAt, tzo: ClaimPDF.tzoOf(rp.tzo) };
    return out;
  }
  function startsWith(bytes, sig) { if (!bytes || bytes.length < sig.length) return false; for (var i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false; return true; }
  var JPEG = [0xFF, 0xD8, 0xFF], PDF = [0x25, 0x50, 0x44, 0x46, 0x2D]; // "%PDF-"
  // -> { lines, claims, approvals, kv, receiptCount, receiptAt(i), lost, cut } ready for Store.replaceAll,
  // or null when the file is not a backup. Receipts and PDFs arrive either already unpacked (x.bytes)
  // or, from an older backup, still packed as text (x.b64).
  function readBackup(d) {
    if (!d || typeof d !== 'object' || d.app !== 'cetg-claims' || !Array.isArray(d.lines) || !Array.isArray(d.receipts)) return null;
    if (d.lines.length > 20000 || d.receipts.length > 20000) return null;
    var out = { lines: [], claims: [], approvals: [], kv: [], exportedAt: typeof d.exportedAt === 'string' ? d.exportedAt : '', cut: d.cut === true }, seen = table();
    d.lines.forEach(function (x) { var l = cleanLine(x); if (l && !seen['l' + l.id]) { seen['l' + l.id] = true; out.lines.push(l); } });
    (Array.isArray(d.claims) ? d.claims : []).forEach(function (x) { var c = cleanClaim(x); if (c && !seen['c' + c.month]) { seen['c' + c.month] = true; out.claims.push(c); } });
    (Array.isArray(d.approvals) ? d.approvals : []).slice(0, 20000).forEach(function (x) { var a = cleanApproval(x); if (a && !seen['a' + a.id]) { seen['a' + a.id] = true; out.approvals.push(a); } });
    (Array.isArray(d.kv) ? d.kv : []).forEach(function (x) {
      if (!x || typeof x !== 'object' || typeof x.k !== 'string' || seen['k' + x.k]) return;
      var v = x.v && typeof x.v === 'object' ? x.v : {}, val;
      if (x.k === 'profile') val = { name: clean(v.name, MAX.name), email: U.isEmail(v.email) ? v.email : '', signature: U.isPngDataUrl(v.signature) ? v.signature : '' };
      else if (x.k === 'team') { val = {}; TEAM_KEYS.forEach(function (k) { val[k] = clean(v[k], 120); }); ['approverEmail', 'financeEmail'].forEach(function (k) { if (val[k] && !U.isEmail(val[k])) val[k] = ''; }); }
      else if (x.k === 'flags') { val = { lastBackup: num(v.lastBackup) }; if (v.noFolderTip === true) val.noFolderTip = true; }
      else if (/^approved:\d{4}-(0[1-9]|1[0-2])$/.test(x.k) || (x.k.slice(0, 5) === 'apdf:' && idOk(x.k.slice(5)))) { // a kept PDF
        if (x.bytes instanceof Uint8Array) val = x.bytes;
        else if (typeof x.b64 === 'string' && x.b64.slice(0, 7) === 'JVBERi0') val = unpack(x.b64);
        if (!startsWith(val, PDF)) return;
      } else return;
      seen['k' + x.k] = true;
      out.kv.push({ k: x.k, v: val });
    });
    // A kept PDF that is not in the file (or is damaged) is not promised: the claim or decision comes back without it.
    out.claims.forEach(function (c) { if (c.approvedPdf && !seen['kapproved:' + c.month]) delete c.approvedPdf; });
    out.approvals.forEach(function (a) { if (a.hasPdf && !seen['kapdf:' + a.id]) delete a.hasPdf; });
    // A receipt image has to be whole (a JPEG, cleanly packed). A damaged one is left out and its item
    // comes back as an item without a receipt, rather than the whole restore failing.
    var rec = d.receipts.filter(function (x) {
      if (!x || typeof x !== 'object' || !idOk(x.id) || seen['r' + x.id]) return false;
      var ok = x.bytes instanceof Uint8Array ? startsWith(x.bytes, JPEG)
        : typeof x.b64 === 'string' && x.b64.slice(0, 4) === '/9j/' && x.b64.length % 4 === 0 && /^[A-Za-z0-9+\/]+={0,2}$/.test(x.b64);
      if (ok) seen['r' + x.id] = true;
      return ok;
    });
    out.lost = 0;
    out.lines.forEach(function (l) {
      if (!l.receiptId || seen['r' + l.receiptId]) return;
      l.receiptId = ''; l.receiptHash = ''; l.ocr = { state: 'none' }; l.verified = false; out.lost++;
    });
    out.receiptCount = rec.length;
    out.receiptAt = function (i) {
      var x = rec[i], bytes = x.bytes instanceof Uint8Array ? x.bytes : U.b64ToBytes(x.b64);
      x.b64 = ''; x.bytes = null; // let the copy held here go as soon as it has been handed over
      return { id: x.id, w: num(x.w), h: num(x.h), hash: typeof x.hash === 'string' && RE_HASH.test(x.hash) ? x.hash : '', addedAt: num(x.addedAt), type: 'image/jpeg', bytes: bytes.buffer };
    };
    return out;
  }
  function confirmRestore(data) {
    var goBtn = h('button', { type: 'button', class: 'btn danger', id: 'btn-restore-go', text: 'Replace and restore' });
    var err = UI.alertBox();
    // a claims folder in use stays in use after the restore
    if (folder.handle && !data.kv.some(function (x) { return x.k === FOLDER_KEY; })) data.kv.push({ k: FOLDER_KEY, v: folder.handle });
    var what = data.fromFolder ? 'The copy in “' + data.fromFolder + '”, written ' : 'Backup from ';
    var dlg = UI.modal({
      title: data.fromFolder ? 'Bring these claims back?' : 'Restore this backup?', narrow: true,
      body: [h('p', { text: what + (U.fmtStamp(data.exportedAt, true) || 'on an unknown date') + ', with ' + holds(data.lines.length, data.receiptCount, data.approvals.length) + '.' }),
        data.cut ? h('div', { class: 'banner warn' }, icon('alert'), h('div', { text: 'This file looks incomplete: it may not have finished downloading. What is in it can still be restored.' })) : null,
        data.lost ? h('p', { class: 'small', text: plural(data.lost, 'item') + ' in the file ' + (data.lost === 1 ? 'has' : 'have') + ' no usable receipt image and will come back without one.' }) : null,
        h('div', { class: hasData() ? 'banner warn' : 'banner' }, icon(hasData() ? 'alert' : 'info'), h('div', { text: hasData() ? 'Everything this form has saved on this device now is replaced by ' + (data.fromFolder ? 'the folder’s copy.' : 'the backup.') : 'This browser has nothing saved yet, so nothing is lost.' }))],
      foot: [err, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: function () { dlg.close(); } }), goBtn]
    });
    goBtn.addEventListener('click', function () {
      goBtn.disabled = true;
      // Nothing from the old state may be written while, or after, the backup goes in.
      S.restoring = true;
      Object.keys(saveTimers).forEach(function (id) { clearTimeout(saveTimers[id]); delete saveTimers[id]; });
      Store.replaceAll(data).then(function () {
        try { sessionStorage.setItem('cetg-restored', data.lines.length || data.claims.length ? 'claims' : data.approvals.length ? 'decisions' : 'empty'); } catch (e) { /* ignore */ }
        location.reload();
      }, function (e) {
        S.restoring = false;
        err.show(e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message || ''))) ? 'There is not enough free storage on this device for this backup. Nothing was changed.'
          : 'The restore did not go through, and nothing was changed. Close this and choose the backup file again to retry.');
      });
    });
  }
  function eraseAll() {
    S.restoring = true;
    Object.keys(saveTimers).forEach(function (id) { clearTimeout(saveTimers[id]); delete saveTimers[id]; });
    Store.eraseAll().then(function () { location.reload(); }, function (e) { S.restoring = false; storeFail(e); toast('Could not erase. Try again.', { bad: true }); });
  }

  /* =====================================================================================
   * the offline copy, new releases, installing as an app
   * A service worker (site/sw.js) keeps every file of the form on the device after the first visit,
   * so the form opens and works with no connection. A new release is fetched in the background and
   * announced; the person chooses when to switch to it.
   * ===================================================================================== */
  var sw = { reg: null, waiting: null, reloading: false, first: false, prompt: null, ready: false };
  function swSupported() {
    try { return 'serviceWorker' in navigator && !!navigator.serviceWorker && /^https?:$/.test(location.protocol); } catch (e) { return false; }
  }
  // Is this page being served from the copy kept on the device?
  function offlineCopy() { try { return !!(navigator.serviceWorker && navigator.serviceWorker.controller); } catch (e) { return false; } }
  function swNewer(w) {
    sw.waiting = w;
    if (w && !S.newer) { S.newer = true; refreshBanners(); }
  }
  function watchInstalling(reg) {
    var w = reg.installing;
    if (!w) return;
    w.addEventListener('statechange', function () {
      if (w.state === 'installed') {
        if (navigator.serviceWorker.controller) swNewer(reg.waiting || w); // a newer release, fetched and ready
        else sw.first = true;                                               // the first copy on this device
      } else if (w.state === 'activated' && sw.first) {
        sw.first = false; sw.ready = true;
        toast('This form is now saved on this device: from now on it opens and works without internet.', { ms: 9000 });
        refreshTips();
      } else if (w.state === 'redundant' && sw.first) {
        sw.first = false;
      }
    });
  }
  function setupOffline() {
    if (!swSupported()) return;
    try {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        if (!reg) return; // (a browser, or a test harness, that keeps workers out)
        sw.reg = reg;
        sw.ready = offlineCopy();
        if (reg.waiting && navigator.serviceWorker.controller) swNewer(reg.waiting);
        watchInstalling(reg);
        reg.addEventListener('updatefound', function () { watchInstalling(reg); });
      }, function (e) { if (window.console) console.warn('The offline copy could not be set up', e); });
      navigator.serviceWorker.addEventListener('controllerchange', function () { if (sw.reloading) location.reload(); });
    } catch (e) { /* no offline copy in this browser */ }
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); sw.prompt = e; refreshTips(); });
    window.addEventListener('appinstalled', function () { sw.prompt = null; refreshTips(); toast('Installed. From now on open the form from its own icon.'); });
  }
  // "Reload now" on the new-release note: the waiting release takes over first, then the page reloads
  // on it. Any other window of the form is left as it is; it offers the same note.
  function reloadForUpdate() {
    if (sw.waiting) {
      sw.reloading = true;
      try { sw.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch (e) { location.reload(); return; }
      setTimeout(function () { if (sw.reloading) location.reload(); }, 4000); // the worker never answered: a plain reload still helps
      return;
    }
    location.reload();
  }
  // Ask the host whether there is a newer release (when the page is looked at again; see checkVersion).
  function checkForRelease() {
    if (sw.reg && offlineCopy()) { sw.reg.update().catch(function () { /* offline: asked again later */ }); return true; }
    return false;
  }
  function canInstall() { return !!sw.prompt && !UI.isStandalone(); }
  function installApp() {
    var p = sw.prompt;
    if (!p) return Promise.resolve(false);
    sw.prompt = null; // the browser hands out one question per visit
    var done;
    try { done = p.prompt().then(function () { return p.userChoice; }); } catch (e) { done = Promise.reject(e); }
    return done.then(function (c) { refreshTips(); return !!(c && c.outcome === 'accepted'); }, function () { refreshTips(); return false; });
  }
  // What to say in Settings about the copy on this device.
  function offlineNote() {
    if (!swSupported()) return location.protocol === 'file:' ? '' : 'This browser cannot keep an offline copy of the form.';
    if (sw.ready || offlineCopy()) return 'The form is saved on this device and works without internet.';
    return 'The form is being saved on this device for use without internet.';
  }

  /* =====================================================================================
   * the claims folder: a copy of everything the form has saved, in a folder the person chooses
   * (Edge and Chrome on a computer; OneDrive and the like are fine). Written as things change, and
   * read back when the browser has lost its copy.
   * In the folder:
   *   CETG claims.json   items, months, decisions and settings (everything but pictures and PDFs)
   *   receipts/<id>.jpg  one file per receipt image
   *   pdfs/              signed-<month>.pdf, approved-<month>.pdf, decision-<id>.pdf
   *   READ ME.txt
   * ===================================================================================== */
  var FOLDER_JSON = 'CETG claims.json', FOLDER_README = 'READ ME.txt', FOLDER_KEY = 'folder';
  var folder = {
    handle: null, state: 'none', // none | ok | ask (needs a click to reconnect) | gone (folder missing) | error
    err: '', have: null, pdfs: null, written: '', timer: null, busy: false, again: false, lastAt: 0,
    offer: null // what the folder holds while this browser holds nothing: { items, months, decisions, last }
  };
  function folderSupported() { try { return typeof window.showDirectoryPicker === 'function' && !Store.isMemoryOnly(); } catch (e) { return false; } }
  function isDirHandle(x) { return !!x && typeof x === 'object' && x.kind === 'directory' && typeof x.getFileHandle === 'function'; }
  function folderName() { return folder.handle && folder.handle.name ? folder.handle.name : 'your claims folder'; }
  function folderOffer() { return folderSupported() && !UI.isIos() && !folder.handle && hasData() && S.tab === 'claims' && !S.flags.noFolderTip; }
  function folderSig() { return [folder.state, folder.err, folder.offer ? folder.offer.items + '/' + folder.offer.last : ''].join('~'); }

  /* ---------- permission ---------- */
  function permissionOf(hnd, ask) {
    var o = { mode: 'readwrite' };
    try {
      if (ask && typeof hnd.requestPermission === 'function') return hnd.requestPermission(o);
      if (typeof hnd.queryPermission === 'function') return hnd.queryPermission(o);
    } catch (e) { return Promise.reject(e); }
    return Promise.resolve('granted');
  }
  function folderFail(e) {
    var name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') { folder.state = 'ask'; folder.err = ''; }
    else if (name === 'NotFoundError') { folder.state = 'gone'; folder.err = ''; }
    else { folder.state = 'error'; folder.err = (e && e.message) || 'unknown problem'; }
    if (window.console) console.warn('claims folder', e);
    refreshBanners();
  }

  /* ---------- files ---------- */
  function writeFile(dir, name, data) {
    return dir.getFileHandle(name, { create: true }).then(function (fh) { return fh.createWritable(); }).then(function (w) {
      return w.write(data).then(function () { return w.close(); }, function (e) { return w.abort().then(function () { throw e; }, function () { throw e; }); });
    });
  }
  function readFile(dir, name, how) {
    return dir.getFileHandle(name).then(function (fh) { return fh.getFile(); }).then(function (f) { return how === 'text' ? f.text() : f.arrayBuffer(); });
  }
  function hasFile(dir, name) { return dir.getFileHandle(name).then(function () { return true; }, function (e) { if (e && e.name === 'NotFoundError') return false; throw e; }); }
  function subdir(dir, name, create) { return dir.getDirectoryHandle(name, { create: !!create }); }
  // The names in a folder (an async iterator, walked without the newer syntax).
  function listNames(dir) {
    var out = [], it;
    try { it = dir.keys(); } catch (e) { return Promise.reject(e); }
    function next() { return it.next().then(function (r) { if (r.done) return out; out.push(r.value); return next(); }); }
    return next();
  }
  function stem(name, ext) { return name.slice(-ext.length) === ext ? name.slice(0, -ext.length) : ''; }

  /* ---------- the copy, kept up to date ---------- */
  // What goes in the JSON: the same records a backup holds, with each receipt's details but not its picture.
  function folderHead(r) {
    var head = { app: 'cetg-claims', v: 3, folder: 1, exportedAt: new Date().toISOString(), lines: r[0], claims: r[1], approvals: r[2], kv: [], receipts: r[4] };
    return r[3].reduce(function (p, k) {
      if (typeof k !== 'string' || k === 'born' || k === FOLDER_KEY || RE_BIN_KEY.test(k)) return p;
      return p.then(function () { return Store.kvGet(k, null); }).then(function (v) { if (v != null && typeof v === 'object' && b64Of(v) === null) head.kv.push({ k: k, v: v }); });
    }, Promise.resolve()).then(function () { return head; });
  }
  function receiptMeta() {
    return Store.all('receipts').then(function (all) {
      return all.filter(function (x) { return x && idOk(x.id); }).map(function (x) { return { id: x.id, w: x.w, h: x.h, hash: x.hash, addedAt: x.addedAt }; });
    });
  }
  function writeFolder() {
    var dir = folder.handle, kvKeys = [];
    return Promise.all([Store.all('lines'), Store.all('claims'), Store.all('approvals'), Store.keys('kv'), receiptMeta()]).then(function (r) { kvKeys = r[3]; return folderHead(r); }).then(function (head) {
      var text = JSON.stringify(head, null, 1), p = Promise.resolve();
      if (text !== folder.written) p = p.then(function () { return writeFile(dir, FOLDER_JSON, text); }).then(function () { folder.written = text; });
      // receipts: each picture once
      var want = head.receipts.map(function (x) { return x.id; }).filter(function (id) { return !folder.have[id]; });
      if (want.length) {
        p = p.then(function () { return subdir(dir, 'receipts', true); }).then(function (rd) {
          return want.reduce(function (q, id) {
            return q.then(function () { return Store.get('receipts', id); }).then(function (x) {
              if (!x || !x.bytes) return;
              return writeFile(rd, id + '.jpg', x.bytes).then(function () { folder.have[id] = true; });
            });
          }, Promise.resolve());
        });
      }
      // kept PDFs: approved claims and decisions, each once
      p = p.then(function () {
        var bin = kvKeys.filter(function (k) { return typeof k === 'string' && RE_BIN_KEY.test(k) && !folder.pdfs[k]; });
        if (!bin.length) return;
        return subdir(dir, 'pdfs', true).then(function (pd) {
          return bin.reduce(function (q, k) {
            return q.then(function () { return Store.kvGet(k, null); }).then(function (v) {
              var b = v ? b64Of(v) : null;
              if (!b) return;
              var name = k.slice(0, 9) === 'approved:' ? 'approved-' + k.slice(9) + '.pdf' : 'decision-' + k.slice(5) + '.pdf';
              return writeFile(pd, name, v).then(function () { folder.pdfs[k] = true; });
            });
          }, Promise.resolve());
        });
      });
      return p.then(function () { return hasFile(dir, FOLDER_README); }).then(function (there) {
        if (there) return;
        return writeFile(dir, FOLDER_README, 'CETG Transport & Expense Claim Form - your claims folder\n\n'
          + 'This folder is written by the claim form on your device. It holds a copy of everything the form has saved:\n'
          + '  ' + FOLDER_JSON + '   your items, months, decisions and settings\n'
          + '  receipts/          one picture per receipt\n'
          + '  pdfs/              signed claims, approved claims and (for approvers) decisions, as PDF files\n\n'
          + 'Keep the folder as it is. If the browser ever loses its copy, open the form, go to Settings and choose\n'
          + '"Bring back from the folder". The PDFs can be opened and read at any time.\n');
      });
    });
  }
  // Write what has changed. Runs one at a time; a change that arrives meanwhile is written afterwards.
  function syncFolder() {
    clearTimeout(folder.timer); folder.timer = null;
    if (!folder.handle || folder.state !== 'ok' || S.restoring) return Promise.resolve();
    if (folder.busy) { folder.again = true; return Promise.resolve(); }
    folder.busy = true;
    return writeFolder().then(function () {
      folder.lastAt = Date.now(); folder.err = '';
    }, folderFail).then(function () {
      folder.busy = false;
      if (folder.again) { folder.again = false; return syncFolder(); }
      refreshTips();
    });
  }
  function folderSoon() { if (!folder.handle || folder.state !== 'ok') return; clearTimeout(folder.timer); folder.timer = setTimeout(syncFolder, 800); }
  // The page is being left or put away: whatever is waiting to be written goes now.
  function folderFlush() { if (folder.timer) syncFolder(); }
  // A signed claim's PDF, as a file the person can open (also what "bring back from PDF" can read).
  function folderKeepPdf(name, bytes) {
    if (!folder.handle || folder.state !== 'ok') return Promise.resolve(false);
    return subdir(folder.handle, 'pdfs', true).then(function (pd) { return writeFile(pd, name, bytes); }).then(function () { return true; }, function (e) { folderFail(e); return false; });
  }

  /* ---------- connecting ---------- */
  // Read what is in the folder now: the records, with each receipt and kept PDF read from its file.
  // Resolves to what readBackup() accepts (or null when the folder holds no claims).
  function readFolder(dir) {
    return hasFile(dir, FOLDER_JSON).then(function (there) {
      if (!there) return null;
      return readFile(dir, FOLDER_JSON, 'text').then(function (text) {
        var d;
        try { d = JSON.parse(text); } catch (e) { throw new Error('damaged'); }
        if (!d || d.app !== 'cetg-claims' || !Array.isArray(d.lines)) throw new Error('damaged');
        var meta = Array.isArray(d.receipts) ? d.receipts.filter(function (x) { return x && idOk(x.id); }) : [];
        d.receipts = [];
        d.kv = Array.isArray(d.kv) ? d.kv : [];
        var p = Promise.resolve();
        if (meta.length) {
          p = p.then(function () { return subdir(dir, 'receipts', false); }).then(function (rd) {
            return meta.reduce(function (q, x) {
              return q.then(function () { return readFile(rd, x.id + '.jpg', 'bytes'); }).then(function (buf) {
                d.receipts.push({ id: x.id, w: x.w, h: x.h, hash: x.hash, addedAt: x.addedAt, bytes: new Uint8Array(buf) });
              }, function () { /* a picture that is missing: its item comes back without one */ });
            }, Promise.resolve());
          }, function () { /* no receipts folder yet */ });
        }
        p = p.then(function () { return subdir(dir, 'pdfs', false); }).then(function (pd) {
          return listNames(pd).then(function (names) {
            return names.reduce(function (q, n) {
              var m = stem(n, '.pdf'), key = m.slice(0, 9) === 'approved-' ? 'approved:' + m.slice(9) : m.slice(0, 9) === 'decision-' ? 'apdf:' + m.slice(9) : '';
              if (!key) return q;
              return q.then(function () { return readFile(pd, n, 'bytes'); }).then(function (buf) { d.kv.push({ k: key, bytes: new Uint8Array(buf) }); }, function () { /* skipped */ });
            }, Promise.resolve());
          });
        }, function () { /* no pdfs folder yet */ });
        return p.then(function () { return d; });
      });
    });
  }
  function summarise(d) {
    var months = {};
    d.lines.forEach(function (l) { if (l && typeof l.month === 'string') months[l.month] = true; });
    (d.claims || []).forEach(function (c) { if (c && typeof c.month === 'string') months[c.month] = true; });
    var ms = Object.keys(months).sort();
    return { items: d.lines.length, months: ms.length, decisions: (d.approvals || []).length, last: ms.length ? ms[ms.length - 1] : '' };
  }
  function describe(sum) {
    return plural(sum.items, 'item') + (sum.months ? ' in ' + plural(sum.months, 'month') : '') + (sum.last ? ' up to ' + U.monthLabel(sum.last) : '') + (sum.decisions ? ', and ' + plural(sum.decisions, 'decision') : '');
  }
  function restoreFromFolder(dir) {
    if (S.broken === 'wiped' || S.broken === 'replaced') { toast('Reload the page before bringing claims back.', { bad: true }); return Promise.resolve(false); }
    var hold = toast('Reading your claims folder…', { ms: 600000 });
    return readFolder(dir).then(function (d) {
      hold();
      if (!d) { toast('There are no claims in that folder yet.'); return false; }
      var data = readBackup(d);
      if (!data) { toast('The claims in that folder could not be read.', { bad: true }); return false; }
      data.kv.push({ k: FOLDER_KEY, v: dir }); // the folder stays connected after the restore
      data.fromFolder = dir.name || '';
      confirmRestore(data);
      return true;
    }, function (e) {
      hold();
      folderFail(e);
      toast(e && e.message === 'damaged' ? 'The claims file in that folder is damaged, so nothing was changed.' : 'That folder could not be read. Nothing was changed.', { bad: true, ms: 9000 });
      return false;
    });
  }
  function useFolder(dir) {
    folder.handle = dir; folder.state = 'ok'; folder.err = ''; folder.have = table(); folder.pdfs = table(); folder.written = ''; folder.offer = null;
    return Store.kvSet(FOLDER_KEY, dir).then(function () {
      // pictures and PDFs already in the folder are not written again
      return subdir(dir, 'receipts', false).then(listNames, function () { return []; }).then(function (names) {
        names.forEach(function (n) { var id = stem(n, '.jpg'); if (id) folder.have[id] = true; });
        return subdir(dir, 'pdfs', false).then(listNames, function () { return []; });
      }).then(function (names) {
        names.forEach(function (n) {
          var m = stem(n, '.pdf');
          if (m.slice(0, 9) === 'approved-') folder.pdfs['approved:' + m.slice(9)] = true;
          else if (m.slice(0, 9) === 'decision-') folder.pdfs['apdf:' + m.slice(9)] = true;
        });
        refreshBanners(); refreshTips();
        return syncFolder();
      });
    }, function (e) { folder.handle = null; folder.state = 'none'; storeFail(e); throw e; });
  }
  // "Choose a folder": pick it, then decide what to do if it already holds claims.
  function chooseFolder() {
    if (!folderSupported()) { toast('A claims folder needs Edge or Chrome on a computer.', { bad: true }); return Promise.resolve(false); }
    if (S.broken === 'wiped' || S.broken === 'replaced') { toast('Reload the page first.', { bad: true }); return Promise.resolve(false); }
    var opts = { id: 'cetg-claims', mode: 'readwrite', startIn: 'documents' }, picked;
    try { picked = window.showDirectoryPicker(opts); } catch (e) { picked = Promise.reject(e); }
    return picked.then(function (dir) {
      return permissionOf(dir, true).then(function (perm) {
        if (perm !== 'granted') { toast('The browser did not allow the form to write to that folder.', { bad: true }); return false; }
        return hasFile(dir, FOLDER_JSON).then(function (there) {
          if (!there) return useFolder(dir).then(function () { toast('Your claims are now also kept in “' + dir.name + '”.'); return true; });
          return readFile(dir, FOLDER_JSON, 'text').then(function (text) {
            var d = null; try { d = JSON.parse(text); } catch (e) { d = null; }
            var sum = d && Array.isArray(d.lines) ? summarise(d) : null;
            if (!sum || (!sum.items && !sum.decisions)) return useFolder(dir).then(function () { toast('Your claims are now also kept in “' + dir.name + '”.'); return true; });
            if (!hasData()) return restoreFromFolder(dir);
            return askWhichCopy(dir, sum);
          });
        });
      });
    }, function (e) {
      if (e && e.name === 'AbortError') return false; // the picker was closed
      toast(e && e.name === 'SecurityError' ? 'The browser would not open a folder from here. Open the form in its own tab and try again.' : 'That folder could not be used.', { bad: true, ms: 8000 });
      return false;
    });
  }
  function askWhichCopy(dir, sum) {
    return new Promise(function (resolve) {
      var mine = summarise({ lines: S.lines, claims: Object.keys(S.claims).map(function (m) { return S.claims[m]; }), approvals: S.approvals });
      var dlg = UI.modal({
        title: 'This folder already holds claims', narrow: true,
        body: [h('p', { text: '“' + dir.name + '” holds ' + describe(sum) + '. This browser holds ' + describe(mine) + '.' }),
          h('p', { text: 'Which copy do you want to keep?' })],
        foot: [h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: function () { dlg.close(); } }),
          h('button', { type: 'button', class: 'btn', id: 'btn-folder-take', text: 'Use the folder’s claims here', onclick: function () { dlg.close(); restoreFromFolder(dir).then(resolve); } }),
          h('button', { type: 'button', class: 'btn primary', id: 'btn-folder-keep', text: 'Keep this browser’s claims', onclick: function () {
            dlg.close();
            // the folder's copy is replaced by this browser's: its old pictures are left, its records are rewritten
            useFolder(dir).then(function () { folder.have = table(); folder.pdfs = table(); folder.written = ''; return syncFolder(); }).then(function () { toast('Your claims are now also kept in “' + dir.name + '”.'); resolve(true); }, function () { resolve(false); });
          } })],
        onClose: function () { resolve(false); }
      });
    });
  }
  function reconnectFolder() {
    if (!folder.handle) return chooseFolder();
    return permissionOf(folder.handle, true).then(function (perm) {
      if (perm !== 'granted') { toast('The browser did not allow the form to use the folder.', { bad: true }); return false; }
      folder.state = 'ok'; folder.err = '';
      refreshBanners();
      return syncFolder().then(function () { return folderPeek(); }).then(function () { return true; });
    }, function (e) { folderFail(e); return false; });
  }
  function forgetFolder() {
    folder.handle = null; folder.state = 'none'; folder.err = ''; folder.offer = null;
    return Store.del('kv', FOLDER_KEY).then(function () { refreshBanners(); refreshTips(); }, storeFail);
  }
  // With nothing saved in this browser, say what the folder holds (the browser's copy was probably lost).
  function folderPeek() {
    folder.offer = null;
    if (!folder.handle || folder.state !== 'ok' || hasData()) { refreshBanners(); return Promise.resolve(); }
    return hasFile(folder.handle, FOLDER_JSON).then(function (there) {
      if (!there) return;
      return readFile(folder.handle, FOLDER_JSON, 'text').then(function (text) {
        var d = null; try { d = JSON.parse(text); } catch (e) { d = null; }
        var sum = d && Array.isArray(d.lines) ? summarise(d) : null;
        if (sum && (sum.items || sum.decisions)) folder.offer = sum;
      });
    }).then(null, function () { /* nothing to offer */ }).then(function () { refreshBanners(); });
  }
  // At start-up: the folder chosen earlier, if the browser still allows it.
  function setupFolder() {
    if (!folderSupported()) return Promise.resolve();
    return Store.kvGet(FOLDER_KEY, null).then(function (hnd) {
      if (!isDirHandle(hnd)) return;
      folder.handle = hnd; folder.have = table(); folder.pdfs = table();
      return permissionOf(hnd, false).then(function (perm) {
        if (perm !== 'granted') { folder.state = 'ask'; refreshBanners(); return; }
        return useFolder(hnd).then(folderPeek);
      }, function (e) { folderFail(e); });
    }, function () { /* storage trouble is reported elsewhere */ });
  }
  // Notes at the top of the page about the folder (both tabs).
  function folderBanners() {
    var out = [];
    if (!folder.handle) return out;
    if (folder.state === 'ask') {
      out.push(h('div', { class: 'banner warn', dataset: { folder: 'ask' } }, icon('alert'), h('div', null, h('b', { text: 'Your claims folder needs a click to reconnect' }),
        h('div', { text: 'Until then the copy in “' + folderName() + '” is not being kept up to date.' }),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn sm primary', id: 'btn-folder-reconnect', text: 'Reconnect', onclick: function () { reconnectFolder(); } }),
          h('button', { type: 'button', class: 'btn sm', text: 'Stop using it', onclick: function () { forgetFolder(); } })))));
    } else if (folder.state === 'gone') {
      out.push(h('div', { class: 'banner warn', dataset: { folder: 'gone' } }, icon('alert'), h('div', null, h('b', { text: 'Your claims folder could not be found' }),
        h('div', { text: '“' + folderName() + '” may have been moved, renamed or removed. Choose it again, or stop using a folder.' }),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn sm primary', text: 'Choose the folder', onclick: function () { chooseFolder(); } }),
          h('button', { type: 'button', class: 'btn sm', text: 'Stop using it', onclick: function () { forgetFolder(); } })))));
    } else if (folder.state === 'error') {
      out.push(h('div', { class: 'banner warn', dataset: { folder: 'error' } }, icon('alert'), h('div', null, h('b', { text: 'The copy in your claims folder could not be written' }),
        h('div', { text: folder.err + '. Your claims are still saved in this browser.' }),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn sm primary', text: 'Try again', onclick: function () { folder.state = 'ok'; folder.err = ''; refreshBanners(); syncFolder(); } })))));
    } else if (folder.offer) {
      out.push(h('div', { class: 'banner', dataset: { folder: 'offer' } }, icon('info'), h('div', null, h('b', { text: 'Your claims folder holds ' + describe(folder.offer) }),
        h('div', { text: 'This browser has nothing saved. Bring the folder’s claims back here?' }),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn sm primary', id: 'btn-folder-restore', text: 'Bring them back', onclick: function () { restoreFromFolder(folder.handle); } }),
          h('button', { type: 'button', class: 'btn sm', text: 'Not now', onclick: function () { folder.offer = null; refreshBanners(); } })))));
    }
    return out;
  }
  // The folder's part of Settings.
  function folderSettings() {
    var slot = h('div', null);
    function paint() {
      U.clear(slot);
      if (!folderSupported()) {
        slot.appendChild(h('p', { class: 'hint', text: Store.isMemoryOnly() ? '' : 'A claims folder (a copy of your claims written to a folder as you go) needs Edge or Chrome on a computer. On this device, download a backup now and then.' }));
        return;
      }
      var state = !folder.handle ? 'No folder chosen yet. Choose one and the form keeps a copy of your claims there as you go: every item, receipt and signed PDF. If this browser ever loses its copy, the folder brings it back.'
        : folder.state === 'ok' ? 'Copy kept in “' + folderName() + '”' + (folder.lastAt ? ', last written ' + U.fmtStamp(new Date(folder.lastAt).toISOString(), true) : '') + '.'
          : folder.state === 'ask' ? '“' + folderName() + '” needs a click to reconnect.'
            : folder.state === 'gone' ? '“' + folderName() + '” could not be found.' : 'The copy in “' + folderName() + '” could not be written: ' + folder.err + '.';
      slot.appendChild(h('p', { class: 'hint', id: 'folder-note', text: state }));
      var row = h('div', { class: 'btn-row' });
      if (!folder.handle || folder.state === 'gone') row.appendChild(h('button', { type: 'button', class: 'btn', id: 'btn-folder-choose', onclick: function () { chooseFolder().then(paint); } }, icon('file'), 'Choose a folder'));
      else if (folder.state === 'ask') row.appendChild(h('button', { type: 'button', class: 'btn primary', id: 'btn-folder-reconnect2', text: 'Reconnect', onclick: function () { reconnectFolder().then(paint); } }));
      else {
        row.appendChild(h('button', { type: 'button', class: 'btn', id: 'btn-folder-restore2', onclick: function () { restoreFromFolder(folder.handle); } }, icon('upload'), 'Bring back from the folder'));
        row.appendChild(h('button', { type: 'button', class: 'btn', id: 'btn-folder-change', onclick: function () { chooseFolder().then(paint); } }, icon('file'), 'Change folder'));
      }
      if (folder.handle) row.appendChild(h('button', { type: 'button', class: 'btn', id: 'btn-folder-forget', text: 'Stop using the folder', onclick: function () { forgetFolder().then(paint); } }));
      slot.appendChild(row);
      if (!folder.handle && !hasData()) slot.appendChild(h('p', { class: 'hint', text: 'Had claims on this computer before? Choose the folder they were kept in and they come back.' }));
    }
    paint();
    return slot;
  }

  /* =====================================================================================
   * bringing a month back from its claim PDF
   * The signed PDF that was sent (or the approved one that came back) carries the items, the receipt
   * pictures and the signature, all checked against the check code made when the month was signed.
   * A device that has lost its copy of a month gets it back from that file.
   * ===================================================================================== */
  function jpegSize(bytes) {
    return loadImage(new Blob([bytes], { type: 'image/jpeg' })).then(function (s) { var r = { w: s.w, h: s.h }; s.done(); return r; }, function () { return { w: 0, h: 0 }; });
  }
  // Why a PDF cannot be brought back here, or '' when it can.
  function bringBackBlocker(claim) {
    var m = claim.month, c = S.claims[m], st = statusOf(c);
    if (st !== 'draft') return U.monthLabel(m) + ' is already ' + STATUS_LABEL[st].toLowerCase() + ' on this device' + (c.fingerprint === claim.fingerprint ? '.' : ' (a different version). Unlock it there first if this PDF should replace it.');
    var n = linesOf(m).length;
    if (n) return U.monthLabel(m) + ' already has ' + plural(n, 'item') + ' on this device. Remove them first, or sign and send them as they are.';
    return '';
  }
  // Put one checked claim back into storage: receipts, items and the signed month together.
  function bringBackPack(pack, bytes) {
    var c = pack.payload.claim, ap = pack.payload.approval, now = Date.now(), m = c.month;
    var lines = c.lines.map(function (l) {
      var has = !!(l.receiptId && own(pack.receipts, l.receiptId));
      return { id: U.uid('l'), month: m, date: l.date || '', amountCents: l.amountCents, type: own(TYPE_LABEL, l.type) ? l.type : 'other', typeTouched: true, monthTouched: true, dateTouched: true,
        desc: l.desc, from: l.from, to: l.to, verified: true, receiptId: has ? l.receiptId : '', receiptHash: has ? l.receiptHash : '',
        ocr: { state: has ? 'done' : 'none', amounts: has && l.hl ? [{ cents: l.amountCents, score: 1, label: 'total', box: l.hl }] : [], dates: [], amountConf: 'high', dateConf: 'high', hintTo: '', foreign: '' }, createdAt: now, updatedAt: now };
    });
    var rec = cleanClaim({ month: m, purpose: c.purpose, status: ap ? 'approved' : 'signed', series: c.series, rev: c.rev, formTitle: c.formTitle, ref: c.ref,
      signedAt: c.signedAt, tzo: c.tzo, signedName: c.signedName, staffEmail: c.staffEmail, signature: c.signature, fingerprint: c.fingerprint,
      signedLines: c.lines.map(function (l, i) { var x = U.clone(l); x.id = lines[i].id; return x; }),
      approval: ap ? { name: ap.name, at: ap.at, tzo: ap.tzo, note: ap.note, signature: ap.signature } : undefined, approvedPdf: !!ap });
    if (!rec || rec.status === 'draft') return Promise.reject(new Error('not signed'));
    var p = Promise.resolve();
    c.lines.forEach(function (l, i) {
      if (!lines[i].receiptId) return;
      var b = pack.receipts[l.receiptId];
      p = p.then(function () { return jpegSize(b); }).then(function (sz) {
        return Store.put('receipts', { id: l.receiptId, bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), type: 'image/jpeg', w: sz.w, h: sz.h, hash: l.receiptHash, addedAt: now });
      });
    });
    return p.then(function () { return Store.signClaim(rec, lines); }).then(function () {
      if (ap) return Store.kvSet('approved:' + m, bytes);
    }).then(function () {
      // the name, email and signature on the claim fill in what this device does not know yet
      var changed = false;
      if (!S.profile.name && c.signedName) { S.profile.name = c.signedName; changed = true; }
      if (!S.profile.email && c.staffEmail) { S.profile.email = c.staffEmail; changed = true; }
      if (!S.profile.signature && U.isPngDataUrl(c.signature)) { S.profile.signature = c.signature; changed = true; }
      return changed ? saveProfile() : null;
    }).then(function () { return rec; });
  }
  function bringBackPdfs(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return Promise.resolve();
    if (S.broken === 'wiped' || S.broken === 'replaced') { toast('Reload the page before bringing claims back.', { bad: true }); return Promise.resolve(); }
    if (Store.isMemoryOnly()) { toast('This browser is not saving anything right now, so a month cannot be brought back here.', { bad: true, ms: 9000 }); return Promise.resolve(); }
    var back = [], chain = UI.needPdfLib().then(flushSaves);
    list.forEach(function (file) {
      var label = '“' + (file.name || 'That file') + '”';
      chain = chain.then(function () {
        if (file.size > 60 * 1024 * 1024) { toast(label + ' is too large to be a claim from this form.', { bad: true }); return null; }
        return blobBytes(file).then(function (buf) { return new Uint8Array(buf); }, function () { toast(label + ' could not be read.', { bad: true }); return null; });
      }).then(function (bytes) {
        if (!bytes) return;
        return ClaimPDF.read(bytes).then(function (res) { return res; }, function () { return null; }).then(function (res) {
          if (!res) { toast(label + ' is not a claim from this form, or another app re-saved it.', { bad: true, ms: 9000 }); return; }
          var pack = { payload: res.payload, receipts: res.receipts };
          return window.App.verifyPack(pack).then(function () {
            var c = pack.payload.claim, why = bringBackBlocker(c);
            if (pack.cannot) { toast('That file cannot be checked on this page, because the form is not open from its secure (https) link.', { bad: true, ms: 10000 }); return; }
            if (!pack.ok) { toast(label + ' does not match the check code made when it was signed, so it cannot be brought back. Add the receipts again as pictures instead.', { bad: true, ms: 12000 }); return; }
            if (why) { toast(why, { bad: true, ms: 10000 }); return; }
            return bringBackPack(pack, bytes).then(function (rec) { back.push(rec); }, function (e) {
              if (e && (e.stale || e.locked)) { toast(U.monthLabel(c.month) + ' changed in another window meanwhile. Try again.', { bad: true }); return; }
              storeFail(e); toast(label + ' could not be saved on this device.', { bad: true });
            });
          });
        });
      });
    });
    return chain.then(function () {
      if (!back.length) return;
      packCache = null;
      return resync(true).then(function () {
        var last = back[back.length - 1];
        goMonth(last.month);
        var months = back.map(function (r) { return U.monthLabel(r.month); }).join(', ');
        toast((back.length === 1 ? months + ' is back' : 'Back: ' + months) + (back.some(function (r) { return r.status === 'signed'; }) ? '. A month that was already sent can be marked as sent from “Send to …”.' : '.'), { ms: 10000 });
      });
    }, function () { toast('That PDF could not be opened. Check your connection, reload the page and try again.', { bad: true }); });
  }

  /* =====================================================================================
   * shell: tabs, events, boot
   * ===================================================================================== */
  // Claims opened on the Approver tab that have not been decided yet.
  function waiting() { return S.pending.filter(function (p) { return !p.result && !p.returned && !p.blocked; }); }
  function paintTabs() {
    var a = document.getElementById('tab-claims'), b = document.getElementById('tab-approve'), n = waiting().length;
    a.setAttribute('aria-selected', S.tab === 'claims' ? 'true' : 'false');
    b.setAttribute('aria-selected', S.tab === 'approve' ? 'true' : 'false');
    a.tabIndex = S.tab === 'claims' ? 0 : -1;
    b.tabIndex = S.tab === 'approve' ? 0 : -1;
    if ($view) $view.setAttribute('aria-labelledby', S.tab === 'approve' ? 'tab-approve' : 'tab-claims');
    U.clear(b); b.appendChild(document.createTextNode('Approver'));
    if (n) b.appendChild(h('span', { class: 'dot', 'aria-label': plural(n, 'claim') + ' waiting', text: String(n) }));
  }
  function render() {
    paintTabs();
    if (S.tab === 'approve' && window.App.renderApprove) { window.App.renderApprove(); renderBar(); }
    else renderClaims();
  }
  function setTab(t) { if (S.tab === t) return; S.tab = t; render(); window.scrollTo(0, 0); }

  // Receipt images that no item points to any more (an item removed in another window, an interrupted add).
  function sweepOrphans() {
    if (Store.isMemoryOnly() || S.broken || S.restoring) return;
    Store.keys('receipts').then(function (keys) {
      var used = table(), cutoff = Date.now() - 24 * 3600 * 1000;
      S.lines.forEach(function (l) { if (l.receiptId) used[l.receiptId] = true; });
      Object.keys(S.claims).forEach(function (m) { (S.claims[m].signedLines || []).forEach(function (l) { if (l.receiptId) used[l.receiptId] = true; }); });
      keys.forEach(function (id) {
        if (typeof id !== 'string' || used[id]) return;
        var made = parseInt(id.slice(1, 9), 36); // ids start with the time they were made
        if (isFinite(made) && made < cutoff) Store.del('receipts', id).catch(function () { /* next time */ });
      });
    }, function () { /* next time */ });
  }

  // Receipts whose reading was cut short (the page was closed) are read now. A window in the
  // background leaves them for the one in view, or for when it is looked at again.
  function resumeReads() {
    if (document.visibilityState === 'hidden' || S.restoring || S.broken === 'wiped' || S.broken === 'replaced') return;
    S.lines.filter(isReading).forEach(function (l) {
      if (readingHere[l.id]) return; // already asked for here
      if (l.receiptId && !isSigned(l.month)) queueOcr(l, { resume: true }); else l.ocr = { state: l.receiptId ? 'failed' : 'none' };
    });
  }

  // Has a newer version of the form been published since this page was loaded? (Asked when the page
  // is looked at again; a page left open for weeks would otherwise never find out.)
  var versionAt = 0;
  function newerThan(a, b) {
    var x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (var i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
    return false;
  }
  function checkVersion() {
    if (S.newer || !/^https?:$/.test(location.protocol) || !window.fetch || Date.now() - versionAt < 10 * 60 * 1000) return;
    versionAt = Date.now();
    // Served from the copy on this device: a newer release is fetched in the background and announced when it is ready.
    if (checkForRelease()) return;
    fetch('version.txt', { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (t) {
      t = String(t).trim();
      if (/^\d+\.\d+\.\d+$/.test(t) && newerThan(t, VERSION)) { S.newer = true; refreshBanners(); }
    }, function () { /* offline: asked again later */ });
  }

  function wire() {
    var tabC = document.getElementById('tab-claims'), tabA = document.getElementById('tab-approve');
    tabC.addEventListener('click', function () { setTab('claims'); });
    tabA.addEventListener('click', function () { setTab('approve'); });
    [tabC, tabA].forEach(function (t) {
      t.addEventListener('keydown', function (e) {
        var to = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? (t === tabC ? tabA : tabC) : e.key === 'Home' ? tabC : e.key === 'End' ? tabA : null;
        if (!to) return;
        e.preventDefault();
        setTab(to === tabC ? 'claims' : 'approve'); to.focus();
      });
    });
    document.getElementById('btn-settings').addEventListener('click', openSettings);
    function picked(id, fn, onCancel) {
      var input = document.getElementById(id);
      input.addEventListener('change', function () { var f = Array.prototype.slice.call(input.files || []); input.value = ''; if (f.length) fn(f); else if (onCancel) onCancel(); });
      if (onCancel) input.addEventListener('cancel', onCancel);
    }
    picked('pick-images', function (f) { addFiles(f); });
    picked('pick-camera', function (f) { addFiles(f); });
    // "Add receipt" on a typed item has its own picker, so a cancelled pick can never swallow the next one.
    picked('pick-attach', function (f) {
      var l = attachTo; attachTo = null;
      if (l && S.lines.indexOf(l) !== -1) addFiles([f[0]], { attachTo: l });
    }, function () { attachTo = null; });
    picked('pick-pdf', function (f) { if (window.App.openPdfs) window.App.openPdfs(f); });
    picked('pick-backup', function (f) { restore(f[0]); });
    picked('pick-bringback', function (f) { bringBackPdfs(f); });

    document.addEventListener('paste', function (e) {
      if (UI.anyModal()) return;
      var items = (e.clipboardData && e.clipboardData.files) ? Array.prototype.slice.call(e.clipboardData.files) : [];
      var imgs = items.filter(isImageFile);
      if (!imgs.length) return;
      e.preventDefault();
      addFiles(imgs);
    });
    var depth = 0, veil = document.getElementById('drop-veil');
    function hasFiles(e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') !== -1; }
    window.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; if (UI.anyModal()) return; veil.textContent = S.tab === 'approve' ? 'Drop the claim PDF to open it' : 'Drop receipts to add them'; veil.hidden = false; });
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) veil.hidden = true; });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; veil.hidden = true;
      if (UI.anyModal()) return;
      addFiles(e.dataTransfer.files);
    });

    window.addEventListener('pagehide', function () { flushSaves(); folderFlush(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { flushSaves().then(folderFlush, folderFlush); return; }
      // Looked at again: catch up with whatever another window did. A message about it can be missed
      // while a page sleeps, so after a while the page checks for itself.
      if (stale || Date.now() - syncedAt > 30000) resync(!stale); // (which also picks up any read left unfinished)
      else resumeReads();
      checkVersion();
    });
    // brought back from the browser's back/forward store, where it heard nothing
    window.addEventListener('pageshow', function (e) { if (e.persisted) { resync(true); checkVersion(); } });
    Store.on('change', function () { if (document.visibilityState === 'hidden') stale = true; else resync(); });
    Store.on('written', folderSoon);
    Store.on('lost', function () { storeFail({ wiped: true }); });
    Store.on('replaced', handleReplaced);
    Store.on('late', function () {
      // The saved data opened after the form had given up waiting for it. With nothing entered yet the
      // page simply starts again (once: a browser that is always this slow must not reload for ever).
      var empty = !S.lines.length && !Object.keys(S.claims).length && !S.pending.length && !UI.anyModal(), again = true;
      try {
        again = Date.now() - (+sessionStorage.getItem('cetg-late') || 0) < 120000;
        if (empty && !again) sessionStorage.setItem('cetg-late', String(Date.now()));
      } catch (e) { again = true; }
      if (empty && !again) location.reload();
      else { S.late = true; refreshBanners(); }
    });
    window.addEventListener('hashchange', function () { if (/^#approve\b/.test(location.hash)) setTab('approve'); });
    if (window.ResizeObserver) new ResizeObserver(setBarHeight).observe($bar);
    window.addEventListener('resize', setBarHeight);
  }

  function boot() {
    $view = document.getElementById('view'); $bar = document.getElementById('bar');
    try { if (history.state && history.state.cetgLayer) history.replaceState(null, ''); } catch (e) { /* ignore */ }
    wire();
    setupOffline();
    var slow = setTimeout(function () { var b = document.getElementById('boot'); if (b) b.textContent = 'Still opening your saved claims. This can take a moment on a busy phone.'; }, 3000);
    Store.open().then(loadAll).then(function (r) {
      clearTimeout(slow);
      adopt(r);
      syncedAt = Date.now();
      // open on the most recent month that still has unsigned items, else one still waiting for approval
      var open = S.lines.filter(function (l) { return !isSigned(l.month); }).map(function (l) { return l.month; }).sort();
      var pending = Object.keys(S.claims).filter(function (m) { var st = statusOf(S.claims[m]); return st === 'signed' || st === 'sent'; }).sort();
      if (open.length) S.month = open[open.length - 1];
      else if (pending.length) S.month = pending[pending.length - 1];
      try {
        var back = sessionStorage.getItem('cetg-restored');
        if (back) {
          sessionStorage.removeItem('cetg-restored');
          setTimeout(function () { toast('Backup restored.' + (back === 'decisions' ? ' Your decisions are under “Approver”.' : back === 'empty' ? '' : ' Pick a month at the top to see it.')); }, 300);
        }
      } catch (e) { /* no session storage */ }
      S.teamOffer = readTeamHash();
      if (/[#&]team=/.test(location.hash)) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ } }
      if (/^#approve\b/.test(location.hash)) S.tab = 'approve';
      render();
      resumeReads(); // finish reading any receipts that were interrupted last time
      setupFolder();
      setTimeout(sweepOrphans, 8000);
      setTimeout(checkVersion, 5000);
    }).catch(function (e) {
      clearTimeout(slow);
      U.clear($view);
      $view.appendChild(h('div', { class: 'banner bad', role: 'alert' }, icon('alert'), h('div', null, 'The claim form could not start in this browser. Try reloading, or use a current version of Chrome, Edge or Safari.',
        h('div', { class: 'btn-row' }, reloadBtn()))));
      if (window.console) console.error(e);
    });
  }

  window.App = {
    S: S, VERSION: VERSION, TYPE_LABEL: TYPE_LABEL, render: render, setTab: setTab, paintTabs: paintTabs, sheetEl: sheetEl, scrollTab: scrollTab, signatureChooser: signatureChooser,
    saveProfile: saveProfile, approverFirst: approverFirst, importApproved: importApproved, ownsFingerprint: ownsFingerprint, isOlderVersion: isOlderVersion,
    storeFail: storeFail, failedOp: failedOp, storageBanners: storageBanners, storageSig: storageSig, tipBanners: tipBanners, tipSig: tipSig, plural: plural, waiting: waiting,
    renderApprove: null, refreshApproveBanners: null, openPdfs: null
  };
  // Deferred scripts run before DOMContentLoaded, so approve.js is in place by the time boot() runs.
  if (document.readyState === 'complete') setTimeout(boot, 0); else document.addEventListener('DOMContentLoaded', boot);
})();
