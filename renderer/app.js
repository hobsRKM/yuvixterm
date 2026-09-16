'use strict';
/* Renderer controller: sidebar + tabs + xterm terminals + remote monitor.
   Talks to main only through window.api (see preload). */
(() => {
  // Selectable terminal colour schemes (xterm palettes).
  const THEMES = {
    'Catppuccin': {
      background: '#181825', foreground: '#cdd6f4', cursor: '#f5e0dc',
      selectionBackground: '#585b70',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
    'Dracula': {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f0',
      selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
      brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
      brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
    'Solarized Dark': {
      background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1',
      selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75',
      brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
    'Light': {
      background: '#fdf6e3', foreground: '#586e75', cursor: '#586e75',
      selectionBackground: '#eee8d5',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#657b83',
      brightBlack: '#93a1a1', brightRed: '#cb4b16', brightGreen: '#586e75',
      brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1', brightWhite: '#002b36',
    },
  };
  const THEME_NAMES = Object.keys(THEMES);
  const DEFAULT_PREFS = { fontSize: 13, theme: 'Catppuccin' };

  // Per-viewer terminal preferences, remembered locally (best-effort).
  function loadPrefs() {
    try {
      const raw = JSON.parse(localStorage.getItem('yx.prefs') || '{}');
      const fontSize = Math.max(9, Math.min(24, parseInt(raw.fontSize, 10) || DEFAULT_PREFS.fontSize));
      const theme = THEMES[raw.theme] ? raw.theme : DEFAULT_PREFS.theme;
      return { fontSize, theme };
    } catch { return { ...DEFAULT_PREFS }; }
  }
  const prefs = loadPrefs();
  const savePrefs = () => { try { localStorage.setItem('yx.prefs', JSON.stringify(prefs)); } catch { /* */ } };

  let sessions = [];
  const tabs = new Map(); // tabId -> {tabId, session, term, fit, paneEl, tabEl, status, metrics, _banner}
  let activeTab = null;
  let tabCounter = 0;

  const el = (id) => document.getElementById(id);
  const listEl = el('session-list');
  const tabbar = el('tabbar');
  const terminals = el('terminals');
  const modalRoot = el('modal-root');

  // ---------- formatters ----------
  function humanBytes(n) {
    if (n == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
  }
  const humanRate = (n) => humanBytes(n) + '/s';
  // KiB (df 1024-blocks) -> compact human size, e.g. 41152736 -> "39G".
  function fmtKB(kb) {
    const u = ['K', 'M', 'G', 'T', 'P'];
    let v = kb, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + u[i];
  }
  const diskColor = (p) => (p >= 90 ? 'var(--red)' : p >= 70 ? 'var(--yellow)' : 'var(--green)');
  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const val = (id) => { const e = el(id); return e ? e.value.trim() : ''; };

  // ---------- sidebar ----------
  async function loadSessions() {
    sessions = await window.api.sessions.list();
    renderSidebar();
  }
  let sessionFilter = '';
  function renderSidebar() {
    listEl.innerHTML = '';
    const q = sessionFilter.trim().toLowerCase();
    const list = q
      ? sessions.filter((s) => `${s.name || ''} ${s.host || ''}`.toLowerCase().includes(q))
      : sessions;
    if (!list.length) {
      listEl.innerHTML = `<div class="empty" style="margin-top:26px;font-size:12px">${sessions.length ? 'No matches.' : 'No saved hosts.<br>Click ＋ to add one.'}</div>`;
      return;
    }
    const groups = {};
    for (const s of list) { const g = s.group || 'Ungrouped'; (groups[g] = groups[g] || []).push(s); }
    for (const g of Object.keys(groups).sort()) {
      const gl = document.createElement('div');
      gl.className = 'group-label'; gl.textContent = g;
      listEl.appendChild(gl);
      for (const s of groups[g].sort((a, b) => (a.name || a.host).localeCompare(b.name || b.host))) {
        const row = document.createElement('div');
        row.className = 'session';
        row.innerHTML = '<span class="sdot"></span><span class="name"></span><span class="host"></span><span class="edit" title="Edit">✎</span>';
        row.querySelector('.name').textContent = s.name || s.host;
        row.querySelector('.host').textContent = s.host;
        row.addEventListener('click', (e) => {
          if (e.target.classList.contains('edit')) openEditor(s);
          else openSaved(s);
        });
        listEl.appendChild(row);
      }
    }
  }

  // ---------- tabs / terminals ----------
  const newTabId = () => 't' + (++tabCounter);

  function showEmpty() {
    if (!tabs.size) {
      terminals.innerHTML = '<div class="empty">No session open.<br>Click <b>＋</b> to add a host, then click it to connect.</div>';
    }
  }

  function openSaved(session) {
    const tabId = newTabId();
    createTab(tabId, session);
    window.api.conn.open(tabId, { sessionId: session.id });
  }

  function createTab(tabId, session) {
    const empty = terminals.querySelector('.empty');
    if (empty) empty.remove();

    const pane = document.createElement('div');
    pane.className = 'term-pane';
    const host = document.createElement('div');
    host.className = 'term-host';
    pane.appendChild(host);
    terminals.appendChild(pane);

    const term = new Terminal({
      fontFamily: 'ui-monospace, Menlo, monospace',
      fontSize: prefs.fontSize, cursorBlink: true, scrollback: 5000, theme: THEMES[prefs.theme],
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.onData((d) => window.api.conn.write(tabId, d));
    // Copy / paste / zoom shortcuts. Plain Ctrl+C is left alone so it still
    // sends SIGINT — copy is Cmd+C (mac) or Ctrl+Shift+C.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if ((e.metaKey && k === 'c') || (e.ctrlKey && e.shiftKey && k === 'c')) {
        const s = term.getSelection(); if (s) window.api.clipboard.write(s);
        return false;
      }
      if ((e.metaKey && k === 'v') || (e.ctrlKey && e.shiftKey && k === 'v')) {
        window.api.clipboard.read().then((txt) => { if (txt) window.api.conn.write(tabId, txt); });
        return false;
      }
      if (mod && (k === '=' || k === '+')) { setFontSize(prefs.fontSize + 1); return false; }
      if (mod && k === '-') { setFontSize(prefs.fontSize - 1); return false; }
      if (mod && k === '0') { setFontSize(DEFAULT_PREFS.fontSize); return false; }
      return true;
    });
    // Keep keystrokes (incl. Ctrl+C / Ctrl+Z) flowing: any click in the terminal
    // pane refocuses the terminal, so focus never gets stranded on padding/output.
    pane.addEventListener('mousedown', () => setTimeout(() => term.focus(), 0));

    const tabEl = document.createElement('div');
    tabEl.className = 'tab st-connecting';
    tabEl.innerHTML = '<span class="dot"></span><span class="label"></span><button class="close" title="Close">✕</button>';
    tabEl.querySelector('.label').textContent = session.name || session.host;
    tabEl.addEventListener('click', (e) => {
      if (!e.target.classList.contains('close')) activateTab(tabId);
    });
    tabEl.querySelector('.close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(tabId); });
    tabbar.appendChild(tabEl);

    tabs.set(tabId, { tabId, session, term, fit, paneEl: pane, tabEl, status: 'connecting',
      metrics: null, history: { cpu: [] }, _banner: null,
      filesOpen: false, fb: null });
    activateTab(tabId);
  }

  function fitActive(t) {
    try {
      t.fit.fit();
      window.api.conn.resize(t.tabId, t.term.cols, t.term.rows);
    } catch { /* pane not visible yet */ }
  }

  // ---------- terminal preferences (font size + theme) ----------
  function applyTermPrefs() {
    for (const [, t] of tabs) {
      t.term.options.fontSize = prefs.fontSize;
      t.term.options.theme = THEMES[prefs.theme];
    }
    const t = tabs.get(activeTab);
    if (t) fitActive(t);
    savePrefs();
  }
  function setFontSize(px) {
    const v = Math.max(9, Math.min(24, px | 0));
    if (v === prefs.fontSize) return;
    prefs.fontSize = v;
    applyTermPrefs();
  }
  function setTheme(name) {
    if (!THEMES[name] || name === prefs.theme) return;
    prefs.theme = name;
    applyTermPrefs();
  }

  // ---------- terminal right-click menu ----------
  const activeTerm = () => { const t = tabs.get(activeTab); return t ? t.term : null; };
  const termMenu = document.createElement('div');
  termMenu.className = 'ctx-menu';
  termMenu.hidden = true;
  document.body.appendChild(termMenu);
  let menuXY = { x: 0, y: 0 };

  function showTermMenu(x, y) {
    if (x != null) menuXY = { x, y };
    const term = activeTerm();
    const hasSel = !!(term && term.hasSelection && term.hasSelection());
    termMenu.innerHTML =
      `<button class="mi" data-act="copy"${hasSel ? '' : ' disabled'}>Copy<span class="mi-k">⌘C</span></button>` +
      `<button class="mi" data-act="paste">Paste<span class="mi-k">⌘V</span></button>` +
      `<button class="mi" data-act="selall">Select All</button>` +
      `<button class="mi" data-act="clear">Clear</button>` +
      `<div class="ctx-sep"></div>` +
      `<div class="ctx-zoom"><span class="ctx-lbl">Text size</span><span class="ctx-zbtns">` +
        `<button data-act="zoom-out" title="Smaller">A−</button><b>${prefs.fontSize}</b>` +
        `<button data-act="zoom-in" title="Bigger">A+</button>` +
        `<button data-act="zoom-reset" title="Reset">⟲</button></span></div>` +
      `<div class="ctx-sep"></div>` +
      `<div class="ctx-lbl ctx-head">Theme</div>` +
      THEME_NAMES.map((n) =>
        `<button class="mi theme${n === prefs.theme ? ' on' : ''}" data-act="theme" data-theme="${escapeHtml(n)}">` +
        `<span class="tick">${n === prefs.theme ? '✓' : ''}</span>${escapeHtml(n)}</button>`).join('');
    termMenu.hidden = false;
    const mw = termMenu.offsetWidth, mh = termMenu.offsetHeight;
    termMenu.style.left = Math.max(8, Math.min(menuXY.x, window.innerWidth - mw - 8)) + 'px';
    termMenu.style.top = Math.max(8, Math.min(menuXY.y, window.innerHeight - mh - 8)) + 'px';
  }
  const hideTermMenu = () => { termMenu.hidden = true; };

  termMenu.addEventListener('click', async (e) => {
    e.stopPropagation(); // never let this bubble to the document dismiss handler
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const term = activeTerm();
    // These keep the menu open so the user can keep adjusting.
    if (act === 'zoom-in') { setFontSize(prefs.fontSize + 1); return showTermMenu(); }
    if (act === 'zoom-out') { setFontSize(prefs.fontSize - 1); return showTermMenu(); }
    if (act === 'zoom-reset') { setFontSize(DEFAULT_PREFS.fontSize); return showTermMenu(); }
    if (act === 'theme') { setTheme(btn.dataset.theme); return showTermMenu(); }
    // These act once and close.
    if (act === 'copy' && term) { const s = term.getSelection(); if (s) await window.api.clipboard.write(s); }
    else if (act === 'paste' && activeTab) { const txt = await window.api.clipboard.read(); if (txt) window.api.conn.write(activeTab, txt); }
    else if (act === 'selall' && term) term.selectAll();
    else if (act === 'clear' && term) term.clear();
    hideTermMenu();
    if (term) term.focus();
  });
  terminals.addEventListener('contextmenu', (e) => {
    if (!activeTerm()) return;
    e.preventDefault();
    showTermMenu(e.clientX, e.clientY);
  });
  document.addEventListener('click', () => { if (!termMenu.hidden) hideTermMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTermMenu(); }, true);
  window.addEventListener('blur', hideTermMenu);

  function activateTab(tabId) {
    activeTab = tabId;
    for (const [id, t] of tabs) {
      const on = id === tabId;
      t.paneEl.classList.toggle('active', on);
      t.tabEl.classList.toggle('active', on);
    }
    const t = tabs.get(tabId);
    if (!t) return;
    requestAnimationFrame(() => { fitActive(t); t.term.focus(); renderMonitor(t); });
    renderMonitor(t);
    layoutFiles();
  }

  // ---------- file browser (SFTP) ----------
  function toggleFiles() {
    const t = tabs.get(activeTab);
    if (!t) return;
    t.filesOpen = !t.filesOpen;
    if (t.filesOpen && !t.fb) {
      t.fb = window.createFileBrowser(t.tabId, t.session);
      el('files-dock').appendChild(t.fb.el);
      t.fb.init();
    }
    layoutFiles();
    if (!t.filesOpen) setTimeout(() => t.term.focus(), 0); // return keys to the terminal
  }
  function layoutFiles() {
    const t = tabs.get(activeTab);
    const dock = el('files-dock'), sp = el('files-splitter'), btn = el('files-toggle');
    for (const [, tt] of tabs) if (tt.fb) tt.fb.el.classList.remove('active');
    const open = !!(t && t.filesOpen && t.fb);
    dock.hidden = !open; sp.hidden = !open;
    btn.classList.toggle('on', !!(t && t.filesOpen));
    if (open) t.fb.el.classList.add('active');
    if (t) requestAnimationFrame(() => fitActive(t));
  }

  function closeTab(tabId) {
    const t = tabs.get(tabId);
    if (!t) return;
    window.api.conn.close(tabId);
    if (t.fb) { try { t.fb.destroy(); } catch { /* */ } }
    try { t.term.dispose(); } catch { /* */ }
    t.paneEl.remove();
    t.tabEl.remove();
    tabs.delete(tabId);
    if (activeTab === tabId) {
      activeTab = null;
      const next = [...tabs.keys()].pop() || null;
      if (next) activateTab(next);
      else { clearMonitor(); showEmpty(); }
    }
  }

  // ---------- banners / status ----------
  function showBanner(tabId, text, kind, actions) {
    const t = tabs.get(tabId);
    if (!t) return;
    clearBanner(tabId);
    const b = document.createElement('div');
    b.className = 'term-banner' + (kind === 'info' ? ' info' : '');
    const span = document.createElement('span');
    span.textContent = text;
    b.appendChild(span);
    (actions || []).forEach((a) => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = a.label;
      btn.addEventListener('click', a.onClick);
      b.appendChild(btn);
    });
    const dismiss = document.createElement('button');
    dismiss.className = 'btn';
    dismiss.textContent = '✕';
    dismiss.addEventListener('click', () => clearBanner(tabId));
    b.appendChild(dismiss);
    t.paneEl.appendChild(b);
    t._banner = b;
  }
  function clearBanner(tabId) {
    const t = tabs.get(tabId);
    if (t && t._banner) { t._banner.remove(); t._banner = null; }
  }

  function reconnectActions(tabId, message) {
    const t = tabs.get(tabId);
    const actions = [{ label: 'Reconnect', onClick: () => reconnect(tabId) }];
    if (message && /key.?exchange|handshake|kex/i.test(message) && t && t.session.id) {
      actions.push({ label: 'Edit session', onClick: () => openEditor(t.session) });
    }
    return actions;
  }
  function reconnect(tabId) {
    const t = tabs.get(tabId);
    if (!t) return;
    clearBanner(tabId);
    t.term.write('\r\n\x1b[33m[reconnecting...]\x1b[0m\r\n');
    if (t.session.id) window.api.conn.open(tabId, { sessionId: t.session.id });
  }

  function setStatus(tabId, state, message) {
    const t = tabs.get(tabId);
    if (!t) return;
    t.status = state;
    t.tabEl.classList.remove('st-connecting', 'st-connected', 'st-error', 'st-closed');
    const cls = { connecting: 'st-connecting', 'need-auth': 'st-connecting', connected: 'st-connected', error: 'st-error', closed: 'st-closed' }[state];
    if (cls) t.tabEl.classList.add(cls);
    if (state === 'connected' || state === 'need-auth') clearBanner(tabId);
    else if (state === 'info') showBanner(tabId, message, 'info');
    else if (state === 'error') showBanner(tabId, message || 'Connection error', 'danger', reconnectActions(tabId, message));
    else if (state === 'closed') showBanner(tabId, 'Disconnected.', 'danger', reconnectActions(tabId));
  }

  function showPasswordPrompt(tabId, prompt) {
    const t = tabs.get(tabId);
    if (!t) return;
    clearBanner(tabId);
    const b = document.createElement('div');
    b.className = 'term-banner info';
    const span = document.createElement('span');
    span.textContent = prompt + ':';
    const input = document.createElement('input');
    input.type = 'password';
    input.style.flex = '1';
    input.style.minWidth = '120px';
    const submit = () => { window.api.conn.answerPassword(tabId, input.value); clearBanner(tabId); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'OK';
    btn.addEventListener('click', submit);
    b.appendChild(span); b.appendChild(input); b.appendChild(btn);
    t.paneEl.appendChild(b);
    t._banner = b;
    setTimeout(() => input.focus(), 0);
  }

  function showHostKeyPrompt(tabId, fingerprint, status, hostPort) {
    const t = tabs.get(tabId);
    if (!t) return;
    clearBanner(tabId);
    const changed = status === 'changed';
    const b = document.createElement('div');
    b.className = 'term-banner' + (changed ? '' : ' info');
    const span = document.createElement('span');
    span.textContent = changed
      ? `⚠ HOST KEY CHANGED for ${hostPort} — now ${fingerprint}. Trust only if you rebuilt/reinstalled this server; otherwise it may be interception.`
      : `Unknown host ${hostPort}. Key fingerprint ${fingerprint}. Trust and connect?`;
    b.appendChild(span);
    const trust = document.createElement('button');
    trust.className = 'btn';
    trust.textContent = changed ? 'Trust new key' : 'Trust';
    trust.addEventListener('click', () => { window.api.conn.answerHostKey(tabId, true); clearBanner(tabId); });
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { window.api.conn.answerHostKey(tabId, false); clearBanner(tabId); });
    b.appendChild(trust);
    b.appendChild(cancel);
    t.paneEl.appendChild(b);
    t._banner = b;
  }

  // ---------- monitor (MobaXterm-style status strip) ----------
  const MON_PTS = 45; // rolling CPU history length (~90s at 2s/sample)

  function pushHistory(t, m) {
    const h = t.history;
    h.cpu.push(m.cpuPct != null ? m.cpuPct : 0);
    if (h.cpu.length > MON_PTS) h.cpu.shift();
  }

  // MobaXterm number formats: "6.04 GB", "11.52 Mb/s", "34 days".
  function fmtSize2(kb) {
    const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let v = kb, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(2) + ' ' + u[i];
  }
  function fmtBits2(bytesPerSec) {
    const bits = Math.max(0, bytesPerSec || 0) * 8;
    const u = [['Kb/s', 1e3], ['Mb/s', 1e6], ['Gb/s', 1e9]];
    let c = u[0];
    for (const x of u) if (bits >= x[1]) c = x;
    return (bits / c[1]).toFixed(2) + ' ' + c[0];
  }
  function fmtUptimeWords(sec) {
    sec = Math.floor(sec);
    const d = Math.floor(sec / 86400), h = Math.floor(sec / 3600), m = Math.floor(sec / 60);
    if (d >= 1) return d + (d === 1 ? ' day' : ' days');
    if (h >= 1) return h + (h === 1 ? ' hour' : ' hours');
    return m + ' min';
  }
  const fmtLoad = (x) => { const n = parseFloat(x); return isFinite(n) ? n.toFixed(2) : '—'; };

  // Small black CPU-history box with a green trace, 0–100%.
  function drawCpuGraph(canvas, data) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 56, hg = canvas.clientHeight || 16;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hg * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(hg * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, hg);
    ctx.strokeStyle = 'rgba(46,230,46,.2)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Math.round(hg / 2) + .5); ctx.lineTo(w, Math.round(hg / 2) + .5); ctx.stroke();
    if (!data || data.length < 2) return;
    const stepX = w / (MON_PTS - 1), x0 = w - (data.length - 1) * stepX;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = x0 + i * stepX, y = hg - 1 - (Math.min(100, Math.max(0, v)) / 100) * (hg - 2);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = '#2ee62e'; ctx.lineWidth = 1.25; ctx.lineJoin = 'round'; ctx.stroke();
  }

  const setText = (id, v) => { const e = el(id); if (e) e.textContent = v; };
  const DISK_ICON = '<svg class="mi mi-disk" viewBox="0 0 16 16"><rect x="1.5" y="3" width="13" height="10" rx="2"/><circle cx="8" cy="8" r="2.6" fill="#0d1117"/><circle cx="8" cy="8" r=".9"/><circle cx="12" cy="11" r=".8" fill="#0d1117"/></svg>';

  // Disks of the active tab: one "mount: NN%" cell each, plus the hover panel.
  let monDisks = [];

  function renderDisks(disks) {
    const box = el('mon-disks');
    if (!box) return;
    if (!disks.length) { box.innerHTML = `<span class="ms" data-k="disk">${DISK_ICON}<span class="mv">—</span></span>`; return; }
    const cell = (d, i) => {
      const p = Math.round(d.pct);
      const cls = p >= 90 ? ' hot' : p >= 70 ? ' warm' : '';
      return `<span class="ms${cls}" data-k="disk">${i === 0 ? DISK_ICON : ''}<span class="mv">${escapeHtml(d.mount)}: ${p}%</span></span>`;
    };
    const paint = (n) => {
      box.innerHTML = disks.slice(0, n).map(cell).join('') +
        (disks.length > n ? `<span class="ms more" data-k="disk"><span class="mv">+${disks.length - n}</span></span>` : '');
    };
    // Show as many mounts as fit in the remaining width; fold the rest into "+N"
    // (the hover panel always lists every mount).
    let n = disks.length;
    paint(n);
    while (n > 1 && box.scrollWidth > box.clientWidth + 1) paint(--n);
  }

  function clearMonitor() {
    drawCpuGraph(el('mon-graph'), []);
    for (const id of ['mon-host', 'mon-cpu', 'mon-ram', 'mon-tx', 'mon-rx', 'mon-up', 'mon-user']) setText(id, '—');
    const cpu = document.querySelector('#monitor .ms[data-k="cpu"]'); if (cpu) cpu.title = 'CPU';
    monDisks = []; renderDisks([]); hideDiskTip();
  }

  function renderMonitor(t) {
    if (!t) return clearMonitor();
    const m = t.metrics, h = t.history, s = t.session || {};
    setText('mon-host', s.name || s.host || '—');
    setText('mon-user', s.username || '—');
    setText('mon-cpu', m && m.cpuPct != null ? Math.round(m.cpuPct) + '%' : '—');
    drawCpuGraph(el('mon-graph'), h.cpu);
    setText('mon-ram', m && m.memTotal ? `${fmtSize2(m.memUsed)} / ${fmtSize2(m.memTotal)}` : '—');
    setText('mon-tx', m && m.netTxRate != null ? fmtBits2(m.netTxRate) : '—');
    setText('mon-rx', m && m.netRxRate != null ? fmtBits2(m.netRxRate) : '—');
    setText('mon-up', m && m.uptime != null ? fmtUptimeWords(m.uptime) : '—');
    const cpu = document.querySelector('#monitor .ms[data-k="cpu"]');
    if (cpu) cpu.title = m && m.load ? `CPU · load ${fmtLoad(m.load.one)} ${fmtLoad(m.load.five)} ${fmtLoad(m.load.fifteen)}` : 'CPU';
    monDisks = (m && Array.isArray(m.disks)) ? m.disks : [];
    renderDisks(monDisks);
    if (!el('disk-tip').hidden) renderDiskTip(); // live-refresh if open
  }

  // ---------- disk hover panel (all mounts) ----------
  function renderDiskTip() {
    const tip = el('disk-tip');
    if (!monDisks.length) { tip.innerHTML = '<div class="tip-h">Disks</div><div class="tip-empty">No disk data yet…</div>'; return; }
    const rows = monDisks.map((d) => {
      const p = Math.max(0, Math.min(100, d.pct));
      return `<div class="dt-row">
        <div class="dt-top"><span class="dt-mount">${escapeHtml(d.mount)}</span>` +
        `<span class="dt-nums">${fmtKB(d.usedKb)} / ${fmtKB(d.sizeKb)}<span class="pct">${Math.round(d.pct)}%</span></span></div>
        <div class="dt-track"><i style="width:${p}%;background:${diskColor(d.pct)}"></i></div>
        <div class="dt-free">${fmtKB(d.availKb)} free · ${escapeHtml(d.fs)}</div>
      </div>`;
    }).join('');
    tip.innerHTML = `<div class="tip-h">Disks · ${monDisks.length} mounted</div>${rows}`;
  }
  function showDiskTip() {
    const tip = el('disk-tip'), anchor = el('mon-disks');
    if (!anchor) return;
    renderDiskTip();
    tip.hidden = false;
    const r = anchor.getBoundingClientRect();
    tip.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    tip.style.top = 'auto';
    // clamp horizontally once we know the panel width
    const w = tip.offsetWidth;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    tip.style.left = left + 'px';
  }
  function hideDiskTip() { const tip = el('disk-tip'); if (tip) tip.hidden = true; }

  // ---------- session editor ----------
  function openEditor(session) {
    const s = session || { name: '', group: '', host: '', port: 22, username: 'root',
      authType: 'password', keyPath: '', keepaliveInterval: 15000, pinnedHostKey: '', algorithms: null };
    const kex = (s.algorithms && s.algorithms.kex) ? s.algorithms.kex.join('\n') : '';
    modalRoot.innerHTML = '';
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h2>${session ? 'Edit session' : 'New session'}</h2>
        <div class="field"><label>Name</label><input id="f-name" value="${escapeHtml(s.name)}"></div>
        <div class="row">
          <div class="field"><label>Host</label><input id="f-host" value="${escapeHtml(s.host)}"></div>
          <div class="field" style="max-width:90px"><label>Port</label><input id="f-port" type="number" value="${escapeHtml(s.port || 22)}"></div>
        </div>
        <div class="row">
          <div class="field"><label>Username</label><input id="f-user" value="${escapeHtml(s.username)}"></div>
          <div class="field"><label>Group</label><input id="f-group" value="${escapeHtml(s.group)}"></div>
        </div>
        <div class="field"><label>Auth</label>
          <select id="f-auth">
            <option value="password">Password</option>
            <option value="key">Private key</option>
            <option value="agent">SSH agent</option>
          </select>
        </div>
        <div class="field" id="wrap-pw"><label>Password ${session ? '(leave blank to keep)' : ''}</label><input id="f-pw" type="password"></div>
        <div class="field" id="wrap-key" hidden><label>Key file path</label>
          <div class="inline"><input id="f-key" value="${escapeHtml(s.keyPath)}" placeholder="~/.ssh/id_ed25519"><button type="button" class="btn" id="f-key-browse">Browse…</button></div>
        </div>
        <div class="field" id="wrap-pass" hidden><label>Key passphrase (leave blank to keep)</label><input id="f-pass" type="password"></div>
        <details class="adv"><summary>Advanced</summary>
          <div class="field"><label>KEX algorithms (one per line, first = highest priority)</label><textarea id="f-kex" placeholder="ecdh-sha2-nistp256">${escapeHtml(kex)}</textarea></div>
          <div class="field"><label>Keepalive interval (ms)</label><input id="f-keep" type="number" value="${escapeHtml(s.keepaliveInterval || 15000)}"></div>
          <div class="field"><label>Pinned host key (SHA256:...)</label><input id="f-pin" value="${escapeHtml(s.pinnedHostKey)}"></div>
        </details>
        <div class="modal-actions">
          ${session ? '<button class="btn danger" id="f-del" style="margin-right:auto">Delete</button>' : ''}
          <button class="btn" id="f-cancel">Cancel</button>
          <button class="btn" id="f-save">Save</button>
          <button class="btn primary" id="f-connect">Save &amp; Connect</button>
        </div>
      </div>`;
    modalRoot.appendChild(backdrop);

    const authSel = el('f-auth');
    authSel.value = s.authType || 'password';
    const toggleAuth = () => {
      const v = authSel.value;
      el('wrap-pw').hidden = v !== 'password';
      el('wrap-key').hidden = v !== 'key';
      el('wrap-pass').hidden = v !== 'key';
    };
    authSel.addEventListener('change', toggleAuth);
    toggleAuth();

    el('f-key-browse').addEventListener('click', async () => {
      const picked = await window.api.dialog.pickKey(el('f-key').value);
      if (picked) el('f-key').value = picked;
    });

    const collect = () => {
      const kexLines = el('f-kex').value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
      const out = {
        id: s.id,
        name: val('f-name'), group: val('f-group'), host: val('f-host'),
        port: parseInt(val('f-port'), 10) || 22, username: val('f-user'),
        authType: authSel.value, keyPath: val('f-key') || null,
        keepaliveInterval: parseInt(val('f-keep'), 10) || 15000,
        pinnedHostKey: val('f-pin') || null,
        algorithms: kexLines.length ? { kex: kexLines } : null,
      };
      const secrets = {};
      if (val('f-pw')) secrets.password = val('f-pw');
      if (val('f-pass')) secrets.passphrase = val('f-pass');
      return { out, secrets };
    };
    const doSave = async () => {
      const { out, secrets } = collect();
      const saved = await window.api.sessions.save(out, secrets);
      await loadSessions();
      return saved;
    };

    el('f-cancel').addEventListener('click', closeModal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    el('f-save').addEventListener('click', async () => { await doSave(); closeModal(); });
    el('f-connect').addEventListener('click', async () => { const saved = await doSave(); closeModal(); openSaved(saved); });
    if (session) {
      el('f-del').addEventListener('click', async () => {
        await window.api.sessions.delete(s.id);
        await loadSessions();
        closeModal();
      });
    }
  }
  function closeModal() { modalRoot.innerHTML = ''; }

  // ---------- events ----------
  window.api.on.termData(({ tabId, chunk }) => { const t = tabs.get(tabId); if (t) t.term.write(chunk); });
  window.api.on.status(({ tabId, state, message }) => setStatus(tabId, state, message));
  window.api.on.needPassword(({ tabId, prompt }) => showPasswordPrompt(tabId, prompt));
  window.api.on.hostkey(({ tabId, fingerprint, status, hostPort }) => {
    showHostKeyPrompt(tabId, fingerprint, status, hostPort);
  });
  window.api.on.stats(({ tabId, metrics }) => {
    const t = tabs.get(tabId);
    if (!t) return;
    t.metrics = metrics;
    pushHistory(t, metrics);
    if (tabId === activeTab) renderMonitor(t);
  });

  el('add-session').addEventListener('click', () => openEditor(null));
  el('session-search').addEventListener('input', (e) => { sessionFilter = e.target.value; renderSidebar(); });
  const sendCtrl = (code) => { if (!activeTab) return; window.api.conn.write(activeTab, code); const t = tabs.get(activeTab); if (t) t.term.focus(); };
  el('term-interrupt').addEventListener('click', () => sendCtrl('\x03')); // Ctrl+C -> SIGINT
  el('term-eof').addEventListener('click', () => sendCtrl('\x1a'));       // Ctrl+Z -> SIGTSTP
  el('files-toggle').addEventListener('click', toggleFiles);
  window.addEventListener('resize', () => { const t = tabs.get(activeTab); if (t) fitActive(t); renderDisks(monDisks); });

  // Mount cells: hover to reveal every mounted filesystem (used/total/free).
  (() => {
    const cells = el('mon-disks');
    if (!cells) return;
    cells.addEventListener('mouseenter', showDiskTip);
    cells.addEventListener('mouseleave', hideDiskTip);
  })();

  // resizable files dock
  (() => {
    const sp = el('files-splitter'), dock = el('files-dock'), stage = el('stage');
    let dragging = false;
    sp.addEventListener('mousedown', (e) => { dragging = true; document.body.style.cursor = 'col-resize'; e.preventDefault(); });
    window.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const r = stage.getBoundingClientRect();
      const w = Math.max(320, Math.min(r.width * 0.72, r.right - e.clientX));
      dock.style.width = w + 'px';
      const t = tabs.get(activeTab); if (t) fitActive(t);
    });
  })();

  // Preview mode (screenshots/design only): launched with ?demo=1. No effect on normal use.
  if (location.search.includes('demo')) {
    // Fake example hosts (RFC 5737 / RFC 1918 addresses) — never real infrastructure.
    sessions = [
      { id: 'd1', name: 'web-01', group: 'Production', host: '203.0.113.10', username: 'deploy', authType: 'key' },
      { id: 'd2', name: 'web-02', group: 'Production', host: '203.0.113.11', username: 'deploy', authType: 'key' },
      { id: 'd3', name: 'db-01', group: 'Production', host: '203.0.113.20', username: 'root', authType: 'password' },
      { id: 'd4', name: 'edge-fra', group: 'Edge', host: '198.51.100.7', username: 'root', authType: 'password' },
      { id: 'd5', name: 'edge-sgp', group: 'Edge', host: '198.51.100.9', username: 'root', authType: 'password' },
      { id: 'd6', name: 'homelab', group: 'Personal', host: '192.168.1.50', username: 'yuvi', authType: 'key' },
    ];
    renderSidebar();
    const fake = sessions[0];
    const tabId = newTabId();
    createTab(tabId, fake);
    const t = tabs.get(tabId);
    setStatus(tabId, 'connected');
    t.term.write('Last login: Mon Sep 15 09:12:04 2026 from 10.0.0.2\r\n');
    t.term.write('\x1b[32mdeploy@web-01\x1b[0m:\x1b[34m~\x1b[0m$ \x1b[36mtop -bn1 | head\x1b[0m\r\n');
    t.term.write('top - 09:41:02 up 3 days,  2:11,  1 user,  load average: 0.42, 0.31, 0.20\r\n');
    t.term.write('Tasks: 142 total,   1 running, 141 sleeping\r\n');
    t.term.write('%Cpu(s): 12.4 us,  3.1 sy,  0.0 ni, 83.9 id\r\n');
    t.term.write('\x1b[32mdeploy@web-01\x1b[0m:\x1b[34m~\x1b[0m$ \x1b[0m\r\n');
    for (let i = 0; i < MON_PTS; i++) {
      const m = {
        cpuPct: 10 + 25 * Math.abs(Math.sin(i / 5)) + Math.random() * 8,
        memUsed: 3100000 + Math.sin(i / 7) * 500000,
        memTotal: 8171400, diskPct: 44,
        netRxRate: 60000 + Math.abs(Math.sin(i / 4)) * 240000 + Math.random() * 40000,
        netTxRate: 20000 + Math.abs(Math.cos(i / 6)) * 90000,
        uptime: 267060 + i * 2, load: { one: 0.42, five: 0.31, fifteen: 0.20 },
        disks: [
          { fs: '/dev/sda1', mount: '/', sizeKb: 41152736, usedKb: 18107204, availKb: 23045532, pct: 44 },
          { fs: '/dev/sdb1', mount: '/data', sizeKb: 515928320, usedKb: 98026380, availKb: 417901940, pct: 19 },
          { fs: '/dev/sda2', mount: '/home', sizeKb: 206292968, usedKb: 158645486, availKb: 47647482, pct: 77 },
        ],
      };
      t.metrics = m; pushHistory(t, m);
    }
    renderMonitor(t);
    window.__demoReady = true;
  } else {
    loadSessions();
    showEmpty();
  }
})();
