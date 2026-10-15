/* CETG claim form — shared interface pieces: toasts, dialogs, the receipt viewer, the signature pad,
 * and the small helpers for saving, sharing and emailing a file. */
(function () {
  'use strict';
  var h = U.h, icon = U.icon;

  function reducedMotion() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function scrollTo(el, block) { if (el && el.scrollIntoView) el.scrollIntoView({ block: block || 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }); }
  function freeCanvas(c) { try { c.width = 0; c.height = 0; } catch (e) { /* ignore */ } } // iPhones keep a small budget for canvas memory
  // Any touch screen counts (a phone with a pen reports a "fine" main pointer).
  function isTouch() { try { return window.matchMedia('(any-pointer: coarse)').matches || navigator.maxTouchPoints > 0; } catch (e) { return false; } }
  function isIos() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function isStandalone() { try { return navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches; } catch (e) { return false; } }

  /* ---------- telling screen readers about things that happen by themselves ---------- */
  var sayT = null;
  function say(msg) {
    var el = document.getElementById('sr');
    if (!el) return;
    el.textContent = '';
    clearTimeout(sayT);
    sayT = setTimeout(function () { el.textContent = msg; }, 60); // emptied first, so the same words are read again
  }

  /* ---------- toast ---------- */
  var openToasts = [];
  // Messages about the page are put away when a dialog opens over it: they would only cover the dialog.
  function clearToasts() { openToasts.slice().forEach(function (c) { c(); }); }
  function toast(msg, o) {
    o = o || {};
    var root = document.getElementById('toast-root');
    var el = h('div', { class: 'toast' + (o.bad ? ' bad' : ''), role: o.bad ? 'alert' : null }, h('span', { text: msg }));
    var timer = null, ms = o.ms || (o.action ? 9000 : 5000);
    function close() { clearTimeout(timer); if (el.parentNode) el.parentNode.removeChild(el); var i = openToasts.indexOf(close); if (i !== -1) openToasts.splice(i, 1); }
    function start() { clearTimeout(timer); timer = setTimeout(close, ms); }
    function hold() { clearTimeout(timer); }
    if (o.action) el.appendChild(h('button', { type: 'button', text: o.action, onclick: function (e) { e.stopPropagation(); close(); if (o.onAction) o.onAction(); } }));
    el.addEventListener('click', close);            // a tap puts a message away early
    el.addEventListener('pointerenter', hold);      // and it stays while it is pointed at or focused
    el.addEventListener('pointerleave', start);
    el.addEventListener('focusin', hold);
    el.addEventListener('focusout', start);
    var most = window.innerHeight < 600 ? 2 : 3;
    while (openToasts.length >= most) openToasts[0]();
    root.appendChild(el);
    openToasts.push(close);
    if (!o.bad) say(o.action ? String(msg).replace(/[.\s]+$/, '') + '. ' + o.action + ' button available.' : msg);
    start();
    return close;
  }

  /* ---------- layers: dialogs and the receipt viewer share one stack ----------
   * Only the top layer hears Escape and Tab; everything underneath is inert; and the phone's Back
   * button closes the top layer instead of leaving the page (one extra history entry does that). */
  var layers = [], armed = false, backPending = false, backTimer = null, padTouchAt = 0;
  var FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (el) {
      if (el === document.activeElement) return true;
      return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
  }
  function syncLayers() {
    var open = layers.length > 0, root = document.documentElement;
    root.classList.toggle('has-layer', open);
    root.style.overflow = open ? 'hidden' : ''; // the page behind does not scroll (its scrollbar's room is kept, see the stylesheet)
    ['.top', '#view', '#bar'].forEach(function (sel) { var el = document.querySelector(sel); if (el) el.inert = open; });
    layers.forEach(function (l, i) { l.root.inert = i !== layers.length - 1; });
  }
  function onSentinel() { try { return !!(history.state && history.state.cetgLayer); } catch (e) { return false; } }
  function arm() {
    if (armed || backPending) return; // while our own "back" is still on its way, the new entry waits for it
    try { history.pushState({ cetgLayer: 1 }, ''); armed = true; } catch (e) { /* history not available */ }
  }
  function disarmSoon() {
    setTimeout(function () { // wait a tick: one dialog often closes just as the next one opens
      if (layers.length || !armed) return;
      armed = false;
      if (!onSentinel()) return;
      backPending = true;
      clearTimeout(backTimer);
      backTimer = setTimeout(function () { backPending = false; if (layers.length) arm(); }, 3000); // in case no popstate ever comes
      try { history.back(); } catch (e) { backPending = false; }
    }, 0);
  }
  function pushLayer(layer) { clearToasts(); layers.push(layer); arm(); syncLayers(); }
  function dropLayer(layer) {
    var i = layers.indexOf(layer);
    if (i === -1) return;
    layers.splice(i, 1);
    syncLayers();
    if (!layers.length) disarmSoon();
  }
  window.addEventListener('popstate', function () {
    if (backPending) { // this is our own history.back() arriving
      backPending = false; clearTimeout(backTimer);
      if (layers.length) arm();
      return;
    }
    armed = false;
    var top = layers[layers.length - 1];
    if (!top) return;
    // An edge swipe that started on the signature pad is a pen stroke, not "go back": keep the dialog.
    if (Date.now() - padTouchAt < 800) { arm(); return; }
    top.close();
    if (layers.length) arm();
  });
  document.addEventListener('keydown', function (e) {
    var top = layers[layers.length - 1];
    if (!top) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); top.close(); return; }
    if (e.key === 'Tab') {
      // the buttons on any message showing are part of the round, so "Show" on a message can be reached
      var f = focusables(top.root).concat(focusables(document.getElementById('toast-root')));
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1], at = document.activeElement;
      if (f.indexOf(at) === -1) { e.preventDefault(); (e.shiftKey ? last : first).focus(); } // focus is on the dialog itself, or has strayed
      else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
      return;
    }
    if (top.onKey) top.onKey(e);
  }, true);
  function anyModal() { return layers.length > 0; }
  // Put focus back where it was; if that has gone from the page, on the main area rather than nowhere.
  function backTo(el) {
    try {
      if (el && el.focus && document.contains(el) && el !== document.body) { el.focus({ preventScroll: true }); return; }
      var main = document.getElementById('view');
      if (main && !layers.length) main.focus({ preventScroll: true });
    } catch (e) { /* ignore */ }
  }

  /* ---------- modal ---------- */
  function modal(o) {
    var prevFocus = document.activeElement;
    var closeBtn = h('button', { type: 'button', class: 'icon-btn plain', 'aria-label': 'Close', onclick: function () { api.close(); } }, icon('x'));
    var titleId = U.uid('mt');
    var head = h('div', { class: 'modal-head' }, h('h2', { id: titleId, text: o.title }), closeBtn);
    var body = h('div', { class: 'modal-body' }, o.body);
    var foot = o.foot ? h('div', { class: 'modal-foot' }, o.foot) : null;
    var box = h('div', { class: 'modal' + (o.narrow ? ' narrow' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, head, body, foot);
    var veil = h('div', { class: 'modal-veil' }, box);
    var closed = false, ro = null;
    var layer = { root: veil, close: function () { api.close(); } };
    // Anything scrolled into view (a focused field, an error) must clear the sticky title and button rows.
    function pad() {
      var sticky = getComputedStyle(head).position === 'sticky';
      veil.style.scrollPaddingTop = (sticky ? head.offsetHeight : 0) + 8 + 'px';
      veil.style.scrollPaddingBottom = (sticky && foot ? foot.offsetHeight : 0) + 8 + 'px';
    }
    var api = {
      el: box, body: body, foot: foot,
      close: function (result) {
        if (closed) return;
        closed = true;
        if (ro) ro.disconnect();
        window.removeEventListener('resize', pad);
        if (veil.parentNode) veil.parentNode.removeChild(veil);
        dropLayer(layer);
        backTo(prevFocus);
        if (o.onClose) o.onClose(result);
      },
      setFoot: function (nodes) { if (foot) { U.clear(foot); U.append(foot, nodes); } },
      isOpen: function () { return !closed; }
    };
    var downOnVeil = false;
    veil.addEventListener('pointerdown', function (e) { downOnVeil = e.target === veil; });
    veil.addEventListener('click', function (e) { if (e.target === veil && downOnVeil) api.close(); });
    document.getElementById('modal-root').appendChild(veil);
    pushLayer(layer);
    pad();
    if (window.ResizeObserver) { ro = new ResizeObserver(pad); ro.observe(head); if (foot) ro.observe(foot); }
    window.addEventListener('resize', pad);
    try { (box.querySelector('[data-autofocus]') || box).focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    return api;
  }

  /* ---------- inline "are you sure" (the page never uses browser confirm boxes) ---------- */
  function confirmInline(slot, question, yesLabel, onYes, o) {
    o = o || {};
    var original = Array.prototype.slice.call(slot.childNodes), qid = U.uid('q');
    U.clear(slot);
    function restore() { U.clear(slot); original.forEach(function (n) { slot.appendChild(n); }); }
    var yes = h('button', { type: 'button', class: 'btn sm ' + (o.danger === false ? 'primary' : 'danger'), text: yesLabel, 'aria-describedby': qid, onclick: function () { restore(); onYes(); } });
    var no = h('button', { type: 'button', class: 'btn sm', text: o.noLabel || 'Cancel', onclick: function () { restore(); var b = slot.querySelector('button'); if (b) backTo(b); } });
    slot.appendChild(h('span', { class: 'confirm' }, h('span', { id: qid, text: question }), yes, no));
    try { yes.focus(); } catch (e) { /* ignore */ }
  }

  /* ---------- receipt viewer ---------- */
  // items: [{ getUrl(): Promise<string>, title, amount, sub, box:[x0,y0,x1,y1]|null, verify:{get(), set(bool), label, onLabel} | null }]
  function viewer(items, index, o) {
    o = o || {};
    if (!items.length) return null;
    var i = Math.max(0, Math.min(items.length - 1, index || 0)), zoomed = false, prevFocus = document.activeElement, closed = false, shown = null;
    var title = h('div', { class: 't', id: U.uid('vt') });
    var frame = h('div', { class: 'frame' });
    var stage = h('div', { class: 'viewer-stage' }, frame);
    var info = h('div', { class: 'info' });
    var verifyBtn = h('button', { type: 'button', class: 'btn' });
    var prevBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous receipt' }, icon('left'));
    var nextBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next receipt' }, icon('right'));
    var zoomBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Zoom in', 'aria-pressed': 'false', title: 'Zoom' }, icon('zoom'));
    var closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close' }, icon('x'));
    var el = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title.id },
      h('div', { class: 'viewer-head' }, title, zoomBtn, closeBtn), stage,
      h('div', { class: 'viewer-foot' }, info, verifyBtn, prevBtn, nextBtn));
    var token = 0, hop = null;
    // Size the picture (fitted, or enlarged to about its real size) and bring the highlighted amount into view.
    function place() {
      var it = items[i], img = shown;
      if (!img || !img.naturalWidth) return;
      var fit = Math.min(stage.clientWidth - 24, 640);
      var big = Math.max(fit * 1.5, Math.min(fit * 3, img.naturalWidth));
      frame.style.width = Math.round(zoomed ? big : fit) + 'px';
      var fw = frame.offsetWidth, fh = frame.offsetHeight, b = it.box;
      stage.scrollLeft = b && zoomed ? Math.max(0, fw * (b[0] + b[2]) / 2 - stage.clientWidth / 2) : 0;
      stage.scrollTop = b ? Math.max(0, fh * (b[1] + b[3]) / 2 - stage.clientHeight / 2) : 0;
    }
    function show() {
      var it = items[i], my = ++token;
      title.textContent = it.title + (items.length > 1 ? '  (' + (i + 1) + ' of ' + items.length + ')' : '');
      U.clear(info);
      if (it.amount) info.appendChild(h('b', { text: it.amount }));
      if (it.sub) info.appendChild(h('div', { text: it.sub }));
      U.clear(frame);
      shown = null;
      it.getUrl().then(function (url) {
        if (my !== token || closed) return;
        if (!url) { frame.appendChild(h('p', { class: 'missing', text: 'This receipt image is not available.' })); return; }
        var img = h('img', { alt: 'Receipt image for ' + it.title });
        img.onload = function () {
          if (my !== token) return;
          shown = img;
          if (it.box) {
            var b = it.box, pad = 0.008;
            frame.appendChild(h('div', { class: 'hl', style: { left: Math.max(0, b[0] - pad) * 100 + '%', top: Math.max(0, b[1] - pad) * 100 + '%', width: Math.min(1, b[2] - b[0] + 2 * pad) * 100 + '%', height: Math.min(1, b[3] - b[1] + 2 * pad) * 100 + '%' } }));
          }
          place();
        };
        img.src = url;
        frame.appendChild(img);
      });
      verifyBtn.hidden = !it.verify;
      if (it.verify) paintVerify();
      prevBtn.disabled = i === 0; nextBtn.disabled = i === items.length - 1;
      prevBtn.style.visibility = nextBtn.style.visibility = items.length > 1 ? '' : 'hidden';
      stage.scrollTop = 0; stage.scrollLeft = 0;
    }
    function paintVerify() {
      var it = items[i], on = it.verify.get();
      U.clear(verifyBtn);
      verifyBtn.className = 'btn verify' + (on ? ' ok' : '');
      if (on) verifyBtn.appendChild(icon('check'));
      verifyBtn.appendChild(document.createTextNode(on ? (it.verify.onLabel || 'Checked') : (it.verify.label || 'Amount matches')));
      verifyBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    function go(d) {
      var n = i + d;
      if (n < 0 || n >= items.length) return;
      var held = document.activeElement;
      i = n; show();
      if (held && held.disabled) backTo(closeBtn); // the arrow that was pressed has just been switched off
    }
    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(hop);
      window.removeEventListener('resize', place);
      if (el.parentNode) el.parentNode.removeChild(el);
      dropLayer(layer);
      if (o.onClose) o.onClose();
      backTo(prevFocus);
    }
    var layer = { root: el, close: close, onKey: function (e) { if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1); } };
    verifyBtn.addEventListener('click', function () {
      var it = items[i]; if (!it.verify) return;
      it.verify.set(!it.verify.get());
      var on = it.verify.get();
      paintVerify();
      clearTimeout(hop);
      if (on && i < items.length - 1) hop = setTimeout(function () { go(1); }, reducedMotion() ? 0 : 250); // tick, then straight on to the next receipt
    });
    prevBtn.addEventListener('click', function () { go(-1); });
    nextBtn.addEventListener('click', function () { go(1); });
    zoomBtn.addEventListener('click', function () {
      zoomed = !zoomed;
      zoomBtn.setAttribute('aria-pressed', zoomed ? 'true' : 'false');
      zoomBtn.setAttribute('aria-label', zoomed ? 'Zoom out' : 'Zoom in');
      place();
    });
    closeBtn.addEventListener('click', close);
    window.addEventListener('resize', place);
    document.body.appendChild(el);
    pushLayer(layer);
    show();
    backTo(closeBtn);
    return { close: close };
  }

  /* ---------- signature pad ---------- */
  var PEN = '#10224f';
  function sigPad() {
    var canvas = h('canvas', { role: 'img', 'aria-label': 'Signature area. Draw your signature with a finger, pen or mouse, or choose "Type it instead".' });
    var el = h('div', { class: 'sigpad' }, canvas, h('div', { class: 'base' }), h('div', { class: 'here', text: 'Sign above the line' }));
    var strokes = [], cur = null, curId = null, cssW = 0, cssH = 0, ctx = null, travelled = 0;
    function fit() {
      var r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var dpr = Math.min(3, window.devicePixelRatio || 1);
      cssW = r.width; cssH = r.height;
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    }
    function path(c, pts, sx, sy, ox, oy) {
      if (!pts.length) return;
      c.beginPath();
      var x0 = pts[0][0] * sx + ox, y0 = pts[0][1] * sy + oy;
      c.moveTo(x0, y0);
      if (pts.length === 1) { c.lineTo(x0 + 0.01, y0 + 0.01); }
      for (var k = 1; k < pts.length - 1; k++) {
        var mx = (pts[k][0] + pts[k + 1][0]) / 2 * sx + ox, my = (pts[k][1] + pts[k + 1][1]) / 2 * sy + oy;
        c.quadraticCurveTo(pts[k][0] * sx + ox, pts[k][1] * sy + oy, mx, my);
      }
      if (pts.length > 1) { var l = pts[pts.length - 1]; c.lineTo(l[0] * sx + ox, l[1] * sy + oy); }
      c.stroke();
    }
    function redraw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.strokeStyle = PEN; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      strokes.forEach(function (s) { path(ctx, s, cssW, cssH, 0, 0); });
    }
    function pos(e) { var r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; }
    canvas.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      if (curId !== null) return; // one finger or pen at a time; a second touch is ignored
      if (!ctx || Math.abs(canvas.getBoundingClientRect().width - cssW) > 1) fit();
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      padTouchAt = Date.now();
      curId = e.pointerId; cur = [pos(e)]; strokes.push(cur); redraw();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!cur || e.pointerId !== curId) return;
      e.preventDefault();
      padTouchAt = Date.now();
      var p = pos(e), l = cur[cur.length - 1];
      var d = Math.hypot((p[0] - l[0]) * cssW, (p[1] - l[1]) * cssH);
      if (d < 1.2) return;
      travelled += d; cur.push(p); redraw();
    });
    function end(e) { if (e.pointerId !== curId) return; cur = null; curId = null; if (api.onChange) api.onChange(); }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    function onResize() { if (document.contains(canvas)) fit(); else window.removeEventListener('resize', onResize); }
    window.addEventListener('resize', onResize);
    // The strokes as a trimmed transparent PNG, `tall` pixels high for a full-height signature.
    function render(tall) {
      var minX = 1, minY = 1, maxX = 0, maxY = 0;
      strokes.forEach(function (s) { s.forEach(function (p) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }); });
      var aspect = cssW / cssH, H = tall, W = H * aspect, pad = Math.round(tall / 26);
      var bw = Math.max(8, (maxX - minX) * W), bh = Math.max(8, (maxY - minY) * H);
      var out = document.createElement('canvas');
      out.width = Math.round(bw + 2 * pad); out.height = Math.round(bh + 2 * pad);
      var c = out.getContext('2d');
      c.strokeStyle = PEN; c.lineWidth = tall / 76; c.lineCap = 'round'; c.lineJoin = 'round';
      strokes.forEach(function (s) { path(c, s, W, H, pad - minX * W, pad - minY * H); });
      var url = out.toDataURL('image/png');
      freeCanvas(out);
      return url;
    }
    var api = {
      el: el, onChange: null,
      fit: fit,
      isEmpty: function () { return travelled < 30; },
      clear: function () { strokes = []; travelled = 0; cur = null; curId = null; redraw(); if (api.onChange) api.onChange(); },
      // A consistent size whatever the screen; a very busy signature is made smaller until it is a sensible size to store.
      toDataUrl: function () {
        if (api.isEmpty() || !cssW || !cssH) return '';
        var sizes = [260, 200, 150, 110], url = '';
        for (var k = 0; k < sizes.length; k++) { url = render(sizes[k]); if (url.length < 240000) break; }
        return U.isPngDataUrl(url) ? url : '';
      }
    };
    setTimeout(fit, 0); setTimeout(fit, 120);
    return api;
  }
  // A typed name set in a handwriting face (the same one on every device), for people who cannot draw with a pointer.
  var SIG_FONT = '600 92px "Caveat", "Snell Roundhand", "Segoe Script", "Bradley Hand", cursive', sigFontP = null;
  function sigFont() {
    if (!sigFontP) {
      sigFontP = (document.fonts && document.fonts.load ? document.fonts.load(SIG_FONT, 'Sign here') : Promise.resolve()).then(function () { return true; }, function () { return false; });
    }
    return sigFontP;
  }
  function typedSig(name) {
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) return '';
    var c = document.createElement('canvas'), ctx = c.getContext('2d');
    ctx.font = SIG_FONT;
    var w = Math.ceil(ctx.measureText(name).width), scale = Math.min(1, 1100 / Math.max(1, w));
    c.width = Math.max(40, Math.round(w * scale) + 40); c.height = Math.round(150 * scale) + 20;
    ctx = c.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.font = SIG_FONT; ctx.fillStyle = PEN; ctx.textBaseline = 'alphabetic';
    ctx.fillText(name, 20 / scale, 104);
    var url = c.toDataURL('image/png');
    freeCanvas(c);
    return U.isPngDataUrl(url) ? url : '';
  }

  /* ---------- files: save, share, email ---------- */
  function fileOf(data, filename, mime) {
    try { return new File([data], filename, { type: mime || (data instanceof Blob && data.type) || 'application/octet-stream' }); } catch (e) { return null; }
  }
  function canShareFile(f) { try { return !!(f && navigator.canShare && navigator.share && navigator.canShare({ files: [f] })); } catch (e) { return false; } }
  function download(data, filename, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    // A Home Screen copy on an iPhone has no downloads list: the file goes through the share sheet
    // ("Save to Files") instead.
    if (isIos() && isStandalone()) {
      var f = fileOf(blob, filename, blob.type);
      if (canShareFile(f)) {
        navigator.share({ files: [f] }).catch(function (e) {
          if (e && e.name === 'AbortError') return; // the sheet was closed
          // The file took a moment to make, and the phone wants a fresh tap before it will share.
          toast('“' + filename + '” is ready.', { action: 'Save file', ms: 30000, onAction: function () { navigator.share({ files: [f] }).catch(function () { /* closed */ }); } });
        });
        return;
      }
    }
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: filename, style: { display: 'none' } });
    document.body.appendChild(a);
    a.click();
    // Phones can take a while to show their "save" sheet, so the link is kept alive for a minute.
    setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); URL.revokeObjectURL(url); }, 60000);
  }
  function canShare(bytes, filename) { return canShareFile(fileOf(bytes, filename, 'application/pdf')); }
  function share(bytes, filename, title, text) {
    return navigator.share({ files: [fileOf(bytes, filename, 'application/pdf')], title: title, text: text });
  }
  function mailto(m) {
    var q = [];
    if (m.cc) q.push('cc=' + encodeURIComponent(m.cc));
    q.push('subject=' + encodeURIComponent(m.subject || ''));
    q.push('body=' + encodeURIComponent(m.body || ''));
    return 'mailto:' + encodeURIComponent(m.to || '').replace(/%40/g, '@') + '?' + q.join('&');
  }
  function gmail(m) {
    return 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(m.to || '') + (m.cc ? '&cc=' + encodeURIComponent(m.cc) : '') + '&su=' + encodeURIComponent(m.subject || '') + '&body=' + encodeURIComponent(m.body || '');
  }
  function copyText(text) {
    function fallback() {
      var ta = h('textarea', { style: { position: 'fixed', left: '-999px', top: '0' } });
      ta.value = text;
      var holder = layers.length ? layers[layers.length - 1].root : document.body; // inside the open dialog, or it could not be selected
      holder.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      holder.removeChild(ta);
      return ok;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { return true; }, fallback);
    return Promise.resolve(fallback());
  }
  // Ways to hand an email over: the device's mail app, Gmail in the browser (computers only: on a
  // phone that link does not open a draft), or copy the words. If copying fails, the words are shown.
  // The row has update(mail) so the address can change without the buttons being rebuilt under a click.
  function emailButtons(m, o) {
    o = o || {};
    var cur = m;
    function words() { return (cur.to ? 'To: ' + cur.to + '\n' : '') + (cur.cc ? 'Cc: ' + cur.cc + '\n' : '') + 'Subject: ' + cur.subject + '\n\n' + cur.body; }
    var a1 = h('a', { class: 'btn' + (o.primary ? ' primary' : ''), href: mailto(m) }, icon('mail'), 'Open email');
    var a2 = isTouch() ? null : h('a', { class: 'btn', href: gmail(m), target: '_blank', rel: 'noopener' }, 'Open in Gmail');
    var box = h('textarea', { class: 'input mailtext', rows: '7', readOnly: true, hidden: true, 'aria-label': 'Email text to copy' });
    var copy = h('button', { type: 'button', class: 'btn', onclick: function () {
      copyText(words()).then(function (ok) {
        if (ok) { toast('Email text copied.'); return; }
        box.value = words(); box.hidden = false; box.focus(); box.select();
        toast('Could not copy it for you. The text is shown below: select it and copy it.', { bad: true });
      });
    } }, icon('copy'), 'Copy text');
    var row = h('div', { class: 'mailrow' }, h('div', { class: 'btn-row' }, a1, a2, copy), box);
    row.update = function (next) { cur = next; a1.href = mailto(next); if (a2) a2.href = gmail(next); if (!box.hidden) box.value = words(); };
    return row;
  }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { if (s.parentNode) s.parentNode.removeChild(s); reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  var pdfLibP = null;
  function needPdfLib() {
    if (window.PDFLib) return Promise.resolve();
    if (!pdfLibP) pdfLibP = loadScript('vendor/pdf-lib-1.17.1/pdf-lib.min.js').catch(function (e) { pdfLibP = null; throw e; });
    return pdfLibP;
  }
  function field(label, input, o) {
    o = o || {};
    return h('label', { class: 'field' + (o.cls ? ' ' + o.cls : '') }, h('span', { text: label }), input, o.hint ? h('small', { class: 'hint', text: o.hint }) : null);
  }
  // A place for an error inside a dialog. Put it in the dialog's button row so it is always in view;
  // screen readers announce it when it is filled, and it clears itself once the person changes something.
  function alertBox() {
    var text = h('div', null), el = h('div', { class: 'banner bad', role: 'alert', hidden: true, tabindex: '-1' }, icon('alert'), text);
    el.show = function (msg, focusEl) {
      text.textContent = msg; el.hidden = false;
      scrollTo(el, 'nearest');
      try { if (focusEl && focusEl.focus) focusEl.focus(); else el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    };
    el.hide = function () { if (!el.hidden) { el.hidden = true; text.textContent = ''; } };
    el.watch = function (root) { root.addEventListener('input', el.hide); root.addEventListener('change', el.hide); return el; };
    return el;
  }

  window.UI = {
    toast: toast, say: say, modal: modal, anyModal: anyModal, confirmInline: confirmInline, viewer: viewer, sigPad: sigPad, typedSig: typedSig, sigFont: sigFont,
    download: download, canShare: canShare, share: share, isTouch: isTouch, isIos: isIos, isStandalone: isStandalone, mailto: mailto, gmail: gmail, copyText: copyText,
    emailButtons: emailButtons, needPdfLib: needPdfLib, field: field, alertBox: alertBox, scrollTo: scrollTo, freeCanvas: freeCanvas, reducedMotion: reducedMotion, backTo: backTo
  };
})();
