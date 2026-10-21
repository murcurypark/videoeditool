(() => {
  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), scroller = $('scroller'), inner = $('inner'), ruler = $('ruler'), track = $('track'), otrack = $('otrack'), playhead = $('playhead');
  const view = $('view'), vctx = view.getContext('2d');
  const MIN_LEN = 0.1, OV_MIN = 0.2, FRAME = 1 / 30, THUMB_H = 56, FPS = 30, LANE_H = 30;
  const FONT = 'Pretendard, "Malgun Gothic", sans-serif';
  const RATIOS = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] };

  const sources = [];     // [{id,name,file,url,duration,el,thumbs,w,h,hue,audio}]
  const imgs = new Map(); // imgId -> {el,w,h,name}
  let segs = [];          // [{id,src,start,end}] src = source id, times in that source's seconds
  let overlays = [];      // text / image clips on the timeline (times in edit/timeline seconds)
  let selOv = null;       // selected overlay id
  let v = null;           // <video> of the source the playhead is in
  let sel = 0;            // selected cut
  let playIdx = 0;        // cut the playhead is currently in
  let pps = 60;           // pixels per second
  let mode = 'all';       // 'all' | 'cut'
  let tab = 'cuts';
  let ratioKey = 'orig', fitMode = 'contain';
  let history = [];
  let nextId = 1;
  let exporting = false;
  let cancelExport = false;
  let onEnd = null;
  let guides = { x: false, y: false };
  const pending = [];     // files being loaded / failed to load, shown in the cut list
  let prepped = -1;       // index of the cut whose video was pre-seeked

  const fmt = (t) => {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60), s = t - m * 60;
    return String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0');
  };
  const total = () => segs.reduce((a, s) => a + (s.end - s.start), 0);
  const offset = (i) => segs.slice(0, i).reduce((a, s) => a + (s.end - s.start), 0);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const loaded = () => segs.length > 0;
  const srcOf = (seg) => sources.find((s) => s.id === seg.src);
  const ovOf = (id) => overlays.find((o) => o.id === id);

  // ---------- fonts / output size ----------
  const fontsReady = () => Promise.all([400, 700, 900].map((w) => document.fonts.load(w + ' 40px Pretendard', '가힣Aa'))).catch(() => {});
  fontsReady();

  function outSize() {
    if (RATIOS[ratioKey]) return RATIOS[ratioKey];
    const s = sources[0];
    return s ? [s.w & ~1, s.h & ~1] : [1920, 1080];
  }
  function setupCanvas() {
    const [W, H] = outSize();
    const k = Math.min(1, 720 / Math.min(W, H));
    view.width = Math.round(W * k); view.height = Math.round(H * k);
  }

  // ---------- active video handling ----------
  function activate(src) { v = src.el; }
  // put the playhead in cut i at source time t
  function goto(i, t) {
    playIdx = i;
    const src = srcOf(segs[i]);
    if (v && v !== src.el) v.pause();
    activate(src);
    v.currentTime = t;
  }

  // ---------- history ----------
  function snapshot() {
    history.push(JSON.stringify({ segs, overlays, sel, selOv }));
    if (history.length > 100) history.shift();
    $('undo').disabled = false;
  }
  function undo() {
    if (!history.length || exporting) return;
    const h = JSON.parse(history.pop());
    segs = h.segs; overlays = h.overlays; sel = clamp(h.sel, 0, segs.length - 1);
    selOv = ovOf(h.selOv) ? h.selOv : null;
    const i = clamp(playIdx, 0, segs.length - 1);
    goto(i, segs[i].start);
    $('undo').disabled = !history.length;
    render(); renderEdit();
  }

  // ---------- loading videos ----------
  const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mts|m2ts|ts|3gp|ogv|mpg|mpeg)$/i;
  async function addFiles(files) {
    for (const f of files) {
      if (!f) continue;
      const p = { name: f.name, state: 'loading', msg: '' };
      pending.push(p); renderList();
      if (!f.type.startsWith('video/') && !VIDEO_EXT.test(f.name)) { p.state = 'error'; p.msg = '영상 파일이 아닙니다.'; renderList(); continue; }
      try { await addFile(f); pending.splice(pending.indexOf(p), 1); }
      catch (e) { p.state = 'error'; p.msg = e.message; }
      renderList();
    }
  }

  async function addFile(file) {
    const el = document.createElement('video');
    el.playsInline = true; el.preload = 'auto';
    el.src = URL.createObjectURL(file);
    stage.appendChild(el);
    const fail = (msg) => { el.remove(); URL.revokeObjectURL(el.src); throw new Error(msg); };
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('영상 정보를 읽지 못했습니다 (시간 초과). 브라우저가 지원하지 않는 코덱일 수 있습니다.')), 20000);
      el.onloadedmetadata = () => { clearTimeout(t); res(); };
      el.onerror = () => { clearTimeout(t); rej(new Error('이 브라우저에서 재생할 수 없는 영상 형식입니다.')); };
    }).catch((e) => fail(e.message));
    el.onloadedmetadata = el.onerror = null;
    if (!el.videoWidth) fail('영상 화면을 재생할 수 없는 코덱입니다 (예: HEVC/H.265). H.264 MP4로 변환 후 사용하세요.');
    const src = { id: nextId++, name: file.name, file, url: el.src, duration: el.duration, el, thumbs: [], w: el.videoWidth, h: el.videoHeight, hue: (sources.length * 47 + 215) % 360, audio: undefined };
    sources.push(src);
    el.addEventListener('play', () => { if (el === v) $('play').textContent = '⏸ 일시정지'; });
    el.addEventListener('pause', () => { if (el === v) $('play').textContent = '▶ 재생'; });

    const first = !loaded();
    snapshot();
    segs.push({ id: nextId++, src: src.id, start: 0, end: src.duration });
    if (first) {
      history = [];
      sel = 0; playIdx = 0;
      activate(src);
      setupCanvas();
      $('empty').hidden = true;
      for (const id of ['play', 'modeAll', 'modeCut', 'split', 'del', 'export', 'addText']) $(id).disabled = false;
      $('undo').disabled = true;
    } else {
      sel = segs.length - 1;
    }
    fitZoom();
    render();
    makeThumbs(src);
  }

  async function makeThumbs(src) {
    const tv = document.createElement('video');
    tv.muted = true; tv.preload = 'auto'; tv.src = src.url;
    await new Promise((r) => { tv.onloadeddata = r; tv.onerror = r; });
    const n = clamp(Math.ceil(src.duration / 2), 8, 60);
    const w = Math.round(THUMB_H * (tv.videoWidth / tv.videoHeight || 16 / 9));
    for (let k = 0; k < n; k++) {
      tv.currentTime = Math.min(src.duration - 0.01, (k + 0.5) * src.duration / n);
      await new Promise((r) => { tv.onseeked = r; });
      const c = document.createElement('canvas');
      c.width = w; c.height = THUMB_H;
      c.getContext('2d').drawImage(tv, 0, 0, w, THUMB_H);
      src.thumbs.push(c);
      if (k % 6 === 5 || k === n - 1) drawBlocks();
    }
  }

  // ---------- overlays: data ----------
  const TEXT_PRESETS = {
    basic: { name: '기본', size: 0.06, weight: 700, color: '#ffffff', stroke: 0, strokeColor: '#000000', bg: false, bgColor: '#000000', shadow: true, y: 0.5 },
    caption: { name: '자막', size: 0.045, weight: 700, color: '#ffffff', stroke: 0.14, strokeColor: '#000000', bg: false, bgColor: '#000000', shadow: false, y: 0.86 },
    title: { name: '제목', size: 0.11, weight: 900, color: '#ffffff', stroke: 0, strokeColor: '#000000', bg: false, bgColor: '#000000', shadow: true, y: 0.5 },
    point: { name: '강조', size: 0.06, weight: 900, color: '#111111', stroke: 0, strokeColor: '#000000', bg: true, bgColor: '#ffe14d', shadow: false, y: 0.5 },
    ghost: { name: '박스', size: 0.05, weight: 700, color: '#ffffff', stroke: 0, strokeColor: '#000000', bg: true, bgColor: '#000000a6', shadow: false, y: 0.82 },
  };

  function editTime() {
    if (!loaded()) return 0;
    const seg = segs[playIdx];
    return offset(playIdx) + clamp(v.currentTime - seg.start, 0, seg.end - seg.start);
  }
  function newOverlayRange(len = 3) {
    const T = total(), t = editTime();
    let start = t, end = t + len;
    if (end > T) { end = T; start = Math.max(0, T - len); }
    if (end - start < OV_MIN) end = start + OV_MIN;
    return [start, end];
  }
  function addOverlay(o) {
    snapshot();
    overlays.push(o);
    selOv = o.id;
    tab = 'edit';
    render(); renderEdit();
  }
  function addText(preset = 'basic') {
    if (!loaded()) { alert('먼저 영상을 추가하세요.'); return; }
    const [start, end] = newOverlayRange();
    const p = TEXT_PRESETS[preset];
    addOverlay({ id: nextId++, type: 'text', start, end, x: 0.5, y: p.y, rot: 0, opacity: 1, text: '텍스트를 입력하세요', align: 'center', ...pick(p) });
  }
  const pick = (p) => { const { name, ...r } = p; return r; };

  async function addImages(files) {
    for (const f of files) {
      if (!f || !f.type.startsWith('image/')) continue;
      if (!loaded()) { alert('먼저 영상을 추가하세요.'); return; }
      const el = new Image();
      el.src = URL.createObjectURL(f);
      try { await el.decode(); } catch (e) { alert(f.name + ': 이미지를 불러올 수 없습니다.'); continue; }
      const imgId = nextId++;
      imgs.set(imgId, { el, w: el.naturalWidth || 400, h: el.naturalHeight || 400, name: f.name });
      const [start, end] = newOverlayRange();
      addOverlay({ id: nextId++, type: 'image', imgId, start, end, x: 0.5, y: 0.5, rot: 0, opacity: 1, w: 0.4 });
    }
  }

  function removeOverlay(id) {
    if (exporting) return;
    snapshot();
    overlays = overlays.filter((o) => o.id !== id);
    if (selOv === id) selOv = null;
    render(); renderEdit();
  }
  function duplicateOverlay(id) {
    const o = ovOf(id); if (!o) return;
    snapshot();
    const c = { ...JSON.parse(JSON.stringify(o)), id: nextId++, x: clamp(o.x + 0.03, 0, 1), y: clamp(o.y + 0.03, 0, 1) };
    overlays.push(c); selOv = c.id;
    render(); renderEdit();
  }
  function splitOverlay(id) {
    const o = ovOf(id), t = editTime();
    if (!o || t - o.start < OV_MIN || o.end - t < OV_MIN) return false;
    snapshot();
    const b = { ...JSON.parse(JSON.stringify(o)), id: nextId++, start: t };
    o.end = t;
    overlays.push(b); selOv = b.id;
    render(); renderEdit();
    return true;
  }

  // ---------- overlays: drawing (shared by preview and export) ----------
  function layoutText(ctx, o, cw) {
    const px = o.size * cw;
    ctx.font = `${o.weight} ${px}px ${FONT}`;
    const lines = String(o.text || ' ').split('\n');
    const lh = px * 1.25;
    const w0 = Math.max(px * 0.5, ...lines.map((l) => ctx.measureText(l).width));
    const pad = o.bg ? px * 0.3 : 0;
    return { px, lines, lh, pad, w: w0 + pad * 2, h: lh * lines.length + pad * 2 };
  }
  function boxOf(ctx, o, cw) {
    if (o.type === 'text') { const L = layoutText(ctx, o, cw); return { L, w: L.w, h: L.h }; }
    const im = imgs.get(o.imgId), w = o.w * cw;
    return { w, h: w * im.h / im.w };
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function drawOverlay(ctx, o, cw, ch) {
    ctx.save();
    ctx.translate(o.x * cw, o.y * ch);
    ctx.rotate(o.rot * Math.PI / 180);
    ctx.globalAlpha = o.opacity;
    const B = boxOf(ctx, o, cw);
    if (o.type === 'text') {
      const { L } = B;
      if (o.bg) { ctx.fillStyle = o.bgColor; roundRect(ctx, -B.w / 2, -B.h / 2, B.w, B.h, L.px * 0.25); ctx.fill(); }
      ctx.font = `${o.weight} ${L.px}px ${FONT}`;
      ctx.textBaseline = 'middle'; ctx.textAlign = o.align;
      const tx = o.align === 'left' ? -B.w / 2 + L.pad : o.align === 'right' ? B.w / 2 - L.pad : 0;
      if (o.shadow) { ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = L.px * 0.12; ctx.shadowOffsetY = L.px * 0.04; }
      L.lines.forEach((line, i) => {
        const ty = -B.h / 2 + L.pad + L.lh * (i + 0.5);
        if (o.stroke > 0) { ctx.lineJoin = 'round'; ctx.lineWidth = L.px * o.stroke; ctx.strokeStyle = o.strokeColor; ctx.strokeText(line, tx, ty); }
        ctx.fillStyle = o.color; ctx.fillText(line, tx, ty);
      });
    } else {
      ctx.drawImage(imgs.get(o.imgId).el, -B.w / 2, -B.h / 2, B.w, B.h);
    }
    ctx.restore();
  }
  const activeOverlays = (t) => overlays.filter((o) => t >= o.start && t < o.end);
  const drawOrder = (list) => list.slice().sort((a, b) => (b.lane || 0) - (a.lane || 0));

  function drawSelection(ctx, o, cw, ch) {
    const k = view.width / (view.getBoundingClientRect().width || view.width);
    const B = boxOf(ctx, o, cw);
    ctx.save();
    ctx.translate(o.x * cw, o.y * ch); ctx.rotate(o.rot * Math.PI / 180);
    ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 2 * k; ctx.strokeRect(-B.w / 2, -B.h / 2, B.w, B.h);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#4f8cff';
    const hs = 12 * k; ctx.fillRect(B.w / 2 - hs / 2, B.h / 2 - hs / 2, hs, hs); ctx.strokeRect(B.w / 2 - hs / 2, B.h / 2 - hs / 2, hs, hs);
    ctx.restore();
  }

  function drawGuides(ctx, cw, ch) {
    const k = view.width / (view.getBoundingClientRect().width || view.width);
    ctx.save(); ctx.strokeStyle = '#ff4f6a'; ctx.lineWidth = 1.5 * k; ctx.beginPath();
    if (guides.x) { ctx.moveTo(cw / 2, 0); ctx.lineTo(cw / 2, ch); }
    if (guides.y) { ctx.moveTo(0, ch / 2); ctx.lineTo(cw, ch / 2); }
    ctx.stroke(); ctx.restore();
  }

  // draws one frame of the project: video (fit / cover) + overlays at timeline time t
  function drawScene(ctx, cw, ch, t, el, srcW, srcH, ui, seg) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
    if (el && srcW) {
      const z = (seg && seg.zoom) || 1;
      const sc = (fitMode === 'cover' ? Math.max(cw / srcW, ch / srcH) : Math.min(cw / srcW, ch / srcH)) * z;
      const dw = srcW * sc, dh = srcH * sc;
      ctx.save();
      ctx.translate(cw / 2 + ((seg && seg.px) || 0) * cw, ch / 2 + ((seg && seg.py) || 0) * ch);
      if (seg && seg.flip) ctx.scale(-1, 1);
      ctx.drawImage(el, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    }
    for (const o of drawOrder(activeOverlays(t))) drawOverlay(ctx, o, cw, ch);
    if (ui && selOv) { const o = ovOf(selOv); if (o && t >= o.start && t < o.end) drawSelection(ctx, o, cw, ch); }
  }

  function drawPreview() {
    if (!loaded()) { vctx.fillStyle = '#000'; vctx.fillRect(0, 0, view.width, view.height); return; }
    const src = srcOf(segs[playIdx]);
    drawScene(vctx, view.width, view.height, editTime(), src.el, src.w, src.h, !exporting, segs[playIdx]);
    if (!exporting && (guides.x || guides.y)) drawGuides(vctx, view.width, view.height);
  }

  // ---------- preview: direct manipulation ----------
  function toCanvas(e) {
    const r = view.getBoundingClientRect(), k = view.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k };
  }
  function localPoint(o, p) {
    const dx = p.x - o.x * view.width, dy = p.y - o.y * view.height, a = -o.rot * Math.PI / 180;
    return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
  }
  function hitBody(o, p) {
    const B = boxOf(vctx, o, view.width), l = localPoint(o, p);
    return Math.abs(l.x) <= B.w / 2 && Math.abs(l.y) <= B.h / 2;
  }
  function hitHandle(o, p) {
    const B = boxOf(vctx, o, view.width), l = localPoint(o, p);
    return Math.abs(l.x - B.w / 2) <= 14 * p.k && Math.abs(l.y - B.h / 2) <= 14 * p.k;
  }

  view.addEventListener('pointerdown', (e) => {
    if (!loaded() || exporting) return;
    const p = toCanvas(e), t = editTime();
    const vis = activeOverlays(t).sort((a, b) => (a.lane || 0) - (b.lane || 0));
    const cur = selOv && vis.find((o) => o.id === selOv);
    if (cur && hitHandle(cur, p)) return startScale(e, cur, p);
    const hit = vis.find((o) => hitBody(o, p));
    if (hit) {
      if (selOv !== hit.id) { selOv = hit.id; tab = 'edit'; render(); renderEdit(); }
      return startMove(e, hit, p);
    }
    if (selOv) { selOv = null; render(); renderEdit(); }
    startPan(e, segs[playIdx], p);
  });
  view.addEventListener('wheel', (e) => {
    if (!loaded() || exporting) return;
    e.preventDefault();
    const seg = segs[playIdx];
    if (armedWheel) { snapshot(); armedWheel = false; }
    clearTimeout(wheelTimer); wheelTimer = setTimeout(() => { armedWheel = true; renderCutView(); }, 400);
    seg.zoom = +clamp((seg.zoom || 1) * (e.deltaY < 0 ? 1.06 : 1 / 1.06), 0.2, 5).toFixed(3);
  }, { passive: false });
  let armedWheel = true, wheelTimer = 0;
  view.addEventListener('pointermove', (e) => {
    if (!loaded() || exporting || e.buttons) return;
    const p = toCanvas(e), vis = activeOverlays(editTime());
    const cur = selOv && vis.find((o) => o.id === selOv);
    view.style.cursor = cur && hitHandle(cur, p) ? 'nwse-resize' : vis.some((o) => hitBody(o, p)) ? 'move' : 'grab';
  });

  function dragWindow(move, up) {
    const u = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', u); guides = { x: false, y: false }; up && up(); };
    addEventListener('pointermove', move); addEventListener('pointerup', u);
  }
  function startMove(e, o, p0) {
    e.preventDefault();
    snapshot();
    const ox = o.x, oy = o.y;
    dragWindow((ev) => {
      const p = toCanvas(ev);
      let x = clamp(ox + (p.x - p0.x) / view.width, 0, 1), y = clamp(oy + (p.y - p0.y) / view.height, 0, 1);
      guides.x = Math.abs(x - 0.5) < 0.012; guides.y = Math.abs(y - 0.5) < 0.012;
      if (guides.x) x = 0.5;
      if (guides.y) y = 0.5;
      o.x = x; o.y = y;
    });
  }
  function startPan(e, seg, p0) {
    e.preventDefault();
    snapshot();
    const ox = seg.px || 0, oy = seg.py || 0;
    view.style.cursor = 'grabbing';
    dragWindow((ev) => {
      const p = toCanvas(ev);
      let x = clamp(ox + (p.x - p0.x) / view.width, -2, 2), y = clamp(oy + (p.y - p0.y) / view.height, -2, 2);
      guides.x = Math.abs(x) < 0.01; guides.y = Math.abs(y) < 0.01;
      if (guides.x) x = 0;
      if (guides.y) y = 0;
      seg.px = +x.toFixed(4); seg.py = +y.toFixed(4);
    }, () => { view.style.cursor = 'default'; renderCutView(); });
  }
  function startScale(e, o, p0) {
    e.preventDefault();
    snapshot();
    const cx = o.x * view.width, cy = o.y * view.height;
    const d0 = Math.hypot(p0.x - cx, p0.y - cy) || 1;
    const orig = o.type === 'text' ? o.size : o.w;
    dragWindow((ev) => {
      const p = toCanvas(ev), r = Math.hypot(p.x - cx, p.y - cy) / d0;
      if (o.type === 'text') o.size = clamp(orig * r, 0.01, 0.4); else o.w = clamp(orig * r, 0.03, 2);
    }, renderEdit);
  }

  // ---------- timeline rendering ----------
  function fitZoom() {
    const avail = scroller.clientWidth - 24;
    pps = clamp(avail / Math.max(total(), 1), 10, 400);
    $('zoom').value = pps;
  }

  function render() {
    renderTimeline();
    renderList();
    renderTabs();
    renderCutView();
    updateTime();
    $('del').disabled = segs.length <= 1 && !selOv;
  }

  function assignLanes() {
    const ends = [];
    for (const o of [...overlays].sort((a, b) => a.start - b.start)) {
      let l = ends.findIndex((e) => e <= o.start + 1e-6);
      if (l < 0) { l = ends.length; ends.push(0); }
      ends[l] = o.end; o.lane = l;
    }
    return ends.length;
  }

  function renderTimeline() {
    const w = Math.max(total() * pps + 40, scroller.clientWidth - 2);
    inner.style.width = ruler.style.width = track.style.width = otrack.style.width = w + 'px';
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * pps >= 70) || 600;
    ruler.innerHTML = '';
    for (let t = 0; t <= total(); t += step) {
      const s = document.createElement('span');
      s.style.left = t * pps + 'px';
      s.textContent = fmt(t).replace(/\.00$/, '');
      ruler.appendChild(s);
    }
    track.innerHTML = '';
    segs.forEach((seg, i) => {
      const src = srcOf(seg);
      const b = document.createElement('div');
      b.className = 'block' + (i === sel && !selOv ? ' sel' : '');
      b.style.left = offset(i) * pps + 'px';
      b.style.width = (seg.end - seg.start) * pps + 'px';
      b.style.background = `hsl(${src.hue} 45% ${i === sel ? 42 : 30}%)`;
      b.dataset.i = i;
      b.title = src.name;
      b.innerHTML = '<canvas></canvas><b></b><i class="handle l"></i><i class="handle r"></i>';
      b.querySelector('b').textContent = (i + 1) + ' · ' + src.name + ' · ' + (seg.end - seg.start).toFixed(1) + 's';
      track.appendChild(b);
    });
    // overlay lanes
    const lanes = assignLanes();
    otrack.style.height = Math.max(lanes, 1) * LANE_H + 'px';
    otrack.classList.toggle('none', !overlays.length);
    otrack.innerHTML = '';
    for (const o of overlays) {
      const c = document.createElement('div');
      c.className = 'oclip ' + o.type + (o.id === selOv ? ' sel' : '');
      c.style.left = o.start * pps + 'px';
      c.style.width = Math.max(8, (o.end - o.start) * pps) + 'px';
      c.style.top = o.lane * LANE_H + 'px';
      c.dataset.id = o.id;
      c.innerHTML = '<span></span><i class="handle l"></i><i class="handle r"></i>';
      c.querySelector('span').textContent = o.type === 'text' ? 'T ' + String(o.text).split('\n')[0] : '🖼 ' + imgs.get(o.imgId).name;
      otrack.appendChild(c);
    }
    drawBlocks();
    movePlayhead();
  }

  function drawBlocks() {
    track.querySelectorAll('.block').forEach((b) => {
      const seg = segs[+b.dataset.i];
      if (!seg) return;
      const src = srcOf(seg);
      if (!src.thumbs.length) return;
      const c = b.querySelector('canvas');
      const w = Math.max(1, Math.round((seg.end - seg.start) * pps));
      c.width = w; c.height = THUMB_H;
      const ctx = c.getContext('2d');
      const tw = src.thumbs[0].width;
      for (let x = 0; x < w; x += tw) {
        const srcT = seg.start + (x + tw / 2) / pps;
        const k = clamp(Math.floor(srcT / src.duration * src.thumbs.length), 0, src.thumbs.length - 1);
        ctx.drawImage(src.thumbs[k], x, 0);
      }
    });
  }

  function renderList() {
    const ol = $('cutList');
    ol.innerHTML = '';
    segs.forEach((seg, i) => {
      const src = srcOf(seg);
      const li = document.createElement('li');
      li.className = i === sel && !selOv ? 'sel' : '';
      li.innerHTML = '<span class="n"></span><span class="d"><em></em>' + fmt(seg.start) + ' – ' + fmt(seg.end) + ' (' + (seg.end - seg.start).toFixed(1) + 's)</span>' +
        '<button data-a="up" title="앞으로"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button data-a="down" title="뒤로"' + (i === segs.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button data-a="del" title="삭제"' + (segs.length <= 1 ? ' disabled' : '') + '>✕</button>';
      li.querySelector('.n').textContent = i + 1;
      const em = li.querySelector('em');
      em.textContent = src.name; em.style.color = `hsl(${src.hue} 70% 70%)`;
      li.onclick = (e) => {
        const a = e.target.dataset && e.target.dataset.a;
        if (exporting) return;
        if (a === 'up') return moveCut(i, -1);
        if (a === 'down') return moveCut(i, 1);
        if (a === 'del') return deleteCut(i);
        selectCut(i, true);
      };
      li.ondblclick = (e) => { if (!e.target.dataset.a) { setMode('cut'); play(); } };
      ol.appendChild(li);
    });
    for (const p of pending) {
      const li = document.createElement('li');
      li.className = 'pending' + (p.state === 'error' ? ' err' : '');
      li.innerHTML = '<span class="d"><em></em><small></small></span>' + (p.state === 'error' ? '<button title="닫기">✕</button>' : '');
      li.querySelector('em').textContent = p.name;
      li.querySelector('small').textContent = p.state === 'error' ? p.msg : '불러오는 중…';
      const x = li.querySelector('button');
      if (x) x.onclick = () => { pending.splice(pending.indexOf(p), 1); renderList(); };
      ol.appendChild(li);
    }
    if (!segs.length && !pending.length) {
      const li = document.createElement('li');
      li.className = 'placeholder';
      li.textContent = '영상을 추가하면 여기에 컷이 표시됩니다.';
      ol.appendChild(li);
    }
  }

  function renderTabs() {
    $('tabCuts').classList.toggle('on', tab === 'cuts');
    $('tabEdit').classList.toggle('on', tab === 'edit');
    $('panelCuts').hidden = tab !== 'cuts';
    $('panelEdit').hidden = tab !== 'edit';
  }

  function movePlayhead() {
    if (!loaded()) return;
    const t = editTime();
    playhead.style.left = t * pps + 'px';
    return t;
  }

  function updateTime() {
    const t = movePlayhead() || 0;
    $('time').textContent = fmt(t) + ' / ' + fmt(total());
    return t;
  }

  // ---------- cut screen panel (zoom / position / flip of the cut under the playhead) ----------
  let cutViewIdx = -1;
  function renderCutView() {
    const box = $('cutView'), seg = segs[playIdx];
    cutViewIdx = playIdx;
    if (!seg) { box.innerHTML = ''; return; }
    const row = (k, label, min, max, step, val, scale) =>
      `<div class="f"><label>${label}</label><div class="row"><input type="range" data-cv="${k}" data-scale="${scale}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${val}</output></div></div>`;
    box.innerHTML = `<h3>컷 ${playIdx + 1} 화면 (크롭)</h3>` +
      row('zoom', '확대', 20, 500, 1, Math.round((seg.zoom || 1) * 100), 0.01) +
      row('px', '가로 위치', -100, 100, 1, Math.round((seg.px || 0) * 100), 0.01) +
      row('py', '세로 위치', -100, 100, 1, Math.round((seg.py || 0) * 100), 0.01) +
      `<div class="f"><label><input type="checkbox" data-cv="flip"> 좌우 반전</label></div>` +
      `<div class="actions"><button class="btn" data-cvreset="1">화면 초기화</button></div>` +
      `<p class="hint">미리보기에서 빈 곳을 끌면 이동, 마우스 휠로 확대/축소</p>`;
    box.querySelector('[data-cv=flip]').checked = !!seg.flip;
  }
  $('cutView').addEventListener('input', (e) => {
    const el = e.target, k = el.dataset.cv, seg = segs[playIdx];
    if (!k || !seg) return;
    if (armed) { snapshot(); armed = false; }
    if (el.type === 'checkbox') seg[k] = el.checked;
    else { seg[k] = +(parseFloat(el.value) * parseFloat(el.dataset.scale)).toFixed(4); el.parentElement.querySelector('output').textContent = el.value; }
  });
  $('cutView').addEventListener('change', () => { armed = true; });
  $('cutView').addEventListener('click', (e) => {
    if (!e.target.dataset.cvreset || !segs[playIdx]) return;
    snapshot();
    Object.assign(segs[playIdx], { zoom: 1, px: 0, py: 0, flip: false });
    renderCutView();
  });

  // ---------- edit panel (selected text / image) ----------
  let armed = true; // take one undo snapshot per slider/typing interaction

  function renderEdit() {
    const p = $('panelEdit');
    const o = selOv && ovOf(selOv);
    if (!o) {
      p.innerHTML = '<p class="hint">미리보기나 타임라인에서 텍스트/이미지를 선택하면 여기서 편집할 수 있습니다.</p><div class="actions"><button class="btn" data-act="addText">T 텍스트 추가</button></div>';
      return;
    }
    const range = (k, label, min, max, step, val, scale) =>
      `<div class="f"><label>${label}</label><div class="row"><input type="range" data-k="${k}" data-scale="${scale}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${val}</output></div></div>`;
    const color = (k, label, val) => `<div class="f"><label>${label}</label><div class="row"><input type="color" data-k="${k}" value="${val.slice(0, 7)}"></div></div>`;
    const times = `<div class="times">표시 구간 ${fmt(o.start)} – ${fmt(o.end)} (${(o.end - o.start).toFixed(1)}초)</div>`;
    const acts = '<div class="actions"><button class="btn" data-act="center">가운데로</button><button class="btn" data-act="split">분할</button><button class="btn" data-act="dup">복제</button><button class="btn" data-act="del">삭제</button></div>';
    if (o.type === 'text') {
      p.innerHTML = times +
        `<div class="f"><label>내용</label><textarea data-k="text" data-str="1"></textarea></div>` +
        `<div class="f"><div class="lbl">스타일</div><div class="chips">${Object.entries(TEXT_PRESETS).map(([k, s]) => `<button class="chip" data-preset="${k}">${s.name}</button>`).join('')}</div></div>` +
        `<div class="f"><label>굵기</label><select data-k="weight" data-num="1"><option value="400">보통</option><option value="700">굵게</option><option value="900">아주 굵게</option></select></div>` +
        range('size', '크기', 1, 30, 0.5, +(o.size * 100).toFixed(1), 0.01) +
        color('color', '글자 색', o.color) +
        range('stroke', '외곽선 두께', 0, 25, 1, Math.round(o.stroke * 100), 0.01) + color('strokeColor', '외곽선 색', o.strokeColor) +
        `<div class="f"><label><input type="checkbox" data-k="bg"> 배경 박스</label></div>` + color('bgColor', '배경 색', o.bgColor) +
        `<div class="f"><label><input type="checkbox" data-k="shadow"> 그림자</label></div>` +
        `<div class="f"><label>정렬</label><select data-k="align" data-str="1"><option value="left">왼쪽</option><option value="center">가운데</option><option value="right">오른쪽</option></select></div>` +
        range('opacity', '투명도', 0, 100, 1, Math.round(o.opacity * 100), 0.01) +
        range('rot', '회전', -180, 180, 1, Math.round(o.rot), 1) + acts;
      p.querySelector('textarea').value = o.text;
      p.querySelector('[data-k=weight]').value = String(o.weight);
      p.querySelector('[data-k=align]').value = o.align;
      p.querySelector('[data-k=bg]').checked = !!o.bg;
      p.querySelector('[data-k=shadow]').checked = !!o.shadow;
    } else {
      p.innerHTML = times + `<div class="f"><div class="lbl">${imgs.get(o.imgId).name.replace(/</g, '&lt;')}</div></div>` +
        range('w', '크기', 3, 200, 1, Math.round(o.w * 100), 0.01) +
        range('opacity', '투명도', 0, 100, 1, Math.round(o.opacity * 100), 0.01) +
        range('rot', '회전', -180, 180, 1, Math.round(o.rot), 1) + acts;
    }
  }

  $('panelEdit').addEventListener('input', (e) => {
    const el = e.target, k = el.dataset.k, o = selOv && ovOf(selOv);
    if (!k || !o) return;
    if (armed) { snapshot(); armed = false; }
    let val;
    if (el.type === 'checkbox') val = el.checked;
    else if (el.type === 'range') { val = parseFloat(el.value) * parseFloat(el.dataset.scale); const out = el.parentElement.querySelector('output'); if (out) out.textContent = el.value; }
    else if (el.dataset.num) val = parseInt(el.value, 10);
    else val = el.value;
    o[k] = el.type === 'range' && k !== 'rot' ? +val.toFixed(4) : val;
    if (k === 'text') renderTimeline();
  });
  $('panelEdit').addEventListener('change', () => { armed = true; });
  $('panelEdit').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !selOv) { if (b && b.dataset.act === 'addText') addText(); return; }
    if (b.dataset.preset) {
      const o = ovOf(selOv); snapshot();
      Object.assign(o, pick(TEXT_PRESETS[b.dataset.preset]), { y: o.y });
      renderTimeline(); renderEdit();
    } else if (b.dataset.act === 'del') removeOverlay(selOv);
    else if (b.dataset.act === 'dup') duplicateOverlay(selOv);
    else if (b.dataset.act === 'split') splitOverlay(selOv);
    else if (b.dataset.act === 'center') { const o = ovOf(selOv); snapshot(); o.x = 0.5; o.y = 0.5; }
  });

  // ---------- editing (cuts) ----------
  function selectCut(i, seek) {
    sel = i; selOv = null; tab = 'cuts';
    if (seek) goto(i, segs[i].start);
    render(); renderEdit();
  }

  function split() {
    if (!loaded() || exporting) return;
    if (selOv && splitOverlay(selOv)) return;
    const seg = segs[playIdx], s = v.currentTime;
    if (s - seg.start < MIN_LEN || seg.end - s < MIN_LEN) return;
    snapshot();
    segs.splice(playIdx, 1, { ...seg, id: nextId++, start: seg.start, end: s }, { ...seg, id: nextId++, start: s, end: seg.end });
    sel = playIdx + 1; playIdx = sel;
    render();
  }

  function deleteCut(i = sel) {
    if (segs.length <= 1 || exporting) return;
    snapshot();
    segs.splice(i, 1);
    sel = clamp(i, 0, segs.length - 1);
    goto(sel, segs[sel].start);
    render();
  }

  function deleteSelected() {
    if (selOv) removeOverlay(selOv); else deleteCut();
  }

  function moveCut(i, d) {
    const j = i + d;
    if (j < 0 || j >= segs.length) return;
    snapshot();
    [segs[i], segs[j]] = [segs[j], segs[i]];
    sel = j; playIdx = j;
    render();
  }

  // ---------- playback ----------
  function setMode(m) {
    mode = m;
    $('modeAll').classList.toggle('on', m === 'all');
    $('modeCut').classList.toggle('on', m === 'cut');
    if (m === 'cut') {
      const s = segs[sel];
      if (playIdx !== sel || v.currentTime < s.start || v.currentTime >= s.end) goto(sel, s.start);
    }
  }

  function play() {
    if (!loaded()) return;
    const s = segs[playIdx];
    if (v.currentTime < s.start - 0.05 || v.currentTime >= s.end - 0.03) v.currentTime = s.start;
    v.play();
  }
  function pause() { v.pause(); }

  function tick() {
    if (loaded() && !v.paused) {
      const seg = segs[playIdx];
      // pre-seek the next cut's video so the switch is seamless
      const next = segs[playIdx + 1];
      if (mode === 'all' && next && prepped !== playIdx && seg.end - v.currentTime < 0.4) {
        prepped = playIdx;
        const ns = srcOf(next);
        if (ns.el !== v) ns.el.currentTime = next.start;
      }
      if (v.currentTime >= seg.end - 0.03) {
        if (mode === 'cut') {
          if ($('loop').checked || exporting) v.currentTime = seg.start; else { v.pause(); v.currentTime = seg.start; }
        } else if (next) {
          const sameSrc = next.src === seg.src;
          const old = v;
          playIdx++;
          if (sameSrc) {
            if (Math.abs(next.start - v.currentTime) > 0.06) v.currentTime = next.start;
          } else {
            old.pause();
            activate(srcOf(next));
            if (Math.abs(v.currentTime - next.start) > 0.06) v.currentTime = next.start;
            v.play();
          }
          if (!exporting && !selOv) { sel = playIdx; renderList(); track.querySelectorAll('.block').forEach((b) => b.classList.toggle('sel', +b.dataset.i === sel)); }
        } else {
          v.pause();
          if (onEnd) onEnd(); else goto(0, segs[0].start);
        }
      }
      const x = movePlayhead() * pps;
      if (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth - 20) scroller.scrollLeft = Math.max(0, x - 40);
    }
    updateTime();
    if (playIdx !== cutViewIdx) renderCutView();
    drawPreview();
    requestAnimationFrame(tick);
  }

  function seekEdit(t) {
    if (!loaded()) return;
    t = clamp(t, 0, total());
    let acc = 0, i = 0;
    for (; i < segs.length - 1; i++) { const d = segs[i].end - segs[i].start; if (t < acc + d) break; acc += d; }
    goto(i, segs[i].start + clamp(t - acc, 0, segs[i].end - segs[i].start));
    if (mode === 'cut' && !selOv) { sel = i; render(); }
    updateTime();
  }

  function stepFrame(dt) {
    if (!loaded() || exporting) return;
    const seg = segs[playIdx];
    v.pause();
    v.currentTime = clamp(v.currentTime + dt, seg.start, seg.end - 0.001);
  }

  // ---------- timeline interactions ----------
  function xToEdit(clientX) {
    const r = scroller.getBoundingClientRect();
    return (clientX - r.left + scroller.scrollLeft) / pps;
  }

  const snapPoints = (skip) => {
    const pts = [0, total(), editTime()];
    for (let i = 0; i < segs.length; i++) pts.push(offset(i));
    for (const o of overlays) if (o.id !== skip) pts.push(o.start, o.end);
    return pts;
  };
  const snapTo = (t, pts) => { const r = 8 / pps; let best = t, d = r; for (const p of pts) if (Math.abs(p - t) < d) { d = Math.abs(p - t); best = p; } return best; };

  scroller.addEventListener('pointerdown', (e) => {
    if (!loaded() || exporting) return;
    const handle = e.target.closest('.handle');
    const block = e.target.closest('.block');
    const clip = e.target.closest('.oclip');
    if (clip) return startOverlayDrag(e, ovOf(+clip.dataset.id), handle ? (handle.classList.contains('l') ? 'l' : 'r') : 'move');
    if (handle && block) return startTrim(e, +block.dataset.i, handle.classList.contains('l'));
    if (block) { sel = +block.dataset.i; selOv = null; tab = 'cuts'; seekEdit(xToEdit(e.clientX)); render(); renderEdit(); }
    else seekEdit(xToEdit(e.clientX));
    const move = (ev) => seekEdit(xToEdit(ev.clientX));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });

  function startOverlayDrag(e, o, kind) {
    e.preventDefault();
    snapshot();
    if (selOv !== o.id) { selOv = o.id; tab = 'edit'; render(); renderEdit(); }
    const x0 = e.clientX, s0 = o.start, e0 = o.end, len = e0 - s0, pts = snapPoints(o.id);
    const move = (ev) => {
      const dt = (ev.clientX - x0) / pps;
      if (kind === 'move') {
        let ns = clamp(s0 + dt, 0, Math.max(0, Math.max(total(), len) - len));
        const a = snapTo(ns, pts), b = snapTo(ns + len, pts) - len;
        ns = a !== ns ? a : b;
        o.start = Math.max(0, ns); o.end = o.start + len;
      } else if (kind === 'l') o.start = clamp(snapTo(s0 + dt, pts), 0, e0 - OV_MIN);
      else o.end = Math.max(o.start + OV_MIN, snapTo(e0 + dt, pts));
      renderTimeline();
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); renderEdit(); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  }

  function startTrim(e, i, isLeft) {
    e.preventDefault();
    snapshot();
    sel = i; selOv = null; tab = 'cuts';
    const seg = segs[i], dur = srcOf(seg).duration, x0 = e.clientX, orig = isLeft ? seg.start : seg.end;
    goto(i, seg.start);
    const move = (ev) => {
      const dt = (ev.clientX - x0) / pps;
      if (isLeft) seg.start = clamp(orig + dt, 0, seg.end - MIN_LEN);
      else seg.end = clamp(orig + dt, seg.start + MIN_LEN, dur);
      v.pause();
      v.currentTime = isLeft ? seg.start : Math.max(seg.start, seg.end - 0.05);
      render();
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
    render(); renderEdit();
  }

  // ---------- export: fallback (real-time recording of the preview canvas, single source only) ----------
  function pickMime() {
    return ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  }

  async function exportRealtime() {
    if (new Set(segs.map((s) => s.src)).size > 1) {
      alert('여러 영상을 합쳐 내보내려면 WebCodecs를 지원하는 최신 Chrome/Edge가 필요합니다.');
      return;
    }
    const mime = pickMime();
    const capture = v.captureStream || v.mozCaptureStream;
    if (!mime || !capture || !view.captureStream) { alert('이 브라우저는 내보내기를 지원하지 않습니다. 최신 Chrome/Edge/Firefox를 사용하세요.'); return; }
    exporting = true;
    $('exportOverlay').hidden = false;
    $('exportOverlay').querySelector('small').textContent = '실시간 속도로 녹화됩니다. 이 탭을 닫거나 숨기지 마세요.';
    pause(); setMode('all'); goto(0, segs[0].start);
    await new Promise((r) => { if (!v.seeking) return r(); v.onseeked = r; });
    const stream = view.captureStream(30);
    capture.call(v).getAudioTracks().forEach((t) => stream.addTrack(t));
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    let cancelled = false;
    const finish = new Promise((res) => { rec.onstop = res; });
    onEnd = () => rec.state !== 'inactive' && rec.stop();
    $('exportCancel').onclick = () => { cancelled = true; v.pause(); if (rec.state !== 'inactive') rec.stop(); };
    const prog = setInterval(() => setProgress(Math.min(1, updateTime() / total())), 200);
    rec.start(1000);
    v.play();
    await finish;
    clearInterval(prog);
    onEnd = null; exporting = false;
    $('exportOverlay').hidden = true;
    stream.getTracks().forEach((t) => t.stop());
    goto(0, segs[0].start);
    if (cancelled) return;
    download(new Blob(chunks, { type: mime }), mime.startsWith('video/mp4') ? 'mp4' : 'webm');
  }

  // ---------- export: WebCodecs (frame-by-frame, faster than real time) ----------
  function seekTo(el, t) {
    if (Math.abs(el.currentTime - t) < 1e-4 && !el.seeking) return Promise.resolve();
    return new Promise((res) => { el.addEventListener('seeked', res, { once: true }); el.currentTime = t; });
  }

  async function decodeAudio(src) {
    if (src.audio !== undefined) return src.audio;
    try {
      const ctx = new AudioContext({ sampleRate: 48000 });
      src.audio = await ctx.decodeAudioData(await src.file.arrayBuffer());
      ctx.close();
    } catch (e) { src.audio = null; }   // no audio track / undecodable
    return src.audio;
  }

  function setProgress(p) {
    $('exportPct').textContent = Math.round(p * 100) + '%';
    $('exportBar').style.width = p * 100 + '%';
  }

  async function exportWebCodecs() {
    await fontsReady();
    const [W, H] = outSize();
    let vc = null;
    for (const [codec, mux] of [['avc1.640033', 'avc'], ['vp09.00.50.08', 'vp9']]) {
      const cfg = { codec, width: W, height: H, bitrate: clamp(W * H * FPS * 0.1, 2e6, 25e6), framerate: FPS };
      if ((await VideoEncoder.isConfigSupported(cfg)).supported) { vc = { cfg, mux }; break; }
    }
    if (!vc) throw new Error('unsupported');
    const { Muxer, ArrayBufferTarget } = await import('./vendor/mp4-muxer.mjs');

    // audio: decode each used source once, stitch the kept ranges (silence where a source has no audio)
    const used = [...new Set(segs.map((s) => srcOf(s)))];
    const bufs = new Map();
    for (const s of used) bufs.set(s.id, await decodeAudio(s));
    let ac = null;
    if ([...bufs.values()].some(Boolean)) {
      const sr = 48000;
      for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
        const cfg = { codec, sampleRate: sr, numberOfChannels: 2, bitrate: 128000 };
        if ((await AudioEncoder.isConfigSupported(cfg)).supported) { ac = { cfg, mux, ch: 2, sr }; break; }
      }
    }

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target, fastStart: 'in-memory', firstTimestampBehavior: 'offset',
      video: { codec: vc.mux, width: W, height: H },
      ...(ac && { audio: { codec: ac.mux, numberOfChannels: ac.ch, sampleRate: ac.sr } }),
    });
    let encErr = null;
    const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { encErr = e; } });
    venc.configure(vc.cfg);
    let aenc = null;
    if (ac) { aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { encErr = e; } }); aenc.configure(ac.cfg); }

    const frameCounts = segs.map((s) => Math.max(1, Math.round((s.end - s.start) * FPS)));
    const offs = segs.map((_, i) => offset(i));
    const totalFrames = frameCounts.reduce((a, b) => a + b, 0);
    let done = 0;

    if (ac) {
      const lens = segs.map((s) => Math.floor((s.end - s.start) * ac.sr));
      const n = lens.reduce((a, b) => a + b, 0);
      const flat = [new Float32Array(n), new Float32Array(n)];
      let o = 0;
      segs.forEach((s, i) => {
        const buf = bufs.get(s.src);
        if (buf) {
          const a = Math.floor(s.start * ac.sr);
          for (let c = 0; c < 2; c++) {
            const d = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)).subarray(a, a + lens[i]);
            flat[c].set(d, o);
          }
        }
        o += lens[i];
      });
      const CH = 4096;
      for (let pos = 0; pos < n && !cancelExport; pos += CH) {
        const len = Math.min(CH, n - pos);
        const data = new Float32Array(len * 2);
        flat.forEach((d, c) => data.set(d.subarray(pos, pos + len), c * len));
        const ad = new AudioData({ format: 'f32-planar', sampleRate: ac.sr, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round(pos / ac.sr * 1e6), data });
        aenc.encode(ad); ad.close();
        if (aenc.encodeQueueSize > 16) await sleep(0);
        if (encErr) throw encErr;
      }
    }

    // every frame is composed on a fixed-size canvas (video fit/cover + text/image overlays)
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');

    outer:
    for (let i = 0; i < segs.length; i++) {
      const src = srcOf(segs[i]);
      for (let k = 0; k < frameCounts[i]; k++) {
        if (cancelExport) break outer;
        if (encErr) throw encErr;
        await seekTo(src.el, Math.min(segs[i].start + k / FPS, segs[i].end - 0.001));
        drawScene(ctx, W, H, offs[i] + k / FPS, src.el, src.w, src.h, false, segs[i]);
        const frame = new VideoFrame(cv, { timestamp: Math.round(done * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
        venc.encode(frame, { keyFrame: done % 60 === 0 });
        frame.close();
        done++;
        while (venc.encodeQueueSize > 8) await sleep(2);
        if (done % 5 === 0) { setProgress(done / totalFrames); await sleep(0); }
      }
    }
    if (cancelExport) { venc.close(); aenc && aenc.close(); return null; }
    await venc.flush(); if (aenc) await aenc.flush();
    if (encErr) throw encErr;
    muxer.finalize();
    return new Blob([target.buffer], { type: 'video/mp4' });
  }

  function download(blob, ext) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'edited.' + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function exportVideo() {
    if (!window.VideoEncoder || !window.VideoFrame) return exportRealtime();
    exporting = true; cancelExport = false;
    $('exportOverlay').hidden = false;
    $('exportOverlay').querySelector('small').textContent = '프레임 단위로 인코딩합니다. 완료까지 탭을 유지해 주세요.';
    setProgress(0);
    $('exportCancel').onclick = () => { cancelExport = true; };
    pause(); setMode('all');
    let blob = null, fallback = false;
    try { blob = await exportWebCodecs(); }
    catch (e) { console.warn('WebCodecs export failed', e); fallback = true; }
    exporting = false;
    $('exportOverlay').hidden = true;
    goto(0, segs[0].start);
    if (fallback) { alert('이 브라우저에서는 고속 내보내기를 쓸 수 없습니다. 실시간 녹화 방식을 시도합니다.'); return exportRealtime(); }
    if (blob) download(blob, 'mp4');
  }

  // ---------- wiring ----------
  $('file').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  $('imgFile').onchange = (e) => { addImages([...e.target.files]); e.target.value = ''; };
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (e) => {
    const fs = [...e.dataTransfer.files];
    addImages(fs.filter((f) => f.type.startsWith('image/')));
    addFiles(fs.filter((f) => !f.type.startsWith('image/')));
  });

  $('play').onclick = () => (v.paused ? play() : pause());
  $('modeAll').onclick = () => setMode('all');
  $('modeCut').onclick = () => setMode('cut');
  $('split').onclick = split;
  $('del').onclick = deleteSelected;
  $('undo').onclick = undo;
  $('export').onclick = exportVideo;
  $('addText').onclick = () => addText();
  $('tabCuts').onclick = () => { tab = 'cuts'; renderTabs(); };
  $('tabEdit').onclick = () => { tab = 'edit'; renderTabs(); renderEdit(); };
  $('ratio').onchange = (e) => { ratioKey = e.target.value; setupCanvas(); };
  $('fit').onchange = (e) => { fitMode = e.target.value; };
  $('zoom').oninput = (e) => { pps = +e.target.value; render(); };
  window.addEventListener('resize', () => loaded() && render());
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('button')) e.target.closest('button').blur(); });

  window.addEventListener('keydown', (e) => {
    if (!loaded() || exporting || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); v.paused ? play() : pause(); }
    else if (k === 's' || k === 'S') split();
    else if (k === 'Delete' || k === 'Backspace') deleteSelected();
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); stepFrame(e.shiftKey ? -1 : -FRAME); }
    else if (k === 'ArrowRight') { e.preventDefault(); stepFrame(e.shiftKey ? 1 : FRAME); }
  });

  // test hook
  window.__editor = {
    get segs() { return segs; }, get overlays() { return overlays; }, get playIdx() { return playIdx; }, get view() { return view; },
    split, deleteCut, moveCut, setMode, play, pause, seekEdit, addFiles, addImages, addText, undo,
    setRatio(k) { $('ratio').value = k; ratioKey = k; setupCanvas(); }, setFit(k) { $('fit').value = k; fitMode = k; },
  };

  renderList(); renderEdit(); renderTabs(); renderCutView();
  requestAnimationFrame(tick);
})();
