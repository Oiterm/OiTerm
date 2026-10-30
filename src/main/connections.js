'use strict';
// 탭마다 하나의 연결(SSH / Telnet / Serial)을 관리
const fs = require('fs');
const iconv = require('iconv-lite');
const { Client } = require('ssh2');
const { SSH_ALGORITHMS, friendlyError, makeHostVerifier, probe } = require('./ssh-common');
const { TelnetClient } = require('./telnet');
const { SessionLogger } = require('./logger');
const { AutoLogin } = require('./autologin');
const { ZmodemBridge, XmodemSender } = require('./transfer');
const localshell = require('./localshell');

let SerialPort = null;
function loadSerial() {
  if (!SerialPort) SerialPort = require('serialport').SerialPort;
  return SerialPort;
}

const STRIP_ESC = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()*+#].|[@-_])/g;
const RE_OSC_TITLE = /\x1b\][02];([^\x07\x1b]{1,100})(?:\x07|\x1b\\)/;
// 장비 프롬프트에서 호스트 이름: SW1#  R1>  core-01(config-if)#  awplus#
const RE_PROMPT_NAME = /^([A-Za-z0-9][\w.\-\/]{0,62}?)(?:\([^)\s]{0,40}\))?\s?[>#]$/;

class Connection {
  constructor(mgr, tabId, cfg, secrets) {
    this.mgr = mgr;
    this.tabId = tabId;
    this.cfg = cfg;
    this.secrets = secrets;
    this.encoding = cfg.encoding === 'cp949' && cfg.protocol !== 'local' ? 'cp949' : 'utf8';
    this.decoder = iconv.getDecoder(this.encoding);
    this.cols = 80;
    this.rows = 24;
    this.logger = null;
    this.autologin = null;
    this.closed = false;
    this.impl = null;
    this.titleBuf = '';
    this.oscTitle = '';
    this.promptTitle = '';
    this.xfer = null;
    this.zmodem = cfg.protocol !== 'local' && mgr.store.getSettings().zmodemEnabled !== false ? new ZmodemBridge(this) : null;
    this.autoName = Connection.wantsAutoName(cfg, mgr.store.getSettings().logHostName || 'auto');
    this.logHost = '';
  }

  /**
   * 탭·로그 파일 이름을 장비 호스트 이름(프롬프트)으로 바꿀지
   * auto: EVE 링크, 콘솔(시리얼), 이름 없이 IP로 바로 접속한 탭 / always: 로컬 셸 빼고 전부 / off: 링크만
   */
  static wantsAutoName(cfg, mode) {
    if (cfg.protocol === 'local' || cfg.fixedName) return false;
    if (cfg.fromLink) return true;
    if (mode === 'off') return false;
    if (mode === 'always') return true;
    const n = String(cfg.name || '').trim();
    return cfg.protocol === 'serial' || !n || n === cfg.host || n === cfg.serialPort || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(n);
  }

  /** 장비에서 받은 원본 바이트: 파일 전송 중이면 전송 쪽으로, 아니면 화면으로 */
  emitData(buf) {
    if (this.xfer) { this.xfer.onData(buf); return; }
    if (this.zmodem) { this.zmodem.consume(buf); return; }
    this.emitText(buf);
  }

  get transferring() { return !!(this.xfer || (this.zmodem && this.zmodem.active)); }

  /** 전송용 원본 바이트 쓰기 (텔넷은 IAC/CR 처리) */
  rawWrite(buf) {
    if (!this.impl || this.closed) return;
    if (this.impl.writeRaw) this.impl.writeRaw(buf); else this.impl.write(buf);
  }

  waitDrain() { return new Promise((r) => setImmediate(r)); }

  startXmodem(file, proto) {
    if (this.closed || !this.impl) throw new Error('연결된 상태에서만 보낼 수 있습니다.');
    if (this.transferring) throw new Error('이미 파일 전송 중입니다.');
    this.xfer = new XmodemSender(this, file, proto);
    this.xfer.start();
  }

  cancelTransfer() {
    if (this.xfer) this.xfer.cancel();
    if (this.zmodem && this.zmodem.active) this.zmodem.cancel();
  }

  emitText(buf) {
    const text = this.decoder.write(buf);
    if (!text) return;
    if (this.autoName) this.detectTitle(text);
    this.mgr.send('conn:data', this.tabId, text);
    if (this.logger) this.logger.write(text);
    if (this.autologin) this.autologin.feed(text);
  }

  /**
   * EVE-NG / PNETLab 링크로 연 탭의 이름 정하기
   * 1) 콘솔 서버가 보내는 터미널 제목(ESC ]0;노드이름 BEL) — 처음 받은 것 하나만 사용
   * 2) 제목이 없으면 프롬프트의 호스트 이름 (hostname을 바꾸면 따라감)
   */
  detectTitle(text) {
    this.titleBuf = (this.titleBuf + text).slice(-600);
    if (!this.oscTitle) {
      // 터미널 제목(OSC)은 EVE 콘솔 서버가 보내는 것만 씀 (리눅스 셸은 제목을 계속 바꿔서)
      const m = this.cfg.fromLink ? RE_OSC_TITLE.exec(this.titleBuf) : null;
      if (m && m[1].trim()) {
        this.oscTitle = m[1].trim();
        return this.setTitle(this.oscTitle);
      }
      const plain = this.titleBuf.replace(STRIP_ESC, '').replace(/[\r\n]+$/, '');
      const last = plain.split(/\r\n|\n|\r/).pop().trim();
      const p = RE_PROMPT_NAME.exec(last);
      if (p && p[1] !== this.promptTitle) {
        this.promptTitle = p[1];
        this.setTitle(p[1]);
      }
    }
  }

  setTitle(name) {
    this.mgr.send('conn:title', this.tabId, name);
    const prev = this.logHost;
    this.logHost = name;
    if (!this.logger) return;
    // 콘솔 케이블을 다른 장비에 꽂음 → 이전 장비 로그는 닫고 새 장비 이름으로 새 파일
    // (장비가 프롬프트를 마구 바꿔도 파일이 끝없이 생기지 않게 탭 하나당 30개까지)
    if (this.cfg.protocol === 'serial' && prev && prev !== name && (this.logSplits = (this.logSplits || 0) + 1) <= 30) {
      this.logger.note(`장비가 바뀜: ${prev} → ${name}`);
      this.logger.close();
      this.logger = null;
      this.startLog();
      return;
    }
    const p = this.logger.renameTo(name);
    this.mgr.send('log:status', this.tabId, { active: true, path: p });
  }

  encode(str) { return this.encoding === 'utf8' ? Buffer.from(str, 'utf8') : iconv.encode(str, this.encoding); }

  write(str) {
    if (!this.impl || this.closed) return;
    // 파일 전송 중에는 키 입력을 막음 (Ctrl+C는 전송 취소)
    if (this.transferring) { if (str === '\x03') this.cancelTransfer(); return; }
    this.impl.write(this.encode(str));
  }

  status(state, message) { this.mgr.send('conn:status', this.tabId, state, message || ''); }

  info(message) { this.mgr.send('conn:info', this.tabId, message); }

  onReady() {
    this.status('connected');
    const st = this.mgr.store.getSettings();
    const autoLog = this.cfg.fromLink
      ? st.linkAutoLog !== false
      : this.cfg.autoLog === 'on' || (this.cfg.autoLog !== 'off' && (this.cfg.protocol === 'local' ? !!st.localAutoLog : st.autoLogAll));
    if (autoLog && !this.logger) this.startLog();
    if (this.logger && (this.oscTitle || this.promptTitle)) this.setTitle(this.oscTitle || this.promptTitle);
    // 랩 콘솔은 붙어도 화면이 비어 있으니 Enter를 한 번 보내 프롬프트를 띄움
    if (this.cfg.fromLink && st.linkAutoEnter !== false) setTimeout(() => this.write('\r'), 500);
    if (this.cfg.autoLogin || this.cfg.enable) {
      this.autologin = new AutoLogin({
        send: (s) => this.write(s),
        login: this.cfg.protocol !== 'ssh' && this.cfg.autoLogin,
        username: this.cfg.username,
        password: this.secrets.password,
        enable: this.cfg.enable,
        enableCmd: this.cfg.enableCmd,
        enablePassword: this.secrets.enablePassword,
        onDone: (reason) => {
          this.autologin = null;
          if (reason) this.info(`자동 로그인 중단: ${reason}`);
        },
      });
      if (this.cfg.protocol === 'serial' && this.cfg.autoLogin) setTimeout(() => this.write('\r'), 300);
    }
  }

  onClose(errMsg) {
    if (this.closed) return;
    this.closed = true;
    if (this.xfer) this.xfer.end(false, '연결이 끊겨 전송이 중단되었습니다.');
    if (this.zmodem && this.zmodem.active) this.zmodem.finish(false, '연결이 끊겨 전송이 중단되었습니다.');
    const tail = this.decoder.end();
    if (tail) this.mgr.send('conn:data', this.tabId, tail);
    if (this.autologin) { this.autologin.finish(); this.autologin = null; }
    if (this.logger) { this.logger.note('연결 종료'); }
    this.status(errMsg ? 'error' : 'closed', errMsg);
    this.mgr.onConnectionClosed(this);
  }

  startLog() {
    if (this.logger) return this.logger.path;
    const st = this.mgr.store.getSettings();
    try {
      this.logger = new SessionLogger({ dir: st.logDir, name: this.logHost || this.cfg.name || this.cfg.host || this.cfg.serialPort, timestamps: st.logTimestamps });
      this.mgr.send('log:status', this.tabId, { active: true, path: this.logger.path });
      return this.logger.path;
    } catch (e) {
      this.info('로그 파일을 만들 수 없습니다: ' + e.message);
      return null;
    }
  }

  stopLog() {
    if (!this.logger) return;
    this.logger.close();
    this.logger = null;
    this.mgr.send('log:status', this.tabId, { active: false, path: '' });
  }

  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    if (this.impl && this.impl.resize) this.impl.resize(cols, rows);
  }

  close() {
    if (this.impl && this.impl.close) this.impl.close();
    else {
      if (this.pendingClient) { try { this.pendingClient.end(); } catch (_) {} }
      this.onClose();
    }
  }

  sendBreak() { if (this.impl && this.impl.sendBreak) this.impl.sendBreak(); }

  // ---------------- 프로토콜별 구현 ----------------
  /** 오류 메시지에 보여줄 접속 주소 */
  where() {
    const c = this.cfg;
    if (c.protocol === 'serial') return `${c.serialPort} ${c.baudRate || 9600}bps`;
    if (c.protocol === 'local') return c.shellName || c.shell || '로컬 셸';
    return `${c.host}:${Number(c.port) || (c.protocol === 'ssh' ? 22 : 23)}`;
  }

  async start(cols, rows) {
    this.cols = cols || 80; this.rows = rows || 24;
    this.status('connecting');
    const p = this.cfg.protocol;
    try {
      if (p === 'ssh') await this.startSSH();
      else if (p === 'telnet') this.startTelnet();
      else if (p === 'serial') this.startSerial();
      else if (p === 'local') this.startLocal();
      else throw new Error('알 수 없는 프로토콜: ' + p);
    } catch (e) {
      this.onClose(friendlyError(e, p, this.where()));
    }
  }

  startTelnet() {
    const t = new TelnetClient({
      host: this.cfg.host,
      port: Number(this.cfg.port) || 23,
      termType: this.cfg.termType || 'xterm',
      cols: this.cols, rows: this.rows,
      keepalive: Number(this.cfg.keepalive) || 0,
    });
    let lastErr = null;
    t.on('ready', () => this.onReady());
    t.on('data', (b) => this.emitData(b));
    t.on('error', (e) => { lastErr = e; });
    t.on('close', () => this.onClose(lastErr ? friendlyError(lastErr, 'telnet', this.where()) : ''));
    this.impl = {
      write: (b) => t.write(b),
      writeRaw: (b) => t.writeRaw(b),
      resize: (c, r) => t.resize(c, r),
      close: () => t.close(),
    };
    t.connect();
  }

  startSerial() {
    const SP = loadSerial();
    const port = new SP({
      path: this.cfg.serialPort,
      baudRate: Number(this.cfg.baudRate) || 9600,
      dataBits: Number(this.cfg.dataBits) || 8,
      stopBits: Number(this.cfg.stopBits) || 1,
      parity: this.cfg.parity || 'none',
      rtscts: this.cfg.flowControl === 'rtscts',
      xon: this.cfg.flowControl === 'xonxoff',
      xoff: this.cfg.flowControl === 'xonxoff',
      autoOpen: false,
    });
    let lastErr = null;
    port.on('data', (b) => this.emitData(b));
    port.on('error', (e) => { lastErr = e; });
    port.on('close', () => this.onClose(lastErr ? friendlyError(lastErr, 'serial', this.where()) : ''));
    this.impl = {
      write: (b) => port.write(b),
      close: () => { if (port.isOpen) port.close(); else this.onClose(); },
      sendBreak: () => {
        port.set({ brk: true }, () => setTimeout(() => port.set({ brk: false }, () => {}), 500));
        this.info('Break 신호를 보냈습니다.');
      },
    };
    port.open((err) => {
      if (err) return this.onClose(friendlyError(err, 'serial', this.where()));
      this.onReady();
    });
  }

  /** 로컬 셸 (PowerShell / cmd / WSL ...) — ConPTY */
  startLocal() {
    const sh = localshell.resolve(this.cfg);
    this.cfg.shellName = sh.name;
    const ptyMod = localshell.loadPty(require('electron').app);
    const p = ptyMod.spawn(sh.file, sh.args, {
      name: 'xterm-256color', cols: this.cols, rows: this.rows,
      cwd: localshell.cwdFor(this.cfg), env: localshell.childEnv(), useConpty: true,
    });
    p.onData((str) => this.emitData(Buffer.from(str, 'utf8')));
    p.onExit(() => this.onClose(''));
    this.impl = {
      write: (b) => { try { p.write(b.toString('utf8')); } catch (_) {} },
      resize: (c, r) => { try { p.resize(Math.max(2, c), Math.max(1, r)); } catch (_) {} },
      close: () => { localshell.killTree(p); this.onClose(''); },
    };
    this.onReady();
  }

  async startSSH() {
    const cfg = this.cfg;
    let username = cfg.username || '';
    let password = this.secrets.password || '';
    let privateKey = null;
    if (cfg.authType === 'key' && cfg.keyPath) {
      try { privateKey = fs.readFileSync(cfg.keyPath); } catch (e) { throw new Error('개인 키 파일을 읽을 수 없습니다: ' + cfg.keyPath); }
    }
    if (!username || (!password && !privateKey)) {
      await probe(cfg.host, Number(cfg.port) || 22); // 포트가 닫혀 있으면 비밀번호 묻기 전에 바로 알림
      if (this.closed) return;
      const ans = await this.mgr.ask('auth', this.tabId, {
        title: `${cfg.name || cfg.host} 로그인`,
        host: `${cfg.host}:${cfg.port || 22}`,
        username, needUser: !username, canSave: !!cfg.id,
      });
      if (this.closed) return;
      if (!ans) return this.onClose('사용자가 로그인을 취소했습니다.');
      username = ans.username || username;
      password = ans.password || '';
      if (ans.save && cfg.id) this.mgr.store.upsertSession({ id: cfg.id, username }, { password });
    }
    this.secrets.password = password;
    this.cfg.username = username;
    await this._sshAttempt(username, password, privateKey, 1);
  }

  _sshAttempt(username, password, privateKey, attempt) {
    return new Promise((resolve) => {
      const cfg = this.cfg;
      const client = new Client();
      this.pendingClient = client;
      let errMsg = '';
      let ready = false;
      let authFailed = false;

      client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
        finish(prompts.map(() => password));
      });

      client.on('ready', () => {
        ready = true;
        client.shell({ term: cfg.termType || 'xterm', cols: this.cols, rows: this.rows }, (err, stream) => {
          if (err) { errMsg = '셸을 열 수 없습니다: ' + err.message; client.end(); return; }
          this.impl = {
            write: (b) => stream.write(b),
            resize: (c, r) => { try { stream.setWindow(r, c, 0, 0); } catch (_) {} },
            close: () => { try { stream.end(); } catch (_) {} client.end(); },
          };
          stream.on('data', (b) => this.emitData(b));
          stream.stderr.on('data', (b) => this.emitData(b));
          stream.on('close', () => client.end());
          this.onReady();
        });
      });

      client.on('error', (err) => {
        if (err.level === 'client-authentication') authFailed = true;
        errMsg = friendlyError(err, 'ssh', this.where());
      });

      client.on('close', async () => {
        if (!ready && authFailed && attempt < 3 && !this.closed) {
          const ans = await this.mgr.ask('auth', this.tabId, {
            title: '인증 실패 — 다시 입력하세요',
            host: `${cfg.host}:${cfg.port || 22}`,
            username, needUser: true, canSave: !!cfg.id, retry: true,
          });
          if (this.closed) return resolve();
          if (!ans) { this.onClose('인증 실패'); return resolve(); }
          if (ans.save && cfg.id) this.mgr.store.upsertSession({ id: cfg.id, username: ans.username || username }, { password: ans.password || '' });
          this.secrets.password = ans.password || '';
          this.cfg.username = ans.username || username;
          await this._sshAttempt(ans.username || username, ans.password || '', privateKey, attempt + 1);
          return resolve();
        }
        this.onClose(ready ? '' : (errMsg || '연결이 종료되었습니다.'));
        resolve();
      });

      const hostport = `${cfg.host}:${Number(cfg.port) || 22}`;
      client.connect({
        host: cfg.host,
        port: Number(cfg.port) || 22,
        username,
        password: password || undefined,
        privateKey: privateKey || undefined,
        passphrase: this.secrets.passphrase || undefined,
        tryKeyboard: true,
        readyTimeout: 20000,
        keepaliveInterval: (Number(cfg.keepalive) || 0) * 1000,
        keepaliveCountMax: 3,
        algorithms: SSH_ALGORITHMS,
        hostVerifier: makeHostVerifier(this.mgr, this.tabId, hostport, () => { errMsg = '호스트 키를 거부했습니다.'; }),
      });
    });
  }
}

