// OfficeDocTool — open a PDF (or an Illustrator file saved PDF-compatible), put text, shapes, images, drawings, covers and
// signatures on its pages, replace existing text (the old text is covered and new text sits on top), and save a new PDF.
// Objects live in page points with the origin at the top-left of the page as displayed; they are mapped back into PDF space on save.
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

const $ = (id) => document.getElementById(id);
const { PDFDocument, rgb, degrees } = window.PDFLib;
const here = (p) => new URL(p, location.href).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = here('vendor/pdfjs/pdf.worker.min.mjs');
const PDFJS_OPTS = {
  cMapUrl: here('vendor/pdfjs/cmaps/'), cMapPacked: true, standardFontDataUrl: here('vendor/pdfjs/standard_fonts/'),
  wasmUrl: here('vendor/pdfjs/wasm/'), iccUrl: here('vendor/pdfjs/iccs/'),
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const rad = (d) => d * Math.PI / 180;
const baseName = (n) => n.replace(/\.[^.]+$/, '');
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const statusEl = $('status');
const say = (m) => { statusEl.textContent = m || ''; };
let busy = false;
async function work(msg, fn) {
  if (busy) return;
  busy = true; document.body.style.cursor = 'progress'; say(msg);
  try { return await fn(); }
  catch (e) { console.error(e); alert('처리하지 못했습니다.\n' + (e && e.message ? e.message : e)); }
  finally { busy = false; document.body.style.cursor = ''; say(''); }
}

// ---------- fonts / text metrics (the same numbers lay text out on screen and in the PDF) ----------
const FONT = '"Pretendard", "Malgun Gothic", sans-serif';
const LH = 1.25;                       // line height, in font sizes
let ASC = 0.95, DESC = 0.25;           // measured from the font once it is loaded
const mctx = document.createElement('canvas').getContext('2d');
(async () => {
  await Promise.all([400, 700].map((w) => document.fonts.load(`${w} 20px Pretendard`, '가힣Aa'))).catch(() => {});
  mctx.font = `400 100px ${FONT}`;
  const m = mctx.measureText('가Ag');
  if (m.fontBoundingBoxAscent) { ASC = m.fontBoundingBoxAscent / 100; DESC = m.fontBoundingBoxDescent / 100; }
  draw();
})();
const baseOff = (size) => ((LH - ASC - DESC) * size) / 2 + ASC * size;   // top of the first line → its baseline
function lineW(t, bold, size) { mctx.font = `${bold ? 700 : 400} 100px ${FONT}`; return mctx.measureText(t).width * size / 100; }
function textMetrics(o) {
  const lines = String(o.text).split('\n'), ws = lines.map((l) => lineW(l || ' ', o.bold, o.size));
  return { lines, ws, w: Math.max(o.size * 0.5, ...ws), h: lines.length * LH * o.size };
}

// ---------- state ----------
let src = null;                  // {name, bytes, pdf, n}
let cur = 0;                     // current page index
let zoom = 1.2;                  // screen px per point
let fitMode = 'page';          // 'page' = whole page visible, 'width' = page width fills the view, null = fixed zoom
let tool = 'select';
let pages = [];                  // per page: {objs: []}
let sel = null;                  // selected object
let editing = null;              // text object being typed into
const info = [];                 // per page: {page, vp1}
const textCache = [];
const imgs = new Map();          // image id → {bitmap, bytes, type, w, h}
let seq = 0;
const style = { stroke: '#e03131', fill: '#ffe066', sw: 2, size: 18, color: '#111111' };
const undoS = [], redoS = [];
let renderToken = 0, renderTask = null;

const pageCv = $('pageCv'), ovCv = $('ovCv'), wrap = $('pageWrap'), stage = $('stage');
const dpr = () => Math.min(2, window.devicePixelRatio || 1);

// ---------- undo ----------
const snapshotJson = () => JSON.stringify(pages.map((p) => p.objs));
function snap() { undoS.push(snapshotJson()); if (undoS.length > 100) undoS.shift(); redoS.length = 0; updateUndo(); }
function restore(json) { const a = JSON.parse(json); pages.forEach((p, i) => { p.objs = a[i] || []; }); sel = null; editing = null; hideEditor(); renderProps(); draw(); renderThumbBadges(); }
function undo() { if (!undoS.length) return; redoS.push(snapshotJson()); restore(undoS.pop()); updateUndo(); }
function redo() { if (!redoS.length) return; undoS.push(snapshotJson()); restore(redoS.pop()); updateUndo(); }
function updateUndo() { $('undo').disabled = !undoS.length; $('redo').disabled = !redoS.length; }
$('undo').onclick = undo; $('redo').onclick = redo;

// ---------- opening files ----------
const isPdfBytes = (b) => { for (let i = 0; i < Math.min(b.length - 4, 1024); i++) if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46) return true; return false; };
async function openFile(file) {
  if (!file) return;
  const ext = (file.name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
  if (ext === 'indd' || ext === 'idml') { alert(`.${ext} 파일은 열 수 없습니다.\n인디자인에서 [파일 → 내보내기]로 PDF를 만든 뒤 그 PDF를 열어 주세요.`); return; }
  await work('파일을 여는 중…', async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isPdfBytes(bytes)) throw new Error(ext === 'ai' ? '이 AI 파일은 PDF 호환 정보가 없어 열 수 없습니다.\n일러스트레이터에서 저장할 때 "PDF 호환 파일 만들기"를 켜서 다시 저장해 주세요.' : 'PDF 파일이 아닙니다.');
    let pdf;
    try { pdf = await pdfjsLib.getDocument({ data: bytes.slice(), ...PDFJS_OPTS }).promise; }
    catch (e) { throw new Error(e && e.name === 'PasswordException' ? '암호가 걸린 PDF는 열 수 없습니다.' : 'PDF를 열 수 없습니다.' + (ext === 'ai' ? '\n(일러스트레이터 파일은 "PDF 호환 파일 만들기"를 켜고 저장한 것만 열립니다)' : '')); }
    if (src && (pages.some((p) => p.objs.length)) && !confirm('지금 작업 중인 내용은 저장되지 않습니다. 다른 파일을 열까요?')) return;
    src = { name: file.name, bytes, pdf, n: pdf.numPages };
    pages = Array.from({ length: pdf.numPages }, () => ({ objs: [] }));
    info.length = 0; textCache.length = 0; undoS.length = 0; redoS.length = 0; sel = null; editing = null; cur = 0;
    updateUndo(); setEnabled(true);
    $('empty').hidden = true; wrap.hidden = false;
    $('pageTotal').textContent = pdf.numPages;
    buildThumbs(); await goPage(0, true);
  });
}
$('docFile').onchange = (e) => { openFile(e.target.files[0]); e.target.value = ''; };
for (const ev of ['dragover', 'dragenter']) addEventListener(ev, (e) => { e.preventDefault(); stage.style.outline = '2px dashed var(--accent)'; });
for (const ev of ['dragleave', 'drop']) addEventListener(ev, (e) => { e.preventDefault(); stage.style.outline = ''; });
addEventListener('drop', (e) => openFile(e.dataTransfer.files[0]));
function setEnabled(on) { for (const id of ['prevPage', 'nextPage', 'pageNo', 'zoomOut', 'zoomIn', 'zoomSel', 'savePdf']) $(id).disabled = !on; $('hintBar').textContent = on ? '개체를 끌어 이동 · 모서리로 크기 조절 · 더블클릭으로 글자 수정 · Delete 삭제' : $('hintBar').textContent; }

