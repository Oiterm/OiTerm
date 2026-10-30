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

class SessionLogger {
  constructor({ dir, name, timestamps = true }) {
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.fileStamp = fileStamp();
    this.path = path.join(dir, `${safeName(name)}_${this.fileStamp}.log`);
    this.timestamps = timestamps;
    this.fd = fs.openSync(this.path, 'a');
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

  /** 탭 이름이 정해지면 로그 파일 이름도 맞춰 바꿈 (예: 192.168.100.2_23 → SW1) */
  renameTo(name) {
    const np = path.join(this.dir, `${safeName(name)}_${this.fileStamp}.log`);
    if (np === this.path || this.fd === null) return this.path;
    this.flushFile();
    try {
      fs.closeSync(this.fd);
      if (!fs.existsSync(np)) { fs.renameSync(this.path, np); this.path = np; }
    } catch (_) { /* 이름을 못 바꾸면 기존 이름 유지 */ }
    this.fd = fs.openSync(this.path, 'a');
    return this.path;
  }

  close() {
    this.renderer.flush(true);
    this._w(`===== 로그 종료 ${stamp()} =====\r\n`);
    this.flushFile();
    try { fs.closeSync(this.fd); } catch (_) {}
    this.fd = null;
  }
}

module.exports = { SessionLogger, LineRenderer, safeName, stamp };
