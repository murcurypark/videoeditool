// PDFTrans — images → PDF (long images are cut into pages), PDF page manager (merge / split / reorder / rotate / delete), PDF → images.
// Everything runs in the browser: pdf-lib builds PDFs, pdf.js draws them.
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

const $ = (id) => document.getElementById(id);
const { PDFDocument, degrees } = window.PDFLib;
const here = (p) => new URL(p, location.href).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = here('vendor/pdfjs/pdf.worker.min.mjs');
const PDFJS_OPTS = {
  cMapUrl: here('vendor/pdfjs/cmaps/'), cMapPacked: true, standardFontDataUrl: here('vendor/pdfjs/standard_fonts/'),
  wasmUrl: here('vendor/pdfjs/wasm/'), iccUrl: here('vendor/pdfjs/iccs/'),
};

const MM = 72 / 25.4;   // points per mm
const PAPER = { A4: [210, 297], A5: [148, 210], B5: [176, 250], Letter: [215.9, 279.4] };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const natKey = (s) => s.toLowerCase().split(/(\d+)/).map((t) => (/^\d+$/.test(t) ? +t : t));
function natCmp(a, b) {
  const x = natKey(a), y = natKey(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    return typeof x[i] === 'number' && typeof y[i] === 'number' ? x[i] - y[i] : String(x[i]) < String(y[i]) ? -1 : 1;
  }
  return x.length - y.length;
}
const baseName = (n) => n.replace(/\.[^.]+$/, '');
const fmtMB = (n) => (n / 1048576).toFixed(1) + 'MB';
const canvasBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- status / busy ----------
const statusEl = $('status');
let busy = false;
function say(msg) { statusEl.textContent = msg || ''; }
async function work(msg, fn) {
  if (busy) return;
  busy = true; document.body.style.cursor = 'progress'; say(msg);
  try { return await fn((m) => say(m)); }
  catch (e) { console.error(e); alert('처리하지 못했습니다.\n' + (e && e.message ? e.message : e)); }
  finally { busy = false; document.body.style.cursor = ''; say(''); }
}

// ---------- modes ----------
for (const b of document.querySelectorAll('#modes button')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('#modes button')) x.classList.toggle('on', x === b);
    for (const s of document.querySelectorAll('.mode')) s.hidden = s.id !== 'm-' + b.dataset.m;
  };
}
const activeMode = () => document.querySelector('#modes button.on').dataset.m;
// dropped files go to the open mode; anywhere else the browser must not open them
for (const ev of ['dragover', 'dragenter']) addEventListener(ev, (e) => { e.preventDefault(); document.querySelector('.mode:not([hidden])').classList.add('dragover'); });
for (const ev of ['dragleave', 'drop']) addEventListener(ev, (e) => { e.preventDefault(); document.querySelector('.mode:not([hidden])').classList.remove('dragover'); });
addEventListener('drop', (e) => {
  const fs = [...e.dataTransfer.files], m = activeMode();
  if (m === 'img') addImages(fs); else if (m === 'pages') addPdfs(fs); else openForImages(fs[0]);
});

// ======================================================================
// 1. images → PDF
// ======================================================================
const imgs = [];   // {id, file, name, bitmap, w, h, url, raw}  raw: the original bytes can go into the PDF unchanged
let imgSeq = 0, planToken = 0, plan = [];

function jpegOrientation(b) {   // EXIF orientation of a JPEG (1 = upright / none)
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 9 < b.length && b[i] === 0xff) {
    const m = b[i + 1], L = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      const t = i + 10, le = b[t] === 0x49;
      const r16 = (o) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
      const r32 = (o) => (le ? (r16(o) | (r16(o + 2) << 16)) >>> 0 : ((r16(o) << 16) | r16(o + 2)) >>> 0);
      const ifd = r32(4), n = r16(ifd);
      for (let k = 0; k < n; k++) if (r16(ifd + 2 + k * 12) === 0x0112) return r16(ifd + 2 + k * 12 + 8);
      return 1;
    }
    if (m === 0xda) break;
    i += 2 + L;
  }
  return 1;
}
async function canEmbedRaw(f) {
  if (f.type === 'image/png') return true;
  if (f.type !== 'image/jpeg') return false;
  return jpegOrientation(new Uint8Array(await f.slice(0, 65536).arrayBuffer())) === 1;
}

