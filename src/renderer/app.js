'use strict';
/* 앱 본체: 세션 트리, 탭, 툴바, 버튼바, 명령창, 단축키 */

/** 사설·루프백·링크로컬 주소인지 (EVE / PNETLab 랩은 보통 여기) */
function isPrivateHost(host) {
  const h4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host || '');
  if (h4) {
    const [a, b] = [Number(h4[1]), Number(h4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const h6 = String(host || '').toLowerCase();
  return h6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(h6) || /^fe[89ab][0-9a-f]:/.test(h6) || h6 === 'localhost';
}

const PROTO_LABEL = { ssh: 'SSH', telnet: 'TEL', serial: 'COM', rdp: 'RDP', vnc: 'VNC', sftp: 'SFTP', ftp: 'FTP', web: 'WEB', local: 'LOC' };

const App = window.App = {
  settings: {},
  sessions: [],
  buttons: [],
  defaults: { settings: {}, buttons: [] },
  tabs: [],
  active: null,
  selectedSessionId: null,
  highlighter: new Highlighter(),
  layout: localStorage.getItem('layout') || '1',
  slots: [null],
  focusSlot: 0,
  broadcast: 'off', // off | visible | all
  openFolders: new Set(JSON.parse(localStorage.getItem('openFolders') || '[]')),

  async init() {
    const data = await window.api.load();
    this.settings = data.settings;
    this.sessions = data.sessions;
    this.buttons = data.buttons;
    this.defaults = data.defaults;
    this.highlighter.set(this.settings.highlightEnabled ? this.settings.highlights : []);

    hydrateIcons();
    this.bindToolbar();
    this.bindSidebar();
    this.bindTabs();
    this.bindFind();
    this.bindCmdWin();
    ToolDock.bind();
    UpdateUI.bind();
    this.bindIpc();
    this.bindShortcuts();

    $('#sidebar').style.width = (this.settings.sidebarWidth || 240) + 'px';
    $('#sidebar').hidden = this.settings.showSidebar === false;
    $('#buttonbar').hidden = this.settings.showButtonBar === false;
    this.renderSessions();
    this.renderButtons();
    this.renderTabs();
    this.renderWelcome();
    this.updateStatus();

    this.slots = new Array(this.slotCount()).fill(null);
    this.applyLayoutClass();
    new ResizeObserver(() => { for (const t of this.tabs) if (t.visible) t.fitNow(); }).observe($('#terminals'));
    window.api.rendererReady();
  },

  // =============== EVE-NG / PNETLab 링크 ===============
  async openLink(link) {
    // 랩 서버(사설 IP)가 아닌 곳으로 가는 링크는 한 번 확인 (웹페이지가 몰래 접속시키는 것 방지)
    if (!isPrivateHost(link.host)) {
      const trustedHosts = JSON.parse(localStorage.getItem('trustedLinkHosts') || '[]');
      if (!trustedHosts.includes(link.host)) {
        const remember = h('input', { type: 'checkbox' });
        const ok = await confirmBox(`웹 페이지의 링크로 ${link.protocol.toUpperCase()} ${link.host}:${link.port} 에 접속하려 합니다.\n사설 IP가 아닌 주소입니다. 직접 누른 링크가 맞으면 접속하세요.`, {
          title: '외부 주소 접속 확인', ok: '접속',
          detail: h('label.chk', { style: 'margin-top:12px' }, remember, '이 주소는 다시 묻지 않기'),
        });
        if (!ok) return;
        if (remember.checked) localStorage.setItem('trustedLinkHosts', JSON.stringify([...trustedHosts, link.host].slice(-50)));
      }
    }
    if (link.protocol === 'rdp') {
      window.api.launchRdp({ session: { protocol: 'rdp', host: link.host, port: link.port, username: link.username, name: link.name || link.host } })
        .then((r) => { if (!r.ok) toast(r.message, 'err'); else toast('원격 데스크톱 창을 열었습니다.'); });
      return;
    }
    const s = {
      protocol: link.protocol, host: link.host, port: link.port, username: link.username || '',
      name: link.name || `${link.host}:${link.port}`, fromLink: true, fixedName: !!link.name,
    };
    const tab = this.openTab({ title: s.name, req: { session: s, secrets: {} }, meta: s });
    if (link.name) tab.userRenamed = true; // 링크에 이름이 들어 있으면 그대로 사용
  },

  // =============== 세션 ===============
  findSession(id) { return this.sessions.find((s) => s.id === id); },
  folders() {
    const set = new Set();
    for (const s of this.sessions) {
      if (!s.folder) continue;
      const parts = s.folder.split('/');
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'ko'));
  },

  renderSessions() {
    const tree = $('#session-tree');
    const q = $('#session-search').value.trim().toLowerCase();
    const root = { folders: new Map(), items: [] };
    const match = (s) => !q || [s.name, s.host, s.serialPort, s.folder, s.notes, s.username].some((v) => v && String(v).toLowerCase().includes(q));
    for (const s of this.sessions) {
      if (!match(s)) continue;
      let node = root;
      let pathSoFar = '';
      for (const part of (s.folder || '').split('/').filter(Boolean)) {
        pathSoFar = pathSoFar ? pathSoFar + '/' + part : part;
        if (!node.folders.has(part)) node.folders.set(part, { name: part, path: pathSoFar, folders: new Map(), items: [] });
        node = node.folders.get(part);
      }
      node.items.push(s);
    }
    const count = (n) => n.items.length + [...n.folders.values()].reduce((a, f) => a + count(f), 0);
    const pad = (d) => `padding-left:${8 + d * 14}px`;

    const renderNode = (node, depth) => {
      const out = [];
      const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      for (const f of folders) {
        const open = !!q || this.openFolders.has(f.path);
        const row = h('div.tree-row', { style: pad(depth), dataset: { folder: f.path },
          onclick: () => { this.toggleFolder(f.path); },
          oncontextmenu: (e) => { e.preventDefault(); this.folderMenu(e, f.path); },
          html: icon('chev', 'chev') + icon('folder') }, h('span.name', f.name), h('span.count', count(f)));
        out.push(h('div.tree-folder' + (open ? '.open' : ''), row, h('div.tree-children', renderNode(f, depth + 1))));
      }
      const items = node.items.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko', { numeric: true }));
      for (const s of items) {
        const sub = s.protocol === 'serial' ? s.serialPort : s.protocol === 'local' ? (s.shellName || s.shell || '') : s.host;
        out.push(h('div.tree-row' + (s.id === this.selectedSessionId ? '.selected' : ''), {
          style: pad(depth) + ';padding-left:' + (22 + depth * 14) + 'px',
          dataset: { id: s.id },
          title: [s.name, `${s.protocol.toUpperCase()} ${sub}${s.port ? ':' + s.port : ''}`, s.username ? '사용자: ' + s.username : '', s.notes, s.protocol === 'rdp' ? '더블클릭하면 Windows 원격 데스크톱 창이 열립니다' : ''].filter(Boolean).join('\n'),
          onclick: () => this.selectSession(s.id),
          ondblclick: () => this.connectSession(s),
          oncontextmenu: (e) => { e.preventDefault(); this.selectSession(s.id); this.sessionMenu(e, s); },
        }, h('span.proto.' + s.protocol, PROTO_LABEL[s.protocol] || s.protocol), h('span.name', s.name), h('span.sub', sub)));
      }
      return out;
    };

    tree.innerHTML = '';
    if (!this.sessions.length) {
      tree.append(h('div.tree-empty', '저장된 세션이 없습니다.', h('br'), '위의 + 버튼으로 만들거나, 설정에서 SecureCRT 세션을 가져오세요.'));
    } else {
      const nodes = renderNode(root, 0);
      if (!nodes.length) tree.append(h('div.tree-empty', '검색 결과가 없습니다.'));
      tree.append(...nodes);
    }
    $('#side-foot').textContent = `세션 ${this.sessions.length}개` + (q ? ` · 검색 결과 ${count(root)}개` : '');
  },

  revealFolder(folder) {
    const parts = (folder || '').split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) this.openFolders.add(parts.slice(0, i).join('/'));
    localStorage.setItem('openFolders', JSON.stringify([...this.openFolders]));
    this.renderSessions();
  },

  toggleFolder(path) {
    if (this.openFolders.has(path)) this.openFolders.delete(path); else this.openFolders.add(path);
    localStorage.setItem('openFolders', JSON.stringify([...this.openFolders]));
    this.renderSessions();
  },

  selectSession(id) {
    this.selectedSessionId = id;
    $$('#session-tree .tree-row[data-id]').forEach((r) => r.classList.toggle('selected', r.dataset.id === id));
  },

  sessionMenu(e, s) {
    showMenu(e.clientX, e.clientY, [
      { label: '연결', key: 'Enter', action: () => this.connectSession(s) },
      s.protocol === 'ssh' ? { label: 'SFTP 파일 창 열기', action: () => this.openTab({ title: s.name + ' 파일', req: { sessionId: s.id, override: { protocol: 'sftp' } }, meta: { ...s, protocol: 'sftp' } }) } : null,
      '-',
      { label: '편집…', action: () => this.editSession(s) },
      { label: '복제', action: () => this.duplicateSession(s) },
      { label: '같은 폴더에 새 세션…', action: () => this.newSession(s.folder || '') },
      /^\d{1,3}(\.\d{1,3}){3}$/.test(s.host || '') ? { label: '같은 대역 IP 스캔 (/24)', action: () => this.openScan(s.host.replace(/\.\d+$/, '.0/24')) } : null,
      '-',
      { label: '삭제', danger: true, action: () => this.deleteSession(s) },
    ]);
  },

  folderMenu(e, path) {
    const inFolder = this.sessions.filter((s) => (s.folder || '') === path || (s.folder || '').startsWith(path + '/'));
    showMenu(e.clientX, e.clientY, [
      { label: `폴더 안 세션 모두 연결 (${inFolder.length}개)`, action: () => this.connectMany(inFolder) },
      { label: '이 폴더에 새 세션…', action: () => this.newSession(path) },
      { label: '폴더 이름 바꾸기…', action: () => this.renameFolder(path) },
    ]);
  },

  async connectMany(list) {
    if (list.length > 8 && !(await confirmBox(`${list.length}개 세션을 한꺼번에 연결할까요?`))) return;
    for (const s of list) { this.connectSession(s); await sleep(150); }
  },

  async renameFolder(path) {
    const parts = path.split('/');
    const v = await promptBox('새 폴더 이름', { title: '폴더 이름 바꾸기', value: parts[parts.length - 1] });
    if (!v || !v.trim()) return;
    const to = [...parts.slice(0, -1), v.trim().replace(/\//g, '_')].join('/');
    this.sessions = await window.api.renameFolder(path, to);
    if (this.openFolders.has(path)) { this.openFolders.delete(path); this.openFolders.add(to); }
    this.renderSessions();
  },

  async newSession(folder = '', preset = {}) {
    const r = await sessionDialog({ mode: 'new', session: { folder, ...preset }, folders: this.folders() });
    if (!r) return;
    const saved = await window.api.upsertSession(r.session, r.secrets);
    await this.reloadSessions();
    this.revealFolder(saved.folder);
    this.selectSession(saved.id);
    if (r.action === 'saveConnect') this.connectSession(saved);
    else toast(`"${saved.name}" 세션을 저장했습니다.`, 'ok');
  },

  async editSession(s) {
    const r = await sessionDialog({ mode: 'edit', session: s, folders: this.folders() });
    if (!r) return;
    const saved = await window.api.upsertSession(r.session, r.secrets);
    await this.reloadSessions();
    this.revealFolder(saved.folder);
    for (const t of this.tabs) if (t.req.sessionId === saved.id) t.meta = saved;
    if (r.action === 'saveConnect') this.connectSession(saved);
    else toast('저장했습니다.', 'ok');
  },

  async duplicateSession(s) {
    const copy = await window.api.duplicateSession(s.id);
    await this.reloadSessions();
    if (copy) { this.selectSession(copy.id); this.editSession(copy); }
  },

  async deleteSession(s) {
    if (!(await confirmBox(`"${s.name}" 세션을 삭제할까요?`, { ok: '삭제', danger: true }))) return;
    await window.api.deleteSession(s.id);
    await this.reloadSessions();
  },

  async reloadSessions() {
    this.sessions = await window.api.listSessions();
    this.renderSessions();
    this.renderWelcome();
  },

  async quickConnect() {
    const r = await sessionDialog({ mode: 'quick', session: { protocol: localStorage.getItem('lastQuickProto') || 'ssh' }, folders: this.folders() });
    if (!r) return;
    localStorage.setItem('lastQuickProto', r.session.protocol);
    if (r.action === 'saveConnect') {
      const saved = await window.api.upsertSession(r.session, r.secrets);
      await this.reloadSessions();
      this.connectSession(saved);
    } else {
      const s = r.session;
      const title = s.protocol === 'serial' ? s.serialPort : s.protocol === 'local' ? (s.shellName || '로컬 셸') : s.host;
      if (s.protocol === 'rdp') {
        const res = await window.api.launchRdp({ session: s, secrets: r.secrets });
        if (!res.ok) toast(res.message, 'err');
        return;
      }
      this.openTab({ title, req: { session: s, secrets: r.secrets }, meta: s });
    }
  },

  connectSession(s) {
    if (s.protocol === 'rdp') {
      window.api.launchRdp({ sessionId: s.id }).then((r) => {
        if (!r.ok) toast(r.message, 'err');
        else { toast(`"${s.name}" 원격 데스크톱 창을 열었습니다.`); this.addRecent(s.id); }
      });
      return;
    }
    this.openTab({ title: s.name, req: { sessionId: s.id }, meta: s });
  },

  openTftp() {
    const t = this.tabs.find((x) => x.kind === 'tftp');
    if (t) return this.activate(t);
    this.openTab({ title: 'TFTP 서버', req: {}, meta: { protocol: 'tftp' } });
  },

  /** IP 스캔 탭 (target을 주면 그 대역으로 채워서 엶) */
  openScan(target, { start = false } = {}) {
    let t = this.tabs.find((x) => x.kind === 'scan' && !x.running && !x.rows.size);
    if (t) { if (target) t.target.value = target; this.activate(t); } else t = this.openTab({ title: 'IP 스캔', req: {}, meta: { protocol: 'scan', target } });
    if (start && target) setTimeout(() => { if (!t.running) t.toggle(); }, 80);
    return t;
  },

  /** 화면의 IP에서 바로 열기: ssh / telnet / http / https */
  openHost(kind, ip) {
    if (kind === 'http' || kind === 'https') {
      const url = `${kind}://${ip}/`;
      const s = { protocol: 'web', url, host: ip, name: ip };
      this.openTab({ title: ip, req: { session: s, secrets: {} }, meta: s });
      return;
    }
    const s = { protocol: kind, host: ip, port: kind === 'ssh' ? 22 : 23, username: '', name: ip };
    this.openTab({ title: ip, req: { session: s, secrets: {} }, meta: s });
  },

  openUrl(url) {
    if (!/^https?:\/\//i.test(url)) return;
    let host = url;
    try { host = new URL(url).hostname; } catch (_) {}
    const s = { protocol: 'web', url, host, name: host };
    this.openTab({ title: host, req: { session: s, secrets: {} }, meta: s });
  },

  // ---------- 로컬 셸 ----------
  async localShells() {
    if (!this._shells) this._shells = await window.api.localShells();
    return this._shells;
  },

  async openLocal(id) {
    const shells = await this.localShells();
    const sh = shells.find((x) => x.id === (id || this.settings.localShell)) || shells[0];
    if (!sh) { toast('이 PC에서 실행할 수 있는 셸을 찾지 못했습니다.', 'err'); return; }
    const s = { protocol: 'local', shell: sh.id, shellName: sh.name, name: sh.name, autoLog: 'default' };
    this.openTab({ title: sh.name, req: { session: s, secrets: {} }, meta: s });
  },

  async localMenu(e) {
    const shells = await this.localShells();
    const r = e.currentTarget.getBoundingClientRect();
    const def = this.settings.localShell || (shells[0] && shells[0].id);
    showMenu(r.left, r.bottom + 4, [
      ...shells.map((sh) => ({ label: sh.name + (sh.id === def ? '  (기본)' : ''), key: sh.id === def ? 'Ctrl+Shift+`' : '', action: () => this.openLocal(sh.id) })),
      shells.length ? '-' : null,
      ...shells.filter((sh) => sh.id !== def).map((sh) => ({ label: `기본 셸로: ${sh.name}`, action: () => { this.saveSettings({ localShell: sh.id }); toast(`기본 셸: ${sh.name}`); } })),
      { label: '셸 세션 만들기 (직접 지정한 셸·시작 폴더)…', action: () => this.newSession('', { protocol: 'local', shell: def }) },
    ]);
  },

  /** SSH 탭(또는 세션)과 같은 계정으로 SFTP 파일 창 열기 */
  openSftpFor(tab) {
    const base = tab.req.sessionId ? { sessionId: tab.req.sessionId } : { session: { ...tab.req.session }, secrets: tab.req.secrets };
    const meta = { ...tab.meta, protocol: 'sftp', port: tab.meta.protocol === 'ssh' ? tab.meta.port : 22 };
    this.openTab({ title: tab.title.replace(/ \(\d+\)$/, '') + ' 파일', req: { ...base, override: { protocol: 'sftp', port: meta.port } }, meta });
  },

  // =============== 탭 ===============
  uniqueTitle(base, except) {
    let title = base || '세션';
    for (let n = 2; this.tabs.some((t) => t !== except && t.title === title); n++) title = `${base} (${n})`;
    return title;
  },

  openTab(spec) {
    const title = this.uniqueTitle(spec.title);
    const proto = (spec.meta && spec.meta.protocol) || (spec.req.override && spec.req.override.protocol);
    const Cls = proto === 'web' ? WebTab : proto === 'vnc' ? VncTab : (proto === 'sftp' || proto === 'ftp') ? FileTab : proto === 'tftp' ? TftpTab : proto === 'scan' ? ScanTab : TermTab;
    const tab = new Cls(this, { ...spec, title });
    this.tabs.push(tab);
    // 분할 화면에 빈 칸이 있으면 거기에 먼저 넣음
    const empty = this.slots.indexOf(null);
    if (empty >= 0) this.focusSlot = empty;
    this.activate(tab);
    tab.connect();
    return tab;
  },

  // ---------- 분할 화면 ----------
  slotCount() { return { 1: 1, v2: 2, h2: 2, v3: 3, q4: 4, g6: 6, g9: 9 }[this.layout] || 1; },
  slotCols() { return { 1: 1, v2: 2, h2: 1, v3: 3, q4: 2, g6: 3, g9: 3 }[this.layout] || 1; },

  /** 탭 메뉴에 보여줄 칸 이름 */
  slotLabel(i) {
    if (this.layout === 'v2') return ['왼쪽', '오른쪽'][i];
    if (this.layout === 'h2') return ['위', '아래'][i];
    if (this.layout === 'v3') return ['왼쪽', '가운데', '오른쪽'][i];
    const c = this.slotCols();
    return `${Math.floor(i / c) + 1}행 ${(i % c) + 1}열`;
  },
  slotOf(tab) { return this.slots.indexOf(tab ? tab.id : '__none__'); },

  applyLayoutClass() {
    const t = $('#terminals');
    t.className = 'layout-' + this.layout;
    $('#tb-split').classList.toggle('active', this.layout !== '1');
  },

  setLayout(layout) {
    this.layout = layout;
    localStorage.setItem('layout', layout);
    const n = this.slotCount();
    const keep = this.slots.filter((id) => id && this.tabById(id));
    if (this.active && !keep.includes(this.active.id)) keep.unshift(this.active.id);
    // 빈 칸은 아직 안 보이는 탭으로 채움
    for (const t of this.tabs) { if (keep.length >= n) break; if (!keep.includes(t.id)) keep.push(t.id); }
    // 칸 순서는 탭 순서대로 (왼쪽 탭이 왼쪽/위 칸)
    const order = (id) => this.tabs.findIndex((t) => t.id === id);
    this.slots = keep.slice(0, n).sort((a, b) => order(a) - order(b));
    while (this.slots.length < n) this.slots.push(null);
    this.focusSlot = Math.max(0, this.slotOf(this.active));
    this.applyLayoutClass();
    this.renderLayout();
    if (this.broadcast !== 'off') this.renderTabs();
  },

  /** 탭 id를 칸 i에 놓기 (이미 다른 칸에 있으면 두 칸을 맞바꿈) */
  placeTab(id, i) {
    if (i < 0 || i >= this.slots.length) return;
    const from = this.slots.indexOf(id);
    if (from === i) return this.activate(this.tabById(id));
    if (from >= 0) this.slots[from] = this.slots[i];
    this.slots[i] = id;
    this.focusSlot = i;
    this.activate(this.tabById(id));
  },

  renderLayout() {
    const shown = new Set(this.slots.filter(Boolean));
    for (const t of this.tabs) t.setVisible(shown.has(t.id) ? this.slots.indexOf(t.id) : null);
    // 빈 칸 표시
    $$('#terminals .slot-empty').forEach((e) => e.remove());
    if (this.tabs.length) {
      this.slots.forEach((id, i) => {
        if (id) return;
        const ph = h('div.slot-empty' + (i === this.focusSlot ? '.focus' : ''), {
          style: `order:${i}`,
          onmousedown: () => { this.focusSlot = i; this.renderLayout(); },
          ondragover: (e) => { if (e.dataTransfer.types.includes('text/tab')) { e.preventDefault(); ph.classList.add('drop'); } },
          ondragleave: () => ph.classList.remove('drop'),
          ondrop: (e) => { e.preventDefault(); const id2 = e.dataTransfer.getData('text/tab'); if (id2) this.placeTab(id2, i); },
        }, h('div', '빈 칸'), h('div.hint', '위의 탭을 여기로 끌어다 놓거나, 이 칸을 누르고 탭을 고르세요'));
        $('#terminals').append(ph);
      });
    }
    $('#terminals').classList.toggle('split', this.slotCount() > 1);
    $$('#terminals .term-pane').forEach((p) => p.classList.toggle('focus', !!this.active && p.dataset.tab === this.active.id));
    requestAnimationFrame(() => { for (const t of this.tabs) if (t.visible) t.fitNow(); });
  },

  activate(tab) {
    if (tab) {
      const at = this.slotOf(tab);
      if (at >= 0) this.focusSlot = at;
      else this.slots[this.focusSlot] = tab.id;
    } else {
      this.slots = this.slots.map((id) => (id && this.tabById(id) ? id : null));
    }
    this.active = tab;
    $('#welcome').hidden = !!tab;
    this.renderLayout();
    this.renderTabs();
    this.updateStatus();
    window.api.setTitle(tab ? tab.title : '');
    if (tab) {
      requestAnimationFrame(() => tab.focus());
      const elx = $(`#tabs .tab[data-id="${tab.id}"]`);
      if (elx) elx.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  },

  layoutMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const mk = (id, label) => ({ label: (this.layout === id ? '✓ ' : '   ') + label, action: () => this.setLayout(id) });
    showMenu(r.left, r.bottom + 4, [
      mk('1', '한 화면'), mk('v2', '좌우 2분할'), mk('h2', '상하 2분할'), mk('v3', '세로 3분할'), mk('q4', '4분할 (2×2)'), mk('g6', '6분할 (3×2)'), mk('g9', '9분할 (3×3)'),
      '-',
      { label: '탭을 칸에 끌어다 놓으면 그 칸에 표시됩니다', disabled: true },
    ]);
  },

  // ---------- 동시 입력 ----------
  broadcastFrom(tab) { return this.broadcast !== 'off' && this.isBroadcastTarget(tab); },
  isBroadcastTarget(t) {
    if (this.broadcast === 'off' || t.kind !== 'term' || t.excludeBroadcast) return false;
    if (this.broadcast === 'visible') return t.visible;
    return true;
  },
  broadcastTargets(src) {
    return this.tabs.filter((t) => t !== src && t.state === 'connected' && this.isBroadcastTarget(t));
  },
  setBroadcast(mode) {
    this.broadcast = mode;
    const bar = $('#bc-banner');
    bar.hidden = mode === 'off';
    $('#tb-broadcast').classList.toggle('broadcasting', mode !== 'off');
    this.renderTabs();
    this.focusActive();
  },
  updateBroadcastBanner() {
    if (this.broadcast === 'off') return;
    const ts = this.tabs.filter((t) => t.state === 'connected' && this.isBroadcastTarget(t));
    $('#bc-text').textContent = `동시 입력 중 — ${this.broadcast === 'visible' ? '분할 화면에 보이는' : '연결된 모든'} 탭 ${ts.length}개에 똑같이 입력됩니다: ${ts.map((t) => t.title).join(', ') || '(없음)'}`;
  },
  broadcastMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const mk = (id, label) => ({ label: (this.broadcast === id ? '✓ ' : '   ') + label, action: () => this.setBroadcast(id) });
    showMenu(r.left, r.bottom + 4, [
      mk('off', '끄기'),
      mk('visible', '분할 화면에 보이는 탭에 동시 입력'),
      mk('all', '연결된 모든 탭에 동시 입력'),
      '-',
      { label: '특정 탭은 탭 메뉴에서 "동시 입력에서 제외"', disabled: true },
    ]);
  },

  async closeTab(tab, { force = false } = {}) {
    if (!tab) return;
    if (!force && tab.kind === 'scan' && tab.running && !(await confirmBox('스캔을 멈추고 탭을 닫을까요?', { ok: '닫기' }))) return;
    if (!force && tab.kind !== 'scan' && tab.state === 'connected' && !(await confirmBox(`"${tab.title}" 연결을 끊고 탭을 닫을까요?`, { ok: '닫기' }))) return;
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    const slot = this.slots.indexOf(tab.id);
    if (slot >= 0) {
      // 빈 칸은 화면에 안 보이던 다른 탭으로 채움
      const hidden = this.tabs.find((t) => !this.slots.includes(t.id));
      this.slots[slot] = hidden ? hidden.id : null;
    }
    if (tab.askModals) for (const m of [...tab.askModals]) m.close(null);
    tab.destroy();
    if (this.active === tab) {
      const next = (slot >= 0 && this.slots[slot] && this.tabById(this.slots[slot])) || this.tabs.find((t) => this.slots.includes(t.id)) || this.tabs[Math.min(i, this.tabs.length - 1)] || null;
      this.activate(next);
    } else { this.renderLayout(); this.renderTabs(); }
  },

  async closeOthers(tab) {
    const others = this.tabs.filter((t) => t !== tab);
    if (!others.length) return;
    const connected = others.filter((t) => t.state === 'connected').length;
    if (connected && !(await confirmBox(`다른 탭 ${others.length}개를 닫습니다. (연결 중 ${connected}개)`, { ok: '모두 닫기' }))) return;
    for (const t of others) await this.closeTab(t, { force: true });
  },

  duplicateTab(tab) { if (tab) this.openTab({ title: tab.title.replace(/ \(\d+\)$/, ''), req: tab.req, meta: tab.meta }); },

  async renameTab(tab) {
    const v = await promptBox('탭 이름', { title: '탭 이름 바꾸기', value: tab.title });
    if (v && v.trim()) { tab.title = v.trim(); tab.userRenamed = true; this.renderTabs(); if (tab === this.active) window.api.setTitle(tab.title); }
  },

  cycleTab(dir) {
    if (this.tabs.length < 2 || !this.active) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length]);
  },

  renderTabs() {
    const wrap = $('#tabs');
    wrap.innerHTML = '';
    for (const t of this.tabs) {
      const tip = t.kind === 'tftp' || t.kind === 'scan' ? t.title : t.meta.protocol === 'local' ? `${t.title}\n로컬 셸${t.logPath ? '\n로그: ' + t.logPath : ''}` : [t.title, t.meta.protocol === 'serial' ? `${t.meta.serialPort} ${t.meta.baudRate || 9600}bps` : `${(t.meta.protocol || '').toUpperCase()} ${t.meta.username ? t.meta.username + '@' : ''}${t.meta.host}`, t.logPath ? '로그: ' + t.logPath : ''].filter(Boolean).join('\n');
      t.updateHead();
      const elx = h('div.tab' + (t === this.active ? '.active' : '') + (t.logPath ? '.logging' : '') + (t.visible && this.slotCount() > 1 ? '.onscreen' : '') + (this.isBroadcastTarget(t) ? '.bc' : ''), {
        draggable: 'true', title: tip, dataset: { id: t.id },
        onmousedown: (e) => { if (e.button === 0 && !e.target.closest('.close')) this.activate(t); },
        onauxclick: (e) => { if (e.button === 1) this.closeTab(t); },
        ondblclick: () => this.renameTab(t),
        oncontextmenu: (e) => { e.preventDefault(); this.tabMenu(e, t); },
        ondragstart: (e) => { e.dataTransfer.setData('text/tab', t.id); e.dataTransfer.effectAllowed = 'move'; },
        ondragover: (e) => { if (e.dataTransfer.types.includes('text/tab')) { e.preventDefault(); elx.classList.add('drag-over'); } },
        ondragleave: () => elx.classList.remove('drag-over'),
        ondrop: (e) => {
          e.preventDefault(); elx.classList.remove('drag-over');
          const from = this.tabs.findIndex((x) => x.id === e.dataTransfer.getData('text/tab'));
          const to = this.tabs.indexOf(t);
          if (from < 0 || from === to) return;
          const [moved] = this.tabs.splice(from, 1);
          this.tabs.splice(to, 0, moved);
          this.renderTabs();
        },
      },
      h('span.dot.' + t.state), t.kind !== 'term' ? h('span.kind', t.kind === 'vnc' ? 'VNC' : t.kind === 'web' ? 'WEB' : (t.meta.protocol || 'sftp').toUpperCase()) : null, h('span.t', t.title), h('span.rec', { title: '로그 저장 중' }),
      h('span.close', { title: '닫기 (Ctrl+Shift+W)', html: icon('x'), onclick: (e) => { e.stopPropagation(); this.closeTab(t); } }));
      wrap.append(elx);
    }
    this.updateBroadcastBanner();
    this.updateToolbar();
  },

  tabMenu(e, t) {
    const connected = t.state === 'connected';
    const isTerm = t.kind === 'term';
    const split = this.slotCount() > 1;
    showMenu(e.clientX, e.clientY, [
      { label: '재연결', key: 'Ctrl+Shift+R', action: () => t.connect() },
      { label: '연결 끊기', disabled: !connected, action: () => t.disconnect() },
      { label: '탭 복제 (같은 장비 하나 더)', key: 'Ctrl+Shift+D', action: () => this.duplicateTab(t) },
      { label: '이름 바꾸기…', action: () => this.renameTab(t) },
      isTerm && t.meta.protocol === 'ssh' ? { label: 'SFTP 파일 창 열기', action: () => this.openSftpFor(t) } : null,
      split ? '-' : null,
      ...(split ? this.slots.map((_, i) => ({ label: `${this.slotLabel(i)} 칸에 표시`, action: () => this.placeTab(t.id, i) })) : []),
      isTerm ? '-' : null,
      isTerm ? { label: t.logPath ? '로그 중지' : '로그 시작', disabled: !connected && !t.logPath, action: () => this.toggleLog(t) } : null,
      isTerm ? { label: '로그 파일 위치 열기', disabled: !t.logPath, action: () => window.api.showFile(t.logPath) } : null,
      isTerm ? { label: '화면 지우기', action: () => t.term.clear() } : null,
      isTerm ? { label: '파일 보내기 (XMODEM / YMODEM)…', disabled: !connected, action: () => t.sendFileDialog() } : null,
      isTerm ? { label: t.guardOff ? '위험 명령 경고 다시 켜기 (이 탭)' : '위험 명령 경고 끄기 (이 탭만, 랩 장비 등)', action: () => { t.guardOff = !t.guardOff; toast(t.guardOff ? `"${t.title}" 탭은 위험 명령 경고를 하지 않습니다.` : `"${t.title}" 탭 위험 명령 경고를 켰습니다.`); } } : null,
      isTerm ? { label: t.excludeBroadcast ? '동시 입력에 다시 포함' : '동시 입력에서 제외', action: () => { t.excludeBroadcast = !t.excludeBroadcast; this.renderTabs(); } } : null,
      isTerm && /^\d{1,3}(\.\d{1,3}){3}$/.test(t.meta.host || '') ? { label: '같은 대역 IP 스캔 (/24)', action: () => this.openScan(t.meta.host.replace(/\.\d+$/, '.0/24')) } : null,
      t.req.sessionId ? { label: '세션 편집…', action: () => { const s = this.findSession(t.req.sessionId); if (s) this.editSession(s); } } : null,
      '-',
      { label: '다른 탭 모두 닫기', action: () => this.closeOthers(t) },
      { label: '닫기', key: 'Ctrl+Shift+W', danger: true, action: () => this.closeTab(t) },
    ]);
  },

  async toggleLog(t = this.active) {
    if (!t || t.kind !== 'term') return;
    if (t.logPath) { window.api.stopLog(t.id); toast('로그를 멈췄습니다.'); return; }
    if (t.state !== 'connected') { toast('연결된 탭에서만 로그를 시작할 수 있습니다.', 'err'); return; }
    const p = await window.api.startLog(t.id);
    if (p) toast('로그 저장 시작: ' + p.split(/[\\/]/).pop(), 'ok');
  },

  updateToolbar() {
    const t = this.active;
    const connected = t && t.state === 'connected';
    $('#tb-reconnect').disabled = !t;
    $('#tb-disconnect').disabled = !connected;
    $('#tb-log').disabled = !t || t.kind !== 'term' || (!connected && !t.logPath);
    $('#tb-log').classList.toggle('recording', !!(t && t.logPath));
    $('#tb-log').lastChild.textContent = t && t.logPath ? '로그 중지' : '로그';
    $('#tb-break').disabled = !(connected && t.meta.protocol === 'serial');
    $('#tb-send').disabled = !(connected && t.kind === 'term');
    $('#tb-tftp').classList.toggle('active', this.tftpRunning === true);
    $('#tb-scan').classList.toggle('active', this.tabs.some((x) => x.kind === 'scan' && x.running));
    $('#tb-sidebar').classList.toggle('active', !$('#sidebar').hidden);
    $('#tb-buttonbar').classList.toggle('active', !$('#buttonbar').hidden);
    $('#tb-cmdwin').classList.toggle('active', !$('#cmdwin').hidden);
    $('#tb-find').disabled = !t || (t.kind !== 'term' && t.kind !== 'web');
  },

  updateStatus() {
    const t = this.active;
    const conn = $('#sb-conn');
    const log = $('#sb-log');
    const size = $('#sb-size');
    if (!t) {
      conn.textContent = this.tabs.length ? '' : '연결 없음';
      log.textContent = ''; size.textContent = '';
      this.updateToolbar();
      return;
    }
    const m = t.meta;
    const stateText = { connected: '연결됨', connecting: '접속 중', closed: '끊김', error: '실패', idle: '' }[t.state];
    if (t.kind === 'tftp') {
      conn.textContent = `TFTP 서버 · ${t.st && t.st.running ? '실행 중' : '꺼짐'}`;
      log.textContent = ''; size.textContent = '';
      this.updateToolbar();
      return;
    }
    if (t.kind === 'scan') {
      conn.textContent = t.statusText();
      log.textContent = ''; size.textContent = '';
      this.updateToolbar();
      return;
    }
    if (t.kind === 'web') {
      conn.textContent = `WEB · ${t.url || ''} · ${stateText}`;
      log.textContent = ''; size.textContent = '';
      this.updateToolbar();
      return;
    }
    if (t.kind !== 'term') {
      const proto = t.kind === 'vnc' ? 'VNC' : (m.protocol || 'sftp').toUpperCase() + (m.ftps ? 'S' : '');
      conn.textContent = `${proto} · ${m.username ? m.username + '@' : ''}${m.host}:${m.port || { vnc: 5900, ftp: 21 }[m.protocol] || 22} · ${stateText}`;
      log.textContent = ''; size.textContent = '';
      this.updateToolbar();
      return;
    }
    const enc = (m.encoding || this.settings.defaultEncoding) === 'cp949' ? 'EUC-KR' : 'UTF-8';
    const where = m.protocol === 'serial'
      ? `${m.serialPort} · ${m.baudRate || 9600} ${m.dataBits || 8}${(m.parity || 'none')[0].toUpperCase()}${m.stopBits || 1}`
      : m.protocol === 'local' ? (m.shellName || m.shell || '로컬 셸')
        : `${m.username ? m.username + '@' : ''}${m.host}:${m.port || (m.protocol === 'ssh' ? 22 : 23)}`;
    conn.textContent = `${(m.protocol || '').toUpperCase()} · ${where} · ${enc} · ${stateText}`;
    log.textContent = t.logPath ? '● 로그: ' + t.logPath.split(/[\\/]/).pop() : '로그 꺼짐';
    log.classList.toggle('on', !!t.logPath);
    log.title = t.logPath ? '클릭하면 로그 파일 위치를 엽니다' : '';
    size.textContent = `${t.term.cols} × ${t.term.rows}`;
    this.updateToolbar();
  },

  focusActive() { if (this.active && !modalStack.length) this.active.focus(); },

  // =============== 최근 / 시작 화면 ===============
  addRecent(id) {
    const list = JSON.parse(localStorage.getItem('recent') || '[]').filter((x) => x !== id);
    list.unshift(id);
    localStorage.setItem('recent', JSON.stringify(list.slice(0, 10)));
    this.renderWelcome();
  },

  renderWelcome() {
    const w = $('#welcome');
    const recent = JSON.parse(localStorage.getItem('recent') || '[]').map((id) => this.findSession(id)).filter(Boolean).slice(0, 8);
    w.innerHTML = '';
    w.append(
      h('h1', 'OiTerm'),
      h('div.lead', 'SSH · Telnet · 시리얼 콘솔 터미널'),
      h('div.welcome-actions',
        h('button.btn.primary.big', { onclick: () => this.quickConnect(), html: icon('zap') + '빠른 연결' }),
        h('button.btn.big', { onclick: () => this.newSession(), html: icon('plus') + '새 세션' }),
        h('button.btn.big', { onclick: () => this.openSettings('lab'), html: icon('server') + 'EVE-NG / PNETLab 연동' }),
      ),
      h('div.welcome-cols',
        h('div.welcome-card', h('h3', '최근 연결'),
          recent.length ? recent.map((s) => h('div.recent-item', { onclick: () => this.connectSession(s) },
            h('span.proto.' + s.protocol, PROTO_LABEL[s.protocol] || s.protocol), h('span', s.name), h('span.sub', s.protocol === 'serial' ? s.serialPort : s.host)))
            : h('div.hint', '아직 없습니다. 세션을 더블클릭하면 연결됩니다.')),
        h('div.welcome-card', h('h3', '단축키'),
          h('div.kbd-list',
            h('kbd', 'Ctrl+Shift+T'), h('span', '빠른 연결'),
            h('kbd', 'Ctrl+Tab'), h('span', '다음 탭 (Alt+1~9: 탭 이동)'),
            h('kbd', 'Ctrl+Shift+D'), h('span', '탭 복제'),
            h('kbd', 'Ctrl+Shift+R'), h('span', '재연결'),
            h('kbd', 'Ctrl+Shift+L'), h('span', '로그 시작/중지'),
            h('kbd', 'Ctrl+Shift+F'), h('span', '찾기'),
            h('kbd', 'Ctrl+Shift+M'), h('span', '명령창 (모든 탭에 전송)'),
            h('kbd', 'Ctrl+Shift+W'), h('span', '탭 닫기'),
          )),
      ),
    );
  },

  // =============== 버튼바 ===============
  renderButtons() {
    const bar = $('#buttonbar');
    bar.innerHTML = '';
    this.buttons.forEach((b, i) => {
      bar.append(h('button.cmd-btn', {
        title: b.command + '\n\n클릭: 현재 탭 / Shift+클릭: 연결된 모든 탭',
        onclick: (e) => this.runButton(b, e.shiftKey),
        oncontextmenu: (e) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [
            { label: '현재 탭에 보내기', action: () => this.runButton(b, false) },
            { label: '모든 탭에 보내기', action: () => this.runButton(b, true) },
            '-',
            { label: '버튼 편집…', action: () => this.editButtons() },
            { label: '이 버튼 삭제', danger: true, action: async () => { this.buttons.splice(i, 1); this.buttons = await window.api.saveButtons(this.buttons); this.renderButtons(); } },
          ]);
        },
      }, b.label));
    });
    bar.append(h('button.cmd-btn.add', { onclick: () => this.editButtons(), title: '버튼 추가/편집' }, '+ 버튼 편집'));
  },

  async editButtons() {
    const r = await buttonsDialog(this.buttons);
    if (!r) return;
    this.buttons = await window.api.saveButtons(r);
    this.renderButtons();
  },

  async runButton(b, all) {
    const lines = (b.command || '').replace(/\r\n/g, '\n').split('\n');
    const targets = all ? this.tabs.filter((t) => t.kind === 'term' && t.state === 'connected') : [this.active].filter((t) => t && t.kind === 'term' && t.state === 'connected');
    if (!targets.length) { toast('연결된 터미널 탭이 없습니다.', 'err'); return; }
    const src = targets.includes(this.active) ? this.active : targets[0];
    if (!(await Guard.allowLines(src, lines, targets))) { this.focusActive(); return; }
    await Promise.all(targets.map((t) => t.sendLines(lines)));
    if (all) toast(`${targets.length}개 탭에 보냈습니다.`, 'ok');
    this.focusActive();
  },

  // =============== 명령창 ===============
  bindCmdWin() {
    const ta = $('#cmd-text');
    $('#cmd-delay').value = localStorage.getItem('cmdDelay') || '';
    $('#cmd-wait').checked = localStorage.getItem('cmdWait') === '1';
    const send = async () => {
      const text = ta.value.replace(/\r\n/g, '\n').replace(/\n+$/, '');
      if (!text) return;
      const all = $('#cmd-target').value !== 'current';
      const tgt = $('#cmd-target').value;
      const targets = tgt === 'all' ? this.tabs.filter((t) => t.kind === 'term' && t.state === 'connected')
        : tgt === 'visible' ? this.tabs.filter((t) => t.kind === 'term' && t.state === 'connected' && t.visible)
          : [this.active].filter((t) => t && t.kind === 'term' && t.state === 'connected');
      if (!targets.length) { toast('연결된 탭이 없습니다.', 'err'); return; }
      if (all && targets.length > 1 && !(await confirmBox(`연결된 ${targets.length}개 탭 모두에 보낼까요?\n\n${targets.map((t) => '· ' + t.title).join('\n')}`, { ok: '보내기' }))) return;
      const lines = text.split('\n');
      const src = targets.includes(this.active) ? this.active : targets[0];
      if (!(await Guard.allowLines(src, lines, targets))) { ta.focus(); return; }
      const dv = $('#cmd-delay').value;
      const opts = { delay: dv === '' ? undefined : Number(dv), waitPrompt: $('#cmd-wait').checked };
      localStorage.setItem('cmdDelay', dv);
      localStorage.setItem('cmdWait', opts.waitPrompt ? '1' : '');
      const res = await Promise.all(targets.map((t) => t.sendLines(lines, opts)));
      if (opts.waitPrompt && res.some((x) => !x)) toast('일부 탭에서 프롬프트가 안 나와 중간에 멈췄습니다. 탭 화면을 확인하세요.', 'err');
      if ($('#cmd-clear').checked) ta.value = '';
      ta.focus();
    };
    $('#cmd-send').addEventListener('click', send);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); send(); }
      if (e.key === 'Escape') { e.preventDefault(); this.toggleCmdWin(false); }
    });
  },

  toggleCmdWin(force) {
    const w = $('#cmdwin');
    w.hidden = force === undefined ? !w.hidden : !force;
    this.updateToolbar();
    if (!w.hidden) $('#cmd-text').focus(); else this.focusActive();
  },

  // =============== 찾기 ===============
  bindFind() {
    const inp = $('#find-input');
    const opts = () => ({
      caseSensitive: $('#find-case').checked, regex: $('#find-regex').checked,
      decorations: { matchBackground: '#5c4a12', matchBorder: '#8a6d1a', matchOverviewRuler: '#ffd866', activeMatchBackground: '#c27c0e', activeMatchBorder: '#ffb84d', activeMatchColorOverviewRuler: '#ff9f1a' },
    });
    const run = (dir) => {
      if (this.active && this.active.kind === 'web') { this.active.find(inp.value, dir > 0, $('#find-case').checked); return; }
      if (!this.active || !this.active.search || !inp.value) { $('#find-result').textContent = ''; return; }
      const found = dir < 0 ? this.active.search.findPrevious(inp.value, opts()) : this.active.search.findNext(inp.value, opts());
      if (!found) $('#find-result').textContent = '찾을 수 없음';
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); run(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); this.closeFind(); }
    });
    inp.addEventListener('input', () => { if (this.active && this.active.kind === 'web') { if (inp.value) this.active.find(inp.value, true, $('#find-case').checked); else this.active.stopFind(); return; } if (this.active && this.active.search) { const f = this.active.search.findNext(inp.value, { ...opts(), incremental: true }); if (!f) $('#find-result').textContent = inp.value ? '찾을 수 없음' : ''; } });
    $('#find-next').addEventListener('click', () => run(1));
    $('#find-prev').addEventListener('click', () => run(-1));
    $('#find-close').addEventListener('click', () => this.closeFind());
    this.findResultHook = (tab) => tab.search.onDidChangeResults((r) => {
      if (tab !== this.active) return;
      $('#find-result').textContent = r.resultCount ? `${r.resultIndex + 1} / ${r.resultCount}` : (inp.value ? '찾을 수 없음' : '');
    });
  },

  openFind() {
    if (!this.active || (this.active.kind !== 'term' && this.active.kind !== 'web')) return;
    if (this.active.kind === 'term' && !this.active.findHooked) { this.findResultHook(this.active); this.active.findHooked = true; }
    $('#findbar').hidden = false;
    const inp = $('#find-input');
    const sel = this.active.term ? this.active.term.getSelection() : '';
    if (sel && !sel.includes('\n')) inp.value = sel;
    inp.focus(); inp.select();
  },

  closeFind() {
    $('#findbar').hidden = true;
    for (const t of this.tabs) { if (t.search) t.search.clearDecorations(); if (t.stopFind) t.stopFind(); }
    $('#find-result').textContent = '';
    this.focusActive();
  },

  // =============== 툴바 / 사이드바 ===============
  bindToolbar() {
    $('#tb-quick').onclick = () => this.quickConnect();
    $('#tab-add').onclick = () => this.quickConnect();
    $('#tb-new-session').onclick = () => this.newSession();
    $('#side-new').onclick = () => this.newSession();
    $('#tb-sidebar').onclick = () => this.toggleSidebar();
    $('#tb-reconnect').onclick = () => this.active && this.active.connect();
    $('#tb-disconnect').onclick = () => this.active && this.active.disconnect();
    $('#tb-log').onclick = () => this.toggleLog();
    $('#tb-break').onclick = () => this.active && window.api.sendBreak(this.active.id);
    $('#tb-send').onclick = () => this.active && this.active.sendFileDialog && this.active.sendFileDialog();
    $('#tb-tftp').onclick = () => this.openTftp();
    $('#tb-scan').onclick = () => this.openScan();
    $('#tb-pcip').onclick = () => PcIpUI.open();
    $('#tb-local').onclick = (e) => this.localMenu(e);
    $('#tb-cmdwin').onclick = () => this.toggleCmdWin();
    $('#tb-split').onclick = (e) => this.layoutMenu(e);
    $('#tb-broadcast').onclick = (e) => this.broadcastMenu(e);
    $('#bc-off').onclick = () => this.setBroadcast('off');
    $('#tb-buttonbar').onclick = () => {
      $('#buttonbar').hidden = !$('#buttonbar').hidden;
      this.saveSettings({ showButtonBar: !$('#buttonbar').hidden });
      this.updateToolbar();
    };
    $('#tb-find').onclick = () => ($('#findbar').hidden ? this.openFind() : this.closeFind());
    $('#tb-logfolder').onclick = () => window.api.openLogFolder();
    $('#tb-settings').onclick = () => this.openSettings();
    $('#sb-log').onclick = () => { if (this.active && this.active.logPath) window.api.showFile(this.active.logPath); };
  },

  toggleSidebar() {
    $('#sidebar').hidden = !$('#sidebar').hidden;
    this.saveSettings({ showSidebar: !$('#sidebar').hidden });
    this.updateToolbar();
  },

  bindSidebar() {
    $('#session-search').addEventListener('input', () => this.renderSessions());
    $('#session-search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = $('#session-tree .tree-row[data-id]');
        if (first) { const s = this.findSession(first.dataset.id); if (s) this.connectSession(s); }
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); $('#session-tree').focus(); this.moveSelection(1); }
      if (e.key === 'Escape') { e.target.value = ''; this.renderSessions(); }
    });
    const tree = $('#session-tree');
    tree.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.moveSelection(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.moveSelection(-1); }
      if (e.key === 'Enter') { const s = this.findSession(this.selectedSessionId); if (s) this.connectSession(s); }
      if (e.key === 'Delete') { const s = this.findSession(this.selectedSessionId); if (s) this.deleteSession(s); }
      if (e.key === 'F2') { const s = this.findSession(this.selectedSessionId); if (s) this.editSession(s); }
    });
    tree.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tree-row')) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: '새 세션…', action: () => this.newSession() },
        { label: '빠른 연결…', action: () => this.quickConnect() },
        '-',
        { label: 'SecureCRT 세션 가져오기…', action: () => this.importSecureCRT() },
        { label: '백업 내보내기…', action: () => this.exportBackup() },
        { label: '백업 가져오기…', action: () => this.importBackup() },
      ]);
    });

    // 사이드바 너비 조절
    const rz = $('#resizer');
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault();
      rz.classList.add('drag');
      const startX = e.clientX;
      const startW = $('#sidebar').getBoundingClientRect().width;
      const move = (ev) => { $('#sidebar').style.width = Math.min(520, Math.max(160, startW + ev.clientX - startX)) + 'px'; };
      const up = () => {
        rz.classList.remove('drag');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.saveSettings({ sidebarWidth: Math.round($('#sidebar').getBoundingClientRect().width) });
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  },

  moveSelection(dir) {
    const rows = $$('#session-tree .tree-row[data-id]').filter((r) => r.offsetParent);
    if (!rows.length) return;
    let i = rows.findIndex((r) => r.dataset.id === this.selectedSessionId);
    i = i < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, i + dir));
    this.selectSession(rows[i].dataset.id);
    rows[i].scrollIntoView({ block: 'nearest' });
  },

  bindTabs() {
    $('#terminals').addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  },

  zoom(d) {
    if (this.active && this.active.kind === 'web') return this.active.setZoom(d);
    const size = d === 0 ? this.defaults.settings.fontSize : Math.min(32, Math.max(8, this.settings.fontSize + d));
    this.saveSettings({ fontSize: size });
    for (const t of this.tabs) t.applySettings(this.settings);
    toast(`글자 크기 ${size}`);
  },

  saveSettings(patch) {
    Object.assign(this.settings, patch);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => window.api.saveSettings(this.settings), 400);
  },

  async openSettings(section) {
    const r = await settingsDialog(this.settings, section);
    if (!r) return;
    this.settings = await window.api.saveSettings(r);
    this.highlighter.set(this.settings.highlightEnabled ? this.settings.highlights : []);
    for (const t of this.tabs) t.applySettings(this.settings);
    toast('설정을 저장했습니다.', 'ok');
  },

  async importSecureCRT() {
    const r = await window.api.importSecureCRT();
    if (!r) return;
    this.sessions = r.sessions;
    this.openFolders.add('SecureCRT');
    this.renderSessions();
    toast(`SecureCRT 세션 ${r.count}개를 가져왔습니다.` + (r.skipped ? ` (${r.skipped}개 건너뜀)` : '') + ' 비밀번호는 다시 입력해야 합니다.', 'ok');
  },

  async exportBackup() {
    const p = await window.api.exportBackup();
    if (p) toast('백업 저장: ' + p, 'ok');
  },

  async importBackup() {
    try {
      const r = await window.api.importBackup();
      if (!r) return;
      this.sessions = r.sessions;
      this.buttons = r.buttons;
      this.renderSessions();
      this.renderButtons();
      toast(`세션 ${r.count}개를 가져왔습니다.`, 'ok');
    } catch (e) {
      toast('백업 파일을 읽을 수 없습니다: ' + e.message, 'err');
    }
  },

  // =============== 메인 프로세스 이벤트 ===============
  tabById(id) { return this.tabs.find((t) => t.id === id); },

  bindIpc() {
    window.api.onData((id, text) => { const t = this.tabById(id); if (t && t.onData) t.onData(text); });
    window.api.onStatus((id, state, msg) => { const t = this.tabById(id); if (t) t.onStatus(state, msg); });
    window.api.onInfo((id, msg) => { const t = this.tabById(id); if (t && t.info) t.info(msg); });
    window.api.onLink((link) => this.openLink(link));
    window.api.onNotice((msg) => toast(msg, 'ok'));
    window.api.onWebPopup((id, url) => {
      let host = url;
      try { host = new URL(url).hostname; } catch (_) {}
      this.openTab({ title: host, req: { session: { protocol: 'web', url, host } }, meta: { protocol: 'web', host, url } });
    });
    window.api.onWebDownload((id, d) => {
      if (d.state === 'started') { toast(`다운로드 중: ${d.name}`); return; }
      if (d.state !== 'completed') { toast(`다운로드 실패: ${d.name}`, 'err'); return; }
      const t = h('div.toast.ok', `다운로드 완료: ${d.name} `, h('a', { href: '#', style: 'color:var(--accent);margin-left:6px', onclick: (e) => { e.preventDefault(); window.api.showFile(d.path); } }, '폴더에서 보기'));
      t.style.pointerEvents = 'auto';
      $('#toast-root').append(t);
      setTimeout(() => t.remove(), 7000);
    });
    window.api.onWebKey((id, k) => { const t = this.tabById(id); if (t && t.onKey) t.onKey(k); });
    window.api.onXferProgress((id, p) => { const t = this.tabById(id); if (t && t.onXferProgress) t.onXferProgress(p); });
    window.api.onXferDone((id, d) => { const t = this.tabById(id); if (t && t.onXferDone) t.onXferDone(d); });
    window.api.onTftpEvent((e) => {
      const t = this.tabs.find((x) => x.kind === 'tftp');
      if (t) t.onEvent(e); else if (e.status === 'done') toast(`TFTP: ${e.file} ${e.kind === 'get' ? 'PC → 장비' : '장비 → PC'} 완료`, 'ok');
    });
    window.api.onTftpStopped((msg) => {
      this.tftpRunning = false; this.updateToolbar();
      const t = this.tabs.find((x) => x.kind === 'tftp');
      if (t) t.onStopped(msg); else toast('TFTP: ' + msg);
    });
    window.api.onScanHost((id, r) => { const t = this.tabById(id); if (t && t.onHost) t.onHost(r); });
    window.api.onScanProgress((id, p) => { const t = this.tabById(id); if (t && t.onProgress) t.onProgress(p); });
    window.api.onScanDone((id, d) => { const t = this.tabById(id); if (t && t.onDone) t.onDone(d); });
    window.api.onScanWarn((id, m) => { const t = this.tabById(id); if (t && t.onWarn) t.onWarn(m); });
    window.api.onFilesProgress((id, p) => { const t = this.tabById(id); if (t && t.onProgress) t.onProgress(p); });
    window.api.onFilesClosed((id) => { const t = this.tabById(id); if (t && t.onClosed) t.onClosed(); });
    window.api.onTitle((id, name) => { const t = this.tabById(id); if (t && t.setAutoTitle) t.setAutoTitle(name); });
    window.api.onLogStatus((id, st) => {
      const t = this.tabById(id);
      if (!t) return;
      t.logPath = st.active ? st.path : '';
      this.renderTabs();
      if (t === this.active) this.updateStatus();
    });
    window.api.onAsk(async (reqId, kind, tabId, payload) => {
      const t = this.tabById(tabId);
      if (!t && kind !== 'cert' && kind !== 'auth') { window.api.answer(reqId, null); return; }
      if (t) this.activate(t);
      let p = null;
      if (kind === 'auth') p = authDialog(payload);
      else if (kind === 'hostkey') p = hostKeyDialog(payload);
      else if (kind === 'cert') p = certDialog(payload);
      else if (kind === 'zmodem') {
        p = confirmBox(`"${t.title}" 장비가 ZMODEM으로 파일을 보내려 합니다.\n\n${payload.name} (${fmtSize(payload.size || 0)})\n받을 폴더: ${payload.dir}`, { title: 'ZMODEM 받기', ok: '받기', cancel: '거절' });
      }
      // 탭을 닫으면 그 탭이 띄운 로그인/호스트 키 창도 같이 닫히게 기억
      const m = p && modalStack[modalStack.length - 1];
      if (t && m) (t.askModals || (t.askModals = new Set())).add(m);
      const ans = p ? await p : null;
      if (t && t.askModals) t.askModals.delete(m);
      window.api.answer(reqId, ans);
      if (kind === 'auth' && ans && ans.save) this.reloadSessions();
      if (t && ans && kind === 'auth' && ans.username && t.meta) t.meta = { ...t.meta, username: ans.username };
      this.updateStatus();
    });
  },

  // =============== 단축키 ===============
  handleShortcut(e) {
    if (modalStack.length) return false;
    const k = e.key.toLowerCase();
    const cs = e.ctrlKey && e.shiftKey && !e.altKey;
    if (cs && k === 't') { this.quickConnect(); return true; }
    if (cs && k === 'w') { this.closeTab(this.active); return true; }
    if (cs && k === 'd') { this.duplicateTab(this.active); return true; }
    if (cs && k === 'r') { if (this.active) this.active.connect(); return true; }
    if (cs && k === 'l') { this.toggleLog(); return true; }
    if (cs && k === 'f') { this.openFind(); return true; }
    if (cs && k === 'm') { this.toggleCmdWin(); return true; }
    if (cs && k === 'b') { this.toggleSidebar(); return true; }
    if (cs && e.code === 'Backquote') { this.openLocal(); return true; }
    if (e.ctrlKey && e.key === 'Tab') { this.cycleTab(e.shiftKey ? -1 : 1); return true; }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'PageDown' || e.key === 'PageUp')) { this.cycleTab(e.key === 'PageDown' ? 1 : -1); return true; }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
      const t = e.key === '9' ? this.tabs[this.tabs.length - 1] : this.tabs[Number(e.key) - 1];
      if (t) this.activate(t);
      return true;
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === '=' || e.key === '+')) { this.zoom(1); return true; }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === '-') { this.zoom(-1); return true; }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === '0') { this.zoom(0); return true; }
    return false;
  },

  bindShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      const inField = e.target.closest && e.target.closest('input, textarea, select');
      if (inField && !(e.ctrlKey && e.shiftKey) && !(e.ctrlKey && e.key === 'Tab')) return;
      if (this.handleShortcut(e)) e.preventDefault();
    });
  },
};

window.addEventListener('DOMContentLoaded', () => App.init());
