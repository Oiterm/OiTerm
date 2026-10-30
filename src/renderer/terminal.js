'use strict';
/* 탭 하나 = xterm.js 터미널 하나 + 연결 하나 */

const THEMES = {
  dark: {
    background: '#16181d', foreground: '#d8dbe2', cursor: '#e8e8e8', cursorAccent: '#16181d', selectionBackground: '#3a5a8c',
    black: '#2a2e36', red: '#ef6b73', green: '#8fd18b', yellow: '#e8c56d', blue: '#61a6f5', magenta: '#c88df0', cyan: '#4fd1d9', white: '#c9cdd5',
    brightBlack: '#6b7280', brightRed: '#ff7b84', brightGreen: '#5ee08a', brightYellow: '#ffd866', brightBlue: '#7cb7ff', brightMagenta: '#e09cff', brightCyan: '#6ee7ee', brightWhite: '#ffffff',
  },
  classic: {
    background: '#000000', foreground: '#c0c0c0', cursor: '#c0c0c0', cursorAccent: '#000000', selectionBackground: '#3d3d8f',
    black: '#000000', red: '#c00000', green: '#00c000', yellow: '#c0c000', blue: '#2b5bd7', magenta: '#c000c0', cyan: '#00c0c0', white: '#c0c0c0',
    brightBlack: '#808080', brightRed: '#ff4040', brightGreen: '#40ff40', brightYellow: '#ffff40', brightBlue: '#6b8cff', brightMagenta: '#ff40ff', brightCyan: '#40ffff', brightWhite: '#ffffff',
  },
  light: {
    background: '#fbfbfa', foreground: '#1f2328', cursor: '#1f2328', cursorAccent: '#fbfbfa', selectionBackground: '#b8d4ff',
    black: '#1f2328', red: '#c62828', green: '#1b7f3b', yellow: '#9a6700', blue: '#0b57d0', magenta: '#8e24aa', cyan: '#00838f', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#d32f2f', brightGreen: '#16833f', brightYellow: '#a56a00', brightBlue: '#1a5fd8', brightMagenta: '#9c27b0', brightCyan: '#00838f', brightWhite: '#24292f',
  },
};

const HL_COLORS = { red: '91', green: '92', yellow: '93', blue: '94', magenta: '95', cyan: '96' };
const HL_SWATCH = { red: '#ff7b84', green: '#5ee08a', yellow: '#ffd866', blue: '#7cb7ff', magenta: '#e09cff', cyan: '#6ee7ee' };
const ESC_RE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()*+#][0-9A-Za-z]|[@-_0-~])/g;

class Highlighter {
  constructor() { this.rules = []; this.re = null; }
  set(rules) {
    this.rules = [];
    for (const r of rules || []) {
      if (!r || !r.pattern || !HL_COLORS[r.color]) continue;
      try { this.rules.push({ code: HL_COLORS[r.color], test: new RegExp('^(?:' + r.pattern + ')$', 'i'), src: r.pattern }); } catch (_) { /* 잘못된 정규식은 무시 */ }
    }
    this.re = this.rules.length ? new RegExp(this.rules.map((r) => '(?:' + r.src + ')').join('|'), 'gi') : null;
  }
  apply(text) {
    if (!this.re) return text;
    let out = '';
    let last = 0;
    ESC_RE.lastIndex = 0;
    let m;
    while ((m = ESC_RE.exec(text))) {
      out += this._plain(text.slice(last, m.index)) + m[0];
      last = m.index + m[0].length;
    }
    return out + this._plain(text.slice(last));
  }
  _plain(s) {
    if (!s) return s;
    return s.replace(this.re, (w) => {
      if (!w) return w;
      const r = this.rules.find((x) => x.test.test(w));
      return r ? `\x1b[${r.code}m${w}\x1b[39m` : w;
    });
  }
}

let tabSeq = 0;

/**
 * 모든 탭의 공통 부분: 화면 칸(pane) + 분할 화면용 머리글 + 상태
 * 하위 클래스: TermTab(SSH/Telnet/Serial), VncTab, FileTab
 */