// ---------- pages / rendering ----------
async function pageInfo(i) {
  if (!info[i]) { const page = await src.pdf.getPage(i + 1); info[i] = { page, vp1: page.getViewport({ scale: 1 }) }; }
  return info[i];
}
async function renderPage() {
  const token = ++renderToken, { page, vp1 } = await pageInfo(cur);
  if (fitMode === 'width') zoom = clamp((stage.clientWidth - 40) / vp1.width, 0.2, 4);
  else if (fitMode === 'page') zoom = clamp(Math.min((stage.clientWidth - 40) / vp1.width, (stage.clientHeight - 40) / vp1.height), 0.2, 4);
  const d = dpr(), vp = page.getViewport({ scale: zoom * d });
  pageCv.width = ovCv.width = Math.ceil(vp.width); pageCv.height = ovCv.height = Math.ceil(vp.height);
  const cw = vp.width / d, ch = vp.height / d;
  pageCv.style.width = ovCv.style.width = cw + 'px'; pageCv.style.height = ovCv.style.height = ch + 'px';
  if (renderTask) { renderTask.cancel(); try { await renderTask.promise; } catch (e) { /* cancelled */ } }
  if (token !== renderToken) return;
  const ctx = pageCv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pageCv.width, pageCv.height);
  renderTask = page.render({ canvasContext: ctx, canvas: pageCv, viewport: vp });
  try { await renderTask.promise; } catch (e) { if (!e || e.name !== 'RenderingCancelledException') throw e; }
  if (token === renderToken) { draw(); $('zoomSel').value = fitMode || ([...$('zoomSel').options].some((o) => o.value && +o.value === +zoom.toFixed(2)) ? String(+zoom.toFixed(2)) : ''); }
}
async function goPage(i, force) {
  if (!src) return;
  i = clamp(i, 0, src.n - 1);
  if (i === cur && !force) return;
  commitEditor(); sel = null; cur = i;
  $('pageNo').value = i + 1;
  document.querySelectorAll('#thumbs .th').forEach((t, k) => t.classList.toggle('on', k === i));
  renderProps();
  await renderPage();
}
$('prevPage').onclick = () => goPage(cur - 1);
$('nextPage').onclick = () => goPage(cur + 1);
$('pageNo').onchange = (e) => goPage((+e.target.value || 1) - 1);
function setZoom(z) { fitMode = z === 'page' || z === 'width' ? z : null; if (!fitMode) zoom = clamp(+z, 0.2, 4); if (src) renderPage(); }
$('zoomSel').onchange = (e) => e.target.value && setZoom(e.target.value);
$('zoomIn').onclick = () => setZoom(zoom * 1.2);
$('zoomOut').onclick = () => setZoom(zoom / 1.2);
addEventListener('resize', () => { if (src && fitMode) renderPage(); });

// thumbnails
let thumbToken = 0;
function buildThumbs() {
  const box = $('thumbs'), token = ++thumbToken;
  box.innerHTML = '';
  const jobs = [];
  for (let i = 0; i < src.n; i++) {
    const t = document.createElement('div');
    t.className = 'th' + (i === 0 ? ' on' : '');
    t.innerHTML = '<canvas></canvas><span></span>';
    t.querySelector('span').textContent = String(i + 1);
    t.onclick = () => goPage(i);
    box.appendChild(t);
    jobs.push(async () => {
      const page = await src.pdf.getPage(i + 1), v0 = page.getViewport({ scale: 1 }), sc = 124 * dpr() / v0.width, vp = page.getViewport({ scale: sc });
      const c = t.querySelector('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
    });
  }
  (async () => { for (const j of jobs) { if (token !== thumbToken) return; try { await j(); } catch (e) { /* ignore */ } } })();
}
function renderThumbBadges() { document.querySelectorAll('#thumbs .th span').forEach((s, i) => { s.textContent = (i + 1) + (pages[i] && pages[i].objs.length ? ' ●' : ''); }); }

// ======================================================================
// objects
// ======================================================================
const RECTLIKE = new Set(['rect', 'ellipse', 'highlight', 'cover', 'image']);
const LINELIKE = new Set(['line', 'arrow']);
const rotates = (o) => !LINELIKE.has(o.type) && o.type !== 'pen';
function box(o) {
  if (o.type === 'text') { const m = textMetrics(o); return { x: o.x, y: o.y, w: m.w, h: m.h }; }
  if (LINELIKE.has(o.type)) return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
  if (o.type === 'pen') {
    const xs = o.pts.map((p) => p[0]), ys = o.pts.map((p) => p[1]), x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}
const ctr = (o) => { const b = box(o); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };
function rotPt(x, y, c, deg) {
  const a = rad(deg), cs = Math.cos(a), sn = Math.sin(a), dx = x - c.x, dy = y - c.y;
  return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs };
}
function distSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function drawObj(ctx, o) {
  ctx.save();
  ctx.globalAlpha = o.opacity ?? 1;
  if (rotates(o) && o.rot) { const c = ctr(o); ctx.translate(c.x, c.y); ctx.rotate(rad(o.rot)); ctx.translate(-c.x, -c.y); }
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (o.type === 'rect' || o.type === 'cover' || o.type === 'highlight') {
    if (o.fill) { ctx.fillStyle = o.fill; ctx.fillRect(o.x, o.y, o.w, o.h); }
    if (o.stroke && o.sw > 0) { ctx.strokeStyle = o.stroke; ctx.lineWidth = o.sw; ctx.strokeRect(o.x, o.y, o.w, o.h); }
  } else if (o.type === 'ellipse') {
    ctx.beginPath(); ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, Math.max(0.01, o.w / 2), Math.max(0.01, o.h / 2), 0, 0, Math.PI * 2);
    if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
    if (o.stroke && o.sw > 0) { ctx.strokeStyle = o.stroke; ctx.lineWidth = o.sw; ctx.stroke(); }
  } else if (LINELIKE.has(o.type)) {
    ctx.strokeStyle = o.stroke; ctx.lineWidth = o.sw;
    ctx.beginPath(); ctx.moveTo(o.x1, o.y1); ctx.lineTo(o.x2, o.y2); ctx.stroke();
    if (o.type === 'arrow') { const h = arrowHead(o); ctx.fillStyle = o.stroke; ctx.beginPath(); ctx.moveTo(h[0].x, h[0].y); ctx.lineTo(h[1].x, h[1].y); ctx.lineTo(h[2].x, h[2].y); ctx.closePath(); ctx.fill(); }
  } else if (o.type === 'pen') {
    ctx.strokeStyle = o.stroke; ctx.lineWidth = o.sw; ctx.beginPath();
    o.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    if (o.pts.length === 1) ctx.lineTo(o.pts[0][0] + 0.01, o.pts[0][1]);
    ctx.stroke();
  } else if (o.type === 'image') {
    const im = imgs.get(o.img);
    if (im) ctx.drawImage(im.bitmap, o.x, o.y, o.w, o.h);
  } else if (o.type === 'text' && o !== editing) {
    const m = textMetrics(o);
    ctx.font = `${o.bold ? 700 : 400} ${o.size}px ${FONT}`; ctx.fillStyle = o.color; ctx.textBaseline = 'alphabetic';
    m.lines.forEach((l, k) => {
      const ax = o.align === 'center' ? (m.w - m.ws[k]) / 2 : o.align === 'right' ? m.w - m.ws[k] : 0;
      ctx.fillText(l, o.x + ax, o.y + baseOff(o.size) + k * LH * o.size);
    });
  }
  ctx.restore();
}
function arrowHead(o) {   // triangle at (x2, y2)
  const a = Math.atan2(o.y2 - o.y1, o.x2 - o.x1), len = Math.max(9, o.sw * 4), w = len * 0.55, tip = { x: o.x2, y: o.y2 };
  const bx = tip.x - Math.cos(a) * len, by = tip.y - Math.sin(a) * len;
  return [tip, { x: bx + Math.sin(a) * w, y: by - Math.cos(a) * w }, { x: bx - Math.sin(a) * w, y: by + Math.cos(a) * w }];
}

