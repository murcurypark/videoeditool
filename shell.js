(() => {
  // The tools of the site, each one a page of its own shown in an iframe. Switching tabs only hides an iframe, so a tool keeps
  // its state (loaded videos, edits) while another one is open. A tool is listed once its page exists: set `ready: true` then.
  const TOOLS = [
    { id: 'video', name: 'Videoeditool', src: 'video.html', ready: true },
    { id: 'pdf', name: 'PDFTrans', src: 'pdf.html', ready: true },
    { id: 'doc', name: 'OfficeDocTool', src: 'doc.html', ready: true },
  ].filter((t) => t.ready);

  const nav = document.getElementById('apptabs'), frames = document.getElementById('frames');
  const ver = (document.currentScript.src.match(/[?&]v=([^&]+)/) || [])[1];   // deploy id, keeps the tool pages from being cached stale
  const KEY = 'medpark-office-tool';
  const get = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  const set = (v) => { try { localStorage.setItem(KEY, v); } catch (e) { /* private mode */ } };

  const tabs = new Map(), pages = new Map();
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'tab-' + t.id; b.textContent = t.name;
    b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'tool-' + t.id);
    b.onclick = () => show(t.id);
    nav.appendChild(b); tabs.set(t.id, b);
  }

  function show(id) {
    const tool = TOOLS.find((t) => t.id === id) || TOOLS[0];
    if (!tool) return;
    for (const [k, b] of tabs) b.setAttribute('aria-selected', String(k === tool.id));
    if (!pages.has(tool.id)) {   // load a tool the first time it is opened
      const f = document.createElement('iframe');
      f.id = 'tool-' + tool.id; f.title = tool.name;
      f.src = tool.src + (ver ? '?v=' + ver : '');
      f.addEventListener('load', () => { if (!f.hidden) f.contentWindow.focus(); });
      frames.appendChild(f); pages.set(tool.id, f);
    }
    for (const [k, f] of pages) f.hidden = k !== tool.id;
    pages.get(tool.id).contentWindow.focus();   // so the tool's keyboard shortcuts work right away
    set(tool.id);
    if (location.hash.slice(1) !== tool.id) history.replaceState(null, '', '#' + tool.id);
    document.title = tool.name + ' · MedPark Office';
  }

  // a file dropped beside the tool must not make the browser open it
  for (const ev of ['dragover', 'drop']) addEventListener(ev, (e) => e.preventDefault());
  addEventListener('hashchange', () => show(location.hash.slice(1)));
  window.MedParkOffice = { tools: TOOLS, show };
  show(location.hash.slice(1) || get());
})();
