'use strict';
/* 웹 GUI 탭: 방화벽·스위치 등 장비 관리 웹화면 (HTTP / HTTPS) */

const WEB_ERRORS = {
  '-102': '연결 거부됨 — 장비의 웹 서비스가 꺼져 있거나 포트가 다릅니다.',
  '-118': '시간 초과 — 장비가 응답하지 않습니다. IP, 경로, 방화벽을 확인하세요.',
  '-105': '호스트 이름을 찾을 수 없습니다.',
  '-109': '주소에 도달할 수 없습니다.',
  '-106': 'PC가 네트워크에 연결돼 있지 않습니다.',
  '-101': '연결이 끊겼습니다 (장비가 연결을 리셋).',
  '-100': '연결이 닫혔습니다. HTTP/HTTPS를 바꿔서 다시 시도해보세요.',
  '-107': 'TLS(HTTPS) 협상 실패 — 아주 오래된 장비는 TLS 1.0/1.1만 지원해서 최신 브라우저 엔진으로는 열 수 없습니다. HTTP로 접속하거나 장비 펌웨어를 업데이트하세요.',
  '-113': 'TLS(HTTPS) 암호 방식이 맞지 않습니다 — 오래된 장비의 약한 암호만 지원하는 경우입니다.',
  '-202': '인증서를 신뢰하지 않아 접속하지 않았습니다.',
};

class WebTab extends BaseTab {
  constructor(app, spec) {
    super(app, spec, 'web');
    this.wv = null;
    this.url = '';
    this.registered = false;
    this.zoom = 0;

    const b = (iconName, title, fn) => h('button.icon-btn', { title, html: icon(iconName), onclick: fn });
    this.btnBack = b('arrowleft', '뒤로 (Alt+←)', () => this.wv && this.wv.canGoBack() && this.wv.goBack());
    this.btnFwd = b('arrowright', '앞으로 (Alt+→)', () => this.wv && this.wv.canGoForward() && this.wv.goForward());
    this.btnReload = b('refresh', '새로고침 (F5)', () => this.reload());
    this.scheme = h('span.web-scheme');
    this.urlInput = h('input.inp.web-url', {
      spellcheck: 'false',
      onkeydown: (e) => { if (e.key === 'Enter') this.go(this.urlInput.value.trim()); if (e.key === 'Escape') { this.urlInput.value = this.url; this.focus(); } },
      onfocus: (e) => e.target.select(),
    });
    this.btnFill = h('button.btn.sm', { title: '저장된 아이디/비밀번호를 로그인 칸에 넣기 (세션 주소와 같은 페이지에서만)', onclick: () => this.fill() }, '로그인 정보 입력');
    this.btnFill.hidden = true;
    this.bar = h('div.web-bar',
      this.btnBack, this.btnFwd, this.btnReload,
      h('div.web-addr', this.scheme, this.urlInput),
      this.btnFill,
      h('button.btn.sm', { title: '이 주소를 내 PC 기본 브라우저(크롬·엣지)로 열기', onclick: () => this.url && window.api.openExternal(this.url) }, '브라우저로 열기'),
    );
    this.view = h('div.web-view');
    this.msg = h('div.vnc-msg');
    this.msg.hidden = true;
    this.body.classList.add('web-body');
    this.body.append(this.bar, this.view, this.msg);
  }

  showMsg(text) {
    this.msg.innerHTML = '';
    this.msg.append(h('div', { style: 'max-width:560px;line-height:1.7;white-space:pre-line' }, text),
      h('div.row', { style: 'margin-top:14px;justify-content:center' },
        h('button.btn.primary', { onclick: () => this.reload() }, '다시 시도'),
        h('button.btn', { onclick: () => this.url && window.api.openExternal(this.url) }, '브라우저로 열기')));
    this.msg.hidden = false;
  }