// handles of the selected object (page coordinates)
function handlesOf(o) {
  const hs = [];
  if (LINELIKE.has(o.type)) return [{ id: 'p1', x: o.x1, y: o.y1 }, { id: 'p2', x: o.x2, y: o.y2 }];
  if (o.type === 'pen') return hs;
  const b = box(o), c = ctr(o), at = (hx, hy) => rotPt(c.x + hx * b.w / 2, c.y + hy * b.h / 2, c, o.rot || 0);
  const list = o.type === 'text' ? [[1, 1]] : [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  for (const [hx, hy] of list) hs.push({ id: 'r', hx, hy, ...at(hx, hy) });
  const top = rotPt(c.x, c.y - b.h / 2 - 22 / zoom, c, o.rot || 0);
  hs.push({ id: 'rot', x: top.x, y: top.y });
  return hs;
}
function drawSel(ctx, o) {
  const k = 1 / zoom;
  ctx.save();
  ctx.lineWidth = 1.2 * k; ctx.strokeStyle = '#4f8cff'; ctx.setLineDash([4 * k, 3 * k]);
  const b = box(o), c = ctr(o);
  if (rotates(o) && o.rot) { ctx.translate(c.x, c.y); ctx.rotate(rad(o.rot)); ctx.translate(-c.x, -c.y); }
  if (!LINELIKE.has(o.type)) ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.restore();
  ctx.save();
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 1.5 * k;
  for (const h of handlesOf(o)) {
    ctx.beginPath();
    if (h.id === 'rot' || h.id === 'p1' || h.id === 'p2') ctx.arc(h.x, h.y, 5 * k, 0, Math.PI * 2); else ctx.rect(h.x - 4 * k, h.y - 4 * k, 8 * k, 8 * k);
    ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}
function draw() {
  const ctx = ovCv.getContext('2d'), s = zoom * dpr();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ovCv.width, ovCv.height);
  if (!src || !pages[cur]) return;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  for (const o of pages[cur].objs) drawObj(ctx, o);
  if (sel && pages[cur].objs.includes(sel) && sel !== editing) drawSel(ctx, sel);
}

function hitObj(o, p) {
  const tol = 6 / zoom;
  if (LINELIKE.has(o.type)) return distSeg(p, { x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }) <= Math.max(tol, o.sw / 2 + tol / 2);
  if (o.type === 'pen') {
    for (let i = 0; i < o.pts.length; i++) {
      const a = { x: o.pts[i][0], y: o.pts[i][1] }, b = o.pts[i + 1] ? { x: o.pts[i + 1][0], y: o.pts[i + 1][1] } : a;
      if (distSeg(p, a, b) <= Math.max(tol, o.sw / 2 + tol / 2)) return true;
    }
    return false;
  }
  const b = box(o), c = ctr(o), q = o.rot ? rotPt(p.x, p.y, c, -o.rot) : p;
  const inside = (m) => q.x >= b.x - m && q.x <= b.x + b.w + m && q.y >= b.y - m && q.y <= b.y + b.h + m;
  if ((o.type === 'rect' || o.type === 'ellipse') && !o.fill) {   // an empty outline is picked by its edge only
    const m = Math.max(tol, (o.sw || 0) / 2 + tol / 2);
    return inside(m) && !(q.x > b.x + m && q.x < b.x + b.w - m && q.y > b.y + m && q.y < b.y + b.h - m);
  }
  return inside(tol / 2);
}
function hitHandle(o, p) {
  const r = 8 / zoom;
  return handlesOf(o).find((h) => Math.abs(h.x - p.x) <= r && Math.abs(h.y - p.y) <= r) || null;
}
const topObjAt = (p) => { const l = pages[cur].objs; for (let i = l.length - 1; i >= 0; i--) if (hitObj(l[i], p)) return l[i]; return null; };

// ---------- pointer interaction ----------
function pt(e) {
  const r = ovCv.getBoundingClientRect(), { vp1 } = info[cur];
  return { x: (e.clientX - r.left) * (vp1.width / r.width), y: (e.clientY - r.top) * (vp1.height / r.height) };
}
function dragWindow(move, up) {
  const u = (ev) => { removeEventListener('pointermove', move); removeEventListener('pointerup', u); up && up(ev); };
  addEventListener('pointermove', move); addEventListener('pointerup', u);
}
function select(o) { sel = o; renderProps(); draw(); }
function setTool(t) {
  tool = t;
  document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  ovCv.style.cursor = t === 'select' ? 'default' : 'crosshair';
}
document.querySelectorAll('#tools button').forEach((b) => {
  b.onclick = () => {
    if (!src) { alert('먼저 PDF / AI 파일을 여세요.'); return; }
    const t = b.dataset.t;
    if (t === 'image') { $('imgFile').click(); return; }
    if (t === 'sig') { openSig(); return; }
    setTool(t);
  };
});

const newId = () => ++seq;
function makeObj(t, p) {
  const base = { id: newId(), type: t, opacity: 1 };
  if (t === 'rect') return { ...base, x: p.x, y: p.y, w: 0, h: 0, rot: 0, fill: null, stroke: style.stroke, sw: style.sw };
  if (t === 'ellipse') return { ...base, x: p.x, y: p.y, w: 0, h: 0, rot: 0, fill: null, stroke: style.stroke, sw: style.sw };
  if (t === 'highlight') return { ...base, x: p.x, y: p.y, w: 0, h: 0, rot: 0, fill: '#ffe14d', stroke: null, sw: 0, opacity: 0.4 };
  if (t === 'cover') return { ...base, x: p.x, y: p.y, w: 0, h: 0, rot: 0, fill: '#ffffff', stroke: null, sw: 0 };
  if (t === 'line' || t === 'arrow') return { ...base, x1: p.x, y1: p.y, x2: p.x, y2: p.y, stroke: style.stroke, sw: style.sw };
  if (t === 'pen') return { ...base, pts: [[p.x, p.y]], stroke: style.stroke, sw: Math.max(1, style.sw) };
  return null;
}
function addObj(o) { pages[cur].objs.push(o); renderThumbBadges(); }

ovCv.addEventListener('pointerdown', (e) => {
  if (!src || busy) return;
  e.preventDefault();
  const p = pt(e);
  if (editing) commitEditor();
  if (tool === 'text') return createText(p);
  if (tool === 'edit') return replaceTextAt(p);
  if (tool !== 'select') return startCreate(e, p);
  const h = sel && hitHandle(sel, p);
  if (h) return startHandle(e, sel, h, p);
  const o = topObjAt(p);
  if (o) { select(o); startMove(e, o, p); } else select(null);
});
ovCv.addEventListener('dblclick', (e) => {
  if (!src || tool !== 'select') return;
  const o = topObjAt(pt(e));
  if (o && o.type === 'text') { select(o); openEditor(o); }
});
ovCv.addEventListener('pointermove', (e) => {
  if (!src || e.buttons) return;
  if (tool !== 'select') { ovCv.style.cursor = 'crosshair'; return; }
  const p = pt(e), h = sel && hitHandle(sel, p);
  ovCv.style.cursor = h ? (h.id === 'rot' ? 'grab' : h.id === 'r' ? (h.hx && h.hy ? (h.hx * h.hy > 0 ? 'nwse-resize' : 'nesw-resize') : h.hx ? 'ew-resize' : 'ns-resize') : 'move') : topObjAt(p) ? 'move' : 'default';
});

function startCreate(e, p0) {
  e.preventDefault();
  const o = makeObj(tool, p0);
  snap(); addObj(o); sel = o;
  const shape = ['rect', 'ellipse', 'highlight', 'cover'].includes(o.type);
  dragWindow((ev) => {
    const p = pt(ev);
    if (shape) { o.x = Math.min(p0.x, p.x); o.y = Math.min(p0.y, p.y); o.w = Math.abs(p.x - p0.x); o.h = Math.abs(p.y - p0.y); }
    else if (o.type === 'pen') { const l = o.pts[o.pts.length - 1]; if (Math.hypot(p.x - l[0], p.y - l[1]) > 0.8 / zoom * 1.5) o.pts.push([p.x, p.y]); }
    else { let { x, y } = p; if (ev.shiftKey) { const a = Math.round(Math.atan2(y - p0.y, x - p0.x) / (Math.PI / 4)) * (Math.PI / 4), d = Math.hypot(x - p0.x, y - p0.y); x = p0.x + Math.cos(a) * d; y = p0.y + Math.sin(a) * d; } o.x2 = x; o.y2 = y; }
    draw();
  }, () => {
    const b = box(o), tiny = o.type === 'pen' ? false : LINELIKE.has(o.type) ? Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 3 : (b.w < 3 && b.h < 3);
    if (tiny) { pages[cur].objs.splice(pages[cur].objs.indexOf(o), 1); undoS.pop(); updateUndo(); sel = null; renderThumbBadges(); }
    else if (shape && (b.w < 3 || b.h < 3) && o.type !== 'highlight' && o.type !== 'cover') { /* a thin line-like box is allowed */ }
    setTool('select'); renderProps(); draw();
  });
}

function startMove(e, o, p0) {
  e.preventDefault();
  const g0 = JSON.parse(JSON.stringify(o));
  let moved = false;
  dragWindow((ev) => {
    const p = pt(ev), dx = p.x - p0.x, dy = p.y - p0.y;
    if (!moved) { if (Math.hypot(dx, dy) * zoom < 3) return; moved = true; snap(); }
    if (LINELIKE.has(o.type)) { o.x1 = g0.x1 + dx; o.y1 = g0.y1 + dy; o.x2 = g0.x2 + dx; o.y2 = g0.y2 + dy; }
    else if (o.type === 'pen') o.pts = g0.pts.map((q) => [q[0] + dx, q[1] + dy]);
    else { o.x = g0.x + dx; o.y = g0.y + dy; }
    draw();
  });
}
function startHandle(e, o, h, p0) {
  e.preventDefault();
  snap();
  const b0 = { ...box(o) }, c0 = ctr(o), rot0 = o.rot || 0, size0 = o.size, d0 = dist(p0, c0) || 1;
  dragWindow((ev) => {
    const p = pt(ev);
    if (h.id === 'rot') {
      let a = Math.atan2(p.y - c0.y, p.x - c0.x) * 180 / Math.PI + 90;
      if (ev.shiftKey) a = Math.round(a / 15) * 15;
      a = ((a + 180) % 360 + 360) % 360 - 180;
      o.rot = Math.round(a * 10) / 10;
    } else if (h.id === 'p1' || h.id === 'p2') {
      let { x, y } = p;
      const fx = h.id === 'p1' ? o.x2 : o.x1, fy = h.id === 'p1' ? o.y2 : o.y1;
      if (ev.shiftKey) { const a = Math.round(Math.atan2(y - fy, x - fx) / (Math.PI / 4)) * (Math.PI / 4), d = Math.hypot(x - fx, y - fy); x = fx + Math.cos(a) * d; y = fy + Math.sin(a) * d; }
      if (h.id === 'p1') { o.x1 = x; o.y1 = y; } else { o.x2 = x; o.y2 = y; }
    } else if (o.type === 'text') {
      o.size = Math.round(clamp(size0 * dist(p, c0) / d0, 4, 400) * 10) / 10;
    } else {
      const MIN = 4, lp = rotPt(p.x, p.y, c0, -rot0), lx = lp.x - c0.x, ly = lp.y - c0.y, hw = b0.w / 2, hh = b0.h / 2;
      let L = -hw, R = hw, T = -hh, B = hh;
      if (h.hx < 0) L = Math.min(lx, R - MIN); else if (h.hx > 0) R = Math.max(lx, L + MIN);
      if (h.hy < 0) T = Math.min(ly, B - MIN); else if (h.hy > 0) B = Math.max(ly, T + MIN);
      if (o.type === 'image' && h.hx && h.hy) { const ratio = b0.w / b0.h; if (h.hy > 0) B = T + (R - L) / ratio; else T = B - (R - L) / ratio; }
      const c1 = rotPt(c0.x + (L + R) / 2, c0.y + (T + B) / 2, c0, rot0);
      o.w = R - L; o.h = B - T; o.x = c1.x - o.w / 2; o.y = c1.y - o.h / 2;
    }
    draw();
  }, () => renderProps());
}

// ---------- text objects ----------
function createText(p) {
  snap();
  const o = { id: newId(), type: 'text', x: p.x, y: p.y, text: '텍스트', size: style.size, bold: false, align: 'left', color: style.color, rot: 0, opacity: 1 };
  addObj(o); setTool('select'); select(o); openEditorSoon(o, true);
}
// the click that made the box would take the focus away again, so the editor opens right after it
const openEditorSoon = (o, all) => setTimeout(() => { if (pages[cur].objs.includes(o)) openEditor(o, all); }, 40);
const ed = $('textEdit');
function openEditor(o, selectAll) {
  editing = o; draw();
  const b = box(o), z = zoom;
  ed.hidden = false;
  ed.value = o.text;
  Object.assign(ed.style, { left: o.x * z + 'px', top: o.y * z + 'px', fontSize: o.size * z + 'px', fontWeight: o.bold ? 700 : 400, color: o.color, textAlign: o.align, transform: o.rot ? `rotate(${o.rot}deg)` : '' });
  sizeEditor();
  ed.focus();
  if (selectAll) ed.select(); else ed.setSelectionRange(ed.value.length, ed.value.length);
  void b;
}
function sizeEditor() {
  if (!editing) return;
  const m = textMetrics({ ...editing, text: ed.value });
  ed.style.width = Math.ceil(m.w * zoom + 8) + 'px'; ed.style.height = Math.ceil(m.h * zoom + 2) + 'px';
}
ed.addEventListener('input', () => { if (!editing) return; editing.text = ed.value; sizeEditor(); renderPropsText(); });
ed.addEventListener('blur', () => commitEditor());
ed.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); commitEditor(); } e.stopPropagation(); });
function hideEditor() { ed.hidden = true; }
function commitEditor() {
  if (!editing) return;
  const o = editing;
  editing = null; hideEditor();
  if (!String(o.text).trim()) { const l = pages[cur].objs; const i = l.indexOf(o); if (i >= 0) l.splice(i, 1); if (sel === o) sel = null; renderThumbBadges(); }
  renderProps(); draw();
}

