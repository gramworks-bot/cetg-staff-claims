/* CETG claim form — PDF receipts.
 * A PDF receipt is drawn on the device with pdf.js (loaded from this site's own files when first
 * needed) and each page becomes a receipt image. When the PDF carries its own text, that text is
 * handed to ReceiptParse in the same shape as the OCR reader's words, so the amount and date come
 * straight from the file; a scanned PDF (a picture of a receipt) is read by OCR like any screenshot.
 */
(function () {
  'use strict';
  var VENDOR = './'; // pdfjs-load.js, pdfjs.min.js, pdfjs.worker.min.js and the image decoders (*.wasm) sit beside the page
  var ATTACH_NAME = 'cetg-claim.json'; // the data file inside a claim PDF made by this form
  var MAX_BYTES = 40 * 1024 * 1024;
  var loading = null, worker = null, idleTimer = null;

  // Module scripts are the one thing the renderer needs that old browsers lack (and they lack the OCR engine too).
  function supported() {
    try { return 'noModule' in HTMLScriptElement.prototype && typeof Worker === 'function' && typeof Uint8Array === 'function'; } catch (e) { return false; }
  }
  function base() { return new URL(VENDOR, document.baseURI).href; }

  function load() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (loading) return loading;
    if (!supported()) return Promise.reject(new Error('This browser cannot read PDF receipts'));
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script'), over = false;
      function fail(msg, kind) {
        if (over) return;
        over = true; loading = null;
        if (s.parentNode) s.parentNode.removeChild(s);
        var e = new Error(msg || 'Could not load the PDF reader');
        if (kind) e.kind = kind;
        reject(e);
      }
      var timer = setTimeout(function () { fail('The PDF reader took too long to load'); }, 120000);
      s.type = 'module'; s.async = true; s.src = base() + 'pdfjs-load.js';
      s.onload = function () {
        clearTimeout(timer);
        if (over) return;
        var lib = window.pdfjsLib;
        // the file arrived but did not run: a browser too old for the renderer
        if (!lib || !lib.getDocument) return fail('This browser cannot run the PDF reader', 'unsupported');
        over = true;
        lib.GlobalWorkerOptions.workerSrc = base() + 'pdfjs.worker.min.js';
        resolve(lib);
      };
      // a page opened as a file on the computer may not load module scripts at all
      s.onerror = function () { clearTimeout(timer); fail('', location.protocol === 'file:' ? 'file' : ''); };
      document.head.appendChild(s);
    });
    return loading;
  }

  // One background worker, shared by the PDFs opened in a sitting and put away after a quiet spell.
  function getWorker(lib) {
    clearTimeout(idleTimer);
    if (!worker) worker = new lib.PDFWorker({ name: 'cetg-pdf' });
    return worker;
  }
  function restSoon() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      var w = worker; worker = null;
      if (w) { try { w.destroy(); } catch (e) { /* ignore */ } }
    }, 90000);
  }

  function fileBytes(file) {
    if (file instanceof Uint8Array) return Promise.resolve(file);
    if (file instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(file));
    if (file.arrayBuffer) return file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (resolve, reject) { var fr = new FileReader(); fr.onload = function () { resolve(new Uint8Array(fr.result)); }; fr.onerror = function () { reject(fr.error); }; fr.readAsArrayBuffer(file); });
  }

  // The page's own text, in the shape of the OCR reader's result (lines of words with boxes, in the
  // pixels of the drawn page), so ReceiptParse can treat both the same way.
  function textOf(lib, page, vp) {
    return page.getTextContent({ includeMarkedContent: false }).then(function (tc) {
      var lines = [], chars = 0, digits = 0;
      (tc.items || []).forEach(function (it) {
        var str = it.str || '';
        if (!str.trim() || !it.transform) return;
        var t = lib.Util.transform(vp.transform, it.transform);
        var fontH = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 10;
        var x = t[4], baseline = t[5], wpx = Math.abs((it.width || 0) * vp.scale);
        if (!(wpx > 0)) wpx = str.length * fontH * 0.5;
        var per = wpx / Math.max(1, str.length), words = [], pos = 0;
        str.split(/(\s+)/).forEach(function (part) {
          if (part && /\S/.test(part)) {
            words.push({ text: part, conf: 100, bbox: { x0: x + pos * per, x1: x + (pos + part.length) * per, y0: baseline - fontH * 0.8, y1: baseline + fontH * 0.2 } });
            chars += part.replace(/[^A-Za-z0-9]/g, '').length;
            digits += part.replace(/\D/g, '').length;
          }
          pos += part.length;
        });
        if (words.length) lines.push({ text: str, conf: 100, bbox: { x0: x, x1: x + wpx, y0: baseline - fontH * 0.8, y1: baseline + fontH * 0.2 }, words: words });
      });
      return { w: Math.round(vp.width), h: Math.round(vp.height), lines: lines, conf: 100, chars: chars, digits: digits };
    });
  }

  // Draw page n with its long side `longSide` pixels across. Resolves {img, w, h, done, text}: img is a
  // canvas (done() frees it); text() resolves the page's own words, or null when it has none to speak of.
  function renderPage(lib, doc, n, longSide) {
    return doc.getPage(n).then(function (page) {
      var vp1 = page.getViewport({ scale: 1 });
      var long = Math.max(1, Math.max(vp1.width, vp1.height)), short = Math.max(1, Math.min(vp1.width, vp1.height));
      var scale = (longSide || 1800) / long;
      // a till-roll page (long and narrow) is drawn wide enough to read, as the receipt images are kept
      if (long / short > 2.6) scale = Math.max(scale, Math.min(900 / short, Math.sqrt(4e6 / (vp1.width * vp1.height))));
      scale = Math.max(0.2, Math.min(8, scale));
      var vp = page.getViewport({ scale: scale });
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
      var ctx = c.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      var task = page.render({ canvasContext: ctx, viewport: vp, background: 'rgb(255,255,255)' });
      return task.promise.then(function () {
        var textP = null;
        return {
          img: c, w: c.width, h: c.height,
          done: function () { try { c.width = 0; c.height = 0; } catch (e) { /* ignore */ } },
          text: function () {
            if (!textP) textP = textOf(lib, page, vp).then(function (shape) { return shape.chars >= 20 ? shape : null; }, function () { return null; });
            return textP;
          },
          release: function () { try { page.cleanup(); } catch (e) { /* ignore */ } }
        };
      }, function (e) {
        try { c.width = 0; c.height = 0; } catch (x) { /* ignore */ }
        throw e;
      });
    });
  }

  // Is a file of this name attached to the PDF? (pdf.js hands the attachments back as a Map, older builds as a plain object.)
  function hasAttachment(att, name) {
    var found = false;
    function look(k, v) { if (k === name || (v && v.filename === name)) found = true; }
    if (!att) return false;
    if (typeof att.forEach === 'function' && typeof att.get === 'function') att.forEach(function (v, k) { look(k, v); });
    else Object.keys(att).forEach(function (k) { look(k, att[k]); });
    return found;
  }

  function kindOf(e) {
    var name = (e && e.name) || '';
    if (/Password/.test(name)) return 'locked';
    if (/InvalidPDF|MissingPDF|Format/.test(name)) return 'notpdf';
    return 'error';
  }

  // Open a PDF (a File, Blob, ArrayBuffer or Uint8Array). Resolves a handle:
  //   pages    how many pages it has
  //   isClaim  it is a claim made by this form (carries the form's data file), not a receipt
  //   render(n, longSide) -> see renderPage
  //   close()  let go of the document
  // Rejects with err.kind 'locked' (needs a password), 'notpdf', 'toolarge', 'unsupported', 'file'
  // (the form was opened as a file on the computer, where the renderer cannot load) or 'error'.
  function open(file) {
    if (file && typeof file.size === 'number' && file.size > MAX_BYTES) { var big = new Error('This PDF is too large'); big.kind = 'toolarge'; return Promise.reject(big); }
    return load().then(function (lib) {
      return fileBytes(file).then(function (bytes) {
        if (bytes.length > MAX_BYTES) { var big2 = new Error('This PDF is too large'); big2.kind = 'toolarge'; throw big2; }
        var task = lib.getDocument({
          data: bytes, worker: getWorker(lib), wasmUrl: base(), isEvalSupported: false,
          verbosity: (lib.VerbosityLevel && lib.VerbosityLevel.ERRORS) || 0, stopAtErrors: false
        });
        return task.promise.then(function (doc) {
          return doc.getAttachments().then(function (att) { return att; }, function () { return null; }).then(function (att) {
            return {
              pages: doc.numPages, isClaim: hasAttachment(att, ATTACH_NAME),
              render: function (n, longSide) { return renderPage(lib, doc, n, longSide); },
              close: function () { try { task.destroy(); } catch (e) { /* ignore */ } restSoon(); }
            };
          });
        }, function (e) {
          restSoon();
          var err = new Error((e && e.message) || 'Could not open this PDF');
          err.kind = kindOf(e);
          throw err;
        });
      });
    }, function (e) {
      var err = new Error((e && e.message) || 'Could not load the PDF reader');
      err.kind = (e && e.kind) || (location.protocol === 'file:' ? 'file' : supported() ? 'error' : 'unsupported');
      throw err;
    });
  }

  window.PDFRead = { open: open, supported: supported, _textOf: textOf };
})();