class BaseTab {
  constructor(app, spec, kind) {
    this.app = app;
    this.kind = kind;
    this.id = 'tab' + (++tabSeq) + '_' + Date.now().toString(36);
    this.title = spec.title;
    this.req = spec.req;
    this.meta = spec.meta || {};
    this.state = 'idle';
    this.logPath = '';
    this.excludeBroadcast = false;

    this.headDot = h('span.dot');
    this.headTitle = h('span.t');
    this.head = h('div.pane-head', this.headDot, this.headTitle, h('span.badge-bc', '동시 입력'));
    this.body = h('div.pane-body');
    this.pane = h('div.term-pane', { dataset: { tab: this.id } }, this.head, this.body);
    // 분할 화면에서 칸을 누르면 그 탭이 현재 탭
    this.pane.addEventListener('mousedown', () => { if (this.app.active !== this) this.app.activate(this); }, true);
    // 탭을 이 칸에 끌어다 놓기
    this.pane.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/tab')) { e.preventDefault(); this.pane.classList.add('drop'); } });
    this.pane.addEventListener('dragleave', () => this.pane.classList.remove('drop'));
    this.pane.addEventListener('drop', (e) => {
      this.pane.classList.remove('drop');
      const id = e.dataTransfer.getData('text/tab');
      if (!id) return;
      e.preventDefault();
      this.app.placeTab(id, this.app.slotOf(this));
    });
    $('#terminals').append(this.pane);
  }

  setState(state) {
    this.state = state;
    this.app.renderTabs();
    if (this.app.active === this) this.app.updateStatus();
  }

  updateHead() {
    this.headDot.className = 'dot ' + this.state;
    this.headTitle.textContent = this.title;
    this.pane.classList.toggle('bc-target', this.app.isBroadcastTarget(this));
  }

  setVisible(slot) {
    if (slot === null || slot === undefined) { this.pane.classList.remove('shown'); this.pane.style.order = ''; return; }
    this.pane.classList.add('shown');
    this.pane.style.order = slot;
  }

  get visible() { return this.pane.classList.contains('shown'); }
  fitNow() {}
  focus() {}
  connect() {}
  disconnect() {}
  applySettings() {}
  destroy() { this.pane.remove(); }
}

class TermTab extends BaseTab {
  /**
   * @param {object} app   App 객체
   * @param {object} spec  { title, req: {sessionId}|{session, secrets}, meta: {protocol, host, port, username, serialPort, encoding} }
   */
  constructor(app, spec) {
    super(app, spec, 'term');
    this.resizeTimer = null;

    const st = app.settings;
    this.term = new Terminal({
      fontFamily: st.fontFamily,
      fontSize: st.fontSize,
      scrollback: st.scrollback,
      cursorBlink: st.cursorBlink,
      theme: THEMES[st.theme] || THEMES.dark,
      allowProposedApi: true,
      rightClickSelectsWord: false,
      macOptionIsMeta: true,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
      smoothScrollDuration: 0,
      // 장비 출력 속 하이퍼링크(OSC 8): http(s)만, 확인 후 기본 브라우저로
      linkHandler: {
        activate: async (_e, uri) => {
          if (!/^https?:\/\//i.test(uri)) { toast('http(s)가 아닌 링크는 열지 않습니다: ' + uri.slice(0, 80), 'err'); return; }
          if (await confirmBox(`장비 출력에 들어 있는 링크를 브라우저로 열까요?\n\n${uri}`, { title: '링크 열기', ok: '열기' })) window.api.openExternal(uri);
        },
      },
    });
    this.fit = new FitAddon.FitAddon();
    this.search = new SearchAddon.SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.host = h('div.xterm-host');
    this.xferName = h('span.n');
    this.xferPct = h('span.p');
    this.xferFill = h('div.fill');
    this.xferBar = h('div.xfer-bar', h('div.track', this.xferFill), this.xferName, this.xferPct,
      h('button.btn.sm.danger', { onclick: () => window.api.cancelTransfer(this.id) }, '취소'));
    this.xferBar.hidden = true;
    this.body.append(this.host, this.xferBar);
    this.term.open(this.host);
    this.body.style.background = (THEMES[st.theme] || THEMES.dark).background;

    this.term.onData((d) => this.onInput(d, true));
    this.term.onResize(({ cols, rows }) => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => window.api.resize(this.id, cols, rows), 80);
      if (this.app.active === this) this.app.updateStatus();
    });
    this.term.onSelectionChange(() => {
      if (this.app.settings.copyOnSelect && this.term.hasSelection()) {
        const s = this.term.getSelection();
        if (s) window.api.clipWrite(s);
      }
    });
    this.term.onBell(() => {
      this.body.animate([{ opacity: 0.75 }, { opacity: 1 }], { duration: 150 });
    });
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    this.typed = '';       // Enter 전까지 직접 친 글자 (위험 명령 확인용, 화살표·Tab을 쓰면 null)
    this.lastRx = 0;       // 마지막으로 장비 출력을 받은 시각
    this.hoverLink = null; // 마우스가 올라간 IP / MAC / URL
    attachSmartLinks(this);