// "글자 바꾸기": cover the line of text under the click and put an editable text box on it
async function textRuns(i) {
  if (!textCache[i]) { const { page } = await pageInfo(i); textCache[i] = await page.getTextContent(); }
  const { vp1 } = await pageInfo(i);
  return textCache[i].items.filter((it) => it.str && it.str.trim()).map((it) => {
    const [a, b, , , e, f] = it.transform, size = Math.hypot(a, b) || 10, p0 = vp1.convertToViewportPoint(e, f);
    const p1 = vp1.convertToViewportPoint(e + (a / size) * it.width, f + (b / size) * it.width);
    return { str: it.str, size, x0: p0[0], y0: p0[1], ang: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]), len: Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) };
  });
}
const sampleColor = (x, y) => {   // page pixel at (x, y) in points
  const s = zoom * dpr(), d = pageCv.getContext('2d').getImageData(clamp(Math.round(x * s), 0, pageCv.width - 1), clamp(Math.round(y * s), 0, pageCv.height - 1), 1, 1).data;
  return [d[0], d[1], d[2]];
};
const hex = (c) => '#' + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
async function replaceTextAt(p) {
  const runs = await textRuns(cur);
  // local coordinates along / across each run
  const local = (r, q) => { const a = rotPt(q.x, q.y, { x: r.x0, y: r.y0 }, -r.ang * 180 / Math.PI); return { u: a.x - r.x0, v: a.y - r.y0 }; };
  const hit = runs.find((r) => { const l = local(r, p); return l.u >= -2 && l.u <= r.len + 2 && l.v >= -r.size * 0.9 && l.v <= r.size * 0.3; });
  if (!hit) { say('이 자리에서 PDF 글자를 찾지 못했습니다 (스캔한 이미지 글자는 선택할 수 없습니다)'); setTimeout(() => say(''), 2500); return; }
  const same = runs.filter((r) => Math.abs(r.ang - hit.ang) < 0.05 && Math.abs(local(hit, { x: r.x0, y: r.y0 }).v) < hit.size * 0.5)
    .map((r) => ({ r, u: local(hit, { x: r.x0, y: r.y0 }).u })).sort((a, b) => a.u - b.u);
  let i = same.findIndex((s) => s.r === hit), lo = i, hi = i;
  while (lo > 0 && same[lo].u - (same[lo - 1].u + same[lo - 1].r.len) < hit.size * 1.0) lo--;
  while (hi < same.length - 1 && same[hi + 1].u - (same[hi].u + same[hi].r.len) < hit.size * 1.0) hi++;
  let text = '';
  for (let k = lo; k <= hi; k++) {
    const s = same[k];
    if (k > lo) { const gap = s.u - (same[k - 1].u + same[k - 1].r.len); if (gap > hit.size * 0.15 && !/\s$/.test(text) && !/^\s/.test(s.r.str)) text += ' '; }
    text += s.r.str;
  }
  const first = same[lo], last = same[hi], size = hit.size, ang = hit.ang * 180 / Math.PI;
  const u0 = first.u, u1 = last.u + last.r.len, top = -size * 0.95, bot = size * 0.3, o0 = { x: hit.x0, y: hit.y0 };
  const toView = (u, v) => rotPt(o0.x + u, o0.y + v, o0, ang);
  const cc = toView((u0 + u1) / 2, (top + bot) / 2);
  const cw = u1 - u0 + 3, chh = bot - top + 2;
  // colours from the page itself: text = darkest pixel in the box, cover = the paper around it
  const tl = toView(u0, top), br = toView(u1, bot);
  let dark = [0, 0, 0], best = 999;
  { const x0 = Math.min(tl.x, br.x), x1 = Math.max(tl.x, br.x), y0 = Math.min(tl.y, br.y), y1 = Math.max(tl.y, br.y), s = zoom * dpr();
    const d = pageCv.getContext('2d').getImageData(clamp(Math.floor(x0 * s), 0, pageCv.width - 1), clamp(Math.floor(y0 * s), 0, pageCv.height - 1), Math.max(1, Math.min(pageCv.width, Math.ceil((x1 - x0) * s))), Math.max(1, Math.min(pageCv.height, Math.ceil((y1 - y0) * s)))).data;
    for (let k = 0; k < d.length; k += 4) { const l = d[k] * 0.299 + d[k + 1] * 0.587 + d[k + 2] * 0.114; if (l < best) { best = l; dark = [d[k], d[k + 1], d[k + 2]]; } } }
  const a = sampleColor(tl.x - 2, cc.y), b = sampleColor(br.x + 2, cc.y), paper = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  snap();
  const cover = { id: newId(), type: 'cover', x: cc.x - cw / 2, y: cc.y - chh / 2, w: cw, h: chh, rot: Math.abs(ang) < 0.01 ? 0 : ang, fill: hex(paper), stroke: null, sw: 0, opacity: 1 };
  const txt = { id: newId(), type: 'text', x: 0, y: 0, text, size: Math.round(size * 10) / 10, bold: false, align: 'left', color: best < 150 ? hex(dark) : '#000000', rot: Math.abs(ang) < 0.01 ? 0 : ang, opacity: 1 };
  if (!txt.rot) { txt.x = first.r.x0; txt.y = first.r.y0 - baseOff(size); }
  else { const m = textMetrics(txt); txt.x = cc.x - m.w / 2; txt.y = cc.y - m.h / 2; }
  addObj(cover); addObj(txt);
  setTool('select'); select(txt); openEditorSoon(txt, true);
}

