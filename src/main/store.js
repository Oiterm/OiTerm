'use strict';
// 설정/세션 저장소. 비밀번호는 Windows DPAPI(safeStorage)로 암호화해서 저장
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

const DEFAULT_SETTINGS = {
  fontFamily: "Consolas, 'D2Coding', 'Malgun Gothic', monospace",
  fontSize: 14,
  theme: 'dark',
  scrollback: 20000,
  cursorBlink: true,
  copyOnSelect: true,
  rightClickPaste: true,
  confirmMultiLinePaste: true,
  lineDelay: 50,
  logDir: '',
  autoLogAll: true,
  logTimestamps: true,
  logHostName: 'auto',
  defaultEncoding: 'utf8',
  defaultTermType: 'xterm',
  highlightEnabled: true,
  highlights: [
    { color: 'red', pattern: '\\b(down|err-disabled|errdisable|error|errors|fail|failed|failure|denied|deny|invalid|rejected|drop|dropped|crc)\\b' },
    { color: 'green', pattern: '\\b(up|connected|established|permit|success|active|forwarding)\\b' },
    { color: 'yellow', pattern: '\\b(warning|notconnect|shutdown|disabled|timeout|blocking|standby)\\b' },
    { color: 'magenta', pattern: '%[A-Z0-9_]+-[0-7]-[A-Z0-9_]+' },
  ],
  zmodemEnabled: true,
  transferDir: '',
  tftpRoot: '',
  tftpAllowRead: true,
  tftpAllowWrite: true,
  tftpAutoStop: 30,
  linkAutoEnter: true,
  linkAutoLog: true,
  scanPorts: '22,23,80,443,3389',
  scanTimeout: 1000,
  scanConcurrency: 64,
  scanDns: true,
  scanNoPing: false,
  scanLastTarget: '',
  smartLinks: true,
  smartRightClick: true,
  smartIpCmd: 'show ip arp {ip}',
  smartMacCmd: 'show mac address-table address {mac}',
  dangerEnabled: true,
  dangerRules: null,
  localShell: '',
  localAutoLog: false,
  updateCheck: true,
  sidebarWidth: 240,
  showSidebar: true,
  showButtonBar: true,
};

const DEFAULT_BUTTONS = [
  { label: 'term len 0', command: 'terminal length 0' },
  { label: 'show run', command: 'show running-config' },
  { label: 'show ver', command: 'show version' },
  { label: 'int status', command: 'show interfaces status' },
  { label: 'ip int brief', command: 'show ip interface brief' },
  { label: 'show log', command: 'show logging' },
  { label: 'mac table', command: 'show mac address-table' },
  { label: 'wr', command: 'write memory' },
];

