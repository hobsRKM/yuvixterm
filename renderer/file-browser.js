'use strict';
/* Dual-pane (local | remote) SFTP file browser for one tab.
   window.createFileBrowser(tabId, session) -> { el, init(), destroy() }.
   Talks to main only through window.api.fm.* */
(function () {
  const api = window.api;
  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const human = (n) => { if (n == null) return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + u[i]; };
  // POSIX joins work for macOS local paths too.
  const pjoin = (base, name) => { const b = (base || '/').replace(/\/+$/, ''); return (b === '/' ? '' : b) + '/' + name; };
  const pup = (p) => { if (!p || p === '/') return '/'; const t = p.replace(/\/+$/, ''); const i = t.lastIndexOf('/'); return i <= 0 ? '/' : t.slice(0, i); };

  // Screenshot/design mode only (?demo): canned listings, never touches the real fs/sftp.
  const DEMO = typeof location !== 'undefined' && location.search.includes('demo');
  const demoData = {
    local: { dir: '/Users/dev/projects', rows: [['app', 1, 0], ['infra', 1, 0], ['scripts', 1, 0], ['deploy.sh', 0, 2048], ['notes.txt', 0, 840], ['README.md', 0, 5312]] },
    remote: { dir: '/var/www/app', rows: [['logs', 1, 0], ['releases', 1, 0], ['shared', 1, 0], ['.env.example', 0, 412], ['docker-compose.yml', 0, 1536], ['nginx.conf', 0, 3200]] },
  };
  const demoList = (side) => demoData[side].rows.map(([name, d, size]) => ({ name, isDir: !!d, size, path: pjoin(demoData[side].dir, name), mtime: 0 }));

  window.createFileBrowser = function (tabId, session) {
    const state = { local: { dir: null, entries: [], history: [], hi: -1 }, remote: { dir: null, entries: [], history: [], hi: -1 } };
    const root = h('div', 'fb-pane');
    root.innerHTML = `
      <div class="fb-cols">
        ${col('local', 'This Mac')}
        ${col('remote', esc(session && (session.name || session.host) || 'Remote'))}
      </div>
      <div class="fb-status" data-status>Ready</div>`;
    function col(side, title) {
      return `<div class="fb-col" data-side="${side}">
        <div class="fb-head"><span class="fb-title">${side === 'local' ? '💻 ' : '🖥 '}${title}</span>
          <span class="fb-tools">
            <button data-act="back" title="Back" disabled>‹</button>
            <button data-act="fwd" title="Forward" disabled>›</button>
            <button data-act="up" title="Up">↑</button>
            <button data-act="refresh" title="Refresh">⟳</button>
            <button data-act="mkdir" title="New folder">＋</button>
          </span></div>
        <div class="fb-path"><span class="fb-crumbs" data-crumbs></span><button class="fb-editpath" data-editpath title="Type a path">✎</button></div>
        <div class="fb-list" data-list></div>
      </div>`;
    }
    const cols = { local: root.querySelector('[data-side=local]'), remote: root.querySelector('[data-side=remote]') };
    const statusEl = root.querySelector('[data-status]');
    const setStatus = (msg) => { statusEl.textContent = msg; };

    // toolbar wiring
    for (const side of ['local', 'remote']) {
      cols[side].querySelector('[data-act=back]').onclick = () => back(side);
      cols[side].querySelector('[data-act=fwd]').onclick = () => fwd(side);
      cols[side].querySelector('[data-act=up]').onclick = () => state[side].dir && go(side, pup(state[side].dir));
      cols[side].querySelector('[data-act=refresh]').onclick = () => state[side].dir && load(side, state[side].dir);
      cols[side].querySelector('[data-act=mkdir]').onclick = () => mkdir(side);
      cols[side].querySelector('[data-editpath]').onclick = () => editPath(side);
      const listEl = cols[side].querySelector('[data-list]');
      listEl.addEventListener('dragover', (ev) => { ev.preventDefault(); listEl.classList.add('drop'); });
      listEl.addEventListener('dragleave', () => listEl.classList.remove('drop'));
      listEl.addEventListener('drop', (ev) => {
        ev.preventDefault(); listEl.classList.remove('drop');
        try { const d = JSON.parse(ev.dataTransfer.getData('text/fb')); if (d.side !== side) transfer(d.side, { name: d.name, path: d.path }); } catch { /* */ }
      });
    }

    const listApi = (side, dir) => (DEMO ? Promise.resolve(demoList(side))
      : side === 'local' ? api.fm.localList(dir) : api.fm.remoteList(tabId, dir));

    async function load(side, dir) {
      state[side].dir = dir;
      renderPath(side, dir);
      updateNav(side);
      const listEl = cols[side].querySelector('[data-list]');
      listEl.innerHTML = '<div class="fb-msg">…</div>';
      try {
        const entries = await listApi(side, dir);
        state[side].entries = entries;
        renderList(side, entries);
      } catch (e) {
        listEl.innerHTML = '';
        listEl.appendChild(h('div', 'fb-msg err', esc((e && e.message) || String(e))));
      }
    }

    // navigation with history
    function go(side, dir) { const s = state[side]; s.history = s.history.slice(0, s.hi + 1); s.history.push(dir); s.hi = s.history.length - 1; return load(side, dir); }
    function back(side) { const s = state[side]; if (s.hi > 0) { s.hi--; return load(side, s.history[s.hi]); } }
    function fwd(side) { const s = state[side]; if (s.hi < s.history.length - 1) { s.hi++; return load(side, s.history[s.hi]); } }
    function updateNav(side) {
      const s = state[side];
      cols[side].querySelector('[data-act=back]').disabled = s.hi <= 0;
      cols[side].querySelector('[data-act=fwd]').disabled = s.hi >= s.history.length - 1;
    }

    function renderPath(side, dir) {
      const c = cols[side].querySelector('[data-crumbs]');
      c.innerHTML = '';
      const parts = String(dir || '/').split('/').filter(Boolean);
      const seg = (label, path, cur) => { const s = h('span', 'fb-crumb' + (cur ? ' cur' : '')); s.textContent = label; if (!cur) s.onclick = () => go(side, path); return s; };
      c.appendChild(seg(side === 'local' ? '💻' : '🖥', '/', parts.length === 0));
      let acc = '';
      parts.forEach((p, i) => { acc += '/' + p; c.appendChild(h('span', 'fb-sep', '/')); c.appendChild(seg(p, acc, i === parts.length - 1)); });
    }

    function editPath(side) {
      const c = cols[side].querySelector('[data-crumbs]');
      const cur = state[side].dir || '/';
      c.innerHTML = '';
      const inp = h('input', 'fb-pathinput'); inp.value = cur; inp.spellcheck = false;
      let done = false;
      const finish = (nav) => { if (done) return; done = true; if (nav) { const v = inp.value.trim(); if (v) { go(side, v); return; } } renderPath(side, cur); };
      inp.onkeydown = (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
      inp.onblur = () => finish(false);
      c.appendChild(inp);
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    }

    function renderList(side, entries) {
      const listEl = cols[side].querySelector('[data-list]');
      listEl.innerHTML = '';
      if (!entries.length) { listEl.appendChild(h('div', 'fb-msg', 'empty')); return; }
      for (const en of entries) {
        const row = h('div', 'fb-row' + (en.isDir ? ' dir' : ''));
        row.draggable = !en.isDir;
        row.innerHTML = `<span class="fb-ic">${en.isDir ? '📁' : '📄'}</span><span class="fb-name"></span>`
          + `<span class="fb-size">${en.isDir ? '' : human(en.size)}</span>`
          + `<span class="fb-acts"><button data-a="ren" title="Rename">✎</button><button data-a="del" title="Delete">✕</button></span>`;
        row.querySelector('.fb-name').textContent = en.name;
        row.addEventListener('dblclick', () => (en.isDir ? go(side, en.path) : transfer(side, en)));
        row.querySelector('[data-a=ren]').addEventListener('click', (ev) => { ev.stopPropagation(); rename(side, en); });
        row.querySelector('[data-a=del]').addEventListener('click', (ev) => { ev.stopPropagation(); del(side, en); });
        if (!en.isDir) row.addEventListener('dragstart', (ev) => ev.dataTransfer.setData('text/fb', JSON.stringify({ side, path: en.path, name: en.name })));
        listEl.appendChild(row);
      }
    }

    async function transfer(fromSide, en) {
      const toSide = fromSide === 'local' ? 'remote' : 'local';
      const destDir = state[toSide].dir;
      if (!destDir) { setStatus('Open a folder on the other side first.'); return; }
      if ((state[toSide].entries || []).some((e) => e.name === en.name)) {
        if (!(await ask(`Overwrite "${en.name}" on ${toSide}?`, null, true))) return;
      }
      const destPath = pjoin(destDir, en.name);
      try {
        if (fromSide === 'local') await api.fm.upload(tabId, en.path, destPath);
        else await api.fm.download(tabId, en.path, destPath);
        await load(toSide, destDir);
      } catch (e) { setStatus('Transfer failed: ' + ((e && e.message) || e)); }
    }

    async function mkdir(side) {
      const name = await ask('New folder name:', '');
      if (!name) return;
      try {
        if (side === 'local') await api.fm.localMkdir(state[side].dir, name);
        else await api.fm.remoteMkdir(tabId, state[side].dir, name);
        await load(side, state[side].dir);
      } catch (e) { setStatus('mkdir failed: ' + ((e && e.message) || e)); }
    }

    async function rename(side, en) {
      const name = await ask('Rename to:', en.name);
      if (!name || name === en.name) return;
      const to = pjoin(pup(en.path), name);
      try {
        if (side === 'local') await api.fm.localRename(en.path, to);
        else await api.fm.remoteRename(tabId, en.path, to);
        await load(side, state[side].dir);
      } catch (e) { setStatus('Rename failed: ' + ((e && e.message) || e)); }
    }

    async function del(side, en) {
      if (!(await ask(`Delete "${en.name}"${en.isDir ? ' and its contents' : ''}?`, null, true))) return;
      try {
        if (side === 'local') await api.fm.localDelete(en.path);
        else await api.fm.remoteDelete(tabId, en.path);
        await load(side, state[side].dir);
      } catch (e) { setStatus('Delete failed: ' + ((e && e.message) || e)); }
    }

    // Inline prompt/confirm in the status bar (Electron blocks window.prompt).
    function ask(label, initial, confirmOnly) {
      return new Promise((resolve) => {
        statusEl.innerHTML = '';
        const wrap = h('span', 'fb-ask');
        wrap.appendChild(h('span', null, esc(label)));
        let inp = null;
        if (!confirmOnly) { inp = h('input'); inp.value = initial || ''; wrap.appendChild(inp); }
        const ok = h('button', 'p', confirmOnly ? 'Yes' : 'OK');
        const no = h('button', null, 'Cancel');
        const done = (v) => { statusEl.innerHTML = 'Ready'; resolve(v); };
        ok.onclick = () => done(confirmOnly ? true : (inp.value.trim() || null));
        no.onclick = () => done(confirmOnly ? false : null);
        if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter') ok.onclick(); if (e.key === 'Escape') no.onclick(); };
        wrap.append(ok, no);
        statusEl.appendChild(wrap);
        setTimeout(() => (inp || ok).focus(), 0);
      });
    }

    const unsub = api.on.fmProgress((p) => {
      if (p.tabId !== tabId) return;
      const arrow = p.dir === 'up' ? '↑' : '↓';
      if (p.done) { setStatus(`✓ ${arrow} ${p.name}`); setTimeout(() => { if (statusEl.textContent.startsWith('✓')) setStatus('Ready'); }, 2500); }
      else { const pct = p.total ? Math.round((p.transferred / p.total) * 100) : 0; setStatus(`${arrow} ${p.name}  ${pct}%  (${human(p.transferred)}/${human(p.total)})`); }
    });

    return {
      el: root,
      async init() {
        if (DEMO) { await go('local', demoData.local.dir); await go('remote', demoData.remote.dir); return; }
        const home = await api.fm.home(tabId).catch(() => ({ local: '/', remote: null, remoteErr: 'not connected' }));
        await go('local', home.local || '/');
        if (home.remote) await go('remote', home.remote);
        else { const le = cols.remote.querySelector('[data-list]'); le.innerHTML = ''; le.appendChild(h('div', 'fb-msg err', esc(home.remoteErr || 'Not connected'))); }
      },
      destroy() { try { unsub && unsub(); } catch { /* */ } root.remove(); },
    };
  };
})();
