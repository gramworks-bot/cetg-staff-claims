/* CETG claim form — approver side: open a signed claim PDF, check each item against its receipt,
 * approve with a signature (or write back to say what needs fixing), and keep a list of decisions. */
(function () {
  'use strict';
  var h = U.h, icon = U.icon, toast = UI.toast, field = UI.field, App = window.App, S = App.S, clean = ClaimPDF.clean, plural = App.plural, MAX = ClaimPDF.MAX;
  var histMonth = '', $banners = null, focusNext = '';
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function first(name) { return clean(name).split(' ')[0] || 'there'; }
  function whoOf(c) { return c.signedName || c.staffName || 'Unknown'; }
  function fileBytes(file) {
    if (file.arrayBuffer) return file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (resolve, reject) { var fr = new FileReader(); fr.onload = function () { resolve(new Uint8Array(fr.result)); }; fr.onerror = function () { reject(fr.error); }; fr.readAsArrayBuffer(file); });
  }
  function hasImage(pack, rid) { return !!rid && own(pack.receipts, rid); }
  function packUrl(pack, rid) {
    if (!hasImage(pack, rid)) return Promise.resolve(null);
    if (!pack.urls[rid]) pack.urls[rid] = URL.createObjectURL(new Blob([pack.receipts[rid]], { type: 'image/jpeg' }));
    return Promise.resolve(pack.urls[rid]);
  }
  function dropPack(pack) {
    Object.keys(pack.urls).forEach(function (k) { URL.revokeObjectURL(pack.urls[k]); });
    pack.urls = Object.create(null);
    S.pending = S.pending.filter(function (p) { return p !== pack; });
    if (S.review === pack) S.review = null;
  }
  function pdfNameFor(c) { return 'CETG-Claim_' + U.slug(whoOf(c)) + '_' + c.month + '_APPROVED.pdf'; }
  function keepData() { if (!/Firefox\//.test(navigator.userAgent)) Store.persist(); } // Firefox would ask a question here; Settings has a button for it

  /* ---------- opening PDFs ---------- */
  // Does the claim in the file still match the check code made when it was signed? (A checksum: it
  // shows that the claim data is intact, not who made the file.)
  function verify(pack) {
    var c = pack.payload.claim, jobs = [];
    pack.missing = 0; pack.changed = 0;
    pack.signed = !!(c.fingerprint && c.signedAt && c.signedName);
    pack.sumOk = c.lines.reduce(function (s, l) { return s + l.amountCents; }, 0) === c.totalCents;
    // A check code made the secure way can only be checked where the browser offers that (a page
    // opened from its https link). Anywhere else the honest answer is "cannot tell", not "does not match".
    pack.cannot = pack.signed && c.fingerprint.charAt(0) !== 'w' && !U.canSha();
    if (pack.cannot) { pack.fpOk = false; pack.ok = false; return Promise.resolve(pack); }
    jobs.push(ClaimPDF.fingerprint(c, c.fingerprint).then(function (fp) { pack.fpOk = !!c.fingerprint && fp === c.fingerprint; }));
    c.lines.forEach(function (l) {
      var bytes = hasImage(pack, l.receiptId) ? pack.receipts[l.receiptId] : null;
      if (!bytes) { if (l.receiptId || l.receiptHash) pack.missing++; return; } // the signed claim had an image here
      if (!l.receiptHash) { pack.changed++; return; }                           // an image the signature knows nothing about
      jobs.push(U.sha256(bytes, l.receiptHash.charAt(0) === 'w').then(function (hsh) { if (hsh !== l.receiptHash) pack.changed++; }));
    });
    return Promise.all(jobs).then(function () { pack.ok = pack.signed && pack.fpOk && pack.sumOk && !pack.missing && !pack.changed; return pack; });
  }
  function problemsOf(pack) {
    var p = [];
    if (!pack.signed) p.push('the claim is not signed');
    else if (!pack.fpOk) p.push('the items or amounts do not match the check code made when it was signed');
    if (pack.missing) p.push(plural(pack.missing, 'receipt image is', 'receipt images are') + ' missing');
    if (pack.changed) p.push(plural(pack.changed, 'receipt image is', 'receipt images are') + ' not the one that was signed');
    if (!pack.sumOk) p.push('the total is not the sum of the items');
    return p;
  }

  function openPdfs(files) {
    var list = Array.prototype.slice.call(files || []), opened = [], chain = UI.needPdfLib();
    list.forEach(function (file) {
      var label = '“' + (file.name || 'That file') + '”';
      chain = chain.then(function () {
        if (file.size > 60 * 1024 * 1024) { toast(label + ' is too large to be a claim from this form.', { bad: true }); return null; }
        return fileBytes(file).then(null, function () { toast(label + ' could not be read.', { bad: true }); return null; });
      }).then(function (bytes) {
        if (!bytes) return { skip: true };
        return ClaimPDF.read(bytes).then(function (res) { return { res: res, bytes: bytes }; }, function () { return { res: null, bytes: bytes }; });
      }).then(function (o) {
        if (o.skip) return;
        if (!o.res) {
          if (S.tab === 'claims') toast(label + ' is not a claim from this form. To add a PDF receipt, take a screenshot of it and add the screenshot.', { bad: true, ms: 10000 });
          else toast(label + ' is not a signed claim from this form, or another app re-saved it. Ask for the original PDF.', { bad: true, ms: 9000 });
          return;
        }
        var payload = o.res.payload, fp = payload.claim.fingerprint;
        var pack = { id: U.uid('p'), fileName: file.name || 'claim.pdf', payload: payload, receipts: o.res.receipts, urls: Object.create(null), checks: {}, replaces: {}, note: '', result: null, returned: false };
        return verify(pack).then(function () {
          if (App.ownsFingerprint(fp)) { // one of this person's own claims coming back
            if (payload.approval) {
              if (pack.ok) return App.importApproved(pack, o.bytes);
              toast(pack.cannot ? 'That file cannot be checked on this page, because the form is not open from its secure (https) link. Open the form from its usual link and add the PDF there.'
                : 'That approved PDF does not match the claim you signed. Ask for the original file.', { bad: true, ms: 10000 });
              return;
            }
            if (S.tab === 'claims') { toast('That is your own signed PDF. It has not been approved yet.'); return; }
          } else if (payload.approval && S.tab === 'claims' && App.isOlderVersion(payload.claim)) {
            toast('That approval is for a different version of your ' + U.monthLabel(payload.claim.month) + ' claim than the one on this device: the claim was unlocked or changed since. The version here still needs approving.', { bad: true, ms: 12000 });
            return;
          }
          S.pending.filter(function (p) { return fp && p.payload.claim.fingerprint === fp; }).forEach(dropPack);
          pack.blocked = pack.ok && !payload.approval && !!related(payload.claim).newer; // an older version of a claim already dealt with
          S.pending.push(pack); opened.push(pack);
        });
      });
    });
    return chain.then(function () {
      if (!opened.length) { App.paintTabs(); return; }
      S.tab = 'approve';
      S.review = opened.length === 1 ? opened[0] : null;
      focusNext = '#ap-top';
      App.render();
      window.scrollTo(0, 0);
    }, function () { toast('That PDF could not be opened. Check your connection, reload the page and try again.', { bad: true }); });
  }

  /* ---------- the list of decisions ----------
   * One approval counts per claim. A claim carries an id of its own ("series") that it keeps when its
   * owner unlocks it and signs again, and a count of signings ("rev"), both inside what is signed. So a
   * newer version of the same claim replaces the older approval, an older version is never approved
   * once a newer one has been seen, and two different people are never merged just because a name or
   * an address matches. A file that fails its check is listed as "not approved" but can never change
   * what the list says about any other claim: nothing read from it is trusted. */
  function live(a) { return a.decision === 'approved' && !a.superseded && !a.withdrawn; }
  function time(s) { var t = Date.parse(s || ''); return isNaN(t) ? 0 : t; }
  function newerThan(a, c) { // is the record `a` of a later signing than the claim `c`?
    var ra = a.rev || 0, rc = c.rev || 0;
    return ra > rc || (ra === rc && time(a.signedAt) > time(c.signedAt));
  }
  // Same month, and the same address or the same name, but not known to be the same claim.
  function lookalike(a, c) {
    if (a.month !== c.month) return false;
    var e1 = String(a.staffEmail || '').toLowerCase(), e2 = String(c.staffEmail || '').toLowerCase();
    return (!!e1 && e1 === e2) || clean(a.staffName).toLowerCase() === clean(whoOf(c)).toLowerCase();
  }
  // What a list of decisions (the one on this page, unless another is given) holds about this claim.
  function related(c, list) {
    var out = { same: null, earlier: [], newer: null, look: [] };
    (list || S.approvals).forEach(function (a) {
      if (a.untrusted) return;
      var mine = !!a.series && !!c.series && a.series === c.series;
      // a later signing of this very claim has been decided on before, whichever way
      if (mine && a.fingerprint !== c.fingerprint && newerThan(a, c)) { if (!out.newer || time(a.decidedAt) > time(out.newer.decidedAt)) out.newer = a; return; }
      if (!live(a)) return;
      if (a.fingerprint && a.fingerprint === c.fingerprint) out.same = a;   // this very file
      else if (mine) out.earlier.push(a);
      else if (lookalike(a, c)) out.look.push(a);
    });
    return out;
  }
  // What a decision changes, worked out against a given list: the new record, and the standing
  // approvals it replaces or takes back. -> { put, kvSet, kvDel, result (the list afterwards), rec } or { fail }.
  function plan(pack, decision, approval, bytes, list, id) {
    var c = pack.payload.claim, now = new Date(), out = { put: [], kvSet: {}, kvDel: [] };
    // (a write that is tried again after a storage failure may find that an earlier try did get through)
    var there = id ? list.filter(function (a) { return a.id === id; })[0] : null;
    if (there) { out.result = list; out.rec = there; return out; }
    var rel = related(c, list);
    if (decision === 'approved' && (!pack.ok || rel.newer)) return { fail: { newer: !!rel.newer, refused: true } };
    var rec = {
      id: id || U.uid('a'), fingerprint: c.fingerprint, series: c.series || '', rev: c.rev || 0, signedAt: c.signedAt || '', ref: c.ref, formTitle: c.formTitle || '',
      staffName: whoOf(c), staffEmail: c.staffEmail, month: c.month,
      totalCents: c.totalCents, lineCount: c.lines.length, decision: decision, decidedAt: (approval && approval.at) || now.toISOString(),
      tzo: approval ? approval.tzo : Math.round(now.getTimezoneOffset()),
      approver: (approval && approval.name) || S.profile.name || '', note: (approval && approval.note) || pack.note || '',
      lines: c.lines.map(function (l) { return { date: l.date, desc: l.desc, from: l.from, to: l.to, type: l.type, amountCents: l.amountCents }; })
    };
    if (!pack.ok) rec.untrusted = true;
    else {
      var before = (rel.same ? [rel.same] : []).concat(rel.earlier);
      if (decision === 'approved') {
        // Replaced by this approval: the same file approved before, earlier versions of the same claim,
        // and any look-alike the approver has said this claim replaces. Their kept PDFs are let go.
        before = before.concat(rel.look.filter(function (a) { return pack.replaces[a.id] === true; }));
        before.forEach(function (a) { a.superseded = true; if (a.hasPdf) { delete a.hasPdf; out.kvDel.push('apdf:' + a.id); } });
        var prev = before.slice().sort(function (x, y) { return time(y.decidedAt) - time(x.decidedAt); })[0];
        if (prev) rec.replaces = { totalCents: prev.totalCents, decidedAt: prev.decidedAt, tzo: prev.tzo };
      } else {
        // Not approving a claim takes back any approval already given to it or to an earlier version
        // of it (and the approved PDF that was kept for it goes too).
        before.forEach(function (a) { a.withdrawn = true; if (a.hasPdf) { delete a.hasPdf; out.kvDel.push('apdf:' + a.id); } });
      }
      out.put = before;
    }
    if (decision === 'approved' && bytes) { rec.hasPdf = true; out.kvSet['apdf:' + rec.id] = bytes; }
    out.put = out.put.concat([rec]);
    out.result = list.concat([rec]);
    out.rec = rec;
    return out;
  }
  // After the list changed: a claim opened on this visit must not go on saying "approved" once its
  // approval no longer stands, and one still waiting may have become an older version of a claim
  // that has now been dealt with.
  function prunePacks() {
    S.pending.filter(function (p) {
      return !!p.result && !!p.recId && p !== S.review && !S.approvals.some(function (a) { return a.id === p.recId && live(a); });
    }).forEach(dropPack);
    S.pending.forEach(function (p) { if (!p.result && !p.returned && p.ok && !p.payload.approval) p.blocked = !!related(p.payload.claim).newer; });
  }
  // Write a change to the list. It is worked out against the stored list at the moment of writing
  // (Store.decide), so a decision made in another window a moment ago counts. If storage fails, the
  // change is still shown here, the page says it is not saving, and "Try again" writes it.
  // -> { ok, rec } or { refused, newer }.
  function commit(work) {
    var made = null;
    function run() {
      return Store.decide(function (stored) { made = work(stored); return made; }).then(function (list) { S.approvals = list; prunePacks(); return list; });
    }
    return run().then(function () { return { ok: true, rec: made.rec }; }, function (e) {
      if (e && e.refused) return { refused: true, newer: !!e.newer };
      var here = work(S.approvals);
      if (here.fail) return { refused: true, newer: !!here.fail.newer };
      S.approvals = here.result; prunePacks();
      App.storeFail(e); App.failedOp(run);
      return { ok: true, rec: here.rec };
    });
  }
  function record(pack, decision, approval, bytes) {
    keepData();
    var id = U.uid('a'); // one id for this decision, however often the write has to be tried
    return commit(function (list) { return plan(pack, decision, approval, bytes, list, id); }).then(function (r) { if (r.ok && r.rec) pack.recId = r.rec.id; return r; });
  }
  function withdraw(id) {
    return commit(function (list) {
      var a = list.filter(function (x) { return x.id === id; })[0], del = [];
      if (!a || !live(a)) return { put: [], result: list };
      a.withdrawn = true;
      if (a.hasPdf) { delete a.hasPdf; del.push('apdf:' + a.id); } // the approved PDF that was kept goes with it
      return { put: [a], kvDel: del, result: list };
    }).then(function () { App.render(); toast('Approval withdrawn. It is no longer counted or exported.'); });
  }
  function exportCsv(rows) {
    var head = ['Approved on', 'Approver', 'Staff', 'Staff email', 'Claim month', 'Ref', 'Item', 'Date', 'Description', 'Start', 'To', 'Type', 'Amount', 'Claim total', 'Check code', 'Replaces an earlier approval'];
    var out = [head.map(U.csvCell).join(',')];
    rows.forEach(function (r) {
      var rp = r.replaces ? '$' + U.money(r.replaces.totalCents) + ' approved ' + U.fmtStamp(r.replaces.decidedAt, false, r.replaces.tzo) : '';
      (r.lines || []).forEach(function (l, i) {
        out.push([U.fmtStamp(r.decidedAt, false, r.tzo), r.approver, r.staffName, r.staffEmail || '', r.month, r.ref || '', i + 1, l.date, l.desc, l.from, l.to,
          App.TYPE_LABEL[l.type] || '', U.money(l.amountCents).replace(/,/g, ''), U.money(r.totalCents).replace(/,/g, ''), U.shortPrint(r.fingerprint), rp].map(U.csvCell).join(','));
      });
    });
    UI.download(new Blob([String.fromCharCode(0xFEFF) + out.join('\r\n')], { type: 'text/csv' }), 'cetg-approved-claims' + (histMonth ? '-' + histMonth : '') + '.csv');
  }
  function historyPanel() {
    var all = S.approvals.slice().sort(function (a, b) { return time(b.decidedAt) - time(a.decidedAt); });
    if (!all.length) return null;
    var months = Object.create(null); all.forEach(function (r) { months[r.month] = true; });
    if (histMonth && !months[histMonth]) histMonth = '';
    var sel = h('select', { class: 'input auto', id: 'hist-month', 'aria-label': 'Show claim month' }, h('option', { value: '', text: 'All claim months' }));
    Object.keys(months).sort().reverse().forEach(function (m) { sel.appendChild(h('option', { value: m, text: U.monthLabel(m) })); });
    sel.value = histMonth;
    sel.addEventListener('change', function () { histMonth = sel.value; focusNext = '#hist-month'; App.render(); });
    var rows = all.filter(function (r) { return !histMonth || r.month === histMonth; });
    var current = rows.filter(live); // what counts: one standing approval per claim
    var total = current.reduce(function (s, r) { return s + r.totalCents; }, 0);
    function td(label, attrs) { attrs = attrs || {}; attrs.role = 'cell'; attrs.dataset = { th: label }; return h.apply(null, ['td', attrs].concat(Array.prototype.slice.call(arguments, 2))); }
    function th(text, cls) { return h('th', { class: cls || null, role: 'columnheader', scope: 'col', text: text }); }
    var tb = h('tbody', { role: 'rowgroup' });
    rows.forEach(function (r) {
      var kind = r.decision !== 'approved' ? ['warn', 'Not approved'] : r.withdrawn ? ['', 'Withdrawn'] : r.superseded ? ['', 'Replaced'] : ['approved', 'Approved'];
      var who = r.staffName + ', ' + U.monthLabel(r.month);
      var pdf = r.hasPdf && live(r) ? h('button', { type: 'button', class: 'link', text: 'PDF', 'aria-label': 'Download the approved PDF for ' + who, onclick: function () {
        Store.kvGet('apdf:' + r.id, null).then(function (bytes) {
          if (bytes) UI.download(new Uint8Array(bytes), pdfNameFor({ signedName: r.staffName, month: r.month }), 'application/pdf');
          else toast('That PDF is no longer kept on this device.', { bad: true });
        }, function () { toast('That PDF could not be read from this device.', { bad: true }); });
      } }) : null;
      var slot = h('span', null);
      if (live(r)) {
        slot.appendChild(h('button', { type: 'button', class: 'link danger', text: 'Withdraw', 'aria-label': 'Withdraw the approval for ' + who, onclick: function () {
          UI.confirmInline(slot, 'Withdraw this approval? It will no longer be counted or exported, and the approved PDF kept here is removed.', 'Withdraw', function () { withdraw(r.id); });
        } }));
      }
      tb.appendChild(h('tr', { class: live(r) || r.decision !== 'approved' ? null : 'old', role: 'row' },
        td('Decided', { text: U.fmtStamp(r.decidedAt, false, r.tzo) }), td('Staff', { text: r.staffName }), td('Claim month', { text: U.monthLabel(r.month, true) }),
        td('Items', { class: 'r', text: String(r.lineCount) }), td('Total', { class: 'r', text: '$' + U.money(r.totalCents) }),
        td('Decision', null, h('span', { class: 'pill ' + kind[0], text: kind[1] })), td('File', { class: 'acts' }, pdf, slot)));
    });
    return h('section', { class: 'panel', 'aria-label': 'Decisions made on this device' },
      h('div', { class: 'btn-row spread' },
        h('h2', { text: 'Your decisions' }),
        h('div', { class: 'btn-row' }, sel, h('button', { type: 'button', class: 'btn sm', id: 'btn-csv', disabled: !current.length, onclick: function () { exportCsv(current); } }, icon('download'), 'Download approved list (for Excel)'))),
      h('p', { class: 'small muted gap-top', id: 'hist-sum', text: plural(current.length, 'claim') + ' approved' + (histMonth ? ' for ' + U.monthLabel(histMonth) : '') + ', $' + U.money(total) + ' in total. A claim approved again after a change counts once. Kept on this device only.' }),
      App.scrollTab(h('div', { class: 'tablewrap gap-top', role: 'group', 'aria-label': 'Table of decisions' }, h('table', { class: 'hist', role: 'table' },
        h('thead', { role: 'rowgroup' }, h('tr', { role: 'row' }, th('Decided'), th('Staff'), th('Claim month'), th('Items', 'r'), th('Total', 'r'), th('Decision'), th('File'))), tb))));
  }

  /* ---------- list ---------- */
  function packRow(p) {
    var c = p.payload.claim, slot = h('span', null), open = !p.result && !p.returned && !p.blocked;
    slot.appendChild(h('button', { type: 'button', class: 'link danger', text: 'Remove', 'aria-label': 'Remove the claim of ' + whoOf(c) + ' from this list', onclick: function () { dropPack(p); App.render(); } }));
    return h('div', { class: 'rrow two' },
      h('div', { class: 'd' }, h('div', { class: 't1', text: whoOf(c) + '  ·  ' + U.monthLabel(c.month) }),
        h('div', { class: 't2', text: plural(c.lines.length, 'item') + '  ·  signed ' + (U.fmtStamp(c.signedAt, false, c.tzo) || '?') + (p.result ? '  ·  approved' : p.returned ? '  ·  not approved' : p.blocked ? '  ·  an older version: cannot be approved' : '') })),
      h('div', { class: 'a' }, h('b', { text: '$' + U.money(c.totalCents) }),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn sm' + (open ? ' primary' : ''), text: open ? 'Review' : 'Open', onclick: function () { S.review = p; focusNext = '#ap-top'; App.render(); window.scrollTo(0, 0); } }), slot)));
  }
  function listScreen($view) {
    $view.appendChild(h('section', { class: 'dropzone', 'aria-label': 'Open a claim' },
      h('h2', { id: 'ap-top', tabindex: '-1', text: 'Approve a claim' }),
      h('p', { text: 'Open the signed PDF a colleague sent you. Each item is shown beside its receipt. Tick the items, then approve with your signature, or write back to say what needs fixing.' }),
      h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn primary big', id: 'btn-open-pdf', onclick: function () { document.getElementById('pick-pdf').click(); } }, icon('file'), 'Open claim PDF')),
      h('p', { text: UI.isTouch() ? 'Save the PDF from the email or chat first, then pick it here.' : 'Or drag the PDF onto this page. You can open several at once.' })));
    var open = App.waiting(), rest = S.pending.filter(function (p) { return open.indexOf(p) === -1; });
    if (open.length) $view.appendChild(h('section', { class: 'section', id: 'ap-waiting' }, h('h2', { text: 'Waiting for you' }), h('div', { class: 'rlist' }, open.map(packRow))));
    if (rest.length) $view.appendChild(h('section', { class: 'section', id: 'ap-decided' }, h('h2', { text: 'Dealt with on this visit' }), h('div', { class: 'rlist' }, rest.map(packRow))));
    var hist = historyPanel();
    if (hist) $view.appendChild(hist);
  }

  /* ---------- review ---------- */
  function reviewScreen($view, pack) {
    var c = pack.payload.claim, who = whoOf(c), done = !!pack.result, prior = pack.payload.approval, n = c.lines.length;
    var rel = related(c), blocked = pack.ok && !!rel.newer && !done && !pack.returned, busy = false;
    pack.blocked = blocked; // (the list of opened claims uses this)
    // Nothing can be ticked or approved once a decision is made, or when the file cannot be trusted or checked.
    var locked = done || !!prior || pack.returned || !pack.ok || blocked;
    $view.appendChild(h('div', null, h('button', { type: 'button', class: 'btn sm', id: 'btn-all-claims', onclick: function () { S.review = null; focusNext = '#ap-top'; App.render(); } }, icon('left'), 'All claims')));

    // What happened, and what to do next, comes first: it is what the page opens on after a decision.
    if (done) $view.appendChild(donePanel(pack));
    else if (pack.returned) $view.appendChild(returnedPanel(pack));

    $view.appendChild(h('section', { class: 'panel' },
      h('div', { class: 'review-head' }, h('h2', { class: 'who', id: done || pack.returned ? null : 'ap-top', tabindex: '-1', text: who }), h('span', { class: 'muted', text: U.monthLabel(c.month) })),
      h('div', { class: 'kv' },
        h('span', null, 'Total ', h('b', { class: 'num', text: '$' + U.money(c.totalCents) })), h('span', null, h('b', { text: String(n) }), n === 1 ? ' item' : ' items'),
        h('span', null, 'Signed ', h('b', { text: U.fmtStamp(c.signedAt, true, c.tzo) || 'not signed' })), c.ref ? h('span', null, 'Ref ', h('b', { text: c.ref })) : null,
        h('span', null, 'Purpose ', h('b', { text: c.purpose || '-' })), c.staffEmail ? h('span', null, 'Email ', h('b', { text: c.staffEmail })) : null,
        // the heading the approved PDF will carry: part of what was signed, so it is shown here
        h('span', null, 'Form title ', h('b', { id: 'ap-form-title', text: c.formTitle || 'Staff Reimbursement Claim Form' }))),
      U.isPngDataUrl(c.signature) ? h('div', { class: 'sigsaved gap-top' }, h('div', { class: 'sigimg' }, h('img', { src: c.signature, alt: 'Signature of ' + who })), h('div', { class: 'small muted', text: 'Signature of ' + who })) : null));

    if (pack.ok) {
      $view.appendChild(h('div', { class: 'banner ok', id: 'ap-check' }, icon('check'), h('div', null,
        h('b', { text: 'The claim shown here matches its check code.' }), ' The items, amounts and receipt images are the ones ' + first(who) + ' signed (check code ' + U.shortPrint(c.fingerprint) + ').',
        h('div', { class: 'small muted', text: 'The check code cannot show who sent the file, so make sure it reached you from ' + first(who) + '. Decide from what is shown on this page: the pages of the PDF itself are not checked.' }))));
    } else if (pack.cannot) {
      $view.appendChild(h('div', { class: 'banner warn', role: 'alert', id: 'ap-check' }, icon('alert'), h('div', null, h('b', { text: 'This file cannot be checked here.' }),
        ' The form is not open from its secure (https) link, so this page cannot tell whether the claim still matches what ' + first(who) + ' signed. Open the form from its usual web link and open the PDF there.')));
    } else {
      $view.appendChild(h('div', { class: 'banner bad', role: 'alert', id: 'ap-check' }, icon('alert'), h('div', null, h('b', { text: 'Do not approve this file.' }),
        ' It does not match what was signed: ' + problemsOf(pack).join('; ') + '. Ask ' + first(who) + ' to send the PDF again.')));
    }
    function was(a) { return U.fmtStamp(a.decidedAt, false, a.tzo) + ' ($' + U.money(a.totalCents) + ')'; }
    if (prior) $view.appendChild(h('div', { class: 'banner ok' }, icon('check'), h('div', { text: 'This PDF is already approved' + (prior.name ? ' by ' + prior.name : '') + ' on ' + U.fmtStamp(prior.at, false, prior.tzo) + '.' })));
    else if (pack.ok && !done && !pack.returned) {
      // what the list of decisions already holds about this claim (only for a file that can be trusted)
      if (rel.newer) {
        var nw = rel.newer, how = live(nw) ? 'You approved a newer version on ' + was(nw) : nw.decision !== 'approved' ? 'You were sent a newer version and did not approve it (' + was(nw) + ')' : 'You approved a newer version on ' + was(nw) + ', an approval since ' + (nw.withdrawn ? 'withdrawn' : 'replaced');
        $view.appendChild(h('div', { class: 'banner bad', role: 'alert', id: 'ap-newer' }, icon('alert'), h('div', null, h('b', { text: 'This is an older version of a claim you have already dealt with.' }),
          ' ' + how + '. ' + first(who) + ' changed the claim after signing this file, so this one cannot be approved. Ask for the latest PDF if you do not have it.')));
      } else if (rel.same) $view.appendChild(h('div', { class: 'banner warn', id: 'ap-same' }, icon('alert'), h('div', { text: 'You already approved this same claim on ' + was(rel.same) + '. Approving it again replaces that entry in your list; not approving it now withdraws it.' })));
      else if (rel.earlier.length) $view.appendChild(h('div', { class: 'banner warn', id: 'ap-earlier' }, icon('alert'), h('div', { text: 'You approved an earlier version of this claim on ' + was(rel.earlier[0]) + '. Approving this one replaces it in your list, so the claim is counted once. Not approving this one withdraws that approval as well, because the earlier version no longer stands.' })));
      rel.look.forEach(function (a) {
        var box = h('input', { type: 'checkbox', checked: pack.replaces[a.id] === true, dataset: { replaces: a.id } });
        box.addEventListener('change', function () { pack.replaces[a.id] = box.checked; });
        $view.appendChild(h('div', { class: 'banner warn', dataset: { look: a.id } }, icon('alert'), h('div', null,
          h('b', { text: 'Your list already has an approved ' + U.monthLabel(a.month) + ' claim that looks like this one.' }),
          ' ' + a.staffName + (a.staffEmail ? ' (' + a.staffEmail + ')' : '') + ', approved ' + was(a) + '. If this file is a corrected version of that claim, tick the box so it is counted once. If it is a different claim, leave it.',
          h('label', { class: 'tick gap-top' }, box, h('span', { text: 'This claim replaces that one' })))));
      });
    }

    /* items: ticking updates the row in place, so a signature already drawn below is never wiped */
    var withReceipt = [], rows = [], paintOutcome = function () {};
    c.lines.forEach(function (l, i) { if (hasImage(pack, l.receiptId)) withReceipt.push(i); });
    function ticked() { return c.lines.filter(function (l, i) { return pack.checks[i]; }).length; }
    function paintRows() { rows.forEach(function (r) { r.paint(); }); paintOutcome(); }
    function openAt(i) {
      var items = withReceipt.map(function (li) {
        var l = c.lines[li];
        return { getUrl: function () { return packUrl(pack, l.receiptId); }, title: 'Receipt ' + U.pad2(li + 1), amount: '$' + U.money(l.amountCents),
          sub: [U.fmtDate(l.date), App.TYPE_LABEL[l.type] || '', l.desc, (l.from || l.to) ? (l.from || '-') + ' to ' + (l.to || '-') : ''].filter(Boolean).join('  ·  '), box: l.hl,
          verify: locked ? null : { get: function () { return !!pack.checks[li]; }, set: function (v) { pack.checks[li] = v; }, label: 'Item is correct', onLabel: 'Checked' } };
      });
      UI.viewer(items, Math.max(0, withReceipt.indexOf(i)), { onClose: paintRows });
    }
    var list = h('div', { class: 'rlist' });
    c.lines.forEach(function (l, i) {
      var has = withReceipt.indexOf(i) !== -1, thumb, no = U.pad2(i + 1);
      if (has) {
        var img = h('img', { alt: '' });
        packUrl(pack, l.receiptId).then(function (u) { if (u) img.src = u; });
        thumb = h('button', { type: 'button', class: 'thumb', 'aria-label': 'Open receipt ' + no, title: 'Open receipt', onclick: function () { openAt(i); } }, img, h('span', { class: 'zoom' }, icon('zoom', 'sm')));
      } else thumb = h('div', { class: 'thumb none', text: 'No receipt' });
      // the tick mark is only drawn once the item is ticked
      var mark = icon('check', 'sm'), label = h('span');
      var btn = locked ? null : h('button', { type: 'button', class: 'btn sm tickbtn', dataset: { check: String(i) }, onclick: function () { pack.checks[i] = !pack.checks[i]; paintRows(); } }, mark, label);
      var row = h('div', { class: 'rrow' },
        h('div', { class: 'n', text: no }), thumb,
        h('div', { class: 'd' }, h('div', { class: 't1', text: l.desc || '-' }),
          h('div', { class: 't2', text: [U.fmtDate(l.date) || 'No date', (l.from || l.to) ? (l.from || '-') + ' to ' + (l.to || '-') : '', App.TYPE_LABEL[l.type] || ''].filter(Boolean).join('  ·  ') })),
        h('div', { class: 'a' }, h('b', { text: '$' + U.money(l.amountCents) }), btn));
      rows.push({ paint: function () {
        var on = !!pack.checks[i] && !locked;
        row.classList.toggle('on', on);
        if (!btn) return;
        btn.classList.toggle('ok', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('aria-label', on ? 'Checked: item ' + no : 'Tick item ' + no);
        mark.style.display = on ? '' : 'none';
        label.textContent = on ? 'Checked' : 'Tick';
      } });
      list.appendChild(row);
    });
    var tickAllLabel = h('span'), tickAll = locked ? null : h('button', { type: 'button', class: 'btn sm', id: 'btn-tick-all', onclick: function () {
      var all = ticked() === n;
      c.lines.forEach(function (l, i) { pack.checks[i] = !all; });
      paintRows();
    } }, tickAllLabel);
    $view.appendChild(h('section', { class: 'section' },
      h('div', { class: 'btn-row spread' }, h('h2', { text: 'Items and receipts' }),
        locked ? null : h('div', { class: 'btn-row' },
          withReceipt.length ? h('button', { type: 'button', class: 'btn sm', id: 'btn-walk', onclick: function () { openAt(withReceipt[0]); } }, icon('image', 'sm'), 'Go through receipts') : null, tickAll)),
      list));

    /* outcome */
    paintRows();
    if (done || prior || pack.returned || pack.cannot || blocked) return;
    var panels = [], returnBtn = null;

    if (pack.ok) {
      // The name offered is this person's own (or the approver named in this copy's settings), never one read from the file.
      var name = h('input', { type: 'text', value: S.profile.name || S.team.approverName || '', maxlength: String(MAX.name), autocomplete: 'name', id: 'ap-name' });
      var noteA = h('input', { type: 'text', maxlength: '300', placeholder: 'Optional', id: 'ap-note' });
      var remember = h('input', { type: 'checkbox', checked: true });
      var err = UI.alertBox();
      var sig = App.signatureChooser(U.isPngDataUrl(S.profile.signature) ? S.profile.signature : '', function () { return clean(name.value, 60); }, { onChange: err.hide });
      var approveBtn = h('button', { type: 'button', class: 'btn ok big', id: 'btn-approve', 'aria-describedby': 'ap-hint' }, icon('check'), 'Approve and sign');
      var hintA = h('p', { class: 'small muted', id: 'ap-hint' });
      name.addEventListener('input', function () { sig.nameChanged(); });
      paintOutcome = function () {
        var t = ticked(), ready = t === n && !busy;
        // not switched off, so that it can still be reached and can say what is missing
        approveBtn.setAttribute('aria-disabled', ready ? 'false' : 'true');
        hintA.textContent = busy ? 'Making the approved PDF…' : t !== n ? 'Tick every item first (' + t + ' of ' + n + ' ticked).' : 'All ' + plural(n, 'item') + ' ticked.';
        tickAllLabel.textContent = t === n ? 'Untick all' : 'Tick all';
        if (returnBtn) returnBtn.disabled = busy; // one decision at a time
      };
      // A newer version of this claim was dealt with (in another window) while this one was open.
      var overtaken = function () {
        pack.result = null; pack.blocked = true; busy = false;
        focusNext = '#ap-top';
        App.render(); window.scrollTo(0, 0);
      };
      approveBtn.addEventListener('click', function () {
        if (busy) return;
        err.hide();
        if (ticked() !== n) {
          var next = list.querySelector('.tickbtn[aria-pressed="false"]');
          err.show('Tick every item first (' + ticked() + ' of ' + n + ' ticked). Tick an item once you have checked it against its receipt.', next);
          if (next) UI.scrollTo(next);
          return;
        }
        var nm = clean(name.value, MAX.name);
        if (!nm) return err.show('Enter your name.', name);
        if (related(c).newer) return overtaken();
        busy = true; paintOutcome();
        function stop(msg, el) { busy = false; paintOutcome(); err.show(msg, el); }
        sig.ready().then(function () {
          var s = sig.value();
          if (!s) return stop(sig.mode() === 'type' ? 'Type your name to sign.' : 'Draw your signature in the box, or choose “Type it instead”.');
          if (!U.isPngDataUrl(s)) return stop('That signature could not be used. Clear it and sign again, a little more simply.');
          if (S.broken) return stop('Changes are not being saved on this device right now, so the approval could not be kept. See the note at the top of the page.');
          if (!S.profile.name) S.profile.name = nm;
          if (remember.checked) S.profile.signature = s;
          App.saveProfile();
          var now = new Date();
          var approval = { decision: 'approved', name: nm, at: now.toISOString(), tzo: Math.round(now.getTimezoneOffset()), signature: s, note: clean(noteA.value, 300) };
          var recs = Object.create(null); Object.keys(pack.receipts).forEach(function (k) { recs[k] = { bytes: pack.receipts[k] }; });
          return UI.needPdfLib().then(function () {
            return ClaimPDF.build({ approverName: nm, claim: c, approval: approval, receipts: recs });
          }).then(function (bytes) {
            return record(pack, 'approved', approval, bytes).then(function (r) {
              if (!r.ok) return false; // refused at the last moment: nothing was recorded
              pack.result = { bytes: bytes, filename: pdfNameFor(c), approval: approval };
              return true;
            });
          }).then(function (went) {
            if (!went) return overtaken();
            focusNext = '#ap-top';
            App.render(); window.scrollTo(0, 0);
            UI.say('Approved. Now send the approved PDF back to ' + first(who) + '.'); // (the page now opens on exactly these words)
          }, function () { stop('The approved PDF could not be created. Check your connection, reload the page and try again.'); });
        }).catch(function (e) {
          if (window.console) console.warn(e);
          if (busy) stop('The approved PDF could not be created. Reload the page and try again.');
        });
      });
      panels.push(h('section', { class: 'panel section', id: 'ap-approve' }, h('h2', { text: 'Approve' }), hintA,
        h('div', { class: 'grid2' }, field('Your name', name), field('Note to add (optional)', noteA)),
        h('h3', { text: 'Your signature' }), sig.el, h('label', { class: 'tick' }, remember, h('span', { text: 'Remember my signature on this device' })), err,
        h('div', { class: 'btn-row' }, approveBtn)));
    }

    // Not approving: nothing is sent from here. The decision is noted, and an email is written for the approver to send.
    var noteR = h('textarea', { rows: '3', maxlength: '1000', placeholder: 'e.g. Item 02: the amount does not match the receipt.', id: 'ret-note' });
    noteR.value = pack.note || '';
    noteR.addEventListener('input', function () { pack.note = noteR.value; });
    var errR = UI.alertBox();
    returnBtn = h('button', { type: 'button', class: 'btn', id: 'btn-return' }, icon('undo'), 'Don’t approve – write to ' + first(who));
    returnBtn.addEventListener('click', function () {
      if (busy) return;
      if (!clean(noteR.value)) { errR.show('Say what needs fixing first.', noteR); return; }
      pack.note = noteR.value.trim().slice(0, 1000); pack.returned = true;
      busy = true; returnBtn.disabled = true; paintOutcome();
      record(pack, 'returned', null).then(function () {
        focusNext = '#ap-top';
        App.render(); window.scrollTo(0, 0);
        UI.say('Marked as not approved. Now let ' + first(who) + ' know what to fix.');
      });
    });
    panels.push(h('section', { class: 'panel section', id: 'ap-return' }, h('h2', { text: 'Not approving?' }),
      h('p', { class: 'small muted', text: 'Tell ' + first(who) + ' what to fix. They correct it, sign again and send you the new PDF.' }),
      field('What needs fixing', noteR), errR.watch(noteR), h('div', { class: 'btn-row' }, returnBtn)));
    $view.appendChild(h('div', { class: 'choice' }, panels));
    paintRows();
  }

  function approvedEmail(pack) {
    var c = pack.payload.claim, who = whoOf(c), ap = pack.result.approval;
    return { to: c.staffEmail || '', cc: S.team.financeEmail || '', subject: 'Approved - claim - ' + who + ' - ' + U.monthLabel(c.month) + ' - $' + U.money(c.totalCents),
      body: 'Hi ' + first(who) + ',\n\nYour transport and expense claim for ' + U.monthLabel(c.month) + ' ($' + U.money(c.totalCents) + ', ' + plural(c.lines.length, 'item') + ') is approved. The approved PDF is attached.\n'
        + (ap.note ? '\nNote: ' + ap.note + '\n' : '') + '\nTo close the month in your claim form, open ' + U.monthLabel(c.month) + ' and choose "Add approved PDF".\n\n' + ap.name };
  }
  function donePanel(pack) {
    var c = pack.payload.claim, who = whoOf(c), r = pack.result, mail = approvedEmail(pack);
    var shareable = UI.canShare(r.bytes, r.filename);
    return h('section', { class: 'panel section', id: 'ap-done' },
      h('div', { class: 'banner ok' }, icon('check'), h('div', null, h('b', { id: 'ap-top', tabindex: '-1', text: 'Approved. Now send the approved PDF back to ' + first(who) + '.' }),
        h('div', { class: 'small muted', text: r.filename + ' (' + Math.max(1, Math.round(r.bytes.length / 1024)) + ' KB)' }))),
      h('div', { class: 'btn-row' },
        shareable ? h('button', { type: 'button', class: 'btn' + (UI.isTouch() ? ' primary' : ''), onclick: function () { UI.share(r.bytes, r.filename, mail.subject, mail.body).catch(function (e) { if (e && e.name !== 'AbortError') toast('Sharing did not work here. Download the PDF instead.', { bad: true }); }); } }, icon('share'), 'Share the PDF') : null,
        h('button', { type: 'button', class: 'btn' + (shareable && UI.isTouch() ? '' : ' primary'), id: 'btn-dl-approved', onclick: function () { UI.download(r.bytes, r.filename, 'application/pdf'); } }, icon('download'), 'Download approved PDF')),
      h('h3', { text: 'Email it to ' + first(who) + (c.staffEmail ? ' (' + c.staffEmail + ')' : '') }), UI.emailButtons(mail),
      h('p', { class: 'hint', text: 'Attach the approved PDF before you send. ' + first(who) + ' adds it to their copy of the form to close the month. A copy stays in your list of decisions.' }),
      h('div', null, h('button', { type: 'button', class: 'btn', id: 'btn-next-claim', onclick: function () { dropPack(pack); focusNext = '#ap-top'; App.render(); window.scrollTo(0, 0); } }, 'Done, next claim')));
  }
  function returnedPanel(pack) {
    var c = pack.payload.claim, who = whoOf(c);
    var mail = { to: c.staffEmail || '', cc: '', subject: 'Please revise - claim - ' + who + ' - ' + U.monthLabel(c.month),
      body: 'Hi ' + first(who) + ',\n\nI have not approved your claim for ' + U.monthLabel(c.month) + ' ($' + U.money(c.totalCents) + ') yet. This needs fixing first:\n\n' + pack.note
        + '\n\nIn the claim form, open ' + U.monthLabel(c.month) + ', choose "Unlock to edit", correct it, then sign and send it again.\n\n' + (S.profile.name || S.team.approverName || '') };
    return h('section', { class: 'panel section', id: 'ap-returned' },
      h('div', { class: 'banner warn' }, icon('undo'), h('div', null, h('b', { id: 'ap-top', tabindex: '-1', text: 'Marked as not approved. Now let ' + first(who) + ' know what to fix.' }), h('div', { class: 'small pre', text: pack.note }))),
      UI.emailButtons(mail, { primary: true }),
      h('p', { class: 'hint', text: 'Nothing has been sent yet: the email is written for you to send.' }),
      h('div', null, h('button', { type: 'button', class: 'btn', id: 'btn-next-claim', onclick: function () { dropPack(pack); focusNext = '#ap-top'; App.render(); window.scrollTo(0, 0); } }, 'Done, next claim')));
  }

  App.renderApprove = function () {
    var $view = document.getElementById('view');
    U.clear($view);
    $banners = h('div', { class: 'banners' }, App.storageBanners(), App.tipBanners());
    $view.appendChild($banners);
    if (S.review && S.pending.indexOf(S.review) === -1) S.review = null;
    if (S.review) reviewScreen($view, S.review); else listScreen($view);
    if (focusNext) {
      var el = $view.querySelector(focusNext);
      focusNext = '';
      if (el) { try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    }
  };
  App.refreshApproveBanners = function () {
    if (!$banners || !document.contains($banners)) return;
    U.clear($banners); U.append($banners, [App.storageBanners(), App.tipBanners()]);
  };
  App.openPdfs = openPdfs;
  App.verifyPack = verify; // the staff side checks a PDF the same way before bringing a month back from it
})();
