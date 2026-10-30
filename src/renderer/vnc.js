'use strict';
/* VNC 탭: EVE-NG / PNETLab GUI 노드(리눅스 데스크톱, 윈도우 등)나 일반 VNC 서버를 탭 안에서 */

// X11 keysym: 클립보드 내용을 키 입력으로 쳐줄 때 사용
const KEYSYM = { '\n': 0xff0d, '\t': 0xff09, '\b': 0xff08 };

class VncTab extends BaseTab {
  constructor(app, spec) {
    super(app, spec, 'vnc');
    this.rfb = null;
    this.scale = true;
    this.viewOnly = !!this.meta.viewOnly;
    this.lastError = '';

    const btn = (label, title, fn) => h('button.btn.sm', { title, onclick: (e) => { e.preventDefault(); fn(); } }, label);
    this.btnScale = btn('화면 맞춤', '창 크기에 맞춰 보기 / 원래 크기로 보기', () => this.toggleScale());
    this.btnView = btn('조작 가능', '보기 전용으로 바꾸기 (실수로 클릭·입력 방지)', () => this.toggleViewOnly());
    this.bar = h('div.vnc-bar',
      btn('Ctrl+Alt+Del', '원격 화면에 Ctrl+Alt+Del 보내기', () => this.rfb && this.rfb.sendCtrlAltDel()),
      btn('클립보드 보내기', '내 PC 클립보드를 원격 클립보드로 (VNC 서버가 지원할 때)', () => this.sendClipboard()),
      btn('클립보드 내용 입력', '클립보드 글자를 키보드로 쳐서 입력 (클립보드 공유가 안 되는 장비용)', () => this.typeClipboard()),
      this.btnScale, this.btnView,
      h('span.grow'),
      btn('재연결', '다시 연결', () => this.connect()),
    );
    this.screen = h('div.vnc-screen');
    this.msg = h('div.vnc-msg');
    this.body.append(this.bar, this.screen, this.msg);
    this.body.classList.add('vnc-body');
    this.updateButtons();
  }

  showMsg(text, retry) {
    this.msg.innerHTML = '';
    this.msg.append(h('div', text));
    if (retry) this.msg.append(h('button.btn.primary', { style: 'margin-top:14px', onclick: () => this.connect() }, '다시 연결'));
    this.msg.hidden = false;
  }

  async connect() {
    if (this.rfb) { try { this.rfb.disconnect(); } catch (_) {} this.rfb = null; }
    this.screen.innerHTML = '';
    this.lastError = '';
    this.setState('connecting');
    this.showMsg(`VNC ${this.meta.host}:${this.meta.port || 5900} 접속 중…`);
    const r = await window.api.vncOpen(this.req);
    if (!r.ok) { this.setState('error'); this.showMsg('[접속 실패] ' + r.message, true); return; }
    if (this.req.sessionId) this.meta = { ...this.meta, ...r.meta };

    let rfb;
    try {
      rfb = new NoVNC_RFB(this.screen, r.url, { credentials: { password: r.password }, wsProtocols: ['binary'] });
    } catch (e) {
      this.setState('error'); this.showMsg('[접속 실패] ' + e.message, true); return;
    }
    this.rfb = rfb;
    rfb.scaleViewport = this.scale;
    rfb.resizeSession = false;
    rfb.viewOnly = this.viewOnly;
    rfb.focusOnClick = true;
    rfb.background = '#0e1014';

    rfb.addEventListener('connect', () => {
      this.setState('connected');
      this.msg.hidden = true;
      if (this.req.sessionId) this.app.addRecent(this.req.sessionId);
      rfb.focus();
    });
    rfb.addEventListener('disconnect', (e) => {
      if (this.rfb !== rfb) return;
      this.rfb = null;
      const clean = e.detail && e.detail.clean;
      this.setState(clean ? 'closed' : 'error');
      const at = `${this.meta.host}:${this.meta.port || 5900}`;
      this.showMsg(clean ? `[연결 종료] ${at}` : `[접속 실패] ${at} — ${this.lastError || 'VNC 서버에 연결할 수 없거나 연결이 끊겼습니다. 노드가 켜져 있는지, 포트(보통 5900번대)가 맞는지 확인하세요.'}`, true);
    });
    rfb.addEventListener('securityfailure', (e) => {
      this.lastError = '인증 실패' + (e.detail && e.detail.reason ? ': ' + e.detail.reason : '');
    });
    rfb.addEventListener('credentialsrequired', async () => {
      const pw = await promptBox('VNC 비밀번호', { title: `${this.title} 로그인`, password: true });
      if (pw === null) { rfb.disconnect(); return; }
      rfb.sendCredentials({ password: pw });
    });
    rfb.addEventListener('desktopname', (e) => {
      // QEMU는 "QEMU (노드이름)" 형태로 알려줌
      const raw = (e.detail && e.detail.name) || '';
      const m = /\(([^)]+)\)\s*$/.exec(raw);
      const name = (m ? m[1] : raw).trim();
      if (name && this.meta.fromLink && !this.userRenamed && !/^qemu$/i.test(name)) {
        this.title = this.app.uniqueTitle(name, this);
        this.app.renderTabs();
        if (this.app.active === this) window.api.setTitle(this.title);
      }
    });
    rfb.addEventListener('clipboard', (e) => { if (e.detail && e.detail.text) window.api.clipWrite(e.detail.text); });
  }

  disconnect() { if (this.rfb) this.rfb.disconnect(); }

  async sendClipboard() {
    if (!this.rfb) return;
    const t = await window.api.clipRead();
    if (!t) return;
    this.rfb.clipboardPasteFrom(t);
    toast('클립보드를 보냈습니다. 원격 화면에서 붙여넣기 하세요.');
  }

  async typeClipboard() {
    if (!this.rfb || this.viewOnly) return;
    const t = (await window.api.clipRead() || '').replace(/\r\n/g, '\n');
    if (!t) return;
    if (t.length > 2000 && !(await confirmBox(`${t.length}글자를 키보드로 입력합니다. 계속할까요?`))) return;
    for (const ch of t) {
      if (!this.rfb) break;
      const code = ch.codePointAt(0);
      const sym = KEYSYM[ch] || (code < 0x100 ? code : 0x01000000 + code);
      this.rfb.sendKey(sym, null, true);
      this.rfb.sendKey(sym, null, false);
      await sleep(8);
    }
    this.rfb.focus();
  }

  toggleScale() {
    this.scale = !this.scale;
    if (this.rfb) this.rfb.scaleViewport = this.scale;
    this.updateButtons();
  }

  toggleViewOnly() {
    this.viewOnly = !this.viewOnly;
    if (this.rfb) this.rfb.viewOnly = this.viewOnly;
    this.updateButtons();
  }

  updateButtons() {
    this.btnScale.textContent = this.scale ? '화면 맞춤' : '원래 크기';
    this.btnView.textContent = this.viewOnly ? '보기 전용' : '조작 가능';
    this.btnView.classList.toggle('danger', this.viewOnly);
  }

  focus() { if (this.rfb) this.rfb.focus(); }

  destroy() {
    if (this.rfb) { try { this.rfb.disconnect(); } catch (_) {} this.rfb = null; }
    super.destroy();
  }
}