class ConnectionManager {
  constructor({ store, send, ask, pickFiles }) {
    this.store = store;
    this.send = send;
    this.ask = ask;
    this.pickFiles = pickFiles || (async () => []);
    this.conns = new Map();
  }

  open(tabId, req, cols, rows) {
    // 재연결이면 열려 있던 로그 파일을 그대로 이어서 씀
    const old = this.conns.get(tabId);
    const carryLogger = old && old.logger;
    if (old) old.logger = null;
    this.close(tabId);
    const r = this.resolve(req);
    if (!r) { this.send('conn:status', tabId, 'error', '세션을 찾을 수 없습니다.'); return; }
    const { cfg, secrets } = r;
    const st = this.store.getSettings();
    if (!cfg.encoding) cfg.encoding = st.defaultEncoding;
    if (!cfg.termType) cfg.termType = st.defaultTermType;
    const conn = new Connection(this, tabId, cfg, secrets);
    if (carryLogger) { conn.logger = carryLogger; conn.logHost = old.logHost || ''; carryLogger.note('재연결'); }
    this.conns.set(tabId, conn);
    conn.start(cols, rows);
  }

  /** 저장된 세션 id 또는 즉석 설정 → { cfg, secrets }. override로 프로토콜 등을 바꿔 쓸 수 있음 (SSH 세션 → SFTP) */
  resolve(req) {
    let cfg, secrets;
    if (req.sessionId) {
      const s = this.store.getSession(req.sessionId);
      if (!s) return null;
      const { secret, ...rest } = s;
      cfg = { ...rest };
      secrets = this.store.getSecrets(req.sessionId);
    } else {
      cfg = { ...req.session };
      secrets = { password: '', enablePassword: '', passphrase: '', ...(req.secrets || {}) };
    }
    if (req.override) Object.assign(cfg, req.override);
    return { cfg, secrets };
  }