async function addImages(files) {
  const ok = files.filter((f) => f && (/^image\//.test(f.type) || /\.(jpe?g|png|webp|bmp|gif)$/i.test(f.name)));
  if (!ok.length) return;
  await work('이미지를 읽는 중…', async (p) => {
    let n = 0;
    for (const f of ok) {
      p(`이미지를 읽는 중… ${++n}/${ok.length}`);
      try {
        const bitmap = await createImageBitmap(f, { imageOrientation: 'from-image' });
        imgs.push({ id: ++imgSeq, file: f, name: f.name, bitmap, w: bitmap.width, h: bitmap.height, url: URL.createObjectURL(f), raw: await canEmbedRaw(f) });
      } catch (e) { alert(f.name + ': 열 수 없는 이미지입니다.'); }
    }
  });
  renderImgList(); schedulePlan();
}
$('imgFile').onchange = (e) => { addImages([...e.target.files]); e.target.value = ''; };
$('imgSort').onclick = () => { imgs.sort((a, b) => natCmp(a.name, b.name)); renderImgList(); schedulePlan(); };
$('imgClear').onclick = () => { for (const i of imgs) URL.revokeObjectURL(i.url); imgs.length = 0; renderImgList(); schedulePlan(); };

function renderImgList() {
  const box = $('imgList');
  box.innerHTML = '';
  imgs.forEach((im, i) => {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = '<img alt=""><span class="n"></span><button data-a="up" title="위로">↑</button><button data-a="down" title="아래로">↓</button><button data-a="del" title="삭제">✕</button>';
    d.querySelector('img').src = im.url;
    d.querySelector('.n').innerHTML = '<span></span><small></small>';
    d.querySelector('.n span').textContent = im.name;
    d.querySelector('.n small').textContent = `${im.w}×${im.h}px · ${fmtMB(im.file.size)}`;
    d.querySelector('[data-a=up]').disabled = i === 0;
    d.querySelector('[data-a=down]').disabled = i === imgs.length - 1;
    d.onclick = (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (!a) return;
      if (a === 'del') { URL.revokeObjectURL(im.url); imgs.splice(i, 1); }
      else { const j = i + (a === 'up' ? -1 : 1); [imgs[i], imgs[j]] = [imgs[j], imgs[i]]; }
      renderImgList(); schedulePlan();
    };
    box.appendChild(d);
  });
  $('makePdf').disabled = !imgs.length;
}

const opts = () => ({
  paper: $('paper').value, orient: $('orient').value, margin: clamp(+$('margin').value || 0, 0, 50), layout: $('layout').value,
  smart: $('smart').checked, stitch: $('stitch').checked, dpi: +$('dpi').value, quality: +$('quality').value / 100,
});
for (const id of ['paper', 'orient', 'margin', 'layout', 'smart', 'stitch', 'dpi']) $(id).addEventListener('change', schedulePlan);
$('margin').addEventListener('input', schedulePlan);
$('quality').addEventListener('input', () => { $('qualityOut').textContent = $('quality').value; });

// A strip is images stacked at one working width; it gets cut into pages.
function makeStrip(items, Wp) {
  let y = 0;
  const parts = items.map((it) => { const h = Math.max(1, Math.round(it.h * Wp / it.w)); const p = { it, y0: y, h }; y += h; return p; });
  return { parts, Wp, H: y };
}
// draw the strip rows [Y0, Y1) at (dx, dy), scaled by k
function drawStrip(ctx, strip, Y0, Y1, dx, dy, k) {
  for (const p of strip.parts) {
    const a = Math.max(Y0, p.y0), b = Math.min(Y1, p.y0 + p.h);
    if (b <= a) continue;
    const f = p.it.h / p.h;
    ctx.drawImage(p.it.bitmap, 0, (a - p.y0) * f, p.it.w, (b - a) * f, dx, dy + (a - Y0) * k, strip.Wp * k, (b - a) * k);
  }
}
// where to cut near `target`: the middle of the lowest blank band in the lower 20% of the slice, else exactly at target
function findCut(strip, y0, target, tol = 8) {
  const slice = target - y0, lo = Math.max(y0 + slice / 2, target - slice * 0.2);
  const k = Math.min(1, 320 / strip.Wp), w = Math.max(1, Math.round(strip.Wp * k)), h = Math.max(1, Math.round((target - lo) * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  drawStrip(ctx, strip, lo, target, 0, 0, k);
  const d = ctx.getImageData(0, 0, w, h).data;
  const blank = (r) => {
    let mn = 255, mx = 0;
    for (let x = 0; x < w; x++) {
      const i = (r * w + x) * 4, g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      if (g < mn) mn = g;
      if (g > mx) mx = g;
    }
    return mx - mn <= tol;
  };
  for (let r = h - 1; r >= 0; r--) {
    if (!blank(r)) continue;
    let r0 = r;
    while (r0 > 0 && blank(r0 - 1)) r0--;   // the whole blank band: cut in its middle so both pages keep some margin
    return lo + (r0 + r + 1) / 2 / k;
  }
  return target;
}

// the pages of the PDF: [{pw, ph, strip, Y0, Y1, k, x, yTop, raw}]  (sizes in points; k = points per strip pixel)
function buildPlan(o) {
  const out = [], m = o.margin * MM;
  if (!imgs.length) return out;
  const groups = o.stitch && o.layout === 'width' && o.paper !== 'image' ? [imgs.slice()] : imgs.map((it) => [it]);
  for (const g of groups) {
    const it0 = g[0];
    let pw, ph;
    if (o.paper === 'image') { pw = it0.w * 72 / o.dpi + 2 * m; ph = it0.h * 72 / o.dpi + 2 * m; }
    else {
      const [w, h] = PAPER[o.paper].map((v) => v * MM);
      const land = o.orient === 'landscape' || (o.orient === 'auto' && g.length === 1 && it0.w > it0.h);
      [pw, ph] = land ? [h, w] : [w, h];
    }
    const bw = pw - 2 * m, bh = ph - 2 * m;
    if (o.paper === 'image' || o.layout === 'fit') {   // the whole image on one page
      const s = Math.min(bw / it0.w, bh / it0.h), Wp = Math.max(1, Math.min(it0.w, Math.round(it0.w * s * o.dpi / 72)));
      const strip = makeStrip([it0], Wp), k = it0.w * s / Wp;
      out.push({ pw, ph, strip, Y0: 0, Y1: strip.H, k, x: (pw - Wp * k) / 2, yTop: (ph - strip.H * k) / 2, raw: it0.raw ? it0 : null });
      continue;
    }
    const Wp = Math.max(1, Math.min(Math.round(bw * o.dpi / 72), Math.max(...g.map((i) => i.w))));
    const strip = makeStrip(g, Wp), k = bw / Wp, sliceH = bh / k;
    const cuts = [0];
    let y = 0;
    while (strip.H - y > sliceH + 0.5) {
      const target = y + sliceH, cut = o.smart ? findCut(strip, y, target) : target;
      cuts.push(cut); y = cut;
    }
    cuts.push(strip.H);
    const single = cuts.length === 2;
    for (let i = 0; i < cuts.length - 1; i++) {
      const Y0 = cuts[i], Y1 = cuts[i + 1], ch = (Y1 - Y0) * k;
      out.push({ pw, ph, strip, Y0, Y1, k, x: (pw - Wp * k) / 2, yTop: single ? (ph - ch) / 2 : m, raw: single && g.length === 1 && it0.raw ? it0 : null });
    }
  }
  return out;
}

let planTimer = 0;
function schedulePlan() { clearTimeout(planTimer); planTimer = setTimeout(refreshPlan, 150); }
async function refreshPlan() {
  const token = ++planToken, box = $('preview');
  if (!imgs.length) { plan = []; $('planInfo').textContent = '이미지를 추가하세요'; box.innerHTML = '<div class="empty">이미지를 끌어다 놓거나 [이미지 추가]를 누르세요<br><small>파일은 업로드되지 않고 이 브라우저 안에서만 처리됩니다</small></div>'; return; }
  await new Promise((r) => setTimeout(r, 0));
  plan = buildPlan(opts());
  if (token !== planToken) return;
  $('planInfo').textContent = `총 ${plan.length}페이지`;
  box.innerHTML = '';
  const SHOW = 80;
  plan.slice(0, SHOW).forEach((s, i) => {
    const d = document.createElement('div');
    d.className = 'page';
    const c = document.createElement('canvas'), sc = 170 / Math.max(s.pw, s.ph);
    c.width = Math.round(s.pw * sc); c.height = Math.round(s.ph * sc);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    drawStrip(ctx, s.strip, s.Y0, s.Y1, s.x * sc, s.yTop * sc, s.k * sc);
    d.appendChild(c);
    const t = document.createElement('small');
    t.textContent = `${i + 1}페이지`;
    d.appendChild(t);
    box.appendChild(d);
  });
  if (plan.length > SHOW) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = `… 외 ${plan.length - SHOW}페이지`; box.appendChild(e); }
}

$('makePdf').onclick = () => work('PDF를 만드는 중…', async (say2) => {
  const o = opts(), pages = buildPlan(o), doc = await PDFDocument.create(), rawCache = new Map();
  for (let i = 0; i < pages.length; i++) {
    say2(`PDF를 만드는 중… ${i + 1}/${pages.length}`);
    await new Promise((r) => setTimeout(r, 0));
    const s = pages[i], page = doc.addPage([s.pw, s.ph]), cw = s.strip.Wp * s.k;
    if (s.raw) {   // unchanged original bytes: no quality loss, small file
      let e = rawCache.get(s.raw);
      if (!e) { const bytes = new Uint8Array(await s.raw.file.arrayBuffer()); e = s.raw.file.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes); rawCache.set(s.raw, e); }
      const dh = cw * s.raw.h / s.raw.w;
      page.drawImage(e, { x: s.x, y: s.ph - s.yTop - dh, width: cw, height: dh });
    } else {
      const ch = (s.Y1 - s.Y0) * s.k, c = document.createElement('canvas');
      c.width = s.strip.Wp; c.height = Math.max(1, Math.round(s.Y1 - s.Y0));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      drawStrip(ctx, s.strip, s.Y0, s.Y1, 0, 0, 1);
      const e = await doc.embedJpg(new Uint8Array(await (await canvasBlob(c, 'image/jpeg', o.quality)).arrayBuffer()));
      page.drawImage(e, { x: s.x, y: s.ph - s.yTop - ch, width: cw, height: ch });
    }
  }
  const bytes = await doc.save();
  saveBlob(new Blob([bytes], { type: 'application/pdf' }), (imgs.length === 1 ? baseName(imgs[0].name) : 'images') + '.pdf');
});

// ======================================================================
// shared: PDFs drawn with pdf.js
// ======================================================================
async function openPdfFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), ...PDFJS_OPTS }).promise;
    return { name: file.name, bytes, pdf, n: pdf.numPages };
  } catch (e) {
    alert(file.name + (e && e.name === 'PasswordException' ? ': 암호가 걸린 PDF는 열 수 없습니다.' : ': PDF를 열 수 없습니다.'));
    return null;
  }
}
async function renderPage(pdf, pageNum, scale, flatten) {
  const page = await pdf.getPage(pageNum), vp = page.getViewport({ scale }), c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d');
  if (flatten) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
  await page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
  return c;
}
const thumbCache = new Map();
function thumb(doc, i, max = 150) {   // a small canvas of a page (cached)
  const key = doc.name + ':' + doc.n + ':' + i;
  if (!thumbCache.has(key)) {
    thumbCache.set(key, (async () => {
      const page = await doc.pdf.getPage(i + 1), v0 = page.getViewport({ scale: 1 });
      return renderPage(doc.pdf, i + 1, max * Math.min(2, window.devicePixelRatio || 1) / Math.max(v0.width, v0.height), true);
    })());
  }
  return thumbCache.get(key);
}
function paint(canvas, src) {
  canvas.width = src.width; canvas.height = src.height;
  canvas.getContext('2d').drawImage(src, 0, 0);
  canvas.style.width = Math.round(src.width / Math.min(2, window.devicePixelRatio || 1)) + 'px';
}

