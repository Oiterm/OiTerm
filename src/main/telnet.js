'use strict';
// 텔넷 클라이언트: TCP 소켓 + IAC 옵션 협상 (RFC 854/855/1073/1091)
const net = require('net');
const { EventEmitter } = require('events');

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const NOP = 241;
const OPT = { BINARY: 0, ECHO: 1, SGA: 3, TTYPE: 24, NAWS: 31 };
const TTYPE_IS = 0, TTYPE_SEND = 1;

const S_DATA = 0, S_IAC = 1, S_VERB = 2, S_SB = 3, S_SB_IAC = 4, S_CR = 5;

class TelnetClient extends EventEmitter {
  constructor({ host, port = 23, termType = 'xterm', cols = 80, rows = 24, keepalive = 0, timeout = 15000 }) {
    super();
    this.host = host;
    this.port = port;
    this.termType = termType;
    this.cols = cols;
    this.rows = rows;
    this.keepalive = keepalive;
    this.timeout = timeout;
    this.state = S_DATA;
    this.verb = 0;
    this.sbBuf = [];
    this.us = new Set();   // 우리가 WILL 한 옵션
    this.him = new Set();  // 상대가 WILL 한 옵션 (우리가 DO 한 것)
    this.socket = null;
    this.kaTimer = null;
    this.closed = false;
  }

  connect() {
    const sock = net.createConnection({ host: this.host, port: this.port });
    this.socket = sock;
    sock.setNoDelay(true);
    sock.setTimeout(this.timeout);
    sock.once('timeout', () => {
      sock.destroy(Object.assign(new Error('연결 시간 초과'), { code: 'ETIMEDOUT' }));
    });
    sock.once('connect', () => {
      sock.setTimeout(0);
      sock.setKeepAlive(true, 30000);
      if (this.keepalive > 0) {
        this.kaTimer = setInterval(() => this._raw([IAC, NOP]), this.keepalive * 1000);
      }
      this.emit('ready');
    });
    sock.on('data', (buf) => this._parse(buf));
    sock.on('error', (err) => this.emit('error', err));
    sock.on('close', () => this._onClose());
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.kaTimer) clearInterval(this.kaTimer);
    this.emit('close');
  }

  _raw(bytes) {
    if (this.socket && !this.socket.destroyed) this.socket.write(Buffer.from(bytes));
  }

  _parse(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      switch (this.state) {
        case S_DATA:
          if (b === IAC) this.state = S_IAC;
          else if (b === 13 && !this.him.has(OPT.BINARY)) { out.push(13); this.state = S_CR; }
          else out.push(b);
          break;
        case S_CR:
          // CR NUL -> CR, CR LF -> CR LF
          this.state = S_DATA;
          if (b === 0) break;
          if (b === IAC) { this.state = S_IAC; break; }
          out.push(b);
          break;
        case S_IAC:
          if (b === IAC) { out.push(IAC); this.state = S_DATA; }
          else if (b === DO || b === DONT || b === WILL || b === WONT) { this.verb = b; this.state = S_VERB; }
          else if (b === SB) { this.sbBuf = []; this.state = S_SB; }
          else this.state = S_DATA; // NOP, GA 등 무시
          break;
        case S_VERB:
          this._negotiate(this.verb, b);
          this.state = S_DATA;
          break;
        case S_SB:
          if (b === IAC) this.state = S_SB_IAC;
          else if (this.sbBuf.length < 512) this.sbBuf.push(b);
          break;
        case S_SB_IAC:
          if (b === SE) { this._subneg(this.sbBuf); this.state = S_DATA; }
          else if (b === IAC) { this.sbBuf.push(IAC); this.state = S_SB; }
          else this.state = S_SB;
          break;
      }
    }
    if (out.length) this.emit('data', Buffer.from(out));
  }

  _negotiate(verb, opt) {
    if (verb === DO) {
      if (opt === OPT.TTYPE || opt === OPT.NAWS || opt === OPT.BINARY || opt === OPT.SGA) {
        if (!this.us.has(opt)) { this.us.add(opt); this._raw([IAC, WILL, opt]); }
        if (opt === OPT.NAWS) this._sendNaws();
      } else {
        this._raw([IAC, WONT, opt]);
      }
    } else if (verb === DONT) {
      if (this.us.has(opt)) { this.us.delete(opt); this._raw([IAC, WONT, opt]); }
    } else if (verb === WILL) {
      if (opt === OPT.ECHO || opt === OPT.SGA || opt === OPT.BINARY) {
        if (!this.him.has(opt)) { this.him.add(opt); this._raw([IAC, DO, opt]); }
      } else {
        this._raw([IAC, DONT, opt]);
      }
    } else if (verb === WONT) {
      if (this.him.has(opt)) { this.him.delete(opt); this._raw([IAC, DONT, opt]); }
    }
  }

  _subneg(sb) {
    if (sb[0] === OPT.TTYPE && sb[1] === TTYPE_SEND) {
      const name = Buffer.from(this.termType.toUpperCase(), 'ascii');
      this._raw([IAC, SB, OPT.TTYPE, TTYPE_IS, ...name, IAC, SE]);
    }
  }

  _sendNaws() {
    if (!this.us.has(OPT.NAWS)) return;
    const w = Math.max(1, Math.min(65535, this.cols));
    const h = Math.max(1, Math.min(65535, this.rows));
    const bytes = [w >> 8, w & 255, h >> 8, h & 255];
    const esc = [];
    for (const x of bytes) { esc.push(x); if (x === IAC) esc.push(IAC); }
    this._raw([IAC, SB, OPT.NAWS, ...esc, IAC, SE]);
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this._sendNaws();
  }

  write(buf) {
    if (!this.socket || this.socket.destroyed) return;
    const out = [];
    const binary = this.us.has(OPT.BINARY);
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b === IAC) { out.push(IAC, IAC); continue; }
      out.push(b);
      // 엔터(CR)는 텔넷 표준 줄바꿈인 CR LF로 보냄
      if (b === 13 && !binary && buf[i + 1] !== 10) out.push(10);
    }
    this.socket.write(Buffer.from(out));
  }

  /** 파일 전송용: 줄바꿈 변환 없이 보냄 (IAC 이스케이프, 비바이너리 모드에서 CR은 CR NUL) */
  writeRaw(buf) {
    if (!this.socket || this.socket.destroyed) return;
    const binary = this.us.has(OPT.BINARY);
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b === IAC) { out.push(IAC, IAC); continue; }
      out.push(b);
      if (b === 13 && !binary) out.push(0);
    }
    this.socket.write(Buffer.from(out));
  }

  close() {
    if (this.socket) this.socket.destroy();
    this._onClose();
  }
}

module.exports = { TelnetClient };
