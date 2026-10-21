(() => {
  const $ = (id) => document.getElementById(id);
  const v = $('video'), scroller = $('scroller'), ruler = $('ruler'), track = $('track'), playhead = $('playhead');
  const MIN_LEN = 0.1, FRAME = 1 / 30, THUMB_H = 56;

  let segs = [];          // [{id,start,end}] in source seconds, in playback order
  let sel = 0;            // selected cut
  let playIdx = 0;        // cut the playhead is currently in
  let pps = 60;           // pixels per second
  let mode = 'all';       // 'all' | 'cut'
  let duration = 0;
  let thumbs = [];        // canvases sampled across the source
  let history = [];
  let nextId = 1;
  let exporting = false;
  let onEnd = null;
  let objectUrl = null;

  const fmt = (t) => {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60), s = t - m * 60;
    return String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0');
  };
  const total = () => segs.reduce((a, s) => a + (s.end - s.start), 0);
  const offset = (i) => segs.slice(0, i).reduce((a, s) => a + (s.end - s.start), 0);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const loaded = () => segs.length > 0;

  // ---------- history ----------
  function snapshot() {
    history.push(JSON.stringify({ segs, sel }));
    if (history.length > 100) history.shift();
    $('undo').disabled = false;
  }
  function undo() {
    if (!history.length || exporting) return;
    const h = JSON.parse(history.pop());
    segs = h.segs; sel = clamp(h.sel, 0, segs.length - 1);
    playIdx = clamp(playIdx, 0, segs.length - 1);
    $('undo').disabled = !history.length;
    render();
  }

  // ---------- loading ----------
  async function openFile(file) {
    if (!file || !file.type.startsWith('video/')) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    v.src = objectUrl;
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('이 브라우저에서 재생할 수 없는 영상 형식입니다.')); })
      .catch((e) => { alert(e.message); throw e; });
    duration = v.duration;
    segs = [{ id: nextId++, start: 0, end: duration }];
    sel = 0; playIdx = 0; history = []; thumbs = [];
    $('empty').hidden = true;
    for (const id of ['play', 'modeAll', 'modeCut', 'split', 'del', 'export']) $(id).disabled = false;
    $('undo').disabled = true;
    fitZoom();
    render();
    makeThumbs(objectUrl);
  }

  async function makeThumbs(url) {
    const tv = document.createElement('video');
    tv.muted = true; tv.preload = 'auto'; tv.src = url;
    await new Promise((r) => { tv.onloadeddata = r; tv.onerror = r; });
    const n = clamp(Math.ceil(duration / 2), 8, 60);
    const w = Math.round(THUMB_H * (tv.videoWidth / tv.videoHeight || 16 / 9));
    for (let k = 0; k < n; k++) {
      if (url !== objectUrl) return;
      tv.currentTime = Math.min(duration - 0.01, (k + 0.5) * duration / n);
      await new Promise((r) => { tv.onseeked = r; });
      const c = document.createElement('canvas');
      c.width = w; c.height = THUMB_H;
      c.getContext('2d').drawImage(tv, 0, 0, w, THUMB_H);
      thumbs.push(c);
      if (k % 6 === 5 || k === n - 1) drawBlocks();
    }
  }

  // ---------- timeline rendering ----------
  function fitZoom() {
    const avail = scroller.clientWidth - 24;
    pps = clamp(avail / Math.max(duration, 1), 10, 400);
    $('zoom').value = pps;
  }

  function render() {
    renderTimeline();
    renderList();
    updateTime();
    $('del').disabled = segs.length <= 1;
  }

  function renderTimeline() {
    const w = Math.max(total() * pps + 40, scroller.clientWidth);
    ruler.style.width = track.style.width = w + 'px';
    // ruler ticks
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * pps >= 70) || 600;
    ruler.innerHTML = '';
    for (let t = 0; t <= total(); t += step) {
      const s = document.createElement('span');
      s.style.left = t * pps + 'px';
      s.textContent = fmt(t).replace(/\.00$/, '');
      ruler.appendChild(s);
    }
    // blocks
    track.innerHTML = '';
    segs.forEach((seg, i) => {
      const b = document.createElement('div');
      b.className = 'block' + (i === sel ? ' sel' : '');
      b.style.left = offset(i) * pps + 'px';
      b.style.width = (seg.end - seg.start) * pps + 'px';
      b.dataset.i = i;
      b.innerHTML = '<canvas></canvas><b>' + (i + 1) + ' · ' + (seg.end - seg.start).toFixed(1) + 's</b><i class="handle l"></i><i class="handle r"></i>';
      track.appendChild(b);
    });
    drawBlocks();
    movePlayhead();
  }

  function drawBlocks() {
    if (!thumbs.length) return;
    track.querySelectorAll('.block').forEach((b) => {
      const seg = segs[+b.dataset.i];
      if (!seg) return;
      const c = b.querySelector('canvas');
      const w = Math.max(1, Math.round((seg.end - seg.start) * pps));
      c.width = w; c.height = THUMB_H;
      const ctx = c.getContext('2d');
      const tw = thumbs[0].width;
      for (let x = 0; x < w; x += tw) {
        const srcT = seg.start + (x + tw / 2) / pps;
        const k = clamp(Math.floor(srcT / duration * thumbs.length), 0, thumbs.length - 1);
        ctx.drawImage(thumbs[k], x, 0);
      }
    });
  }

  function renderList() {
    const ol = $('cutList');
    ol.innerHTML = '';
    segs.forEach((seg, i) => {
      const li = document.createElement('li');
      li.className = i === sel ? 'sel' : '';
      li.innerHTML = '<span class="n">' + (i + 1) + '</span><span class="d">' + fmt(seg.start) + ' – ' + fmt(seg.end) + ' (' + (seg.end - seg.start).toFixed(1) + 's)</span>' +
        '<button data-a="up" title="앞으로"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button data-a="down" title="뒤로"' + (i === segs.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button data-a="del" title="삭제"' + (segs.length <= 1 ? ' disabled' : '') + '>✕</button>';
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
  }

  function movePlayhead() {
    if (!loaded()) return;
    const seg = segs[playIdx];
    const t = offset(playIdx) + clamp(v.currentTime - seg.start, 0, seg.end - seg.start);
    playhead.style.left = t * pps + 'px';
    return t;
  }

  function updateTime() {
    const t = movePlayhead() || 0;
    $('time').textContent = fmt(t) + ' / ' + fmt(total());
    return t;
  }

  // ---------- editing ----------
  function selectCut(i, seek) {
    sel = i;
    if (seek) { playIdx = i; v.currentTime = segs[i].start; }
    render();
  }

  function split() {
    if (!loaded() || exporting) return;
    const seg = segs[playIdx], s = v.currentTime;
    if (s - seg.start < MIN_LEN || seg.end - s < MIN_LEN) return;
    snapshot();
    segs.splice(playIdx, 1, { id: nextId++, start: seg.start, end: s }, { id: nextId++, start: s, end: seg.end });
    sel = playIdx + 1; playIdx = sel;
    render();
  }

  function deleteCut(i = sel) {
    if (segs.length <= 1 || exporting) return;
    snapshot();
    segs.splice(i, 1);
    sel = clamp(i, 0, segs.length - 1);
    playIdx = sel; v.currentTime = segs[sel].start;
    render();
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
    if (m === 'cut') { playIdx = sel; const s = segs[sel]; if (v.currentTime < s.start || v.currentTime >= s.end) v.currentTime = s.start; }
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
      if (v.currentTime >= seg.end - 0.03) {
        if (mode === 'cut') {
          if ($('loop').checked || exporting) v.currentTime = seg.start; else { v.pause(); v.currentTime = seg.start; }
        } else if (playIdx + 1 < segs.length) {
          playIdx++;
          const nx = segs[playIdx];
          if (Math.abs(nx.start - v.currentTime) > 0.06) v.currentTime = nx.start;
          if (!exporting) { sel = playIdx; renderList(); track.querySelectorAll('.block').forEach((b) => b.classList.toggle('sel', +b.dataset.i === sel)); }
        } else {
          v.pause();
          if (onEnd) onEnd(); else { playIdx = 0; v.currentTime = segs[0].start; }
        }
      }
      // keep the playhead in view while playing
      const x = movePlayhead() * pps;
      if (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth - 20) scroller.scrollLeft = Math.max(0, x - 40);
    }
    updateTime();
    requestAnimationFrame(tick);
  }

  function seekEdit(t) {
    if (!loaded()) return;
    t = clamp(t, 0, total());
    let acc = 0, i = 0;
    for (; i < segs.length - 1; i++) { const d = segs[i].end - segs[i].start; if (t < acc + d) break; acc += d; }
    playIdx = i;
    v.currentTime = segs[i].start + clamp(t - acc, 0, segs[i].end - segs[i].start);
    if (mode === 'cut') { sel = i; render(); }
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

  scroller.addEventListener('pointerdown', (e) => {
    if (!loaded() || exporting) return;
    const handle = e.target.closest('.handle');
    const block = e.target.closest('.block');
    if (handle && block) return startTrim(e, +block.dataset.i, handle.classList.contains('l'));
    if (block) { selectCutAt(e, +block.dataset.i); }
    else seekEdit(xToEdit(e.clientX));
    // scrub while dragging
    const move = (ev) => seekEdit(xToEdit(ev.clientX));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });

  function selectCutAt(e, i) {
    sel = i;
    const t = xToEdit(e.clientX);
    seekEdit(t);
    render();
  }

  function startTrim(e, i, isLeft) {
    e.preventDefault();
    snapshot();
    sel = i; playIdx = i;
    const seg = segs[i], x0 = e.clientX, orig = isLeft ? seg.start : seg.end;
    const move = (ev) => {
      const dt = (ev.clientX - x0) / pps;
      if (isLeft) seg.start = clamp(orig + dt, 0, seg.end - MIN_LEN);
      else seg.end = clamp(orig + dt, seg.start + MIN_LEN, duration);
      v.pause();
      v.currentTime = isLeft ? seg.start : Math.max(seg.start, seg.end - 0.05);
      render();
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
    render();
  }

  // ---------- export (records the edited playback in real time) ----------
  function pickMime() {
    return ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  }

  async function exportVideo() {
    const mime = pickMime();
    const capture = v.captureStream || v.mozCaptureStream;
    if (!mime || !capture) { alert('이 브라우저는 내보내기를 지원하지 않습니다. 최신 Chrome/Edge/Firefox를 사용하세요.'); return; }
    exporting = true;
    $('exportOverlay').hidden = false;
    pause(); setMode('all'); playIdx = 0;
    v.currentTime = segs[0].start;
    await new Promise((r) => { if (!v.seeking) return r(); v.onseeked = r; });
    const stream = capture.call(v);
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    let cancelled = false;
    const finish = new Promise((res) => { rec.onstop = res; });
    onEnd = () => rec.state !== 'inactive' && rec.stop();
    $('exportCancel').onclick = () => { cancelled = true; v.pause(); if (rec.state !== 'inactive') rec.stop(); };
    const prog = setInterval(() => {
      const p = Math.min(1, updateTime() / total());
      $('exportPct').textContent = Math.round(p * 100) + '%';
      $('exportBar').style.width = p * 100 + '%';
    }, 200);
    rec.start(1000);
    v.play();
    await finish;
    clearInterval(prog);
    onEnd = null; exporting = false;
    $('exportOverlay').hidden = true;
    stream.getTracks().forEach((t) => t.stop());
    playIdx = 0; v.currentTime = segs[0].start;
    if (cancelled) return;
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(chunks, { type: mime }));
    a.download = 'edited.' + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---------- wiring ----------
  $('file').onchange = (e) => openFile(e.target.files[0]).catch(() => {});
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (e) => openFile(e.dataTransfer.files[0]).catch(() => {}));

  $('play').onclick = () => (v.paused ? play() : pause());
  v.addEventListener('play', () => { $('play').textContent = '⏸ 일시정지'; });
  v.addEventListener('pause', () => { $('play').textContent = '▶ 재생'; });
  v.addEventListener('click', () => loaded() && !exporting && (v.paused ? play() : pause()));
  $('modeAll').onclick = () => { setMode('all'); };
  $('modeCut').onclick = () => { setMode('cut'); };
  $('split').onclick = split;
  $('del').onclick = () => deleteCut();
  $('undo').onclick = undo;
  $('export').onclick = exportVideo;
  $('zoom').oninput = (e) => { pps = +e.target.value; render(); };
  window.addEventListener('resize', () => loaded() && render());

  window.addEventListener('keydown', (e) => {
    if (!loaded() || exporting || /INPUT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); v.paused ? play() : pause(); }
    else if (k === 's' || k === 'S') split();
    else if (k === 'Delete' || k === 'Backspace') deleteCut();
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); stepFrame(e.shiftKey ? -1 : -FRAME); }
    else if (k === 'ArrowRight') { e.preventDefault(); stepFrame(e.shiftKey ? 1 : FRAME); }
  });

  // test hook
  window.__editor = { get segs() { return segs; }, get playIdx() { return playIdx; }, split, deleteCut, moveCut, setMode, play, pause, seekEdit, openFile };

  requestAnimationFrame(tick);
})();
