'use strict';
// TFTP 서버 (RFC 1350 + blksize/tsize/timeout 옵션 RFC 2347~2349)
// 장비에서: copy running-config tftp://<PC IP>/SW1-confg  /  copy tftp://<PC IP>/<이미지> flash:
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const OP = { RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERROR: 5, OACK: 6 };
const ERR = { NOT_DEFINED: 0, NOT_FOUND: 1, ACCESS: 2, DISK_FULL: 3, ILLEGAL: 4, UNKNOWN_TID: 5, EXISTS: 6, OPTION: 8 };

function errorPacket(code, msg) {
  const m = Buffer.from(String(msg).slice(0, 200), 'ascii');
  const b = Buffer.alloc(5 + m.length);
  b.writeUInt16BE(OP.ERROR, 0); b.writeUInt16BE(code, 2); m.copy(b, 4);
  return b;
}

function parseRequest(msg) {
  const parts = [];
  let start = 2;
  for (let i = 2; i < msg.length; i++) {
    if (msg[i] === 0) { parts.push(msg.slice(start, i).toString('latin1')); start = i + 1; }
  }
  if (parts.length < 2) return null;
  const [file, mode, ...rest] = parts;
  const opts = {};
  for (let i = 0; i + 1 < rest.length; i += 2) opts[rest[i].toLowerCase()] = rest[i + 1];
  return { file, mode: mode.toLowerCase(), opts };
}

/** 요청한 파일 이름 → 루트 폴더 안의 실제 경로 (밖으로 나가면 null) */
function resolveInRoot(root, name) {
  const clean = String(name).replace(/\\/g, '/').replace(/^[a-z]+:\/\/[^/]*\//i, '').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((p) => p === '..') || /[\x00-\x1f<>:"|?*]/.test(clean.replace(/\//g, ''))) return null;
  const full = path.resolve(root, clean);
  const rootAbs = path.resolve(root);
  if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) return null;
  return full;
}

function localIPs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}