// store-only zip
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makeZip(files) {   // [{name, data: Uint8Array}]
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length, h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, f.data);
    central.push({ name, crc, size, offset });
    offset += 30 + name.length + size;
  }
  let cdSize = 0;
  for (const c of central) {
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true); h.setUint16(4, 20, true); h.setUint16(6, 20, true); h.setUint16(8, 0x0800, true); h.setUint16(14, 0x21, true);
    h.setUint32(16, c.crc, true); h.setUint32(20, c.size, true); h.setUint32(24, c.size, true); h.setUint16(28, c.name.length, true); h.setUint32(42, c.offset, true);
    parts.push(new Uint8Array(h.buffer), c.name);
    cdSize += 46 + c.name.length;
  }
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, central.length, true); e.setUint16(10, central.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  parts.push(new Uint8Array(e.buffer));
  return new Blob(parts, { type: 'application/zip' });
}

// ======================================================================
// 2. page manager
// ======================================================================
const docs = [];   // opened PDFs
let pgs = [];      // pages in the output order: {d: doc index, i: page index, rot: extra rotation, sel}
let gridToken = 0, dragFrom = -1;

async function addPdfs(files) {
  const list = files.filter((f) => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)));
  if (!list.length) return;
  await work('PDF를 여는 중…', async () => {
    for (const f of list) {
      const d = await openPdfFile(f);
      if (!d) continue;
      docs.push(d);
      for (let i = 0; i < d.n; i++) pgs.push({ d: docs.length - 1, i, rot: 0, sel: false });
    }
  });
  renderPages();
}
$('pdfFile').onchange = (e) => { addPdfs([...e.target.files]); e.target.value = ''; };

