'use strict';
// 웹 GUI 탭 (장비 관리 웹화면): <webview>를 앱과 완전히 분리된 세션·샌드박스로 띄움
const fs = require('fs');
const path = require('path');
const { app, session, webContents, Menu } = require('electron');
const { safeFileName, uniquePath } = require('./transfer');

const PARTITION = 'persist:switchterm-web';
const isWebUrl = (u) => /^https?:\/\//i.test(String(u || ''));
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch (_) { return ''; } };
// 인증서는 같은 IP라도 포트마다 다를 수 있어서 host:port로 구분
const hostPortOf = (u) => { try { const x = new URL(u); return `${x.hostname.replace(/^\[|\]$/g, '').toLowerCase()}:${x.port || (x.protocol === 'https:' ? 443 : 80)}`; } catch (_) { return ''; } };

function buildUrl(cfg) {
  if (cfg.url && isWebUrl(cfg.url)) return cfg.url;
  const scheme = cfg.webScheme === 'http' ? 'http' : 'https';
  const host = /:/.test(cfg.host) && !/^\[/.test(cfg.host) ? `[${cfg.host}]` : cfg.host;
  const def = scheme === 'https' ? 443 : 80;
  const port = Number(cfg.port) && Number(cfg.port) !== def ? `:${Number(cfg.port)}` : '';
  let p = String(cfg.webPath || '/').trim();
  if (!p.startsWith('/')) p = '/' + p;
  return `${scheme}://${host}${port}${p}`;
}

// 웹 탭에서 눌러도 OiTerm 단축키로 동작하게 할 키
function isAppShortcut(i) {
  const k = (i.key || '').toLowerCase();
  if (i.control && !i.alt && (k === 'tab' || k === 'pageup' || k === 'pagedown')) return true;
  if (i.control && i.shift && !i.alt && 'twdrlfmb'.includes(k) && k.length === 1) return true;
  if (i.alt && !i.control && !i.shift && /^[1-9]$/.test(k)) return true;
  if (i.alt && !i.control && (k === 'arrowleft' || k === 'arrowright')) return true;
  if (i.control && !i.shift && !i.alt && ['f', 'l', 'r', '=', '+', '-', '0'].includes(k)) return true;
  if (k === 'f5' && !i.control && !i.alt) return true;
  return false;
}

class WebManager {
  constructor({ store, send, ask }) {
    this.store = store;
    this.send = send;
    this.ask = ask;
    this.tabs = new Map();       // tabId -> { cfg, secrets, wcId, basicUsed }
    this.byWc = new Map();       // webContentsId -> tabId
    this.sessionTrust = new Map(); // host -> fingerprint (이번 실행 동안만)
    this.pendingCert = new Map();
  }

  init() {
    const ses = session.fromPartition(PARTITION);
    this.ses = ses;
    // 웹 페이지 권한: 클립보드 쓰기와 전체 화면만
    const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.has(perm)));
    ses.setPermissionCheckHandler((_wc, perm) => allowed.has(perm));
    // http(s) 외의 요청(파일, 확장 프로그램 등)은 네트워크 단에서도 차단
    ses.webRequest.onBeforeRequest((details, cb) => {
      const u = details.url;
      cb({ cancel: !(isWebUrl(u) || u.startsWith('about:') || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('ws:') || u.startsWith('wss:')) });
    });
    // 다운로드: 받은 파일 폴더에 저장 (자동 실행은 절대 안 함)
    ses.on('will-download', (_e, item, wc) => {
      const dir = this.store.getSettings().transferDir;
      fs.mkdirSync(dir, { recursive: true });
      const target = uniquePath(dir, safeFileName(item.getFilename()));
      item.setSavePath(target);
      const tabId = wc ? this.byWc.get(wc.id) : null;
      this.send('web:download', tabId, { state: 'started', name: path.basename(target) });
      item.once('done', (_ev, state) => this.send('web:download', tabId, { state, name: path.basename(target), path: target }));
    });

    app.on('certificate-error', (event, wc, url, error, cert, callback) => this.onCertError(event, wc, url, error, cert, callback));
    app.on('login', (event, wc, details, authInfo, callback) => this.onLogin(event, wc, details, authInfo, callback));
    app.on('web-contents-created', (_e, wc) => {
      if (wc.getType() === 'webview') this.harden(wc);
    });
  }

  /** 메인 창이 <webview>를 붙이려 할 때: 렌더러가 뭘 넘기든 안전한 설정으로 강제 */
  onWillAttach(e, webPreferences, params) {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    Object.assign(webPreferences, {
      nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, plugins: false, experimentalFeatures: false, spellcheck: false, javascript: true,
    });
    params.partition = PARTITION;
    // 팝업은 허용해야 setWindowOpenHandler까지 오고, 거기서 항상 거절 후 OiTerm 새 탭으로 연다
    params.allowpopups = true;
    delete params.nodeintegration;
    delete params.disablewebsecurity;
    if (params.src && params.src !== 'about:blank' && !isWebUrl(params.src)) e.preventDefault();
  }

  harden(wc) {
    // 새 창(팝업) → http(s)만 OiTerm 새 웹 탭으로
    wc.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) this.send('web:popup', this.byWc.get(wc.id) || null, url);
      return { action: 'deny' };
    });
    const guard = (ev, url) => { if (!isWebUrl(url) && !String(url).startsWith('about:')) ev.preventDefault(); };
    wc.on('will-navigate', guard);
    wc.on('will-frame-navigate', (ev) => guard(ev, ev.url));
    wc.on('will-redirect', (ev, url) => guard(ev, ev.url || url));
    wc.on('before-input-event', (ev, input) => {
      if (input.type !== 'keyDown' || !isAppShortcut(input)) return;
      ev.preventDefault();
      this.send('web:key', this.byWc.get(wc.id) || null, { key: input.key, ctrl: input.control, shift: input.shift, alt: input.alt });
    });
    wc.on('context-menu', (_ev, p) => {
      const items = [];
      if (p.linkURL && isWebUrl(p.linkURL)) items.push({ label: '링크를 새 탭으로 열기', click: () => this.send('web:popup', this.byWc.get(wc.id) || null, p.linkURL) }, { label: '링크 주소 복사', click: () => require('electron').clipboard.writeText(p.linkURL) }, { type: 'separator' });
      if (p.isEditable) items.push({ role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' }, { role: 'selectAll', label: '모두 선택' });
      else if (p.selectionText) items.push({ role: 'copy', label: '복사' });
      if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
      items.push(
        { label: '뒤로', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: '앞으로', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: '새로고침', click: () => wc.reload() },
      );
      Menu.buildFromTemplate(items).popup();
    });
  }

  tabOf(wc) {
    if (!wc) return null;
    return this.byWc.get(wc.id) || null;
  }

  // ---------- 인증서 ----------
  async onCertError(event, wc, url, error, cert, callback) {
    if (!wc || wc.session !== this.ses) return callback(false); // 앱 자체 통신은 절대 예외 없음
    event.preventDefault();
    const host = hostPortOf(url);
    const fp = cert.fingerprint;
    const saved = (this.store.data.trustedCerts || {})[host];
    if ((saved && saved.fingerprint === fp) || this.sessionTrust.get(host) === fp) return callback(true);
    const key = host + '|' + fp;
    if (!this.pendingCert.has(key)) {
      const tabId = this.tabOf(wc);
      const p = this.ask('cert', tabId, {
        host, error, fingerprint: fp,
        subject: cert.subjectName, issuer: cert.issuerName,
        validStart: cert.validStart, validExpiry: cert.validExpiry,
        changed: !!saved, oldFingerprint: saved ? saved.fingerprint : '',
      }).then((ans) => {
        this.pendingCert.delete(key);
        if (ans === 'save') {
          this.store.data.trustedCerts = { ...(this.store.data.trustedCerts || {}), [host]: { fingerprint: fp, saved: new Date().toISOString() } };
          this.store.save();
        }
        if (ans) this.sessionTrust.set(host, fp);
        return !!ans;
      });
      this.pendingCert.set(key, p);
    }
    callback(await this.pendingCert.get(key));
  }

  // ---------- HTTP 기본 인증 ----------
  async onLogin(event, wc, _details, authInfo, callback) {
    if (!wc || wc.session !== this.ses) return;
    event.preventDefault();
    const tabId = this.tabOf(wc);
    const t = tabId && this.tabs.get(tabId);
    const host = String(authInfo.host || '').toLowerCase();
    // 저장된 계정은 세션에 적힌 호스트에만, 한 번만 자동으로 보냄 (틀리면 물어봄)
    if (t && !authInfo.isProxy && !t.basicUsed && t.secrets.password && host === String(t.cfg.host).toLowerCase()) {
      t.basicUsed = true;
      return callback(t.cfg.username || '', t.secrets.password);
    }
    const ans = await this.ask('auth', tabId, {
      title: `${authInfo.isProxy ? '프록시' : '웹'} 로그인`,
      host: `${authInfo.host}${authInfo.realm ? ` — ${authInfo.realm}` : ''}`,
      username: t ? t.cfg.username || '' : '', needUser: true, canSave: false, retry: !!(t && t.basicUsed),
    });
    if (ans) callback(ans.username, ans.password); else callback();
  }

  // ---------- 탭 ----------
  open(tabId, resolved) {
    const { cfg, secrets } = resolved;
    const url = buildUrl(cfg);
    if (!isWebUrl(url)) return { ok: false, message: '주소가 올바르지 않습니다.' };
    if (!cfg.host) cfg.host = hostOf(url);
    this.tabs.set(tabId, { cfg, secrets, wcId: null, basicUsed: false });
    return { ok: true, url, hasCreds: !!(cfg.username || secrets.password), meta: { ...cfg } };
  }

  register(tabId, wcId) {
    const t = this.tabs.get(tabId);
    if (!t) return false;
    const wc = webContents.fromId(wcId);
    // 우리 창 안의 webview이고, 웹 전용 세션일 때만 연결
    if (!wc || wc.getType() !== 'webview' || wc.session !== this.ses) return false;
    t.wcId = wcId;
    this.byWc.set(wcId, tabId);
    return true;
  }

  /** "로그인 정보 입력": 지금 페이지가 세션에 적힌 장비 주소일 때만 아이디/비밀번호를 채움 */
  async fill(tabId) {
    const t = this.tabs.get(tabId);
    if (!t || !t.wcId) return { ok: false, message: '페이지가 아직 열리지 않았습니다.' };
    if (!t.secrets.password && !t.cfg.username) return { ok: false, message: '이 세션에 저장된 아이디/비밀번호가 없습니다.' };
    const wc = webContents.fromId(t.wcId);
    if (!wc) return { ok: false, message: '페이지가 닫혔습니다.' };
    const want = String(t.cfg.host).toLowerCase();
    if (hostOf(wc.getURL()) !== want) {
      return { ok: false, message: `지금 페이지(${hostOf(wc.getURL())})가 세션 주소(${want})와 달라서 입력하지 않았습니다.` };
    }
    const script = `(() => {
      const U = ${JSON.stringify(t.cfg.username || '')}, P = ${JSON.stringify(t.secrets.password || '')};
      const vis = (e) => e.offsetParent !== null && !e.disabled && !e.readOnly;
      const pw = [...document.querySelectorAll('input[type=password]')].filter(vis);
      if (!pw.length) return 0;
      const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      const scope = pw[0].form || document;
      const users = [...scope.querySelectorAll('input:not([type]),input[type=text],input[type=email],input[type=tel]')].filter(vis)
        .filter((e) => e.compareDocumentPosition(pw[0]) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (U && users.length) set(users[users.length - 1], U);
      if (P) set(pw[0], P);
      pw[0].focus();
      return 1;
    })()`;
    let filled = 0;
    // 로그인 화면이 프레임 안에 있는 오래된 장비도 있어서, 같은 호스트의 프레임에만 실행
    for (const frame of wc.mainFrame.framesInSubtree) {
      if (hostOf(frame.url) !== want) continue;
      try { filled += Number(await frame.executeJavaScript(script)) || 0; } catch (_) {}
    }
    if (!filled) return { ok: false, message: '이 화면에서 비밀번호 입력칸을 찾지 못했습니다.' };
    return { ok: true, plain: wc.getURL().startsWith('http:') };
  }

  close(tabId) {
    const t = this.tabs.get(tabId);
    if (t && t.wcId) this.byWc.delete(t.wcId);
    this.tabs.delete(tabId);
  }

  async clearData() {
    await this.ses.clearStorageData();
    await this.ses.clearCache();
    await this.ses.clearAuthCache();
    this.sessionTrust.clear();
    delete this.store.data.trustedCerts;
    this.store.save();
    return true;
  }
}

module.exports = { WebManager, PARTITION, buildUrl, isAppShortcut };