    this.body.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const st = this.app.settings;
      if (this.hoverLink && st.smartLinks !== false && (st.smartRightClick !== false || !st.rightClickPaste || e.shiftKey)) {
        this.smartMenu(e, this.hoverLink.kind, this.hoverLink.text);
        return;
      }
      if (st.rightClickPaste && !e.shiftKey) this.paste();
      else this.showMenu(e.clientX, e.clientY);
    });
    // 가운데 버튼 = 붙여넣기 (PuTTY 습관)
    this.body.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); this.paste(); } });
  }

  // ---------- 키 입력 ----------
  onKey(e) {
    if (e.type !== 'keydown') return true;
    if (this.app.handleShortcut(e)) { e.preventDefault(); return false; }
    const k = e.key.toLowerCase();
    // Ctrl+C: 선택된 글자가 있으면 복사, 없으면 장비로 ^C
    if (e.ctrlKey && !e.altKey && k === 'c' && (e.shiftKey || this.term.hasSelection())) {
      if (this.term.hasSelection()) { window.api.clipWrite(this.term.getSelection()); this.term.clearSelection(); }
      e.preventDefault();
      return false;
    }
    if ((e.ctrlKey && !e.altKey && k === 'v') || (e.shiftKey && e.key === 'Insert')) {
      e.preventDefault();
      this.paste();
      return false;
    }
    if (e.ctrlKey && e.key === 'Insert') {
      if (this.term.hasSelection()) window.api.clipWrite(this.term.getSelection());
      e.preventDefault();
      return false;
    }
    return true;
  }

  /** fromUser: 이 탭에서 직접 친 키 → 동시 입력이 켜져 있으면 다른 탭에도 똑같이 보냄 */
  onInput(d, fromUser) {
    if (this.state !== 'connected') {
      if (fromUser && (this.state === 'closed' || this.state === 'error') && (d === '\r' || d === '\n')) this.connect();
      return;
    }
    if (this.guardBusy) return; // 위험 명령 확인 창이 떠 있는 동안 들어온 키(Enter 반복 등)는 버림
    const i = fromUser ? d.indexOf('\r') : -1;
    if (i >= 0 && Guard.active(this)) {
      if (i > 0) this.rawInput(d.slice(0, i), true);
      const found = Guard.checkEnter(this);
      if (found) {
        this.guardBusy = true;
        const targets = this.app.broadcastFrom(this) ? [this, ...this.app.broadcastTargets(this)] : [this];
        Guard.confirm(this, found, targets).then((ok) => {
          this.guardBusy = false;
          if (ok) this.rawInput(d.slice(i), true);
          this.focus();
        });
        return;
      }
      this.rawInput(d.slice(i), true);
      return;
    }
    this.rawInput(d, fromUser);
  }

  rawInput(d, fromUser) {
    if (fromUser) this.trackTyped(d);
    window.api.write(this.id, this.meta.backspace === 'ctrlh' && d === '\x7f' ? '\x08' : d);
    if (fromUser && this.app.broadcastFrom(this)) {
      for (const t of this.app.broadcastTargets(this)) t.onInput(d, false);
    }
  }

  /** Enter 전까지 친 글자 기억. 화살표(히스토리)·Tab(자동 완성)을 쓰면 화면 기준으로만 판단 */
  trackTyped(d) {
    for (let k = 0; k < d.length; k++) {
      const ch = d[k];
      if (ch === '\r' || ch === '\n') { this.typed = ''; continue; }
      if (this.typed === null) continue;
      if (ch === '\x7f' || ch === '\b') this.typed = this.typed.slice(0, -1);
      else if (ch === '\x15' || ch === '\x03') this.typed = '';
      else if (ch < ' ') this.typed = null;
      else this.typed = (this.typed + ch).slice(-500);
    }
  }

  /** 커서가 있는 줄 (자동 줄바꿈된 줄은 이어 붙임) */
  currentLine() {
    const b = this.term.buffer.active;
    let y = b.baseY + b.cursorY;
    const line = b.getLine(y);
    if (!line) return '';
    let text = line.translateToString(true);
    while (y > 0 && b.getLine(y) && b.getLine(y).isWrapped) { y--; text = b.getLine(y).translateToString(false) + text; }
    return text;
  }

  /** 장비 줄에 글자만 넣기 (Enter는 안 보냄) */
  typeText(text) {
    if (this.state !== 'connected') { toast('연결된 탭이 아닙니다.', 'err'); return; }
    this.send(text);
    this.focus();
  }

  async smartMenu(e, kind, text) {
    const items = await smartMenuItems(this, kind, text);
    showMenu(e.clientX, e.clientY, [...items, '-', { label: '붙여넣기', key: 'Ctrl+V', action: () => this.paste() }]);
  }

  // ---------- 연결 ----------
  connect() {
    if (this.req.sessionId) {
      const s = this.app.findSession(this.req.sessionId);
      if (s) this.meta = s;
    }
    this.setState('connecting');
    const where = this.meta.protocol === 'serial'
      ? `${this.meta.serialPort} (${this.meta.baudRate || 9600} bps)`
      : `${this.meta.host}:${this.meta.port || (this.meta.protocol === 'ssh' ? 22 : 23)}`;
    if (this.meta.protocol === 'local') this.term.write(`\x1b[90m${this.meta.shellName || this.title} 시작…\x1b[0m\r\n`);
    else this.term.write(`\x1b[90m${(this.meta.protocol || '').toUpperCase()} ${where} 접속 중…\x1b[0m\r\n`);
    this.typed = '';
    this.fitNow();
    window.api.open(this.id, this.req, this.term.cols, this.term.rows);
  }

  disconnect() { window.api.disconnect(this.id); }

  onStatus(state, message) {
    if (state === 'connected') {
      this.setState('connected');
      if (this.req.sessionId) this.app.addRecent(this.req.sessionId);
    } else if (state === 'closed') {
      this.setState('closed');
      this.term.write(this.meta.protocol === 'local' ? '\r\n\x1b[90m[셸 종료] Enter 키를 누르면 다시 시작합니다.\x1b[0m\r\n' : '\r\n\x1b[90m[연결 종료] Enter 키를 누르면 다시 연결합니다.\x1b[0m\r\n');
    } else if (state === 'error') {
      this.setState('error');
      this.term.write(`\r\n\x1b[91m[접속 실패] ${message}\x1b[0m\r\n\x1b[90mEnter 키를 누르면 다시 연결합니다.\x1b[0m\r\n`);
    } else if (state === 'connecting') {
      this.setState('connecting');
    }
  }

  onData(text) {
    this.lastRx = Date.now();
    const app = this.app;
    if (app.settings.highlightEnabled && this.term.buffer.active.type === 'normal') text = app.highlighter.apply(text);
    this.term.write(text);
  }

  /** 링크로 연 탭: 장비가 알려준 이름으로 탭 이름 변경 (사용자가 직접 바꾼 이름은 유지) */
  setAutoTitle(name) {
    if (this.userRenamed || !name) return;
    const title = this.app.uniqueTitle(name, this);
    if (title === this.title) return;
    this.title = title;
    this.meta = { ...this.meta, name };
    this.app.renderTabs();
    if (this.app.active === this) window.api.setTitle(this.title);
  }

  info(msg) { this.term.write(`\r\n\x1b[90m[알림] ${msg}\x1b[0m\r\n`); }

  // ---------- 파일 전송 (ZMODEM / XMODEM / YMODEM) ----------
  onXferProgress(p) {
    this.xferBar.hidden = false;
    const pct = p.total ? Math.min(100, Math.floor((p.done / p.total) * 100)) : 0;
    this.xferFill.style.width = pct + '%';
    this.xferName.textContent = `${p.proto} ${p.dir === 'up' ? '보내는 중' : '받는 중'}: ${p.name}`;
    this.xferPct.textContent = `${pct}%  ${fmtSize(p.done)} / ${fmtSize(p.total)}`;
  }

  onXferDone(d) {
    this.xferBar.hidden = true;
    const color = d.ok ? '92' : '91';
    this.term.write(`\r\n\x1b[${color}m[${d.proto}] ${d.message}\x1b[0m\r\n`);
    if (d.ok && d.files && d.files.length) {
      const t = h('div.toast.ok', `${d.files.length}개 파일을 받았습니다 `, h('a', { href: '#', style: 'color:var(--accent);margin-left:6px', onclick: (e) => { e.preventDefault(); window.api.openTransferFolder(); } }, '폴더 열기'));
      t.style.pointerEvents = 'auto';
      $('#toast-root').append(t);
      setTimeout(() => t.remove(), 7000);
    } else if (!d.ok) toast(`${d.proto}: ${d.message}`, 'err');
  }

  async sendFileDialog() {
    if (this.state !== 'connected') { toast('연결된 탭에서만 보낼 수 있습니다.', 'err'); return; }
    const r = await transferDialog(this.title);
    if (!r) return;
    const res = await window.api.xmodemSend(this.id, r.file, r.proto);
    if (!res.ok) toast(res.message, 'err');
    this.focus();
  }

  // ---------- 보내기 ----------
  send(text) { if (this.state === 'connected') window.api.write(this.id, text); }

  /** 여러 줄을 한 줄씩 엔터와 함께 보냄
   * delay: 줄 사이 기다리는 시간(ms, 안 주면 설정값) / waitPrompt: 장비가 프롬프트를 다시 띄울 때까지 기다림 */
  async sendLines(lines, { enterLast = true, delay, waitPrompt = false } = {}) {
    if (this.state !== 'connected') return false;
    const gap = Math.max(0, Number(delay ?? this.app.settings.lineDelay) || 0);
    for (let i = 0; i < lines.length; i++) {
      const isLast = i === lines.length - 1;
      const sentAt = Date.now();
      this.send(lines[i] + (!isLast || enterLast ? '\r' : ''));
      if (!isLast && waitPrompt && !(await this.waitForPrompt(sentAt))) {
        this.info(`${i + 1}번째 줄을 보낸 뒤 15초 동안 프롬프트가 나오지 않아 멈췄습니다. (남은 ${lines.length - i - 1}줄은 안 보냄)`);
        return false;
      }
      if (!isLast && gap) await sleep(gap);
      if (this.state !== 'connected') return false;
    }
    return true;
  }

  /** 보낸 뒤 출력이 오고, 잠깐 조용해지고, 마지막 줄이 프롬프트(SW1# 등)면 끝 */
  async waitForPrompt(sentAt, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      await sleep(25);
      if (this.state !== 'connected') return false;
      if (this.lastRx > sentAt && Date.now() - this.lastRx > 80 && parsePrompt(this.currentLine())) return true;
    }
    return false;
  }

  async paste() {
    const raw = await window.api.clipRead();
    if (!raw) return;
    if (this.state !== 'connected') { toast('연결되지 않은 탭입니다.', 'err'); return; }
    const targets = this.app.broadcastFrom(this) ? [this, ...this.app.broadcastTargets(this)] : [this];
    const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n');
    const trailingNewline = text.endsWith('\n');
    if (trailingNewline) lines.pop();
    if (lines.length > 1 || trailingNewline) {
      if (this.app.settings.confirmMultiLinePaste) {
        const preview = h('div.paste-preview', lines.slice(0, 40).join('\n') + (lines.length > 40 ? `\n… (${lines.length - 40}줄 더)` : ''));
        const where = targets.length > 1 ? `${targets.length}개 탭(${targets.map((t) => t.title).join(', ')})` : `"${this.title}"`;
        const ok = await confirmBox(`${lines.length}줄을 ${where}에 붙여넣을까요?`, {
          title: '여러 줄 붙여넣기', ok: '붙여넣기', detail: h('div', { style: 'margin-top:10px' }, preview),
        });
        if (!ok) return;
      }
      const toRun = trailingNewline ? lines : lines.slice(0, -1);
      if (!(await Guard.allowLines(this, toRun, targets))) { this.focus(); return; }
      await Promise.all(targets.map((t) => t.sendLines(lines, { enterLast: trailingNewline })));
    } else {
      for (const t of targets) t.send(lines[0]);
    }
    this.focus();
  }

  // ---------- 화면 ----------
  showMenu(x, y) {
    const hasSel = this.term.hasSelection();
    showMenu(x, y, [
      { label: '복사', key: 'Ctrl+C', disabled: !hasSel, action: () => window.api.clipWrite(this.term.getSelection()) },
      { label: '붙여넣기', key: 'Ctrl+V', action: () => this.paste() },
      { label: '모두 선택', action: () => this.term.selectAll() },
      '-',
      { label: '찾기', key: 'Ctrl+Shift+F', action: () => this.app.openFind() },
      { label: '파일 보내기 (XMODEM / YMODEM)…', action: () => this.sendFileDialog() },
      { label: '화면 지우기', action: () => this.term.clear() },
      { label: '스크롤백 전체 복사', action: () => { this.term.selectAll(); window.api.clipWrite(this.term.getSelection()); this.term.clearSelection(); toast('화면 내용을 모두 복사했습니다.'); } },
    ]);
  }

  applySettings(st) {
    const o = this.term.options;
    o.fontFamily = st.fontFamily;
    o.fontSize = st.fontSize;
    o.scrollback = st.scrollback;
    o.cursorBlink = st.cursorBlink;
    o.theme = THEMES[st.theme] || THEMES.dark;
    this.body.style.background = o.theme.background;
    this.fitNow();
  }

  fitNow() {
    if (!this.visible) return;
    try { this.fit.fit(); } catch (_) {}
  }

  focus() { this.term.focus(); }

  destroy() {
    window.api.close(this.id);
    this.term.dispose();
    super.destroy();
  }
}