// ---------- images / signature ----------
async function jpegOrientation(file) {
  const b = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 9 < b.length && b[i] === 0xff) {
    const m = b[i + 1], L = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78) {
      const t = i + 10, le = b[t] === 0x49, r16 = (o) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
      const r32 = (o) => (le ? (r16(o) | (r16(o + 2) << 16)) >>> 0 : ((r16(o) << 16) | r16(o + 2)) >>> 0), ifd = r32(4), n = r16(ifd);
      for (let k = 0; k < n; k++) if (r16(ifd + 2 + k * 12) === 0x0112) return r16(ifd + 2 + k * 12 + 8);
      return 1;
    }
    if (m === 0xda) break;
    i += 2 + L;
  }
  return 1;
}
async function registerImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let bytes, type = file.type;
  if ((type === 'image/png' || (type === 'image/jpeg' && (await jpegOrientation(file)) === 1))) bytes = new Uint8Array(await file.arrayBuffer());
  else { const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height; c.getContext('2d').drawImage(bitmap, 0, 0); type = 'image/png'; bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer()); }
  const id = newId();
  imgs.set(id, { bitmap, bytes, type, w: bitmap.width, h: bitmap.height });
  return id;
}
function placeImage(id, maxFrac = 0.4) {
  const im = imgs.get(id), { vp1 } = info[cur], w = Math.min(im.w, vp1.width * maxFrac), h = w * im.h / im.w;
  snap();
  const o = { id: newId(), type: 'image', img: id, x: (vp1.width - w) / 2, y: (vp1.height - h) / 2, w, h, rot: 0, opacity: 1 };
  addObj(o); setTool('select'); select(o);
}
$('imgFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !src) return;
  try { placeImage(await registerImage(f)); } catch (err) { alert('이미지를 넣지 못했습니다.\n' + err.message); }
};
// signature pad
const sigCv = $('sigCv'), sctx = sigCv.getContext('2d');
let sigStrokes = [];
function openSig() { sigStrokes = []; sctx.clearRect(0, 0, sigCv.width, sigCv.height); $('sigModal').hidden = false; }
function sigDraw() { sctx.clearRect(0, 0, sigCv.width, sigCv.height); sctx.lineWidth = 3; sctx.lineCap = sctx.lineJoin = 'round'; sctx.strokeStyle = '#111'; for (const s of sigStrokes) { sctx.beginPath(); s.forEach((p, i) => (i ? sctx.lineTo(p[0], p[1]) : sctx.moveTo(p[0], p[1]))); if (s.length === 1) sctx.lineTo(s[0][0] + 0.1, s[0][1]); sctx.stroke(); } }
sigCv.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const r = sigCv.getBoundingClientRect(), at = (ev) => [(ev.clientX - r.left) * sigCv.width / r.width, (ev.clientY - r.top) * sigCv.height / r.height];
  const s = [at(e)]; sigStrokes.push(s); sigDraw();
  dragWindow((ev) => { s.push(at(ev)); sigDraw(); });
});
$('sigClear').onclick = () => { sigStrokes = []; sigDraw(); };
$('sigCancel').onclick = () => { $('sigModal').hidden = true; };
$('sigOk').onclick = async () => {
  const pts = sigStrokes.flat();
  if (!pts.length) { $('sigModal').hidden = true; return; }
  const pad = 6, x0 = Math.max(0, Math.min(...pts.map((p) => p[0])) - pad), y0 = Math.max(0, Math.min(...pts.map((p) => p[1])) - pad);
  const x1 = Math.min(sigCv.width, Math.max(...pts.map((p) => p[0])) + pad), y1 = Math.min(sigCv.height, Math.max(...pts.map((p) => p[1])) + pad);
  const c = document.createElement('canvas'); c.width = Math.ceil(x1 - x0); c.height = Math.ceil(y1 - y0);
  c.getContext('2d').drawImage(sigCv, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png')), id = newId();
  imgs.set(id, { bitmap: await createImageBitmap(blob), bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/png', w: c.width, h: c.height });
  $('sigModal').hidden = true;
  placeImage(id, 0.25);
};

// ======================================================================
// properties panel
// ======================================================================
const props = $('props');
const colorRow = (label, k, val, none) => `<div class="f"><label>${label}</label><div class="row"><input type="color" data-k="${k}" value="${val || '#000000'}"${val ? '' : ' disabled'}>${none ? `<label class="chk"><input type="checkbox" data-none="${k}"${val ? '' : ' checked'}> 없음</label>` : ''}</div></div>`;
const rangeRow = (label, k, min, max, step, val, scale = 1) => `<div class="f"><label>${label}</label><div class="row"><input type="range" data-k="${k}" data-scale="${scale}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${val}</output></div></div>`;
function renderProps() {
  const o = sel && pages[cur] && pages[cur].objs.includes(sel) ? sel : null;
  if (!src) { props.innerHTML = '<p class="hint">파일을 열면 여기서 선택한 개체의 속성을 바꿀 수 있습니다.</p>'; return; }
  if (!o) {
    props.innerHTML = '<h3>새 개체 기본값</h3>' + colorRow('선 색', 'dstroke', style.stroke) + rangeRow('선 굵기', 'dsw', 1, 20, 0.5, style.sw) + rangeRow('글자 크기', 'dsize', 6, 120, 1, style.size) + colorRow('글자 색', 'dcolor', style.color) +
      '<p class="hint">개체를 선택하면 속성을 바꿀 수 있습니다.<br>Delete: 삭제 · 방향키: 이동(Shift: 10pt) · Ctrl+Z: 실행취소<br>글자 바꾸기: PDF 안의 글자를 클릭하면 그 줄을 가리고 같은 자리에 수정할 글자 상자를 만듭니다. 원래 글자는 지워지지 않고 덮어씌워집니다. (가리기도 마찬가지라 기밀 정보를 가리는 용도로는 쓰지 마세요)</p>';
    return;
  }
  let h = `<h3>${{ text: '텍스트', rect: '사각형', ellipse: '타원', line: '선', arrow: '화살표', pen: '펜', highlight: '형광펜', cover: '가리기', image: '이미지' }[o.type]}</h3>`;
  if (o.type === 'text') {
    h += `<div class="f"><label>내용</label><textarea data-k="text" data-str="1"></textarea></div>` + rangeRow('글자 크기', 'size', 4, 200, 0.5, o.size) + colorRow('글자 색', 'color', o.color) +
      `<div class="f"><label class="chk"><input type="checkbox" data-k="bold"${o.bold ? ' checked' : ''}> 굵게</label></div>` +
      `<div class="f"><label>정렬</label><select data-k="align" data-str="1"><option value="left">왼쪽</option><option value="center">가운데</option><option value="right">오른쪽</option></select></div>`;
  } else if (o.type === 'rect' || o.type === 'ellipse') h += colorRow('채우기', 'fill', o.fill, true) + colorRow('선 색', 'stroke', o.stroke, true) + rangeRow('선 굵기', 'sw', 0, 30, 0.5, o.sw);
  else if (o.type === 'highlight' || o.type === 'cover') h += colorRow('색', 'fill', o.fill);
  else if (LINELIKE.has(o.type) || o.type === 'pen') h += colorRow('색', 'stroke', o.stroke) + rangeRow('굵기', 'sw', 0.5, 30, 0.5, o.sw);
  h += rangeRow('투명도', 'opacity', 0, 100, 1, Math.round((o.opacity ?? 1) * 100), 0.01);
  if (rotates(o)) h += rangeRow('회전', 'rot', -180, 180, 1, Math.round(o.rot || 0), 1);
  h += '<div class="actions"><button class="btn small" data-act="dup">복제</button><button class="btn small" data-act="del">삭제</button><button class="btn small" data-act="front">맨 앞으로</button><button class="btn small" data-act="back">맨 뒤로</button></div>';
  props.innerHTML = h;
  const ta = props.querySelector('textarea'); if (ta) ta.value = o.text;
  const al = props.querySelector('select[data-k=align]'); if (al) al.value = o.align;
}
function renderPropsText() { const ta = props.querySelector('textarea[data-k=text]'); if (ta && document.activeElement !== ta) ta.value = sel ? sel.text : ''; }
let armed = true;
props.addEventListener('input', (e) => {
  const el = e.target, k = el.dataset.k;
  if (!k || el.dataset.none) return;
  if (['dstroke', 'dsw', 'dsize', 'dcolor'].includes(k)) {   // defaults for the next objects
    const v = el.type === 'range' ? +el.value : el.value;
    style[{ dstroke: 'stroke', dsw: 'sw', dsize: 'size', dcolor: 'color' }[k]] = v;
    if (el.type === 'range') el.parentElement.querySelector('output').textContent = el.value;
    return;
  }
  const o = sel;
  if (!o) return;
  if (armed) { snap(); armed = false; }
  let v;
  if (el.type === 'checkbox') v = el.checked;
  else if (el.type === 'range') { v = parseFloat(el.value) * parseFloat(el.dataset.scale); el.parentElement.querySelector('output').textContent = el.value; if (k !== 'rot' && k !== 'opacity') v = +v.toFixed(2); else v = +v.toFixed(3); }
  else v = el.value;
  o[k] = v;
  if (k === 'text' && o.type === 'text') { /* panel typing */ }
  draw();
});
props.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.none) {   // "없음" for fill / stroke
    const k = el.dataset.none, o = sel;
    if (!o) return;
    snap();
    const color = props.querySelector(`input[type=color][data-k=${k}]`);
    if (el.checked) o[k] = null; else o[k] = color.value;
    color.disabled = el.checked;
    draw();
  }
  armed = true;
});
props.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || !sel) return;
  const l = pages[cur].objs, i = l.indexOf(sel);
  if (i < 0) return;
  snap();
  if (b.dataset.act === 'del') { l.splice(i, 1); sel = null; }
  else if (b.dataset.act === 'dup') { const c = JSON.parse(JSON.stringify(sel)); c.id = newId(); shiftObj(c, 12, 12); l.push(c); sel = c; }
  else if (b.dataset.act === 'front') { l.push(l.splice(i, 1)[0]); }
  else if (b.dataset.act === 'back') { l.unshift(l.splice(i, 1)[0]); }
  renderProps(); draw(); renderThumbBadges();
});
function shiftObj(o, dx, dy) {
  if (LINELIKE.has(o.type)) { o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; }
  else if (o.type === 'pen') o.pts = o.pts.map((p) => [p[0] + dx, p[1] + dy]);
  else { o.x += dx; o.y += dy; }
}
addEventListener('keydown', (e) => {
  if (!src || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || !$('sigModal').hidden) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if ((k === 'Delete' || k === 'Backspace') && sel) { e.preventDefault(); const l = pages[cur].objs, i = l.indexOf(sel); if (i >= 0) { snap(); l.splice(i, 1); sel = null; renderProps(); draw(); renderThumbBadges(); } }
  else if (k === 'Escape') { setTool('select'); select(null); }
  else if (sel && k.startsWith('Arrow')) { e.preventDefault(); snap(); const d = e.shiftKey ? 10 : 1; shiftObj(sel, k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0, k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0); draw(); }
  else if (!e.ctrlKey && !e.metaKey && !e.altKey && (k === 'v' || k === 'V')) setTool('select');
  else if (!e.ctrlKey && !e.metaKey && !e.altKey && (k === 't' || k === 'T')) setTool('text');
});