function renderPages() {
  const token = ++gridToken, box = $('pageGrid');
  box.innerHTML = '';
  $('pagesInfo').textContent = pgs.length ? `${pgs.length}페이지 · 선택 ${pgs.filter((p) => p.sel).length}` : '';
  for (const id of ['saveAll', 'splitGo']) $(id).disabled = !pgs.length;
  $('saveSel').disabled = !pgs.some((p) => p.sel);
  if (!pgs.length) { box.innerHTML = '<div class="empty">PDF를 끌어다 놓거나 [PDF 추가]를 누르세요 (여러 개를 추가하면 합쳐집니다)<br><small>카드를 끌어 순서를 바꾸고, 회전/삭제는 카드 아래 버튼이나 위쪽 선택 도구를 쓰세요</small></div>'; return; }
  const jobs = [];
  pgs.forEach((p, k) => {
    const d = docs[p.d], c = document.createElement('div');
    c.className = 'pcard' + (p.sel ? ' sel' : '');
    c.draggable = true; c.dataset.k = k;
    c.innerHTML = '<label class="top"><input type="checkbox" class="sel"><b></b><small></small></label><div class="thumb"><canvas></canvas></div>' +
      '<div class="acts"><button data-a="l" title="왼쪽으로 회전">↺</button><button data-a="r" title="오른쪽으로 회전">↻</button><button data-a="mvl" title="앞으로">←</button><button data-a="mvr" title="뒤로">→</button><button data-a="del" title="삭제">✕</button></div>';
    c.querySelector('b').textContent = k + 1;
    c.querySelector('small').textContent = `${d.name} · ${p.i + 1}p`;
    c.querySelector('.sel').checked = p.sel;
    c.querySelector('[data-a=mvl]').disabled = k === 0;
    c.querySelector('[data-a=mvr]').disabled = k === pgs.length - 1;
    const cv = c.querySelector('canvas');
    cv.style.transform = `rotate(${p.rot}deg)`;
    jobs.push(() => thumb(d, p.i).then((src) => { if (token === gridToken) paint(cv, src); }));
    c.querySelector('.sel').onchange = (e) => { p.sel = e.target.checked; c.classList.toggle('sel', p.sel); $('pagesInfo').textContent = `${pgs.length}페이지 · 선택 ${pgs.filter((x) => x.sel).length}`; $('saveSel').disabled = !pgs.some((x) => x.sel); };
    c.onclick = (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (!a) return;
      if (a === 'l' || a === 'r') p.rot = (p.rot + (a === 'l' ? 270 : 90)) % 360;
      else if (a === 'del') pgs.splice(k, 1);
      else { const j = k + (a === 'mvl' ? -1 : 1); [pgs[k], pgs[j]] = [pgs[j], pgs[k]]; }
      renderPages();
    };
    c.ondragstart = (e) => { dragFrom = k; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(k)); };
    c.ondragover = (e) => { if (dragFrom < 0) return; e.preventDefault(); c.classList.add('over'); };
    c.ondragleave = () => c.classList.remove('over');
    c.ondrop = (e) => {
      if (dragFrom < 0) return;
      e.preventDefault(); e.stopPropagation();
      const to = k, [m] = pgs.splice(dragFrom, 1);
      pgs.splice(to, 0, m);
      dragFrom = -1; renderPages();
    };
    c.ondragend = () => { dragFrom = -1; };
    box.appendChild(c);
  });
  (async () => { for (const j of jobs) { if (token !== gridToken) return; await j(); } })();
}
$('selAll').onclick = () => { pgs.forEach((p) => { p.sel = true; }); renderPages(); };
$('selNone').onclick = () => { pgs.forEach((p) => { p.sel = false; }); renderPages(); };
$('rotL').onclick = () => { pgs.forEach((p) => { if (p.sel) p.rot = (p.rot + 270) % 360; }); renderPages(); };
$('rotR').onclick = () => { pgs.forEach((p) => { if (p.sel) p.rot = (p.rot + 90) % 360; }); renderPages(); };
$('delSel').onclick = () => { pgs = pgs.filter((p) => !p.sel); renderPages(); };
$('clearPages').onclick = () => { if (pgs.length && !confirm('열어 둔 PDF와 페이지를 모두 지울까요?')) return; docs.length = 0; pgs = []; thumbCache.clear(); renderPages(); };

