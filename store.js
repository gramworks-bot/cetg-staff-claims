/* CETG claim form — on-device storage (IndexedDB, with an in-memory fallback).
 * Everything the form keeps lives in this browser on this device; nothing is sent to a server.
 * Writes that matter are guarded inside one transaction, so a second tab that is out of date can
 * never change a month that has been signed, nor write its old picture over a restored backup.
 */
(function () {
  'use strict';
  var DB_NAME = 'cetg-claims', DB_VER = 1, WAIT_MS = 8000;
  var STORES = { kv: 'k', lines: 'id', receipts: 'id', claims: 'month', approvals: 'id' };
  var db = null, mem = null, opening = null;
  // "born" is a random mark kept with the data. It is written when the database is first made and
  // again whenever everything is replaced (restore, erase). A page whose mark no longer matches the
  // stored one is looking at data that has since been cleared or replaced, and must reload.
  var born = null, wiped = false, replaced = false;
  var listeners = { change: [], late: [], lost: [], replaced: [], written: [] };
  var tabId = Math.random().toString(36).slice(2), channel = null, announceT = null;

  function emit(kind, arg) { listeners[kind].slice().forEach(function (fn) { try { fn(arg); } catch (e) { /* a listener must not break storage */ } }); }
  function isLockedStatus(s) { return s === 'signed' || s === 'sent' || s === 'approved'; }
  function err(props, msg) { var e = new Error(msg || 'Storage refused the change'); Object.keys(props).forEach(function (k) { e[k] = props[k]; }); return e; }
  function newMark() { return tabId + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  /* ---------- telling this person's other tabs that something changed ---------- */
  function hear() { emit('change'); }
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('cetg-claims');
      channel.onmessage = function (e) { if (e && e.data && e.data.from !== tabId) hear(); };
    } else {
      window.addEventListener('storage', function (e) { if (e.key === 'cetg-claims-rev') hear(); });
    }
  } catch (e) { channel = null; }
  function post() {
    try {
      if (channel) channel.postMessage({ from: tabId, at: Date.now() });
      else localStorage.setItem('cetg-claims-rev', tabId + ':' + Date.now());
    } catch (e) { /* other tabs simply are not told */ }
  }
  function announce(now) {
    if (mem) return;
    emit('written'); // this page's own listeners (the claims folder keeps its copy up to date)
    clearTimeout(announceT);
    if (now) post(); else announceT = setTimeout(post, 120); // "now" when the page is about to reload
  }

  /* ---------- opening ---------- */
  function useMemory() { mem = {}; Object.keys(STORES).forEach(function (s) { mem[s] = new Map(); }); }
  function attach(d) {
    db = d;
    function gone() { if (db === d) { db = null; opening = null; } try { d.close(); } catch (e) { /* already closed */ } }
    d.onversionchange = gone; // another tab is deleting or upgrading the database
    d.onclose = gone;         // the browser closed it under us (site data cleared, storage trouble)
  }
  function markChanged(stored) {
    if (!stored) { if (!wiped) { wiped = true; emit('lost'); } }
    else if (!replaced) { replaced = true; emit('replaced'); }
  }
  // On the first open the mark is read (or made). On a re-open it must still be the same.
  function checkBorn(d) {
    return new Promise(function (resolve) {
      var t, got;
      try { t = d.transaction('kv', 'readwrite'); } catch (e) { return resolve(); }
      var os = t.objectStore('kv'), r = os.get('born');
      r.onsuccess = function () {
        got = r.result && r.result.v;
        if (!got && born === null) { got = newMark(); os.put({ k: 'born', v: got }); }
      };
      t.oncomplete = function () {
        if (born === null) born = got || null;
        else if (born !== got) markChanged(got);
        resolve();
      };
      t.onabort = function () { resolve(); };
    });
  }
  function open() {
    if (db || mem) return Promise.resolve();
    if (opening) return opening;
    opening = new Promise(function (resolve) {
      var settled = false, req;
      function fallback() { if (settled) return; settled = true; useMemory(); resolve(); }
      try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { return fallback(); }
      var timer = setTimeout(fallback, WAIT_MS);
      req.onupgradeneeded = function () {
        var d = req.result;
        Object.keys(STORES).forEach(function (s) { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: STORES[s] }); });
      };
      req.onsuccess = function () {
        clearTimeout(timer);
        if (settled) { // we had given up waiting and are running without storage: say the saved data is there after all
          try { req.result.close(); } catch (e) { /* ignore */ }
          emit('late');
          return;
        }
        settled = true;
        var d = req.result;
        checkBorn(d).then(function () { attach(d); resolve(); });
      };
      req.onerror = function () { clearTimeout(timer); fallback(); };
      req.onblocked = function () { /* another tab holds an older version; the timer decides */ };
    });
    return opening;
  }
  // Errors that mean the connection itself has gone (Safari reports "Connection to Indexed Database
  // server lost" as an UnknownError after the app has been in the background).
  function lostConnection(e) {
    if (!e || e.locked || e.stale || e.gone || e.wiped || e.replaced) return false;
    return e.name === 'InvalidStateError' || e.name === 'TypeError' || e.name === 'TransactionInactiveError' || e.name === 'UnknownError' ||
      (e.name === 'AbortError' && /connection|server|clos/i.test(String(e.message || '')));
  }
  // Run fn against an open database; if the connection turns out to be dead, open again and try once more.
  function withDb(fn) {
    function attempt(again) {
      return open().then(function () {
        if (wiped) throw err({ wiped: true }, 'Saved data was cleared');
        if (replaced) throw err({ replaced: true }, 'Saved data was replaced');
        return fn();
      }).catch(function (e) {
        if (again && !mem && lostConnection(e)) { var d = db; db = null; opening = null; try { if (d) d.close(); } catch (x) { /* ignore */ } return attempt(false); }
        throw e;
      });
    }
    return attempt(true);
  }

  /* ---------- one request ---------- */
  function run(store, mode, fn) {
    return withDb(function () {
      if (mem) return fn(null, mem[store]);
      return new Promise(function (resolve, reject) {
        var tx, out;
        try { tx = db.transaction(store, mode); } catch (e) { return reject(e); }
        var req = fn(tx.objectStore(store), null);
        if (req) req.onsuccess = function () { out = req.result; };
        // Writes are committed straight away so a tab closed right after a tick still keeps it.
        if (mode === 'readwrite' && tx.commit) { try { tx.commit(); } catch (e) { /* commits on its own */ } }
        tx.oncomplete = function () { if (mode === 'readwrite') announce(); resolve(out); };
        tx.onerror = function () { /* reported by onabort */ };
        tx.onabort = function () { reject(tx.error || new Error('Storage error')); };
      });
    });
  }

  /* ---------- several steps that succeed or fail together ----------
   * work(t) queues reads and writes: t.get(store, key, cb), t.all(store, cb), t.put, t.del, t.clear,
   * t.fail(error) to undo everything, t.result(value) for what the promise resolves to.
   * Unless o.replacing is set, the step first checks that the stored data is still the data this
   * page loaded (see "born"), and is refused with {replaced:true} or {wiped:true} when it is not. */
  function copy(v) { // structured-clone-ish copy for the memory fallback
    if (v == null || typeof v !== 'object') return v;
    if (v instanceof ArrayBuffer) return v.slice(0);
    if (ArrayBuffer.isView(v)) return new v.constructor(v);
    if (Array.isArray(v)) return v.map(copy);
    var o = {};
    Object.keys(v).forEach(function (k) { o[k] = copy(v[k]); });
    return o;
  }
  function txn(names, work, o) {
    o = o || {};
    return withDb(function () {
      var dead = false, reason = null, result;
      if (mem) {
        var snap = {};
        names.forEach(function (n) { snap[n] = new Map(mem[n]); });
        var m = {
          get: function (s, k, cb) { if (!dead) cb(copy(mem[s].get(k))); },
          all: function (s, cb) { if (!dead) cb(Array.from(mem[s].values()).map(copy)); },
          sync: true,
          put: function (s, v) { if (!dead) mem[s].set(v[STORES[s]], copy(v)); },
          del: function (s, k) { if (!dead) mem[s].delete(k); },
          clear: function (s) { if (!dead) mem[s].clear(); },
          fail: function (why) { dead = true; reason = why; },
          result: function (v) { result = v; }
        };
        try { work(m); } catch (e) { dead = true; reason = e; }
        if (dead) { names.forEach(function (n) { mem[n] = snap[n]; }); return Promise.reject(reason || new Error('Storage aborted')); }
        return Promise.resolve(result);
      }
      return new Promise(function (resolve, reject) {
        var t, scope = names.indexOf('kv') === -1 ? names.concat(['kv']) : names;
        try {
          // "strict" asks the browser to put the change on disk before reporting success (signatures, approvals)
          try { t = o.strict ? db.transaction(scope, 'readwrite', { durability: 'strict' }) : db.transaction(scope, 'readwrite'); }
          catch (e1) { if (!o.strict) throw e1; t = db.transaction(scope, 'readwrite'); }
        } catch (e) { return reject(e); }
        function stop(why) { if (dead) return; dead = true; reason = why; try { t.abort(); } catch (e) { /* already finished */ } }
        function guard(cb) { return function (ev) { if (dead) return; try { cb(ev.target.result); } catch (e) { stop(e); } }; }
        var api = {
          get: function (s, k, cb) { if (!dead) t.objectStore(s).get(k).onsuccess = guard(cb); },
          all: function (s, cb) { if (!dead) t.objectStore(s).getAll().onsuccess = guard(cb); },
          sync: false,
          put: function (s, v, then) { if (dead) return; var r = t.objectStore(s).put(v); if (then) r.onsuccess = guard(then); },
          del: function (s, k) { if (!dead) t.objectStore(s).delete(k); },
          clear: function (s) { if (!dead) t.objectStore(s).clear(); },
          fail: stop,
          result: function (v) { result = v; }
        };
        t.oncomplete = function () { announce(o.replacing); resolve(result); };
        t.onerror = function () { /* reported by onabort */ };
        t.onabort = function () { reject(reason || t.error || new Error('Storage aborted')); };
        if (!o.replacing) {
          api.get('kv', 'born', function (rec) {
            var stored = rec && rec.v;
            if (born !== null && stored !== born) { markChanged(stored); stop(err(stored ? { replaced: true } : { wiped: true }, 'Saved data changed underneath this page')); }
          });
        }
        try { work(api); } catch (e) { stop(e); }
      });
    });
  }

  // A window that is not the one reading a receipt may still hold "being read" for it, while storage
  // already has the finished read from another window. When such a window saves the line, the
  // finished read wins: its result is kept, and so are the amount, date, type and month it filled
  // in, wherever the copy being saved still has nothing of its own there. True when `line` was changed.
  function mergeRead(line, prev) {
    var mine = line && line.ocr ? line.ocr.state : '', theirs = prev && prev.ocr ? prev.ocr.state : '';
    if (!prev || (prev.receiptId || '') !== (line.receiptId || '') || (mine !== 'pending' && mine !== 'running') || (theirs !== 'done' && theirs !== 'failed')) return false;
    line.ocr = prev.ocr;
    if (line.amountCents == null && prev.amountCents != null) line.amountCents = prev.amountCents;
    if (!line.date && prev.date) line.date = prev.date;
    if (!line.typeTouched && prev.type) line.type = prev.type;
    if (!line.monthTouched && prev.month && prev.month !== line.month) line.month = prev.month;
    return true;
  }

  var Store = {
    open: open,
    isMemoryOnly: function () { return !!mem; },
    isWiped: function () { return wiped; },
    isReplaced: function () { return replaced; },
    get: function (store, key) { return run(store, 'readonly', function (os, m) { return m ? copy(m.get(key)) : os.get(key); }); },
    all: function (store) { return run(store, 'readonly', function (os, m) { return m ? Array.from(m.values()).map(copy) : os.getAll(); }); },
    keys: function (store) { return run(store, 'readonly', function (os, m) { return m ? Array.from(m.keys()) : os.getAllKeys(); }); },
    put: function (store, value) { return run(store, 'readwrite', function (os, m) { if (m) { m.set(value[STORES[store]], copy(value)); return undefined; } os.put(value); return null; }); },
    del: function (store, key) { return run(store, 'readwrite', function (os, m) { if (m) { m.delete(key); return undefined; } os.delete(key); return null; }); },
    clear: function (store) { return run(store, 'readwrite', function (os, m) { if (m) { m.clear(); return undefined; } os.clear(); return null; }); },
    kvGet: function (key, dflt) { return Store.get('kv', key).then(function (r) { return r && r.v !== undefined ? r.v : dflt; }); },
    kvSet: function (key, v) { return Store.put('kv', { k: key, v: v }); },
    storeNames: function () { return Object.keys(STORES); },
    // Has another tab replaced or cleared everything since this page loaded? (Asked before re-reading.)
    epochChanged: function () {
      if (mem) return Promise.resolve(false);
      if (wiped || replaced) return Promise.resolve(true);
      return run('kv', 'readonly', function (os) { return os.get('born'); }).then(function (rec) {
        var stored = rec && rec.v;
        if (born !== null && stored !== born) { markChanged(stored); return true; }
        return false;
      }, function () { return wiped || replaced; });
    },

    /* ----- guarded writes ----- */
    // Save one claim line. Refused ({locked:true}) when the month it is in, or the month it would
    // leave, has been signed: by then the line is part of what was signed.
    // Unless o.mine says this window is itself reading the line's receipt, a read that another window
    // has finished in the meantime is kept (see mergeRead); the line object is brought up to date in
    // place, and the promise resolves to true when that happened.
    putLine: function (line, o) {
      o = o || {};
      return txn(['lines', 'claims'], function (t) {
        function check(month, then) { t.get('claims', month, function (c) { if (c && isLockedStatus(c.status)) return t.fail(err({ locked: true, month: month })); if (then) then(); }); }
        t.get('lines', line.id, function (prev) {
          var from = prev ? prev.month : null, merged = !o.mine && mergeRead(line, prev);
          function write() { t.put('lines', line); t.result(merged); }
          if (from && from !== line.month) check(from, function () { check(line.month, write); });
          else check(line.month, write);
        });
      });
    },
    // Change the stored copy of a line in place: change(line) is given what is in storage right now
    // (which may hold details typed in another tab) and alters it. Resolves to the line as stored.
    // {gone:true} when the line no longer exists, {locked:true} when its month has been signed.
    patchLine: function (id, change) {
      return txn(['lines', 'claims'], function (t) {
        t.get('lines', id, function (line) {
          if (!line) return t.fail(err({ gone: true }));
          var from = line.month;
          change(line);
          var months = line.month === from ? [from] : [from, line.month], left = months.length;
          months.forEach(function (m) {
            t.get('claims', m, function (c) {
              if (c && isLockedStatus(c.status)) return t.fail(err({ locked: true, month: m }));
              if (--left === 0) { t.put('lines', line); t.result(line); }
            });
          });
        });
      });
    },
    // Remove a line and its receipt image, unless its month has been signed.
    delLine: function (id) {
      return txn(['lines', 'claims', 'receipts'], function (t) {
        t.get('lines', id, function (line) {
          if (!line) return;
          t.get('claims', line.month, function (c) {
            if (c && isLockedStatus(c.status)) return t.fail(err({ locked: true, month: line.month }));
            t.del('lines', id);
            if (line.receiptId) t.del('receipts', line.receiptId);
          });
        });
      });
    },
    // Sign a month: its lines and the signed claim are written together, and only if nobody (another
    // tab) has signed the month or added a line to it in the meantime ({stale:true} otherwise).
    signClaim: function (claim, lines) {
      return txn(['lines', 'claims'], function (t) {
        var ids = {};
        lines.forEach(function (l) { ids[l.id] = true; });
        t.get('claims', claim.month, function (c) { if (c && isLockedStatus(c.status)) t.fail(err({ stale: true })); });
        t.all('lines', function (stored) {
          var extra = stored.some(function (l) { return l.month === claim.month && ids[l.id] !== true; });
          if (extra) return t.fail(err({ stale: true }));
          lines.forEach(function (l) { t.put('lines', l); });
          t.put('claims', claim);
        });
      }, { strict: true });
    },
    // Change a claim's state. `expect` lists the states this tab believes it is in now, and o.fp the
    // fingerprint it believes the stored claim has; if either differs, a different tab got there
    // first ({stale:true}). o.kvSet {key: value} and o.kvDel [keys] are written in the same step.
    setClaim: function (claim, expect, o) {
      o = o || {};
      return txn(['claims', 'kv'], function (t) {
        t.get('claims', claim.month, function (c) {
          var st = (c && c.status) || 'draft';
          if (expect && expect.indexOf(st) === -1) return t.fail(err({ stale: true }));
          if (typeof o.fp === 'string' && ((c && c.fingerprint) || '') !== o.fp) return t.fail(err({ stale: true }));
          t.put('claims', claim);
          Object.keys(o.kvSet || {}).forEach(function (k) { t.put('kv', { k: k, v: o.kvSet[k] }); });
          (o.kvDel || []).forEach(function (k) { t.del('kv', k); });
        });
      }, { strict: true });
    },
    // An approver's decision. work(stored) is handed the stored list of decisions as it is at that
    // very moment and returns what to write: { put: [records], kvSet: {key: value}, kvDel: [keys],
    // result }, or { fail: {...} } to change nothing. Deciding from the stored list, not from what a
    // window remembers, is what keeps two windows from both approving the same claim; everything is
    // written together or not at all, and the promise resolves to `result`.
    decide: function (work) {
      return txn(['approvals', 'kv'], function (t) {
        t.all('approvals', function (stored) {
          var plan = work(stored) || { fail: { stale: true } };
          if (plan.fail) return t.fail(err(plan.fail, 'The decision was not recorded'));
          (plan.put || []).forEach(function (r) { t.put('approvals', r); });
          Object.keys(plan.kvSet || {}).forEach(function (k) { t.put('kv', { k: k, v: plan.kvSet[k] }); });
          (plan.kvDel || []).forEach(function (k) { t.del('kv', k); });
          t.result(plan.result);
        });
      }, { strict: true });
    },
    // Restore a backup: everything is replaced in one step, or nothing is. The data gets a new mark,
    // so any other tab still holding the old picture is refused when it next tries to save.
    // data: { lines, claims, approvals, kv, receiptCount, receiptAt(i) }.
    replaceAll: function (data) {
      var names = Object.keys(STORES), mark = newMark();
      return txn(names, function (t) {
        names.forEach(function (n) { t.clear(n); });
        ['lines', 'claims', 'approvals', 'kv'].forEach(function (n) { (data[n] || []).forEach(function (v) { t.put(n, v); }); });
        t.put('kv', { k: 'born', v: mark });
        // Receipt images are unpacked and written one after another, so a big backup never sits in
        // memory twice over.
        var n = data.receiptCount || 0, i = 0;
        if (t.sync) { for (; i < n; i++) t.put('receipts', data.receiptAt(i)); }
        else { (function next() { if (i < n) t.put('receipts', data.receiptAt(i++), next); })(); }
      }, { replacing: true, strict: true }).then(function () { born = mark; });
    },
    eraseAll: function () {
      var names = Object.keys(STORES), mark = newMark();
      return txn(names, function (t) { names.forEach(function (n) { t.clear(n); }); t.put('kv', { k: 'born', v: mark }); }, { replacing: true, strict: true }).then(function () { born = mark; });
    },

    mergeRead: mergeRead,
    on: function (kind, fn) { if (listeners[kind]) listeners[kind].push(fn); },
    // Ask the browser not to clear this site's data when storage runs low.
    persist: function () {
      try {
        if (navigator.storage && navigator.storage.persist) return navigator.storage.persist().catch(function () { return false; });
      } catch (e) { /* not supported */ }
      return Promise.resolve(false);
    },
    persisted: function () {
      try {
        if (navigator.storage && navigator.storage.persisted) return navigator.storage.persisted().catch(function () { return false; });
      } catch (e) { /* not supported */ }
      return Promise.resolve(false);
    },
    // How much this site is storing, in bytes (null when the browser will not say).
    usage: function () {
      try {
        if (navigator.storage && navigator.storage.estimate) return navigator.storage.estimate().then(function (e) { return e && typeof e.usage === 'number' ? e.usage : null; }, function () { return null; });
      } catch (e) { /* not supported */ }
      return Promise.resolve(null);
    }
  };
  window.Store = Store;
})();