// ======================================================================
// save: put every object into the PDF
// ======================================================================
const fmtN = (n) => (+n.toFixed(3)).toString();
const rgbOf = (h) => { const n = parseInt(h.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
// Text goes into the PDF as vector outlines of the font's glyphs (exactly what is on screen, any language, no font to embed):
// embedding a subset of this font with pdf-lib/fontkit loses glyphs. The text is therefore not selectable / searchable in the new PDF.
const fonts = {};
async function loadFont(bold) {
  const k = bold ? 'b' : 'r';
  if (!fonts[k]) {
    const r = await fetch(`fonts/Pretendard-${bold ? 'Bold' : 'Regular'}.ttf`);
    if (!r.ok) throw new Error('글꼴 파일을 불러오지 못했습니다.');
    fonts[k] = window.fontkit.create(new Uint8Array(await r.arrayBuffer()));
  }
  return fonts[k];
}
// glyph outlines of one line → path commands as [cmd, [[x, y]...]] in object-local view coordinates (y down), baseline-left at (bx, by)
function glyphLine(font, line, size, bx, by) {
  const run = font.layout(line), k = size / font.unitsPerEm, out = [];
  let pen = 0;
  run.glyphs.forEach((g, i) => {
    const pos = run.positions[i], ox = bx + (pen + pos.xOffset) * k, oy = by - pos.yOffset * k;
    for (const c of g.path.commands) {
      const a = c.args, pts = [];
      for (let j = 0; j < a.length; j += 2) pts.push([ox + a[j] * k, oy - a[j + 1] * k]);
      out.push([c.command, pts]);
    }
    pen += pos.xAdvance;
  });
  return { cmds: out, width: pen * k };
}
async function savePdf() {
  await work('PDF를 만드는 중…', async () => {
    commitEditor();
    const doc = await PDFDocument.load(src.bytes, { ignoreEncryption: true });
    const emb = new Map();
    for (let i = 0; i < pages.length; i++) {
      const objs = pages[i].objs;
      if (!objs.length) continue;
      say(`PDF를 만드는 중… ${i + 1}/${pages.length}`);
      const page = doc.getPage(i), { vp1 } = await pageInfo(i), R = vp1.rotation || 0;
      const U = (p) => { const [x, y] = vp1.convertToPdfPoint(p.x, p.y); return { x, y }; };
      const P = (p) => `${fmtN(p.x)} ${fmtN(-p.y)}`;
      const toU = (o, x, y) => U(o.rot ? rotPt(x, y, ctr(o), o.rot) : { x, y });
      for (const o of objs) {
        const op = o.opacity ?? 1;
        if (o.type === 'rect' || o.type === 'cover' || o.type === 'highlight') {
          const c = [toU(o, o.x, o.y), toU(o, o.x + o.w, o.y), toU(o, o.x + o.w, o.y + o.h), toU(o, o.x, o.y + o.h)];
          page.drawSvgPath(`M ${P(c[0])} L ${P(c[1])} L ${P(c[2])} L ${P(c[3])} Z`, svgStyle(o, op));
        } else if (o.type === 'ellipse') {
          const k = 0.5522847498, cx = o.x + o.w / 2, cy = o.y + o.h / 2, rx = o.w / 2, ry = o.h / 2, T = (lx, ly) => toU(o, cx + lx, cy + ly);
          const d = `M ${P(T(0, -ry))} C ${P(T(k * rx, -ry))} ${P(T(rx, -k * ry))} ${P(T(rx, 0))} C ${P(T(rx, k * ry))} ${P(T(k * rx, ry))} ${P(T(0, ry))} C ${P(T(-k * rx, ry))} ${P(T(-rx, k * ry))} ${P(T(-rx, 0))} C ${P(T(-rx, -k * ry))} ${P(T(-k * rx, -ry))} ${P(T(0, -ry))} Z`;
          page.drawSvgPath(d, svgStyle(o, op));
        } else if (LINELIKE.has(o.type)) {
          page.drawSvgPath(`M ${P(U({ x: o.x1, y: o.y1 }))} L ${P(U({ x: o.x2, y: o.y2 }))}`, { x: 0, y: 0, borderColor: rgbOf(o.stroke), borderWidth: o.sw, borderOpacity: op, borderLineCap: 1 });
          if (o.type === 'arrow') { const h = arrowHead(o).map(U); page.drawSvgPath(`M ${P(h[0])} L ${P(h[1])} L ${P(h[2])} Z`, { x: 0, y: 0, color: rgbOf(o.stroke), opacity: op }); }
        } else if (o.type === 'pen') {
          const d = o.pts.map((p, n) => `${n ? 'L' : 'M'} ${P(U({ x: p[0], y: p[1] }))}`).join(' ') + (o.pts.length === 1 ? ` L ${P(U({ x: o.pts[0][0] + 0.01, y: o.pts[0][1] }))}` : '');
          page.drawSvgPath(d, { x: 0, y: 0, borderColor: rgbOf(o.stroke), borderWidth: o.sw, borderOpacity: op, borderLineCap: 1 });
        } else if (o.type === 'image') {
          const im = imgs.get(o.img);
          if (!im) continue;
          let e = emb.get(o.img);
          if (!e) { e = im.type === 'image/png' ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes); emb.set(o.img, e); }
          const a = toU(o, o.x, o.y + o.h);   // bottom-left corner of the image as displayed
          page.drawImage(e, { x: a.x, y: a.y, width: o.w, height: o.h, rotate: degrees(R - (o.rot || 0)), opacity: op });
        } else if (o.type === 'text') {
          const font = await loadFont(o.bold), m = textMetrics(o);
          m.lines.forEach((line, n) => {
            if (!line.trim()) return;
            const w = glyphLine(font, line, o.size, 0, 0).width, ax = o.align === 'center' ? (m.w - w) / 2 : o.align === 'right' ? m.w - w : 0;
            const g = glyphLine(font, line, o.size, o.x + ax, o.y + baseOff(o.size) + n * LH * o.size);
            const T = (q) => P(toU(o, q[0], q[1]));
            const d = g.cmds.map(([c, pts]) => ({ moveTo: 'M', lineTo: 'L', quadraticCurveTo: 'Q', bezierCurveTo: 'C', closePath: 'Z' }[c] + (pts.length ? ' ' + pts.map(T).join(' ') : ''))).join(' ');
            if (d) page.drawSvgPath(d, { x: 0, y: 0, color: rgbOf(o.color), opacity: op });
          });
        }
      }
    }
    const out = await doc.save();
    saveBlob(new Blob([out], { type: 'application/pdf' }), baseName(src.name) + '_edited.pdf');
  });
}
function svgStyle(o, op) {
  const s = { x: 0, y: 0, opacity: op, borderOpacity: op };
  if (o.fill) s.color = rgbOf(o.fill);
  if (o.stroke && o.sw > 0) { s.borderColor = rgbOf(o.stroke); s.borderWidth = o.sw; }
  return s;
}
$('savePdf').onclick = savePdf;

renderProps(); setTool('select');
// small hook for tests
window.__doc = { get pages() { return pages; }, get cur() { return cur; }, get sel() { return sel; }, get zoom() { return zoom; }, get tool() { return tool; }, get src() { return src; }, info, baseOff, textMetrics, snap, renderPage };