class Transfer {
  constructor(server, peer, req, kind, full) {
    this.server = server;
    this.peer = peer;
    this.req = req;
    this.kind = kind; // 'get' (장비가 받음) | 'put' (장비가 올림)
    this.full = full;
    this.id = ++server.seq;
    this.blksize = 512;
    this.timeoutMs = 3000;
    this.retries = 0;
    this.done = 0;
    this.total = 0;
    this.block = 0;
    this.finished = false;
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m, rinfo) => this.onMessage(m, rinfo));
    this.sock.on('error', (e) => this.fail(e.message));
  }

  emit(status, message) {
    this.server.emit('transfer', {
      id: this.id, kind: this.kind, file: this.req.file, peer: this.peer.address,
      done: this.done, total: this.total, status, message: message || '',
    });
  }

  send(buf) {
    this.last = buf;
    this.sock.send(buf, this.peer.port, this.peer.address);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onTimeout(), this.timeoutMs);
  }

  onTimeout() {
    // 마지막 블록까지 보냈는데 끝 확인(ACK)만 못 받은 경우: 장비는 대개 이미 다 받은 상태
    if (this.kind === 'get' && this.lastSize !== undefined && this.lastSize < this.blksize && this.retries >= 2) {
      this.done += this.pending;
      return this.complete();
    }
    if (++this.retries > 6) return this.fail('응답 없음 (시간 초과)');
    this.sock.send(this.last, this.peer.port, this.peer.address);
    this.timer = setTimeout(() => this.onTimeout(), this.timeoutMs);
  }

  negotiate() {
    const o = this.req.opts;
    const ack = {};
    if (o.blksize) {
      const n = Math.max(8, Math.min(65464, parseInt(o.blksize, 10) || 512));
      this.blksize = Math.min(n, 1468); // 이더넷 MTU를 넘지 않게
      ack.blksize = String(this.blksize);
    }
    if (o.timeout) {
      const t = Math.max(1, Math.min(255, parseInt(o.timeout, 10) || 3));
      this.timeoutMs = t * 1000;
      ack.timeout = String(t);
    }
    if (o.tsize !== undefined) {
      if (this.kind === 'get') ack.tsize = String(this.total);
      else { this.total = parseInt(o.tsize, 10) || 0; ack.tsize = o.tsize; }
    }
    return ack;
  }

  oack(opts) {
    const parts = [Buffer.from([0, OP.OACK])];
    for (const [k, v] of Object.entries(opts)) parts.push(Buffer.from(`${k}\0${v}\0`, 'ascii'));
    return Buffer.concat(parts);
  }

  start() {
    this.server.active.set(this.id, this);
    try {
      if (this.kind === 'get') {
        this.fd = fs.openSync(this.full, 'r');
        this.total = fs.fstatSync(this.fd).size;
      } else {
        fs.mkdirSync(path.dirname(this.full), { recursive: true });
        this.tmp = this.full + '.part';
        this.fd = fs.openSync(this.tmp, 'w');
      }
    } catch (e) {
      this.sock.send(errorPacket(e.code === 'ENOENT' ? ERR.NOT_FOUND : ERR.ACCESS, e.code === 'ENOENT' ? 'File not found' : 'Access violation'), this.peer.port, this.peer.address);
      return this.fail(e.code === 'ENOENT' ? '파일이 없습니다' : '파일을 열 수 없습니다: ' + e.message, true);
    }
    const opts = this.negotiate();
    this.emit('start');
    if (Object.keys(opts).length) {
      this.state = 'oack';
      this.send(this.oack(opts));
    } else if (this.kind === 'get') {
      this.sendNextData();
    } else {
      this.sendAck(0);
    }
  }

  sendNextData() {
    this.block = (this.block + 1) & 0xffff;
    const buf = Buffer.alloc(4 + this.blksize);
    buf.writeUInt16BE(OP.DATA, 0);
    buf.writeUInt16BE(this.block, 2);
    const n = fs.readSync(this.fd, buf, 4, this.blksize, null);
    this.lastSize = n;
    this.pending = n;
    this.send(buf.subarray(0, 4 + n));
  }

  sendAck(block) {
    const b = Buffer.alloc(4);
    b.writeUInt16BE(OP.ACK, 0); b.writeUInt16BE(block, 2);
    this.send(b);
  }

  onMessage(m, rinfo) {
    // 마지막 ACK가 유실돼 장비가 마지막 블록을 다시 보내면 ACK만 다시 보냄
    if (this.finished) {
      if (this.kind === 'put' && m.length >= 4 && m.readUInt16BE(0) === OP.DATA && m.readUInt16BE(2) === this.block) {
        const b = Buffer.alloc(4); b.writeUInt16BE(OP.ACK, 0); b.writeUInt16BE(this.block, 2);
        this.sock.send(b, this.peer.port, this.peer.address);
      }
      return;
    }
    if (rinfo.address !== this.peer.address || rinfo.port !== this.peer.port) {
      this.sock.send(errorPacket(ERR.UNKNOWN_TID, 'Unknown transfer ID'), rinfo.port, rinfo.address);
      return;
    }
    if (m.length < 4) return;
    const op = m.readUInt16BE(0);
    if (op === OP.ERROR) return this.fail('장비가 전송을 취소: ' + m.slice(4, m.length - 1).toString('latin1'));
    this.retries = 0;
    if (this.kind === 'get' && op === OP.ACK) {
      const blk = m.readUInt16BE(2);
      if (this.state === 'oack') { if (blk !== 0) return; this.state = 'data'; return this.sendNextData(); }
      if (blk !== this.block) return; // 중복 ACK
      this.done += this.pending;
      this.progress();
      if (this.lastSize < this.blksize) return this.complete();
      return this.sendNextData();
    }
    if (this.kind === 'put' && op === OP.DATA) {
      const blk = m.readUInt16BE(2);
      const expected = (this.block + 1) & 0xffff;
      if (blk !== expected) { if (blk === this.block) this.sendAck(blk); return; }
      const data = m.subarray(4);
      if (this.server.maxBytes && this.done + data.length > this.server.maxBytes) {
        this.sock.send(errorPacket(ERR.DISK_FULL, 'File too large'), this.peer.port, this.peer.address);
        return this.fail('파일이 너무 큽니다');
      }
      fs.writeSync(this.fd, data);
      this.block = blk;
      this.done += data.length;
      this.state = 'data';
      this.sendAck(blk);
      this.progress();
      if (data.length < this.blksize) this.complete();
    }
  }

  progress() {
    const now = Date.now();
    if (this.lastEmit && now - this.lastEmit < 200) return;
    this.lastEmit = now;
    this.emit('progress');
  }

  cleanup(dallyMs = 0) {
    clearTimeout(this.timer);
    try { if (this.fd !== undefined) fs.closeSync(this.fd); } catch (_) {}
    this.fd = undefined;
    const close = () => { try { this.sock.close(); } catch (_) {} };
    if (dallyMs) setTimeout(close, dallyMs); else close();
    this.server.active.delete(this.id);
    this.server.touch();
  }

  complete() {
    if (this.finished) return;
    this.finished = true;
    this.cleanup(this.kind === 'put' ? 3000 : 0);
    if (this.kind === 'put') {
      try { if (fs.existsSync(this.full)) fs.unlinkSync(this.full); fs.renameSync(this.tmp, this.full); } catch (e) { return this.emit('error', '저장 실패: ' + e.message); }
    }
    this.emit('done');
  }

  fail(msg, quiet) {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    if (this.tmp) { try { fs.unlinkSync(this.tmp); } catch (_) {} }
    this.emit('error', msg);
    if (quiet) return;
  }

  abort() {
    try { this.sock.send(errorPacket(ERR.NOT_DEFINED, 'Server stopped'), this.peer.port, this.peer.address); } catch (_) {}
    this.fail('서버를 멈춰 중단했습니다.');
  }
}

