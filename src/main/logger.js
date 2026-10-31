'use strict';
// 세션 로그: 제어문자(색, 커서 이동, --More-- 지우기 등)를 해석해서 사람이 읽을 수 있는 텍스트로 저장
const fs = require('fs');
const path = require('path');

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fileStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function safeName(s) {
  return String(s || 'session').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 80) || 'session';
}
function dayStamp(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

/** 폴더 이름·확장자만 붙는 파일 이름으로 써도 안전한 이름
 *  (장비가 보낸 호스트 이름이 들어오므로: 경로 문자 제거, ".", ".." 같은 이름 막기,
 *   Windows 예약 이름 CON·NUL·COM1 등과 끝의 점·공백 처리) */
function safeBase(s) {
  let n = safeName(s).replace(/^[.\s]+|[.\s]+$/g, '');
  if (!n || /^\.+$/.test(n)) n = 'session';
  if (/^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i.test(n)) n = '_' + n;
  return n;
}

// 이 프로그램 안에서 지금 열려 있는 로그 파일 (같은 장비 탭 두 개가 한 파일에 섞이지 않게)
const openPaths = new Set();
const key = (p) => path.resolve(p).toLowerCase();

// 화면 출력용 문자열을 "한 줄 버퍼 + 커서" 모델로 해석
class LineRenderer {
  constructor(onLine) {
    this.onLine = onLine;
    this.line = [];
    this.cur = 0;
    this.esc = 0; // 0: 일반, 1: ESC 직후, 2: CSI, 3: OSC, 4: OSC 안의 ESC, 5: 문자셋 지정(ESC ( 등)
    this.csi = '';
  }

  _put(ch) {
    if (this.cur > 65536) { this.flush(); }
    while (this.line.length < this.cur) this.line.push(' ');
    this.line[this.cur] = ch;
    this.cur++;
  }

  _csi(seq) {
    const final = seq[seq.length - 1];
    const params = seq.slice(0, -1).replace(/[?>=!]/g, '');
    const n = parseInt(params, 10);
    switch (final) {
      case 'K': {
        const mode = isNaN(n) ? 0 : n;
        if (mode === 0) this.line.length = Math.min(this.line.length, this.cur);
        else if (mode === 1) for (let i = 0; i < Math.min(this.cur, this.line.length); i++) this.line[i] = ' ';
        else if (mode === 2) this.line = [];
        break;
      }
      case 'D': this.cur = Math.max(0, this.cur - (isNaN(n) ? 1 : Math.max(1, n))); break;
      case 'C': this.cur += isNaN(n) ? 1 : Math.max(1, n); break;
      case 'G': this.cur = Math.max(0, (isNaN(n) ? 1 : n) - 1); break;
      case 'J': if (n === 2) { this.line = []; this.cur = 0; } break;
      default: break; // 색상(m) 등은 무시
    }
  }

  feed(text) {
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (this.esc === 1) {
        if (ch === '[') { this.esc = 2; this.csi = ''; }
        else if (ch === ']') this.esc = 3;
        else if ('()*+#'.includes(ch)) this.esc = 5;
        else this.esc = 0;
        continue;
      }
      if (this.esc === 2) {
        this.csi += ch;
        if (c >= 0x40 && c <= 0x7e) { this._csi(this.csi); this.esc = 0; }
        else if (this.csi.length > 32) this.esc = 0;
        continue;
      }
      if (this.esc === 3) {
        if (c === 7) this.esc = 0;
        else if (c === 27) this.esc = 4;
        continue;
      }
      if (this.esc === 4) { this.esc = ch === '\\' ? 0 : 3; continue; }
      if (this.esc === 5) { this.esc = 0; continue; }

      if (c === 27) { this.esc = 1; continue; }
      if (c === 10) { this.flush(); continue; }
      if (c === 13) { this.cur = 0; continue; }
      if (c === 8) { this.cur = Math.max(0, this.cur - 1); continue; }
      if (c === 9) { this._put('\t'); continue; }
      if (c < 32 || c === 127) continue;
      this._put(ch);
    }
  }

  flush(force = false) {
    const s = this.line.join('').replace(/\s+$/, '');
    if (s.length || !force) this.onLine(s);
    this.line = [];
    this.cur = 0;
  }
}

/** 폴더 구조
 *  flat        : 로그폴더/SW1_20261031_192233.log            (하루 파일: SW1_20261031.log)
 *  date        : 로그폴더/2026-10-31/SW1_20261031_192233.log (하루 파일: 2026-10-31/SW1.log)
 *  date-device : 로그폴더/2026-10-31/SW1/SW1_20261031_192233.log (하루 파일: 2026-10-31/SW1/SW1.log) */