const SECRET_KEYS = ['password', 'enablePassword', 'passphrase'];

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'oiterm-config.json');
    // 이름 변경 전(SwitchTerm) 설정 파일이 있으면 그대로 이어서 사용
    const legacy = path.join(app.getPath('userData'), 'switchterm-config.json');
    if (!fs.existsSync(this.file) && fs.existsSync(legacy)) {
      try { fs.renameSync(legacy, this.file); } catch (_) { try { fs.copyFileSync(legacy, this.file); } catch (__) {} }
    }
    this.data = { sessions: [], settings: {}, buttons: null, knownHosts: {} };
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      Object.assign(this.data, JSON.parse(raw));
    } catch (_) { /* 첫 실행 */ }
    this.data.settings = { ...DEFAULT_SETTINGS, ...this.data.settings };
    if (!this.data.settings.logDir) {
      this.data.settings.logDir = path.join(app.getPath('documents'), 'OiTerm Logs');
    }
    if (!this.data.settings.transferDir) this.data.settings.transferDir = path.join(app.getPath('downloads'), 'OiTerm');
    if (!this.data.settings.tftpRoot) this.data.settings.tftpRoot = path.join(app.getPath('documents'), 'OiTerm TFTP');
    if (!Array.isArray(this.data.buttons)) this.data.buttons = DEFAULT_BUTTONS.slice();
    if (!Array.isArray(this.data.sessions)) this.data.sessions = [];
    if (!this.data.knownHosts) this.data.knownHosts = {};
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  // ---- 암호화 ----
  encrypt(text) {
    if (!text) return '';
    if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64');
    return 'b64:' + Buffer.from(text, 'utf8').toString('base64');
  }

  decrypt(val) {
    if (!val) return '';
    try {
      if (val.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(val.slice(4), 'base64'));
      if (val.startsWith('b64:')) return Buffer.from(val.slice(4), 'base64').toString('utf8');
    } catch (_) { return ''; }
    return '';
  }

  // ---- 세션 ----
  publicSession(s) {
    const { secret = {}, ...rest } = s;
    return {
      ...rest,
      hasPassword: !!secret.password,
      hasEnablePassword: !!secret.enablePassword,
      hasPassphrase: !!secret.passphrase,
    };
  }

  listSessions() { return this.data.sessions.map((s) => this.publicSession(s)); }

  getSession(id) { return this.data.sessions.find((s) => s.id === id) || null; }

  getSecrets(id) {
    const s = this.getSession(id);
    const out = {};
    for (const k of SECRET_KEYS) out[k] = s && s.secret ? this.decrypt(s.secret[k]) : '';
    return out;
  }

  /** secrets: { password: undefined(유지) | ''(삭제) | 'xxx'(변경) } */
  upsertSession(input, secrets = {}) {
    const clean = { ...input };
    delete clean.hasPassword; delete clean.hasEnablePassword; delete clean.hasPassphrase; delete clean.secret;
    let s = clean.id ? this.getSession(clean.id) : null;
    if (!s) {
      s = { id: clean.id || crypto.randomUUID(), secret: {} };
      this.data.sessions.push(s);
    }
    const secret = s.secret || {};
    Object.assign(s, clean, { id: s.id });
    for (const k of SECRET_KEYS) {
      if (secrets[k] === undefined || secrets[k] === null) continue;
      secret[k] = secrets[k] === '' ? '' : this.encrypt(secrets[k]);
    }
    s.secret = secret;
    this.save();
    return this.publicSession(s);
  }

  duplicateSession(id) {
    const src = this.getSession(id);
    if (!src) return null;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = crypto.randomUUID();
    copy.name = (src.name || '') + ' 복사';
    this.data.sessions.push(copy);
    this.save();
    return this.publicSession(copy);
  }

  deleteSession(id) {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    this.save();
  }

  renameFolder(from, to) {
    for (const s of this.data.sessions) {
      if ((s.folder || '') === from) s.folder = to;
      else if ((s.folder || '').startsWith(from + '/')) s.folder = to + s.folder.slice(from.length);
    }
    this.save();
  }

  // ---- 설정 ----
  getSettings() { return this.data.settings; }
  saveSettings(st) {
    const prev = this.data.settings;
    this.data.settings = { ...DEFAULT_SETTINGS, ...st };
    for (const k of ['logDir', 'transferDir', 'tftpRoot']) if (!this.data.settings[k]) this.data.settings[k] = prev[k];
    this.save();
    return this.data.settings;
  }
  getButtons() { return this.data.buttons; }
  saveButtons(b) { this.data.buttons = Array.isArray(b) ? b : []; this.save(); return this.data.buttons; }
  defaults() { return { settings: DEFAULT_SETTINGS, buttons: DEFAULT_BUTTONS }; }

  // ---- 호스트 키 ----
  getHostKey(hostport) { return this.data.knownHosts[hostport] || null; }
  setHostKey(hostport, info) { this.data.knownHosts[hostport] = info; this.save(); }
}

module.exports = { Store, DEFAULT_SETTINGS, DEFAULT_BUTTONS };