class TftpServer extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.active = new Map();
    this.seq = 0;
    this.cfg = null;
    this.maxBytes = 4 * 1024 * 1024 * 1024; // 4GB
  }

  get running() { return !!this.sock; }

  status() {
    return { running: this.running, root: this.cfg ? this.cfg.root : '', port: this.cfg ? this.cfg.port : 69, allowRead: this.cfg ? this.cfg.allowRead : true, allowWrite: this.cfg ? this.cfg.allowWrite : true, ips: localIPs(), active: this.active.size };
  }

  start({ root, port = 69, allowRead = true, allowWrite = true, autoStopMin = 30 }) {
    return new Promise((resolve, reject) => {
      if (this.sock) this.stop();
      fs.mkdirSync(root, { recursive: true });
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      sock.on('message', (m, rinfo) => this.onRequest(m, rinfo));
      sock.once('error', (e) => {
        try { sock.close(); } catch (_) {}
        this.sock = null;
        reject(e.code === 'EADDRINUSE' ? new Error(`UDP ${port} 포트를 다른 프로그램(다른 TFTP 서버 등)이 쓰고 있습니다.`)
          : e.code === 'EACCES' ? new Error(`UDP ${port} 포트를 열 권한이 없습니다.`) : e);
      });
      sock.bind(port, '0.0.0.0', () => {
        this.sock = sock;
        this.cfg = { root, port, allowRead, allowWrite, autoStopMin };
        sock.on('error', () => {});
        this.touch();
        resolve(this.status());
      });
    });
  }

  /** 마지막 전송 후 일정 시간 아무 일 없으면 자동으로 멈춤 (열어둔 채 잊는 것 방지) */
  touch() {
    clearTimeout(this.idleTimer);
    if (!this.cfg || !this.cfg.autoStopMin) return;
    this.idleTimer = setTimeout(() => {
      if (this.active.size) return this.touch();
      this.stop();
      this.emit('stopped', `${this.cfg ? this.cfg.autoStopMin : ''}분 동안 전송이 없어 자동으로 멈췄습니다.`);
    }, this.cfg.autoStopMin * 60 * 1000);
  }

  stop() {
    clearTimeout(this.idleTimer);
    for (const t of [...this.active.values()]) t.abort();
    if (this.sock) { try { this.sock.close(); } catch (_) {} }
    this.sock = null;
  }

  onRequest(m, rinfo) {
    if (m.length < 4 || !this.cfg) return;
    const op = m.readUInt16BE(0);
    if (op !== OP.RRQ && op !== OP.WRQ) return;
    const req = parseRequest(m);
    const reply = (code, msg) => this.sock.send(errorPacket(code, msg), rinfo.port, rinfo.address);
    if (!req) return reply(ERR.ILLEGAL, 'Bad request');
    if (req.mode !== 'octet' && req.mode !== 'netascii') return reply(ERR.ILLEGAL, 'Only octet/netascii');
    const kind = op === OP.RRQ ? 'get' : 'put';
    const full = resolveInRoot(this.cfg.root, req.file);
    const note = (message) => this.emit('transfer', { id: ++this.seq, kind, file: req.file, peer: rinfo.address, done: 0, total: 0, status: 'error', message });
    if (!full) { reply(ERR.ACCESS, 'Access violation'); return note('허용되지 않는 경로라 거절했습니다.'); }
    if (kind === 'get' && !this.cfg.allowRead) { reply(ERR.ACCESS, 'Read not allowed'); return note('PC→장비 받기가 꺼져 있어 거절했습니다.'); }
    if (kind === 'put' && !this.cfg.allowWrite) { reply(ERR.ACCESS, 'Write not allowed'); return note('장비→PC 올리기가 꺼져 있어 거절했습니다.'); }
    if (kind === 'get' && (!fs.existsSync(full) || !fs.statSync(full).isFile())) { reply(ERR.NOT_FOUND, 'File not found'); return note('파일이 없습니다.'); }
    new Transfer(this, rinfo, req, kind, full).start();
  }
}

module.exports = { TftpServer, resolveInRoot, localIPs };