  async connect() {
    this.setState('connecting');
    const r = await window.api.webOpen(this.id, this.req);
    if (!r.ok) { this.setState('error'); this.showMsg('[접속 실패] ' + r.message); return; }
    if (this.req.sessionId) this.meta = { ...this.meta, ...r.meta };
    this.btnFill.hidden = !r.hasCreds;
    this.url = r.url;
    this.urlInput.value = r.url;
    this.updateScheme(r.url);
    if (this.wv) { this.go(r.url); return; }

    // 처음엔 빈 페이지로 붙이고, 메인 프로세스에 등록한 다음 실제 주소로 이동 (인증서 확인 창이 이 탭을 알 수 있게)
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:switchterm-web');
    // 팝업 요청이 메인 프로세스까지 오도록 (메인은 항상 거절하고 OiTerm 새 탭으로 엶)
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('src', 'about:blank');
    this.wv = wv;
    let first = true;
    wv.addEventListener('dom-ready', async () => {
      if (!first) return;
      first = false;
      this.registered = await window.api.webRegister(this.id, wv.getWebContentsId());
      if (!this.registered) { this.setState('error'); this.showMsg('웹 화면을 안전하게 열 수 없어 중단했습니다.'); return; }
      wv.loadURL(this.url).catch(() => {});
    });
    wv.addEventListener('did-start-loading', () => { if (this.registered) { this.setState('connecting'); this.msg.hidden = true; } });
    wv.addEventListener('did-stop-loading', () => { if (this.registered && this.state !== 'error') this.setState('connected'); this.updateNav(); });
    wv.addEventListener('did-fail-load', (e) => {
      if (!e.isMainFrame || e.errorCode === -3) return; // -3: 사용자가 이동을 멈춤
      this.setState('error');
      this.showMsg(`[접속 실패] ${WEB_ERRORS[String(e.errorCode)] || e.errorDescription || '페이지를 열 수 없습니다.'}\n${e.validatedURL || ''}`);
    });
    const onNav = (e) => {
      if (!e.url || e.url === 'about:blank') return;
      if (e.isMainFrame === false) return;
      this.url = e.url;
      if (document.activeElement !== this.urlInput) this.urlInput.value = e.url;
      this.updateScheme(e.url);
      this.updateNav();
      if (this.req.sessionId) this.app.addRecent(this.req.sessionId);
    };
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    wv.addEventListener('page-title-updated', (e) => {
      // 빠른 연결이나 팝업으로 연 탭만 페이지 제목을 탭 이름으로
      if (!this.req.sessionId && !this.userRenamed && e.title) {
        this.title = this.app.uniqueTitle(e.title.slice(0, 40), this);
        this.app.renderTabs();
      }
      this.headTitle.title = e.title;
    });
    wv.addEventListener('found-in-page', (e) => {
      const r2 = e.result;
      if (r2.finalUpdate) $('#find-result').textContent = r2.matches ? `${r2.activeMatchOrdinal} / ${r2.matches}` : '찾을 수 없음';
    });
    this.view.append(wv);
  }

  go(text) {
    if (!text || !this.wv) return;
    let u = text;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
    if (!/^https?:\/\//i.test(u)) { toast('http:// 또는 https:// 주소만 열 수 있습니다.', 'err'); return; }
    this.msg.hidden = true;
    this.wv.loadURL(u).catch(() => {});
    this.focus();
  }

  reload() {
    if (!this.wv) return this.connect();
    this.msg.hidden = true;
    if (this.registered && this.wv.getURL() && this.wv.getURL() !== 'about:blank') this.wv.reload(); else this.go(this.url);
  }

  updateScheme(u) {
    const https = /^https:/i.test(u);
    this.scheme.textContent = https ? 'HTTPS' : 'HTTP';
    this.scheme.className = 'web-scheme ' + (https ? 'secure' : 'plain');
    this.scheme.title = https ? '암호화된 연결' : '암호화되지 않은 연결 — 비밀번호가 네트워크에 그대로 보입니다';
  }

  updateNav() {
    if (!this.wv || !this.registered) return;
    try {
      this.btnBack.disabled = !this.wv.canGoBack();
      this.btnFwd.disabled = !this.wv.canGoForward();
    } catch (_) {}
  }

  async fill() {
    const r = await window.api.webFill(this.id);
    if (!r.ok) toast(r.message, 'err');
    else if (r.plain) toast('주의: 암호화되지 않은 HTTP 연결이라 로그인하면 비밀번호가 네트워크에 그대로 보입니다.', 'err');
  }

  find(text, forward = true, matchCase = false) {
    if (!this.wv || !text) return;
    this.wv.findInPage(text, { forward, matchCase, findNext: this.lastFind === text });
    this.lastFind = text;
  }

  stopFind() { if (this.wv) { try { this.wv.stopFindInPage('clearSelection'); } catch (_) {} } this.lastFind = ''; }

  setZoom(d) {
    if (!this.wv) return;
    this.zoom = d === 0 ? 0 : Math.max(-5, Math.min(5, this.zoom + d));
    this.wv.setZoomLevel(this.zoom);
    toast(`웹 화면 확대 ${Math.round(100 * Math.pow(1.2, this.zoom))}%`);
  }

  /** 웹 화면에 포커스가 있을 때 누른 단축키 (메인 프로세스가 대신 받아 넘겨줌) */
  onKey(k) {
    const key = (k.key || '').toLowerCase();
    if (key === 'f5' || (k.ctrl && !k.shift && key === 'r')) return this.reload();
    if (k.ctrl && !k.shift && key === 'l') { this.urlInput.focus(); return; }
    if (k.ctrl && !k.shift && key === 'f') { this.app.openFind(); return; }
    if (k.alt && key === 'arrowleft') { if (this.wv.canGoBack()) this.wv.goBack(); return; }
    if (k.alt && key === 'arrowright') { if (this.wv.canGoForward()) this.wv.goForward(); return; }
    if (k.ctrl && !k.shift && (key === '=' || key === '+')) return this.setZoom(1);
    if (k.ctrl && !k.shift && key === '-') return this.setZoom(-1);
    if (k.ctrl && !k.shift && key === '0') return this.setZoom(0);
    this.app.handleShortcut({ key: k.key, ctrlKey: k.ctrl, shiftKey: k.shift, altKey: k.alt });
  }

  disconnect() { if (this.wv) { try { this.wv.stop(); } catch (_) {} } }
  focus() { if (this.wv) this.wv.focus(); }

  destroy() {
    window.api.webClose(this.id);
    if (this.wv) this.wv.remove();
    super.destroy();
  }
}