const LAYOUTS = ['flat', 'date', 'date-device'];

class SessionLogger {
  constructor({ dir, name, timestamps = true, layout = 'flat', daily = false }) {
    this.base = dir;
    this.layout = LAYOUTS.includes(layout) ? layout : 'flat';
    this.daily = !!daily;
    this.started = new Date();
    this.fileStamp = fileStamp(this.started);
    this.path = this.pathFor(name);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.timestamps = timestamps;
    this.fd = fs.openSync(this.path, 'a');
    openPaths.add(key(this.path));
    this.buf = [];
    this.timer = null;
    this.renderer = new LineRenderer((line) => {
      this._w((this.timestamps ? `[${stamp()}] ` : '') + line + '\r\n');
    });
    this._w(`===== 로그 시작 ${stamp()} : ${name} =====\r\n`);
  }

  _w(s) {
    this.buf.push(s);
    if (!this.timer) this.timer = setTimeout(() => this.flushFile(), 200);
  }

  flushFile() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.buf.length || this.fd === null) return;
    try { fs.writeSync(this.fd, this.buf.join('')); } catch (_) { /* 디스크 문제 등은 무시 */ }
    this.buf = [];
  }

  write(text) { this.renderer.feed(text); }

  note(msg) {
    this.renderer.flush(true);
    this._w(`===== ${msg} ${stamp()} =====\r\n`);
  }

  /** 이 로그가 들어갈 경로 (항상 로그 폴더 안) */
  pathFor(name, avoidOpen = true) {
    const n = safeBase(name);
    const day = dayStamp(this.started);
    let dir = this.base;
    if (this.layout !== 'flat') dir = path.join(dir, day);
    if (this.layout === 'date-device') dir = path.join(dir, n);
    let file;
    if (this.daily) {
      file = path.join(dir, this.layout === 'flat' ? `${n}_${this.fileStamp.slice(0, 8)}.log` : `${n}.log`);
      // 같은 장비 탭이 이미 이 파일에 쓰고 있으면 섞이지 않게 시각 붙인 파일로
      if (avoidOpen && openPaths.has(key(file))) file = path.join(dir, `${n}_${this.fileStamp}.log`);
    } else {
      file = path.join(dir, `${n}_${this.fileStamp}.log`);
    }
    // 마지막 안전장치: 로그 폴더 밖으로는 절대 안 나감
    const rel = path.relative(path.resolve(this.base), path.resolve(file));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return path.join(this.base, `session_${this.fileStamp}.log`);
    return file;
  }

  /** 탭 이름이 정해지면 로그 파일 이름(폴더)도 맞춰 바꿈 (예: 192.168.100.2_23 → SW1)
   *  하루 파일 모드에서 그 장비 파일이 이미 있으면 지금까지 쓴 내용을 거기에 이어 붙임 */
  renameTo(name) {
    if (this.fd === null) return this.path;
    const np = this.pathFor(name);
    if (key(np) === key(this.path)) return this.path;
    this.flushFile();
    const old = this.path;
    try {
      fs.closeSync(this.fd);
      fs.mkdirSync(path.dirname(np), { recursive: true });
      if (!fs.existsSync(np)) { fs.renameSync(old, np); this.path = np; }
      else if (this.daily && !openPaths.has(key(np))) {
        fs.appendFileSync(np, fs.readFileSync(old));
        fs.unlinkSync(old);
        this.path = np;
      }
    } catch (_) { /* 이름을 못 바꾸면 기존 이름 유지 */ }
    if (this.path !== old) {
      openPaths.delete(key(old));
      openPaths.add(key(this.path));
      this.removeEmptyDir(path.dirname(old));
    }
    this.fd = fs.openSync(this.path, 'a');
    return this.path;
  }

  /** 이름이 바뀌어 비게 된 장비 폴더 정리 (로그 폴더·날짜 폴더 자체는 그대로) */
  removeEmptyDir(d) {
    if (this.layout !== 'date-device') return;
    const rel = path.relative(path.resolve(this.base), path.resolve(d));
    if (!rel || rel.startsWith('..') || rel.split(path.sep).length !== 2) return;
    try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch (_) {}
  }

  close() {
    this.renderer.flush(true);
    this._w(`===== 로그 종료 ${stamp()} =====\r\n`);
    this.flushFile();
    try { fs.closeSync(this.fd); } catch (_) {}
    this.fd = null;
    openPaths.delete(key(this.path));
  }
}

module.exports = { SessionLogger, LineRenderer, safeName, safeBase, stamp, LAYOUTS };
