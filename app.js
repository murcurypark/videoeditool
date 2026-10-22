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
  let out = null;         // {el, idx}: element showing the outgoing cut while a transition plays
  let cropMode = false;   // crop handles shown on the preview
  let cropLockKey = 'free'; // aspect lock while dragging crop corners
  const transDefault = { type: 'fade', dur: 0.5 };   // shown on cut 1, applied to all cuts by [모든 컷 사이에 적용]
  const TRANS = [['none', '없음'], ['fade', '크로스페이드'], ['dipB', '검정으로 페이드'], ['dipW', '흰색으로 페이드'],
    ['slideL', '밀기 ←'], ['slideR', '밀기 →'], ['slideU', '밀기 ↑'], ['slideD', '밀기 ↓'],
    ['wipeL', '와이프 ←'], ['wipeR', '와이프 →'], ['wipeU', '와이프 ↑'], ['wipeD', '와이프 ↓'], ['zoom', '줌 전환']];
  const TRANS_TYPES = new Set(TRANS.map((t) => t[0]));
  const CROP_AR = [['free', '자유'], ['orig', '원본 비율'], ['out', '출력 화면 비율'], ['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:5', '4:5']];

  const fmt = (t) => {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60), s = t - m * 60;
    return String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0');
  };
  const len = (s) => s.end - s.start;
  // a cut's transition (from the previous cut) overlaps both cuts; each side gives at most half its length
  const tdur = (i) => {
    const tr = i > 0 && segs[i] && segs[i].trans;
    if (!tr || !TRANS_TYPES.has(tr.type) || tr.type === 'none') return 0;
    const d = Math.min(+tr.dur || 0, len(segs[i - 1]) / 2, len(segs[i]) / 2);
    return d >= 0.05 ? d : 0;
  };
  const offset = (i) => { let t = 0; for (let j = 0; j < i; j++) t += len(segs[j]) - tdur(j + 1); return t; };
  const total = () => (segs.length ? offset(segs.length - 1) + len(segs[segs.length - 1]) : 0);
  // per-cut fade to black at the cut's end (picture + sound); skipped when a transition follows, which already handles the exit
  const fdur = (i) => {
    const sg = segs[i], d = sg && sg.fadeOut;
    if (!d || tdur(i + 1)) return 0;
    const m = Math.min(d, len(sg) - tdur(i));
    return m >= 0.05 ? m : 0;
  };
  const fadeAlpha = (t) => {
    let a = 0;
    for (let i = 0; i < segs.length; i++) {
      const f = fdur(i);
      if (!f) continue;
      const end = offset(i) + len(segs[i]);
      if (t > end - f && t < end) a = Math.max(a, (t - (end - f)) / f);
    }
    return clamp(a, 0, 1);
  };
  const cutAt = (t) => { let i = 0; while (i < segs.length - 1 && offset(i + 1) <= t) i++; return i; };
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
    if (!loaded() && !$('restoreBar').hidden && files.length && !confirm('저장된 이전 작업이 있습니다.\n새 작업을 시작하면 이전 작업이 덮어써집니다. 계속할까요?')) return;
    if (!loaded()) $('restoreBar').hidden = true;
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

  function makeVideoEl() {
    const el = document.createElement('video');
    el.playsInline = true; el.preload = 'auto';
    stage.appendChild(el);
    el.addEventListener('play', () => { if (el === v) $('play').textContent = '⏸ 일시정지'; });
    el.addEventListener('pause', () => { if (el === v) $('play').textContent = '▶ 재생'; });
    return el;
  }

  // second <video> of a source: needed when a transition shows two cuts of the same source at once
  const altEl = (src) => src.alt || (src.alt = (() => { const el = makeVideoEl(); el.src = src.url; return el; })());

  function enableUI() {
    $('empty').hidden = true;
    for (const id of ['play', 'modeAll', 'modeCut', 'split', 'del', 'export', 'addText', 'saveProj']) $(id).disabled = false;
    $('undo').disabled = !history.length;
  }

  async function addFile(file) {
    // a saved project may be waiting for its original files: match by name + size, else offer to relink
    let target = sources.find((s) => s.missing && s.name === file.name && s.size === file.size);
    if (!target) {
      const m = sources.find((s) => s.missing);
      if (m && confirm(`'${file.name}'은(는) 저장된 영상과 이름/크기가 다릅니다.\n누락된 '${m.name}' 대신 연결할까요?\n(취소하면 새 영상으로 추가합니다)`)) target = m;
    }
    const el = makeVideoEl();
    el.src = URL.createObjectURL(file);
    const fail = (msg) => { el.remove(); URL.revokeObjectURL(el.src); throw new Error(msg); };
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('영상 정보를 읽지 못했습니다 (시간 초과). 브라우저가 지원하지 않는 코덱일 수 있습니다.')), 20000);
      el.onloadedmetadata = () => { clearTimeout(t); res(); };
      el.onerror = () => { clearTimeout(t); rej(new Error('이 브라우저에서 재생할 수 없는 영상 형식입니다.')); };
    }).catch((e) => fail(e.message));
    el.onloadedmetadata = el.onerror = null;
    if (!el.videoWidth) fail('영상 화면을 재생할 수 없는 코덱입니다 (예: HEVC/H.265). H.264 MP4로 변환 후 사용하세요.');

    if (target) {   // relink a saved source to this file
      const oldEl = target.el, wasActive = v === oldEl;
      oldEl.remove();
      if (target.alt) { target.alt.remove(); target.alt = null; }
      Object.assign(target, { el, file, url: el.src, size: file.size, lastModified: file.lastModified, duration: el.duration, w: el.videoWidth, h: el.videoHeight, thumbs: [], audio: undefined, missing: false });
      for (const sg of segs) if (sg.src === target.id) { sg.end = Math.min(sg.end, target.duration); sg.start = Math.min(sg.start, sg.end - MIN_LEN); }
      if (wasActive) { activate(target); el.currentTime = segs[playIdx] ? segs[playIdx].start : 0; }
      setupCanvas(); fitZoom(); render(); makeThumbs(target);
      return;
    }

    const src = { id: nextId++, name: file.name, file, size: file.size, lastModified: file.lastModified, url: el.src, duration: el.duration, el, thumbs: [], w: el.videoWidth, h: el.videoHeight, hue: (sources.length * 47 + 215) % 360, audio: undefined, missing: false };
    sources.push(src);

    const first = !loaded();
    snapshot();
    segs.push({ id: nextId++, src: src.id, start: 0, end: src.duration });
    if (first) {
      history = [];
      sel = 0; playIdx = 0;
      activate(src);
      setupCanvas();
      enableUI();
    } else {
      sel = segs.length - 1;
    }
    fitZoom();
    render();
    makeThumbs(src);
  }

  async function makeThumbs(src) {
    if (src.missing || !src.url) return;
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
      imgs.set(imgId, { el, w: el.naturalWidth || 400, h: el.naturalHeight || 400, name: f.name, dataUrl: await imageDataUrl(f, el) });
      const [start, end] = newOverlayRange();
      addOverlay({ id: nextId++, type: 'image', imgId, start, end, x: 0.5, y: 0.5, rot: 0, opacity: 1, w: 0.4 });
    }
  }

  // small data URL copy of an image so it can be saved with the project (big photos are downscaled)
  function imageDataUrl(f, el) {
    if (f.size <= 1.5e6) return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(''); r.readAsDataURL(f); });
    const k = Math.min(1, 1920 / Math.max(el.naturalWidth, el.naturalHeight)), c = document.createElement('canvas');
    c.width = Math.round(el.naturalWidth * k); c.height = Math.round(el.naturalHeight * k);
    c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
    return Promise.resolve(c.toDataURL(f.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.92));
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

  // ---------- drawing: video layer (crop + fit + zoom/pan/flip), transitions, overlays ----------
  const FULL = { x: 0, y: 0, w: 1, h: 1 };
  const cropOf = (seg) => (seg && seg.crop) || FULL;
  const CROP_HANDLES = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  function geom(cw, ch, L) {
    const s = L.seg || {}, z = s.zoom || 1;
    const sc = (fitMode === 'cover' ? Math.max(cw / L.w, ch / L.h) : Math.min(cw / L.w, ch / L.h)) * z;
    return { dw: L.w * sc, dh: L.h * sc, cx: cw / 2 + (s.px || 0) * cw, cy: ch / 2 + (s.py || 0) * ch, f: s.flip ? -1 : 1 };
  }
  // L = {el, w, h, seg}; mode: undefined = black background + cropped video, 'nobg' = no background, 'faint' = whole uncropped video, dimmed
  function drawLayer(ctx, cw, ch, L, mode) {
    if (!mode) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch); }
    if (!L || !L.el || !L.w) return;
    const g = geom(cw, ch, L), c = mode === 'faint' ? FULL : cropOf(L.seg);
    ctx.save();
    if (mode === 'faint') ctx.globalAlpha = 0.3;
    ctx.translate(g.cx, g.cy); ctx.scale(g.f, 1);
    ctx.drawImage(L.el, c.x * L.w, c.y * L.h, c.w * L.w, c.h * L.h, -g.dw / 2 + c.x * g.dw, -g.dh / 2 + c.y * g.dh, c.w * g.dw, c.h * g.dh);
    ctx.restore();
  }

  const ease = (p) => p * p * (3 - 2 * p);
  // a layer drawn onto a scratch canvas, so it can be blended as one opaque picture (its black bars included)
  let scratch = null;
  function snapLayer(cw, ch, L) {
    if (!scratch) scratch = document.createElement('canvas');
    if (scratch.width !== cw || scratch.height !== ch) { scratch.width = cw; scratch.height = ch; }
    drawLayer(scratch.getContext('2d'), cw, ch, L);
    return scratch;
  }
  // A = outgoing layer, B = incoming layer, p = 0..1
  function drawTransition(ctx, cw, ch, A, B, type, p) {
    p = ease(clamp(p, 0, 1));
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
    if (type === 'fade') {
      drawLayer(ctx, cw, ch, A);
      ctx.save(); ctx.globalAlpha = p; ctx.drawImage(snapLayer(cw, ch, B), 0, 0); ctx.restore();
    } else if (type === 'dipB' || type === 'dipW') {
      drawLayer(ctx, cw, ch, p < 0.5 ? A : B);
      ctx.save(); ctx.fillStyle = type === 'dipB' ? '#000' : '#fff'; ctx.globalAlpha = p < 0.5 ? p * 2 : (1 - p) * 2; ctx.fillRect(0, 0, cw, ch); ctx.restore();
    } else if (type === 'zoom') {
      drawLayer(ctx, cw, ch, B);
      ctx.save(); ctx.globalAlpha = 1 - p; ctx.translate(cw / 2, ch / 2); const k = 1 + p * 0.4; ctx.scale(k, k); ctx.translate(-cw / 2, -ch / 2);
      ctx.drawImage(snapLayer(cw, ch, A), 0, 0); ctx.restore();
    } else {
      const dir = type.slice(-1), horiz = dir === 'L' || dir === 'R', sgn = dir === 'L' || dir === 'U' ? -1 : 1;
      if (type.startsWith('slide')) {
        const size = horiz ? cw : ch;
        for (const [L, o] of [[A, sgn * p * size], [B, sgn * (p - 1) * size]]) {
          ctx.save(); if (horiz) ctx.translate(o, 0); else ctx.translate(0, o);
          drawLayer(ctx, cw, ch, L); ctx.restore();
        }
      } else {   // wipe: the incoming cut is revealed from the right/bottom (L/U) or left/top (R/D)
        drawLayer(ctx, cw, ch, A);
        ctx.save(); ctx.beginPath();
        if (dir === 'L') ctx.rect(cw * (1 - p), 0, cw * p, ch); else if (dir === 'R') ctx.rect(0, 0, cw * p, ch);
        else if (dir === 'U') ctx.rect(0, ch * (1 - p), cw, ch * p); else ctx.rect(0, 0, cw, ch * p);
        ctx.clip(); drawLayer(ctx, cw, ch, B); ctx.restore();
      }
    }
  }

  function drawCutBox(ctx, cw, ch, L) {
    const k = view.width / (view.getBoundingClientRect().width || view.width), hs = 12 * k;
    const g = geom(cw, ch, L), c = cropOf(L.seg);
    const x0 = -g.dw / 2 + c.x * g.dw, y0 = -g.dh / 2 + c.y * g.dh, w = c.w * g.dw, h = c.h * g.dh;
    ctx.save(); ctx.translate(g.cx, g.cy); ctx.scale(g.f, 1);
    ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 2 * k; ctx.strokeRect(x0, y0, w, h);
    ctx.fillStyle = '#fff';
    for (const [hx, hy] of cutHandles()) {
      const x = x0 + (hx + 1) * w / 2 - hs / 2, y = y0 + (hy + 1) * h / 2 - hs / 2;
      ctx.fillRect(x, y, hs, hs); ctx.strokeRect(x, y, hs, hs);
    }
    ctx.restore();
  }
  // handles shown on the selected cut: bottom-right corner scales; in crop mode all edges (only corners while a ratio is locked)
  const cutHandles = () => (!cropMode ? [[1, 1]] : cropLockKey !== 'free' ? CROP_HANDLES.filter(([x, y]) => x && y) : CROP_HANDLES);

  // draws one frame of the project at timeline time t: main layer (+ outgoing layer `o` while transition `tr` plays) + overlays
  function drawScene(ctx, cw, ch, t, main, o, tr, ui) {
    if (o && tr) drawTransition(ctx, cw, ch, o, main, tr.type, tr.p);
    else {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
      if (ui && cropMode) drawLayer(ctx, cw, ch, main, 'faint');
      drawLayer(ctx, cw, ch, main, 'nobg');
    }
    for (const ov of drawOrder(activeOverlays(t))) drawOverlay(ctx, ov, cw, ch);
    const fa = fadeAlpha(t);
    if (fa > 0) { ctx.save(); ctx.globalAlpha = fa; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch); ctx.restore(); }
    if (ui && selOv) { const ov = ovOf(selOv); if (ov && t >= ov.start && t < ov.end) drawSelection(ctx, ov, cw, ch); }
    else if (ui && main && main.el) drawCutBox(ctx, cw, ch, main);
  }

  const mainLayer = () => {
    const seg = segs[playIdx], src = seg && srcOf(seg);
    return src ? { el: src.missing ? null : v, w: src.w, h: src.h, seg } : null;
  };

  // While a transition plays, the previous cut keeps running on a second element. Returns its layer state (or null).
  function clearOut() { if (out) { if (out.el !== v) out.el.pause(); out.el.volume = 1; out = null; } }
  function syncOut() {
    const i = playIdx, td = tdur(i), dt = editTime() - offset(i);
    if (!v || !td || dt >= td || srcOf(segs[i - 1]).missing) { clearOut(); if (v) v.volume = 1; return null; }
    const prev = segs[i - 1];
    if (out && (out.idx !== i - 1 || out.el === v)) clearOut();
    if (!out) { const ps = srcOf(prev); out = { el: ps.el === v ? altEl(ps) : ps.el, idx: i - 1 }; }
    const want = prev.end - td + dt, el = out.el;
    if (!v.paused) { if (el.paused) el.play(); if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want; }
    else { if (!el.paused) el.pause(); if (Math.abs(el.currentTime - want) > 0.04) el.currentTime = want; }
    const p = clamp(dt / td, 0, 1);
    v.volume = Math.sin(p * Math.PI / 2); el.volume = Math.cos(p * Math.PI / 2);
    return { el, seg: prev, p };
  }

  function drawPreview() {
    if (!loaded()) { vctx.fillStyle = '#000'; vctx.fillRect(0, 0, view.width, view.height); return; }
    if (!v) return;
    const seg = segs[playIdx], src = srcOf(seg), main = mainLayer();
    let o = null, tr = null;
    const so = exporting ? null : syncOut();
    if (!exporting && !so) v.volume = 1 - fadeAlpha(editTime());
    if (so) { const ps = srcOf(so.seg); o = { el: so.el, w: ps.w, h: ps.h, seg: so.seg }; tr = { type: seg.trans.type, p: so.p }; }
    drawScene(vctx, view.width, view.height, editTime(), main, o, tr, !exporting);
    if (src.missing) {
      vctx.save(); vctx.fillStyle = 'rgba(255,255,255,.85)'; vctx.textAlign = 'center'; vctx.textBaseline = 'middle';
      vctx.font = `700 ${view.width * 0.04}px ${FONT}`;
      vctx.fillText('원본 영상을 다시 연결하세요', view.width / 2, view.height * 0.4);
      vctx.font = `400 ${view.width * 0.03}px ${FONT}`; vctx.fillText(src.name, view.width / 2, view.height * 0.4 + view.width * 0.06);
      vctx.restore();
    }
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
    const hh = hitCutHandle(p);
    if (hh) return cropMode ? startCrop(e, hh, p) : startZoom(e, p);
    if (cropMode && insideCrop(p)) return startCrop(e, [0, 0], p);
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
    const hh = !selOv && hitCutHandle(p);
    view.style.cursor = cur && hitHandle(cur, p) ? 'nwse-resize' : vis.some((o) => hitBody(o, p)) ? 'move'
      : hh ? (hh[0] && hh[1] ? (hh[0] * hh[1] > 0 ? 'nwse-resize' : 'nesw-resize') : hh[0] ? 'ew-resize' : 'ns-resize')
      : cropMode && insideCrop(p) ? 'move' : 'grab';
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
  // ----- cut handles: scale (zoom) the cut, or crop it (crop mode) -----
  const toLocal = (g, p) => ({ x: (p.x - g.cx) * g.f, y: p.y - g.cy });
  function cropRect(g, c) {
    const x0 = -g.dw / 2 + c.x * g.dw, y0 = -g.dh / 2 + c.y * g.dh;
    return { x0, y0, x1: x0 + c.w * g.dw, y1: y0 + c.h * g.dh };
  }
  function hitCutHandle(p) {
    const L = mainLayer(); if (!L || !L.el) return null;
    const g = geom(view.width, view.height, L), r = cropRect(g, cropOf(L.seg)), l = toLocal(g, p);
    for (const [hx, hy] of cutHandles()) {
      const x = r.x0 + (hx + 1) * (r.x1 - r.x0) / 2, y = r.y0 + (hy + 1) * (r.y1 - r.y0) / 2;
      if (Math.abs(l.x - x) <= 14 * p.k && Math.abs(l.y - y) <= 14 * p.k) return [hx, hy];
    }
    return null;
  }
  function insideCrop(p) {
    const L = mainLayer(); if (!L || !L.el) return false;
    const g = geom(view.width, view.height, L), r = cropRect(g, cropOf(L.seg)), l = toLocal(g, p);
    return l.x >= r.x0 && l.x <= r.x1 && l.y >= r.y0 && l.y <= r.y1;
  }
  function startZoom(e, p0) {
    e.preventDefault();
    snapshot();
    const seg = segs[playIdx], g = geom(view.width, view.height, mainLayer());
    const d0 = Math.hypot(p0.x - g.cx, p0.y - g.cy) || 1, z0 = seg.zoom || 1;
    dragWindow((ev) => {
      const p = toCanvas(ev);
      seg.zoom = +clamp(z0 * Math.hypot(p.x - g.cx, p.y - g.cy) / d0, 0.2, 5).toFixed(3);
    }, renderCutView);
  }
  function setCrop(seg, c) {
    const r = (x) => +x.toFixed(4);
    const x = clamp(c.x, 0, 0.95), y = clamp(c.y, 0, 0.95), w = clamp(c.w, 0.05, 1 - x), h = clamp(c.h, 0.05, 1 - y);
    if (x < 0.0005 && y < 0.0005 && w > 0.9995 && h > 0.9995) delete seg.crop; else seg.crop = { x: r(x), y: r(y), w: r(w), h: r(h) };
  }
  function lockRatio(L) {
    if (cropLockKey === 'orig') return L.w / L.h;
    if (cropLockKey === 'out') { const [W, H] = outSize(); return W / H; }
    return RATIOS[cropLockKey] ? RATIOS[cropLockKey][0] / RATIOS[cropLockKey][1] : 0;
  }
  // drag a crop handle ([0,0] = move the whole crop window); all math is in the video's own (unflipped) space
  function startCrop(e, [hx, hy], p0) {
    e.preventDefault();
    snapshot();
    const L = mainLayer(), seg = L.seg, g = geom(view.width, view.height, L), r0 = cropRect(g, cropOf(seg));
    const bx = g.dw / 2, by = g.dh / 2, minW = g.dw * 0.05, minH = g.dh * 0.05, ratio = lockRatio(L), l0 = toLocal(g, p0);
    dragWindow((ev) => {
      const l = toLocal(g, toCanvas(ev)), dx = l.x - l0.x, dy = l.y - l0.y;
      let { x0, y0, x1, y1 } = r0;
      if (!hx && !hy) {
        const w = r0.x1 - r0.x0, h = r0.y1 - r0.y0;
        x0 = clamp(r0.x0 + dx, -bx, bx - w); y0 = clamp(r0.y0 + dy, -by, by - h); x1 = x0 + w; y1 = y0 + h;
      } else if (ratio && hx && hy) {   // locked ratio: the opposite corner stays, width follows the pointer
        const fx = hx < 0 ? r0.x1 : r0.x0, fy = hy < 0 ? r0.y1 : r0.y0;
        const maxW = Math.min(hx < 0 ? fx + bx : bx - fx, (hy < 0 ? fy + by : by - fy) * ratio);
        const w = clamp(Math.abs((hx < 0 ? r0.x0 : r0.x1) + dx - fx), minW, Math.max(minW, maxW)), h = w / ratio;
        x0 = hx < 0 ? fx - w : fx; x1 = x0 + w; y0 = hy < 0 ? fy - h : fy; y1 = y0 + h;
      } else {
        if (hx < 0) x0 = clamp(r0.x0 + dx, -bx, r0.x1 - minW); else if (hx > 0) x1 = clamp(r0.x1 + dx, r0.x0 + minW, bx);
        if (hy < 0) y0 = clamp(r0.y0 + dy, -by, r0.y1 - minH); else if (hy > 0) y1 = clamp(r0.y1 + dy, r0.y0 + minH, by);
      }
      setCrop(seg, { x: (x0 + bx) / g.dw, y: (y0 + by) / g.dh, w: (x1 - x0) / g.dw, h: (y1 - y0) / g.dh });
    }, renderCutView);
  }
  // largest crop of the chosen ratio, centred on the current crop
  function applyCropRatio() {
    const L = mainLayer(), ratio = L && lockRatio(L);
    if (!L || !ratio) return;
    const c = cropOf(L.seg), cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    let w = 1, h = L.w / ratio / L.h;
    if (h > 1) { h = 1; w = ratio * L.h / L.w; }
    setCrop(L.seg, { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h });
  }
  // zoom/move the cut so the cropped area fills the output frame (per the 화면 setting)
  function fitCrop() {
    const L = mainLayer(), seg = segs[playIdx];
    if (!L || !L.el) return;
    const cw = view.width, ch = view.height, c = cropOf(seg);
    const pick = fitMode === 'cover' ? Math.max : Math.min;
    const sc0 = pick(cw / L.w, ch / L.h), f = seg.flip ? -1 : 1;
    seg.zoom = +clamp(pick(cw / (c.w * L.w), ch / (c.h * L.h)) / sc0, 0.2, 5).toFixed(3);
    const sc = sc0 * seg.zoom;
    seg.px = +(-f * (c.x + c.w / 2 - 0.5) * L.w * sc / cw).toFixed(4);
    seg.py = +(-(c.y + c.h / 2 - 0.5) * L.h * sc / ch).toFixed(4);
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
    segs.forEach((seg, i) => {   // transition zones (the two cuts overlap here)
      const td = tdur(i);
      if (!td) return;
      const m = document.createElement('div');
      m.className = 'trans';
      m.style.left = offset(i) * pps + 'px';
      m.style.width = Math.max(td * pps, 12) + 'px';
      m.dataset.i = i;
      m.title = '전환: ' + TRANS.find((t) => t[0] === seg.trans.type)[1] + ' ' + td.toFixed(1) + '초';
      m.innerHTML = '<span>⇄</span><i class="handle r"></i>';
      track.appendChild(m);
    });
    segs.forEach((seg, i) => {   // fade-out zones at the end of a cut
      const f = fdur(i);
      if (!f) return;
      const m = document.createElement('div');
      m.className = 'fadeout';
      m.style.left = (offset(i) + len(seg) - f) * pps + 'px';
      m.style.width = Math.max(f * pps, 6) + 'px';
      m.title = '끝 페이드 아웃 ' + f.toFixed(1) + '초';
      track.appendChild(m);
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
    const miss = sources.filter((s) => s.missing);
    if (miss.length) {
      const li = document.createElement('li');
      li.className = 'pending err relink';
      li.innerHTML = '<span class="d"><em>원본 영상을 다시 연결하세요</em><small></small></span><button title="파일 선택">파일 선택</button>';
      li.querySelector('small').textContent = miss.map((m) => m.name).join(', ') + ' — 같은 파일을 선택하면 자동으로 연결됩니다.';
      li.querySelector('button').onclick = () => $('file').click();
      ol.appendChild(li);
    }
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
      em.textContent = (src.missing ? '⚠ ' : '') + src.name; em.style.color = `hsl(${src.hue} 70% 70%)`;
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

  // ---------- cut panel: screen (zoom / position / flip), crop, transition of the cut under the playhead ----------
  let cutViewIdx = -1;
  const curTrans = () => (playIdx > 0 ? segs[playIdx].trans || { type: 'none', dur: 0.5 } : transDefault);
  function renderCutView() {
    const box = $('cutView'), seg = segs[playIdx];
    cutViewIdx = playIdx;
    if (!seg) { box.innerHTML = ''; return; }
    const row = (k, label, min, max, step, val, scale) =>
      `<div class="f"><label>${label}</label><div class="row"><input type="range" data-cv="${k}" data-scale="${scale}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${val}</output></div></div>`;
    const c = cropOf(seg), pct = (x) => Math.max(0, Math.round(x * 100)), tr = curTrans(), eff = playIdx > 0 ? tdur(playIdx) : 0;
    box.innerHTML = `<h3>컷 ${playIdx + 1} 화면</h3>` +
      row('zoom', '확대', 20, 500, 1, Math.round((seg.zoom || 1) * 100), 0.01) +
      row('px', '가로 위치', -100, 100, 1, Math.round((seg.px || 0) * 100), 0.01) +
      row('py', '세로 위치', -100, 100, 1, Math.round((seg.py || 0) * 100), 0.01) +
      `<div class="f"><label><input type="checkbox" data-cv="flip"> 좌우 반전</label></div>` +
      `<div class="actions"><button class="btn" data-cvreset="1">화면 초기화</button></div>` +
      `<p class="hint">미리보기: 영상을 끌면 이동, 마우스 휠/오른쪽 아래 모서리 끌기로 확대·축소</p>` +
      `<h3>크롭 (잘라내기)</h3>` +
      `<div class="actions"><button class="btn${cropMode ? ' on' : ''}" data-cvact="crop">✂ 크롭 편집</button><button class="btn" data-cvact="fit">프레임에 맞추기</button><button class="btn" data-cvact="uncrop">크롭 해제</button></div>` +
      `<div class="f"><label>비율 고정</label><select data-cropar>${CROP_AR.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></div>` +
      row('cl', '왼쪽 자르기', 0, 90, 1, pct(c.x), 0.01) + row('cr', '오른쪽 자르기', 0, 90, 1, pct(1 - c.x - c.w), 0.01) +
      row('ct', '위쪽 자르기', 0, 90, 1, pct(c.y), 0.01) + row('cb', '아래쪽 자르기', 0, 90, 1, pct(1 - c.y - c.h), 0.01) +
      `<p class="hint">[크롭 편집]을 켜고 미리보기의 테두리/모서리를 끌면 잘라냅니다 (안쪽을 끌면 크롭 창 이동). 자른 뒤 [프레임에 맞추기]로 화면을 채우세요.</p>` +
      `<h3>${playIdx ? `전환 · 컷 ${playIdx} → 컷 ${playIdx + 1}` : '전환 (첫 컷에는 적용되지 않음 · 일괄 적용용 설정)'}</h3>` +
      `<div class="f"><label>효과</label><select data-tr="type">${TRANS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></div>` +
      `<div class="f"><label>길이</label><div class="row"><input type="range" data-tr="dur" min="1" max="30" step="1" value="${Math.round(tr.dur * 10)}"><output>${tr.dur.toFixed(1)}초</output></div></div>` +
      `<div class="actions"><button class="btn" data-cvact="trall">모든 컷 사이에 적용</button></div>` +
      `<p class="hint">전환 구간만큼 두 컷이 겹쳐 전체 길이가 짧아집니다.${playIdx && tr.type !== 'none' && eff < tr.dur - 0.01 ? ` 이 컷은 짧아서 실제로는 ${eff.toFixed(2)}초 적용됩니다.` : ''}</p>`;
    const fo = seg.fadeOut || 0, nextTr = tdur(playIdx + 1) > 0;
    box.insertAdjacentHTML('beforeend',
      `<h3>컷 ${playIdx + 1} 끝 페이드 아웃</h3><div class="f"><label>검정으로 사라지기</label><div class="row"><input type="range" data-fo min="0" max="50" step="1" value="${Math.round(fo * 10)}"><output>${fo ? fo.toFixed(1) + '초' : '없음'}</output></div></div>` +
      `<div class="actions"><button class="btn" data-cvact="foall">모든 컷 끝에 적용</button></div>` +
      `<p class="hint">이 컷의 끝에서 화면(텍스트/이미지 포함)과 소리가 함께 검정으로 사라집니다. 0이면 사용하지 않습니다.${fo && nextTr ? ' 다음 컷에 전환이 있어 지금은 적용되지 않습니다.' : ''}</p>`);
    box.querySelector('[data-cv=flip]').checked = !!seg.flip;
    box.querySelector('[data-cropar]').value = cropLockKey;
    box.querySelector('[data-tr=type]').value = tr.type;
    box.querySelector('[data-tr=dur]').disabled = tr.type === 'none';
  }
  $('cutView').addEventListener('input', (e) => {
    const el = e.target, seg = segs[playIdx], box = $('cutView');
    if (!seg) return;
    if (el.dataset.tr) {
      if (armed) { snapshot(); armed = false; }
      const patch = el.dataset.tr === 'type' ? { type: el.value } : { dur: +el.value / 10 };
      if (patch.dur) el.parentElement.querySelector('output').textContent = patch.dur.toFixed(1) + '초';
      if (patch.type) box.querySelector('[data-tr=dur]').disabled = patch.type === 'none';
      if (playIdx > 0) seg.trans = { ...curTrans(), ...patch }; else Object.assign(transDefault, patch);
      renderTimeline();
      return;
    }
    if ('fo' in el.dataset) {
      if (armed) { snapshot(); armed = false; }
      const f = +el.value / 10;
      if (f) seg.fadeOut = f; else delete seg.fadeOut;
      el.parentElement.querySelector('output').textContent = f ? f.toFixed(1) + '초' : '없음';
      renderTimeline();
      return;
    }
    if ('cropar' in el.dataset) { snapshot(); cropLockKey = el.value; applyCropRatio(); renderCutView(); return; }
    const k = el.dataset.cv;
    if (!k) return;
    if (armed) { snapshot(); armed = false; }
    if (el.type === 'checkbox') seg[k] = el.checked;
    else if (k.length === 2 && k[0] === 'c') {   // crop sliders: how much is cut off each side (%)
      const c = cropOf(seg), m = { l: c.x, t: c.y, r: 1 - c.x - c.w, b: 1 - c.y - c.h };
      const side = { cl: 'l', cr: 'r', ct: 't', cb: 'b' }[k], opp = { l: 'r', r: 'l', t: 'b', b: 't' }[side];
      m[side] = clamp(+el.value / 100, 0, 0.95 - Math.max(0, m[opp]));
      el.value = Math.round(m[side] * 100);
      el.parentElement.querySelector('output').textContent = el.value;
      cropLockKey = 'free'; box.querySelector('[data-cropar]').value = 'free';
      setCrop(seg, { x: m.l, y: m.t, w: 1 - m.l - m.r, h: 1 - m.t - m.b });
    } else { seg[k] = +(parseFloat(el.value) * parseFloat(el.dataset.scale)).toFixed(4); el.parentElement.querySelector('output').textContent = el.value; }
  });
  $('cutView').addEventListener('change', () => { armed = true; });
  $('cutView').addEventListener('click', (e) => {
    const b = e.target.closest('button'), seg = segs[playIdx];
    if (!b || !seg) return;
    if (b.dataset.cvreset) { snapshot(); Object.assign(seg, { zoom: 1, px: 0, py: 0, flip: false }); }
    else if (b.dataset.cvact === 'crop') cropMode = !cropMode;
    else if (b.dataset.cvact === 'fit') { snapshot(); fitCrop(); }
    else if (b.dataset.cvact === 'uncrop') { snapshot(); delete seg.crop; cropLockKey = 'free'; }
    else if (b.dataset.cvact === 'foall') {
      snapshot();
      segs.forEach((sg) => { if (seg.fadeOut) sg.fadeOut = seg.fadeOut; else delete sg.fadeOut; });
      renderTimeline();
    } else if (b.dataset.cvact === 'trall') {
      snapshot();
      const t = curTrans();
      segs.forEach((sg, i) => { if (i > 0) sg.trans = { type: t.type, dur: t.dur }; });
      renderTimeline();
    } else return;
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
    const b = { ...seg, id: nextId++, start: s, end: seg.end };
    delete b.trans;   // the second half continues the first one, no transition between
    const a = { ...seg, id: nextId++, start: seg.start, end: s };
    delete a.fadeOut;   // the fade-out stays with the part that ends the cut
    segs.splice(playIdx, 1, a, b);
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
    if (srcOf(segs[playIdx]).missing) { alert('원본 영상을 다시 연결해야 재생할 수 있습니다.\n컷 목록의 [파일 선택]으로 영상을 다시 선택하세요.'); return; }
    const s = segs[playIdx];
    if (v.currentTime < s.start - 0.05 || v.currentTime >= s.end - 0.03) v.currentTime = s.start;
    v.play();
  }
  function pause() { v.pause(); }

  function tick() {
    if (loaded() && !v.paused) {
      const seg = segs[playIdx];
      const next = segs[playIdx + 1];
      const td = mode === 'all' && next ? tdur(playIdx + 1) : 0;   // next cut starts this early, overlapping this one
      const switchAt = td ? seg.end - td : seg.end - 0.03;
      // pre-seek the next cut's video so the switch is seamless
      if (mode === 'all' && next && prepped !== playIdx && switchAt - v.currentTime < 0.4) {
        prepped = playIdx;
        const ns = srcOf(next), el = td && ns.el === v ? altEl(ns) : ns.el;
        if (el !== v && !(out && out.el === el)) el.currentTime = next.start;
      }
      if (v.currentTime >= switchAt) {
        if (mode === 'cut') {
          if ($('loop').checked || exporting) v.currentTime = seg.start; else { v.pause(); v.currentTime = seg.start; }
        } else if (next) {
          const sameSrc = next.src === seg.src;
          const old = v, ns = srcOf(next);
          playIdx++;
          if (td) {   // transition: this cut keeps playing underneath while the next one starts on another element
            let el = ns.el;
            if (el === old || (out && out.el === el)) el = altEl(ns);
            clearOut();
            out = { el: old, idx: playIdx - 1 };
            v = el;
            if (Math.abs(v.currentTime - next.start) > 0.06) v.currentTime = next.start;
            v.play();
          } else if (sameSrc) {
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
    const i = cutAt(t);
    goto(i, segs[i].start + clamp(t - offset(i), 0, len(segs[i])));
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
    const tm = e.target.closest('.trans');   // only its right handle is clickable: trims the previous cut
    const clip = e.target.closest('.oclip');
    if (tm) return startTrim(e, +tm.dataset.i - 1, false);
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
    if (segs.some((_, i) => tdur(i))) {
      alert('컷 전환 효과가 있는 영상은 WebCodecs를 지원하는 최신 Chrome/Edge에서만 내보낼 수 있습니다.\n(전환을 [없음]으로 바꾸면 이 브라우저에서도 내보낼 수 있습니다)');
      return;
    }
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

    const totalFrames = Math.max(1, Math.round(total() * FPS));
    let done = 0;

    if (ac) {
      // mix every cut at its timeline position; overlapping transition zones are cross-faded (equal power)
      const n = Math.ceil(total() * ac.sr);
      const flat = [new Float32Array(n), new Float32Array(n)];
      segs.forEach((sg, i) => {
        const buf = bufs.get(sg.src);
        if (!buf) return;
        const o = Math.round(offset(i) * ac.sr), a = Math.floor(sg.start * ac.sr), full = Math.floor(len(sg) * ac.sr);
        const L = Math.min(full, n - o), hin = Math.floor(tdur(i) * ac.sr), hout = Math.floor(tdur(i + 1) * ac.sr), fo = Math.floor(fdur(i) * ac.sr);
        for (let c = 0; c < 2; c++) {
          const d = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)), f = flat[c];
          for (let j = 0; j < L; j++) {
            let g = j < hin ? Math.sin(j / hin * Math.PI / 2) : j >= full - hout ? Math.cos((j - (full - hout)) / hout * Math.PI / 2) : 1;
            if (fo && j >= full - fo) g *= 1 - (j - (full - fo)) / fo;   // fade-out to black: sound matches the picture
            f[o + j] += (d[a + j] || 0) * g;
          }
        }
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

    for (let k = 0; k < totalFrames; k++) {
      if (cancelExport) break;
      if (encErr) throw encErr;
      const t = k / FPS, i = cutAt(t), seg = segs[i], src = srcOf(seg), td = tdur(i), dt = Math.max(0, t - offset(i));
      await seekTo(src.el, Math.min(seg.start + dt, seg.end - 0.001));
      let o = null, tr = null;
      if (td && dt < td) {   // inside a transition: the previous cut is drawn too, from its own element
        const ps = segs[i - 1], psrc = srcOf(ps), el = psrc.el === src.el ? altEl(psrc) : psrc.el;
        await seekTo(el, Math.min(ps.end - td + dt, ps.end - 0.001));
        o = { el, w: psrc.w, h: psrc.h, seg: ps }; tr = { type: seg.trans.type, p: dt / td };
      }
      drawScene(ctx, W, H, t, { el: src.el, w: src.w, h: src.h, seg }, o, tr, false);
      const frame = new VideoFrame(cv, { timestamp: Math.round(done * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      venc.encode(frame, { keyFrame: done % 60 === 0 });
      frame.close();
      done++;
      while (venc.encodeQueueSize > 8) await sleep(2);
      if (done % 5 === 0) { setProgress(done / totalFrames); await sleep(0); }
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
    const miss = sources.filter((s) => s.missing);
    if (miss.length) { alert('원본 영상을 다시 연결해야 내보낼 수 있습니다:\n' + miss.map((m) => '· ' + m.name).join('\n')); return; }
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

  // ---------- project save / restore (edit decisions only; videos are re-linked by name + size) ----------
  const DB = 'videoeditool-db', ST = 'kv';
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(ST); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const kv = async (mode, fn) => { const db = await idb(); return new Promise((res, rej) => { const q = fn(db.transaction(ST, mode).objectStore(ST)); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); };
  const kvGet = (k) => kv('readonly', (s) => s.get(k));
  const kvSet = (k, val) => kv('readwrite', (s) => s.put(val, k));
  const kvDel = (k) => kv('readwrite', (s) => s.delete(k));

  function serialize() {
    return {
      v: 1, ratioKey, fitMode, nextId, segs, overlays,
      sources: sources.map((s) => ({ id: s.id, name: s.name, size: s.size, lastModified: s.lastModified, duration: s.duration, w: s.w, h: s.h, hue: s.hue })),
      imgs: [...imgs].map(([id, im]) => ({ id, name: im.name, dataUrl: im.dataUrl })),
    };
  }

  function resetProject() {
    for (const s of sources) { s.el.remove(); if (s.alt) s.alt.remove(); if (s.url) URL.revokeObjectURL(s.url); }
    out = null; cropMode = false; cropLockKey = 'free';
    sources.length = 0; imgs.clear();
    segs = []; overlays = []; selOv = null; v = null; sel = 0; playIdx = 0; history = []; pending.length = 0; cutViewIdx = -1;
    $('undo').disabled = true;
  }

  // saved projects may predate (or garble) the transition / crop fields
  function cleanSeg(sg) {
    const o = { ...sg }, t = o.trans, c = o.crop;
    if (t && TRANS_TYPES.has(t.type) && t.type !== 'none') o.trans = { type: t.type, dur: clamp(+t.dur || 0.5, 0.1, 3) }; else delete o.trans;
    if (+o.fadeOut > 0) o.fadeOut = clamp(+o.fadeOut, 0.1, 5); else delete o.fadeOut;
    if (c && [c.x, c.y, c.w, c.h].every(Number.isFinite) && c.x >= 0 && c.y >= 0 && c.w > 0.01 && c.h > 0.01 && c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001) o.crop = { x: c.x, y: c.y, w: c.w, h: c.h }; else delete o.crop;
    return o;
  }

  async function applyProject(p) {
    if (!p || p.v !== 1 || !Array.isArray(p.segs) || !Array.isArray(p.sources) || !p.segs.length) throw new Error('프로젝트 파일 형식이 올바르지 않습니다.');
    resetProject();
    ratioKey = RATIOS[p.ratioKey] || p.ratioKey === 'orig' ? p.ratioKey : 'orig';
    fitMode = p.fitMode === 'cover' ? 'cover' : 'contain';
    $('ratio').value = ratioKey; $('fit').value = fitMode;
    for (const s of p.sources) sources.push({ ...s, file: null, url: null, el: makeVideoEl(), thumbs: [], audio: undefined, missing: true });
    for (const im of p.imgs || []) {
      const el = new Image(); el.src = im.dataUrl;
      try { await el.decode(); imgs.set(im.id, { el, w: el.naturalWidth || 400, h: el.naturalHeight || 400, name: im.name, dataUrl: im.dataUrl }); } catch (e) { /* skip broken image */ }
    }
    segs = p.segs.filter((sg) => sources.some((x) => x.id === sg.src)).map(cleanSeg);
    overlays = (p.overlays || []).filter((o) => o.type === 'text' || imgs.has(o.imgId));
    nextId = Math.max(p.nextId || 1, ...segs.map((x) => x.id + 1), ...overlays.map((o) => o.id + 1), ...sources.map((x) => x.id + 1), ...[...imgs.keys()].map((k) => k + 1));
    if (!segs.length) throw new Error('프로젝트에 컷이 없습니다.');
    activate(srcOf(segs[0]));
    tab = 'cuts';
    setupCanvas(); enableUI(); fitZoom(); render(); renderEdit();
  }

  let lastSig = '', saveBusy = false;
  const setSaveState = (t) => { $('saveState').textContent = t; };
  async function autosave(force) {
    if (!loaded() || exporting || saveBusy) return;
    const body = JSON.stringify(serialize());
    if (body === lastSig && !force) return;
    saveBusy = true;
    try { await kvSet('autosave', { savedAt: Date.now(), body }); lastSig = body; setSaveState('자동 저장됨 ' + new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })); }
    catch (e) { setSaveState('자동 저장 불가 — [저장]으로 파일에 저장하세요'); }
    saveBusy = false;
  }
  setInterval(autosave, 2000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) autosave(); });

  function saveProjectFile() {
    if (!loaded()) return;
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    const name = `project-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.json`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(serialize())], { type: 'application/json' }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function openProjectFile(f) {
    if (!f) return;
    if (loaded() && !confirm('현재 작업을 닫고 프로젝트 파일을 불러올까요?')) return;
    try { await applyProject(JSON.parse(await f.text())); $('restoreBar').hidden = true; }
    catch (e) { alert('프로젝트를 불러오지 못했습니다.\n' + e.message); }
  }

  async function checkAutosave() {
    try {
      const rec = await kvGet('autosave');
      if (!rec) return;
      const p = JSON.parse(rec.body);
      if (!p.segs || !p.segs.length) return;
      $('restoreInfo').textContent = `이전 작업이 있습니다 · ${new Date(rec.savedAt).toLocaleString('ko-KR')} · 컷 ${p.segs.length}개 · 영상 ${p.sources.length}개`;
      $('restoreBar').hidden = false;
      $('restoreGo').onclick = async () => {
        try { await applyProject(p); $('restoreBar').hidden = true; lastSig = rec.body; }
        catch (e) { alert('불러오지 못했습니다.\n' + e.message); }
      };
      $('restoreDel').onclick = async () => { if (!confirm('저장된 이전 작업을 삭제할까요?')) return; try { await kvDel('autosave'); } catch (e) {} $('restoreBar').hidden = true; };
    } catch (e) { setSaveState('자동 저장을 사용할 수 없는 환경입니다'); }
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
  $('saveProj').onclick = saveProjectFile;
  $('projFile').onchange = (e) => { openProjectFile(e.target.files[0]); e.target.value = ''; };
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
    get segs() { return segs; }, get sources() { return sources; }, get overlays() { return overlays; }, get playIdx() { return playIdx; }, get view() { return view; },
    split, deleteCut, moveCut, setMode, play, pause, seekEdit, addFiles, addImages, addText, undo, total, offset, tdur, drawScene, cropOf,
    setFade(i, f) { segs[i].fadeOut = f; renderTimeline(); }, fadeAlpha, fdur,
    setTrans(i, type, dur = 0.5) { segs[i].trans = { type, dur }; renderTimeline(); }, setCrop(i, c) { setCrop(segs[i], c); }, exportVideo,
    setRatio(k) { $('ratio').value = k; ratioKey = k; setupCanvas(); }, setFit(k) { $('fit').value = k; fitMode = k; },
  };

  renderList(); renderEdit(); renderTabs(); renderCutView();
  checkAutosave();
  requestAnimationFrame(tick);
})();