async function buildPdf(list) {
  const out = await PDFDocument.create(), copied = new Map();
  for (const d of [...new Set(list.map((p) => p.d))]) {
    const src = await PDFDocument.load(docs[d].bytes, { ignoreEncryption: true }), idx = [...new Set(list.filter((p) => p.d === d).map((p) => p.i))];
    const pages = await out.copyPages(src, idx);
    idx.forEach((i, n) => copied.set(d + ':' + i, pages[n]));
  }
  for (const p of list) {
    const page = copied.get(p.d + ':' + p.i);
    if (p.rot) page.setRotation(degrees((page.getRotation().angle + p.rot) % 360));
    out.addPage(page);
  }
  return out.save();
}
const outName = () => (docs.length === 1 ? baseName(docs[0].name) : 'merged');
$('saveAll').onclick = () => work('PDF를 만드는 중…', async () => saveBlob(new Blob([await buildPdf(pgs)], { type: 'application/pdf' }), outName() + '.pdf'));
$('saveSel').onclick = () => work('PDF를 만드는 중…', async () => {
  const list = pgs.filter((p) => p.sel);
  if (list.length) saveBlob(new Blob([await buildPdf(list)], { type: 'application/pdf' }), outName() + '_selected.pdf');
});
$('splitGo').onclick = () => work('나누는 중…', async (say2) => {
  const n = Math.max(1, Math.floor(+$('splitN').value || 1)), files = [], total = Math.ceil(pgs.length / n);
  for (let s = 0, part = 1; s < pgs.length; s += n, part++) {
    say2(`나누는 중… ${part}/${total}`);
    files.push({ name: `${outName()}_${String(part).padStart(3, '0')}.pdf`, data: await buildPdf(pgs.slice(s, s + n)) });
  }
  if (files.length === 1) saveBlob(new Blob([files[0].data], { type: 'application/pdf' }), files[0].name);
  else saveBlob(makeZip(files), outName() + '_split.zip');
});

