/* CETG claim form — reading receipts on the device.
 * Loads the Tesseract OCR engine from this site's own files (no third-party requests),
 * runs it in a background worker, and hands the words to ReceiptParse.
 */
(function () {
  'use strict';
  var VENDOR = './'; // the reader's files sit beside the page (tesseract.min.js, worker.min.js, the engine builds, eng.traineddata.gz)
  var READER_VERSION = 'tesseract-7.0.0';
  var worker = null, starting = null, idleTimer = null, chain = Promise.resolve();
  var onProgress = null, scriptLoaded = null;

  var scriptTries = 0, scriptEl = null;
  function loadScript(src) {
    if (scriptLoaded) return scriptLoaded;
    scriptLoaded = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      // a later try asks under a slightly different address, so the browser cannot tie it to a first request that is still hanging
      s.src = src + (scriptTries ? '?try=' + scriptTries : ''); s.async = true;
      scriptTries++; scriptEl = s;
      s.onload = function () { resolve(); };
      s.onerror = function () { scriptLoaded = null; if (s.parentNode) s.parentNode.removeChild(s); reject(new Error('Could not load the receipt reader')); };
      document.head.appendChild(s);
    });
    return scriptLoaded;
  }

  function start() {
    if (worker) return Promise.resolve(worker);
    if (starting) return starting;
    var base = new URL(VENDOR, document.baseURI).href;
    starting = loadScript(base + 'tesseract.min.js').then(function () {
      return window.Tesseract.createWorker('eng', 1, {
        workerPath: base + 'worker.min.js',
        corePath: base,
        langPath: base,
        workerBlobURL: false,
        gzip: true,
        cachePath: 'cetg-' + READER_VERSION, // the reader keeps its language data in the browser under this name; a new version gets a new name
        logger: function (m) {
          if (!onProgress || !m) return;
          var p = typeof m.progress === 'number' ? m.progress : 0;
          if (m.status === 'recognizing text') onProgress(0.3 + 0.7 * p, 'Reading');
          else onProgress(Math.min(0.3, 0.3 * p), 'Getting the reader ready');
        },
        errorHandler: function () { /* surfaced through the rejected promise */ }
      });
    }).then(function (w) {
      // debug_file keeps the engine's own chatter out of the browser console
      return w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300', debug_file: '/dev/null' }).then(function () { worker = w; starting = null; return w; });
    }).catch(function (e) { starting = null; throw e; });
    return starting;
  }

  function stopSoon() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (worker) { var w = worker; worker = null; try { w.terminate(); } catch (e) { /* ignore */ } }
    }, 90000);
  }

  // Greyscale copy sized for OCR: small screenshots are enlarged (they read far better), big photos reduced.
  function prepare(img, w, h) {
    var long = Math.max(w, h), short = Math.min(w, h);
    // about 2000px on the long side (a long scrolling screenshot may run to 4096px so its text stays
    // readable), and never more than ~3 megapixels, which is kind to phone memory
    var cap = long / short > 2.6 ? 4096 : 2000;
    var scale = Math.max(0.1, Math.min(4, cap / long, Math.sqrt(3.2e6 / (w * h))));
    var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    var c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cw, ch);
    try {
      var d = ctx.getImageData(0, 0, cw, ch), p = d.data;
      for (var i = 0; i < p.length; i += 4) {
        var y = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
        p[i] = p[i + 1] = p[i + 2] = y;
      }
      ctx.putImageData(d, 0, 0);
    } catch (e) { /* leave in colour */ }
    return c;
  }

  function recognise(canvas, psm) {
    return start().then(function (w) {
      return w.setParameters({ tessedit_pageseg_mode: String(psm) }).then(function () {
        return w.recognize(canvas, { rotateAuto: true }, { text: true, blocks: true });
      });
    }).then(function (res) {
      var data = res.data || {}, lines = [];
      (data.blocks || []).forEach(function (b) {
        (b.paragraphs || []).forEach(function (p) {
          (p.lines || []).forEach(function (l) {
            lines.push({ text: l.text, conf: l.confidence, bbox: l.bbox, words: (l.words || []).map(function (x) { return { text: x.text, conf: x.confidence, bbox: x.bbox }; }) });
          });
        });
      });
      return { w: canvas.width, h: canvas.height, lines: lines, conf: data.confidence };
    });
  }

  // If the reader shows no sign of life for this long (its files neither arrive nor fail, or the
  // worker has died), the read is given up as failed so that the person can type the details instead.
  var STALL_MS = 180000;
  function watched(start) {
    return new Promise(function (resolve, reject) {
      var over = false, timer = null;
      function alive() {
        if (over) return;
        clearTimeout(timer);
        timer = setTimeout(function () {
          if (over) return;
          over = true;
          var w = worker; worker = null; starting = null;
          if (!window.Tesseract) { // the reader's own script never arrived: ask for it afresh next time
            scriptLoaded = null;
            if (scriptEl && scriptEl.parentNode) scriptEl.parentNode.removeChild(scriptEl);
          }
          try { if (w) w.terminate(); } catch (e) { /* ignore */ }
          reject(new Error('The receipt reader stopped responding'));
        }, STALL_MS);
      }
      alive();
      start(alive).then(function (v) { if (over) return; over = true; clearTimeout(timer); resolve(v); },
        function (e) { if (over) return; over = true; clearTimeout(timer); reject(e); });
    });
  }

  // Read one receipt image. Jobs run one at a time, and each image is only opened when its turn
  // comes (load() resolves {img, w, h, done}), so a batch of photos doesn't sit in memory.
  function read(load, todayIso, progress) {
    var job = chain.then(function () {
      clearTimeout(idleTimer);
      return load();
    }).then(function (src) {
      var canvas;
      try { canvas = prepare(src.img, src.w, src.h); } finally { if (src.done) src.done(); }
      function release() { try { canvas.width = 0; canvas.height = 0; } catch (e) { /* ignore */ } } // phones keep a small budget for canvas memory
      return watched(function (alive) {
      onProgress = function (p, label) { alive(); if (progress) progress(p, label); }; // every sign of progress resets the wait
      // First read the receipt as one block of text (label on the left, amount on the right).
      return recognise(canvas, 6).then(function (ocr) {
        alive();
        var parsed = window.ReceiptParse.parseReceipt(ocr, todayIso);
        if (parsed.amountConf === 'high') return parsed;
        // No clear total: read it again as scattered text and keep whichever reading is surer.
        return recognise(canvas, 11).then(function (ocr2) {
          var p2 = window.ReceiptParse.parseReceipt(ocr2, todayIso);
          var rank = { high: 3, medium: 2, low: 1, none: 0 };
          var best = (rank[p2.amountConf] || 0) > (rank[parsed.amountConf] || 0) ? p2 : parsed;
          var other = best === p2 ? parsed : p2;
          if (!best.date && other.date) { best.date = other.date; best.dateConf = other.dateConf; best.dates = other.dates; }
          if (best.type === 'other' && other.type !== 'other') best.type = other.type;
          if (!best.hintTo && other.hintTo) best.hintTo = other.hintTo;
          if (!best.foreign && other.foreign) best.foreign = other.foreign;
          return best;
        }, function () { return parsed; });
      });
      }).then(function (res) { release(); return res; }, function (e) { release(); throw e; });
    });
    chain = job.then(function () { onProgress = null; stopSoon(); }, function () { onProgress = null; stopSoon(); });
    return job;
  }

  window.OCR = { read: read, warm: function () { return start().then(function () { stopSoon(); }); }, _prepare: prepare, _recognise: recognise,
    _stall: function (ms) { STALL_MS = ms; } }; // (for the tests: how long to wait for a sign of life)
})();