  onConnectionClosed(_conn) { /* 로그는 탭을 닫거나 사용자가 멈출 때까지 유지 */ }

  get(tabId) { return this.conns.get(tabId); }

  write(tabId, data) { const c = this.conns.get(tabId); if (c) c.write(data); }
  resize(tabId, cols, rows) { const c = this.conns.get(tabId); if (c) c.resize(cols, rows); }
  sendBreak(tabId) { const c = this.conns.get(tabId); if (c) c.sendBreak(); }
  startXmodem(tabId, file, proto) {
    const c = this.conns.get(tabId);
    if (!c) throw new Error('연결이 없습니다.');
    c.startXmodem(file, proto);
  }
  cancelTransfer(tabId) { const c = this.conns.get(tabId); if (c) c.cancelTransfer(); }
  startLog(tabId) { const c = this.conns.get(tabId); return c ? c.startLog() : null; }
  stopLog(tabId) { const c = this.conns.get(tabId); if (c) c.stopLog(); }

  close(tabId) {
    const c = this.conns.get(tabId);
    if (!c) return;
    this.conns.delete(tabId);
    if (!c.closed) c.close();
    c.stopLog();
  }

  disconnect(tabId) {
    const c = this.conns.get(tabId);
    if (c && !c.closed) c.close();
  }

  closeAll() { for (const id of [...this.conns.keys()]) this.close(id); }
}

module.exports = { ConnectionManager };