// ======================================================================
// 3. PDF → images
// ======================================================================
let doc3 = null;
const sel3 = new Set();

async function openForImages(file) {
  if (!file || !(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) return;
  await work('PDF를 여는 중…', async () => { const d = await openPdfFile(file); if (d) { doc3 = d; sel3.clear(); for (let i = 0; i < d.n; i++) sel3.add(i); } });
  renderGrid3();
}
$('toimgFile').onchange = (e) => { openForImages(e.target.files[0]); e.target.value = ''; };
function info3() { $('toimgInfo').textContent = doc3 ? `${doc3.name} · ${doc3.n}페이지 · 선택 ${sel3.size}` : ''; $('toImgGo').disabled = !doc3 || !sel3.size; }
function renderGrid3() {
  const box = $('grid3'), token = ++gridToken;
  box.innerHTML = '';
  $('toimgName').textContent = doc3 ? doc3.name : 'PDF를 끌어다 놓아도 됩니다.';
  info3();
  if (!doc3) { box.innerHTML = '<div class="empty">PDF를 열면 페이지가 여기에 표시됩니다</div>'; return; }
  const jobs = [];
  for (let i = 0; i < doc3.n; i++) {
    const c = document.createElement('div');
    c.className = 'pcard' + (sel3.has(i) ? ' sel' : '');
    c.style.cursor = 'default';
    c.innerHTML = '<label class="top"><input type="checkbox" class="sel"><b></b></label><div class="thumb"><canvas></canvas></div>';
    c.querySelector('b').textContent = i + 1;
    c.querySelector('.sel').checked = sel3.has(i);
    c.querySelector('.sel').onchange = (e) => { if (e.target.checked) sel3.add(i); else sel3.delete(i); c.classList.toggle('sel', e.target.checked); info3(); };
    const cv = c.querySelector('canvas');
    jobs.push(() => thumb(doc3, i).then((src) => { if (token === gridToken) paint(cv, src); }));
    box.appendChild(c);
  }
  (async () => { for (const j of jobs) { if (token !== gridToken) return; await j(); } })();
}
$('selAll3').onclick = () => { if (doc3) { for (let i = 0; i < doc3.n; i++) sel3.add(i); renderGrid3(); } };
$('selNone3').onclick = () => { sel3.clear(); renderGrid3(); };

$('toImgGo').onclick = () => work('이미지로 바꾸는 중…', async (say2) => {
  const pages = [...sel3].sort((a, b) => a - b), jpg = $('fmt').value === 'jpg', type = jpg ? 'image/jpeg' : 'image/png', ext = jpg ? 'jpg' : 'png';
  const scale = +$('imgDpi').value / 72, base = baseName(doc3.name);
  if ($('joinTall').checked) {   // all selected pages stacked into one long image
    const sizes = [];
    for (const i of pages) { const v = (await doc3.pdf.getPage(i + 1)).getViewport({ scale }); sizes.push([Math.ceil(v.width), Math.ceil(v.height)]); }
    const W = Math.max(...sizes.map((s) => s[0])), H = sizes.reduce((a, s) => a + s[1], 0);
    if (H > 32000 || W * H > 200e6) throw new Error(`이미지가 너무 큽니다 (${W}×${H}px). 해상도를 낮추거나 페이지 수를 줄여 주세요.`);
    const big = document.createElement('canvas');
    big.width = W; big.height = H;
    const ctx = big.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    let y = 0;
    for (let n = 0; n < pages.length; n++) {
      say2(`이미지로 바꾸는 중… ${n + 1}/${pages.length}`);
      const c = await renderPage(doc3.pdf, pages[n] + 1, scale, true);
      ctx.drawImage(c, Math.round((W - c.width) / 2), y); y += sizes[n][1];
    }
    saveBlob(await canvasBlob(big, type, 0.92), `${base}.${ext}`);
    return;
  }
  const files = [];
  for (let n = 0; n < pages.length; n++) {
    say2(`이미지로 바꾸는 중… ${n + 1}/${pages.length}`);
    const blob = await canvasBlob(await renderPage(doc3.pdf, pages[n] + 1, scale, true), type, 0.92);
    files.push({ name: `${base}_${String(pages[n] + 1).padStart(3, '0')}.${ext}`, data: new Uint8Array(await blob.arrayBuffer()), blob });
  }
  if (files.length === 1) saveBlob(files[0].blob, files[0].name);
  else saveBlob(makeZip(files), `${base}_images.zip`);
});

// small hook for tests
window.__pdftrans = { get imgs() { return imgs; }, get plan() { return plan; }, get pgs() { return pgs; }, get docs() { return docs; }, get doc3() { return doc3; }, buildPlan, opts, makeZip, refreshPlan };
