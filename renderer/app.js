'use strict';
/* Renderer controller: sidebar + tabs + xterm terminals + remote monitor.
   Talks to main only through window.api (see preload). */
(() => {
  const XTERM_THEME = {
    background: '#181825', foreground: '#cdd6f4', cursor: '#f5e0dc',
    selectionBackground: '#585b70',
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
    blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5', brightWhite: '#a6adc8',
  };

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
  // Network throughput in bits/s (Kb/s, Mb/s, Gb/s) — both directions in one shared unit.
  const fmtNet = (rxBytes, txBytes) => {
    const units = [['bit/s', 1], ['Kb/s', 1e3], ['Mb/s', 1e6], ['Gb/s', 1e9]];
    const maxBits = Math.max(rxBytes, txBytes) * 8;
    let u = units[0];
    for (const c of units) if (maxBits >= c[1]) u = c;
    const f = (bytes) => { const v = (bytes * 8) / u[1]; return v >= 100 || u[1] === 1 ? v.toFixed(0) : v.toFixed(1); };
    return `↓${f(rxBytes)} ↑${f(txBytes)} ${u[0]}`;
  };
  function humanUptime(sec) {
    sec = Math.floor(sec);
    const d = Math.floor(sec / 86400); sec %= 86400;
    const h = Math.floor(sec / 3600); sec %= 3600;
    const m = Math.floor(sec / 60);
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
  }
  function humanMem(usedKb, totalKb) {
    const g = (kb) => kb / 1024 / 1024; // KB -> GB
    const fmt = (x) => (x >= 10 ? x.toFixed(0) : x.toFixed(1));
    return `${fmt(g(usedKb))}/${fmt(g(totalKb))}G`;
  }
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
      fontSize: 13, cursorBlink: true, scrollback: 5000, theme: XTERM_THEME,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.onData((d) => window.api.conn.write(tabId, d));
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
      metrics: null, history: { cpu: [], ram: [], rx: [], tx: [] }, _banner: null,
      filesOpen: false, fb: null });
    activateTab(tabId);
  }

  function fitActive(t) {
    try {
      t.fit.fit();
      window.api.conn.resize(t.tabId, t.term.cols, t.term.rows);
    } catch { /* pane not visible yet */ }
  }

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

  // ---------- monitor (compact status strip, MobaXterm-style) ----------
  const MON_PTS = 45; // rolling history length (~90s at 2s/sample)

  function pushHistory(t, m) {
    const h = t.history;
    const ram = (m.memTotal && m.memUsed != null) ? (m.memUsed / m.memTotal) * 100 : 0;
    h.cpu.push(m.cpuPct != null ? m.cpuPct : 0);
    h.ram.push(ram);
    h.rx.push(m.netRxRate != null ? m.netRxRate : 0);
    h.tx.push(m.netTxRate != null ? m.netTxRate : 0);
    for (const k of ['cpu', 'ram', 'rx', 'tx']) if (h[k].length > MON_PTS) h[k].shift();
  }

  // Smooth gradient area sparkline (bezier-smoothed).
  function drawSpark(canvas, series, yMax) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 120, hg = canvas.clientHeight || 17;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hg * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hg);
    const stepX = w / (MON_PTS - 1);
    for (const s of series) {
      const data = s.data;
      if (!data || data.length < 2) continue;
      const max = yMax || Math.max(1, ...data);
      const x0 = w - (data.length - 1) * stepX;
      const pts = data.map((v, i) => [x0 + i * stepX, hg - 1 - (Math.min(v, max) / max) * (hg - 2)]);
      const trace = () => {
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          const mx = (pts[i - 1][0] + pts[i][0]) / 2, my = (pts[i - 1][1] + pts[i][1]) / 2;
          ctx.quadraticCurveTo(pts[i - 1][0], pts[i - 1][1], mx, my);
        }
        ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      };
      if (s.fill) {
        const g = ctx.createLinearGradient(0, 0, 0, hg);
        g.addColorStop(0, s.fill); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.beginPath(); trace();
        ctx.lineTo(pts[pts.length - 1][0], hg); ctx.lineTo(pts[0][0], hg); ctx.closePath();
        ctx.fillStyle = g; ctx.fill();
      }
      ctx.beginPath(); trace();
      ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.strokeStyle = s.color; ctx.stroke();
    }
  }

  const gCanvas = (k) => document.querySelector(`#monitor .sg[data-k="${k}"] canvas`);
  const setV = (k, v) => { const e = document.querySelector(`#monitor .sg[data-k="${k}"] .sv`); if (e) e.textContent = v; };
  const setChip = (id, v) => { const e = document.querySelector(`#${id} .sv`); if (e) e.textContent = v; };

  function clearMonitor() {
    ['cpu', 'ram', 'net'].forEach((k) => { const cv = gCanvas(k); if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); setV(k, '—'); });
    setChip('mon-disk', '—'); setChip('mon-load', '—'); setChip('mon-up', '—');
    el('mon-host').textContent = '—'; el('mon-user').textContent = '';
  }

  function renderMonitor(t) {
    if (!t) return clearMonitor();
    const m = t.metrics, h = t.history, s = t.session || {};
    drawSpark(gCanvas('cpu'), [{ data: h.cpu, color: '#58a6ff', fill: 'rgba(88,166,255,0.40)' }], 100);
    drawSpark(gCanvas('ram'), [{ data: h.ram, color: '#3fb950', fill: 'rgba(63,185,80,0.34)' }], 100);
    drawSpark(gCanvas('net'), [{ data: h.rx, color: '#56d4dd' }, { data: h.tx, color: '#bc8cff' }], Math.max(1024, ...h.rx, ...h.tx));
    setV('cpu', m && m.cpuPct != null ? Math.round(m.cpuPct) + '%' : '—');
    setV('ram', m && m.memTotal ? humanMem(m.memUsed, m.memTotal) : '—');
    setV('net', m && m.netRxRate != null ? fmtNet(m.netRxRate, m.netTxRate) : '—');
    setChip('mon-disk', m && m.diskPct != null ? m.diskPct + '%' : '—');
    setChip('mon-load', m && m.load ? `${m.load.one} ${m.load.five} ${m.load.fifteen}` : '—');
    setChip('mon-up', m && m.uptime != null ? humanUptime(m.uptime) : '—');
    el('mon-host').textContent = s.name || s.host || '—';
    el('mon-user').textContent = s.username ? '· ' + s.username : '';
  }

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
  window.addEventListener('resize', () => { const t = tabs.get(activeTab); if (t) fitActive(t); });

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
