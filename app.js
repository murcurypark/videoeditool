(() => {
  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), scroller = $('scroller'), ruler = $('ruler'), track = $('track'), playhead = $('playhead');
  const MIN_LEN = 0.1, FRAME = 1 / 30, THUMB_H = 56, FPS = 30;

  const sources = [];     // [{id,name,file,url,duration,el,thumbs,w,h,hue,audio}]
  let segs = [];          // [{id,src,start,end}] src = source id, times in that source's seconds
  let v = null;           // <video> of the source the playhead is in
  let sel = 0;            // selected cut
  let playIdx = 0;        // cut the playhead is currently in
  let pps = 60;           // pixels per second
  let mode = 'all';       // 'all' | 'cut'
  let history = [];
  let nextId = 1;
  let exporting = false;
  let cancelExport = false;
  let onEnd = null;
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

  // ---------- active video handling ----------
  function activate(src) {
    for (const s of sources) s.el.classList.toggle('active', s === src);
    v = src.el;
  }
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
    history.push(JSON.stringify({ segs, sel }));
    if (history.length > 100) history.shift();
    $('undo').disabled = false;
  }
  function undo() {
    if (!history.length || exporting) return;
    const h = JSON.parse(history.pop());
    segs = h.segs; sel = clamp(h.sel, 0, segs.length - 1);
    const i = clamp(playIdx, 0, segs.length - 1);
    goto(i, segs[i].start);
    $('undo').disabled = !history.length;
    render();
  }

  // ---------- loading ----------
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
    el.addEventListener('click', () => loaded() && !exporting && (v.paused ? play() : pause()));

    const first = !loaded();
    snapshot();
    segs.push({ id: nextId++, src: src.id, start: 0, end: src.duration });
    if (first) {
      history = [];
      sel = 0; playIdx = 0;
      activate(src);
      $('empty').hidden = true;
      for (const id of ['play', 'modeAll', 'modeCut', 'split', 'del', 'export']) $(id).disabled = false;
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

  // ---------- timeline rendering ----------
  function fitZoom() {
    const avail = scroller.clientWidth - 24;
    pps = clamp(avail / Math.max(total(), 1), 10, 400);
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
      b.className = 'block' + (i === sel ? ' sel' : '');
      b.style.left = offset(i) * pps + 'px';
      b.style.width = (seg.end - seg.start) * pps + 'px';
      b.style.background = `hsl(${src.hue} 45% ${i === sel ? 42 : 30}%)`;
      b.dataset.i = i;
      b.title = src.name;
      b.innerHTML = '<canvas></canvas><b></b><i class="handle l"></i><i class="handle r"></i>';
      b.querySelector('b').textContent = (i + 1) + ' · ' + src.name + ' · ' + (seg.end - seg.start).toFixed(1) + 's';
      track.appendChild(b);
    });
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
      li.className = i === sel ? 'sel' : '';
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
    if (seek) goto(i, segs[i].start);
    render();
  }

  function split() {
    if (!loaded() || exporting) return;
    const seg = segs[playIdx], s = v.currentTime;
    if (s - seg.start < MIN_LEN || seg.end - s < MIN_LEN) return;
    snapshot();
    segs.splice(playIdx, 1, { id: nextId++, src: seg.src, start: seg.start, end: s }, { id: nextId++, src: seg.src, start: s, end: seg.end });
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
          if (!exporting) { sel = playIdx; renderList(); track.querySelectorAll('.block').forEach((b) => b.classList.toggle('sel', +b.dataset.i === sel)); }
        } else {
          v.pause();
          if (onEnd) onEnd(); else goto(0, segs[0].start);
        }
      }
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
    goto(i, segs[i].start + clamp(t - acc, 0, segs[i].end - segs[i].start));
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
    if (block) { sel = +block.dataset.i; seekEdit(xToEdit(e.clientX)); render(); }
    else seekEdit(xToEdit(e.clientX));
    const move = (ev) => seekEdit(xToEdit(ev.clientX));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });

  function startTrim(e, i, isLeft) {
    e.preventDefault();
    snapshot();
    sel = i;
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
    render();
  }

  // ---------- export: fallback (real-time recording, single source only) ----------
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
    if (!mime || !capture) { alert('이 브라우저는 내보내기를 지원하지 않습니다. 최신 Chrome/Edge/Firefox를 사용하세요.'); return; }
    exporting = true;
    $('exportOverlay').hidden = false;
    $('exportOverlay').querySelector('small').textContent = '실시간 속도로 녹화됩니다. 이 탭을 닫거나 숨기지 마세요.';
    pause(); setMode('all'); goto(0, segs[0].start);
    await new Promise((r) => { if (!v.seeking) return r(); v.onseeked = r; });
    const stream = capture.call(v);
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
    // output size = first cut's source, rounded to even
    const first = srcOf(segs[0]);
    const W = first.w & ~1, H = first.h & ~1;
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

    // each frame is drawn letterboxed onto a fixed-size canvas so sources of different sizes can be mixed
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
        const sc = Math.min(W / src.w, H / src.h), dw = src.w * sc, dh = src.h * sc;
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(src.el, (W - dw) / 2, (H - dh) / 2, dw, dh);
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
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));

  $('play').onclick = () => (v.paused ? play() : pause());
  $('modeAll').onclick = () => setMode('all');
  $('modeCut').onclick = () => setMode('cut');
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
  window.__editor = { get segs() { return segs; }, get playIdx() { return playIdx; }, split, deleteCut, moveCut, setMode, play, pause, seekEdit, addFiles };

  renderList();
  requestAnimationFrame(tick);
})();
