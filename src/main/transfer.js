'use strict';
// 터미널 안 파일 전송: ZMODEM(rz/sz 자동 감지), XMODEM / XMODEM-1K / YMODEM 보내기 (콘솔 펌웨어 업로드)
const fs = require('fs');
const path = require('path');
const Zmodem = require('zmodem.js/src/zmodem');

// ---------- 파일 이름 정리 (경로 탈출·금지 문자 차단) ----------
function safeFileName(name) {
  let n = String(name || 'file').split(/[\\/]/).pop();
  n = n.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '_').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
  return n.slice(0, 200) || 'file';
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

// ============================================================
// ZMODEM
// ============================================================
class ZmodemBridge {
  /**
   * @param {object} conn  Connection (emitText, rawWrite, mgr, tabId)
   */
  constructor(conn) {
    this.conn = conn;
    this.session = null;
    this.sentry = new Zmodem.Sentry({
      to_terminal: (octets) => conn.emitText(Buffer.from(octets)),
      sender: (octets) => conn.rawWrite(Buffer.from(octets)),
      on_retract: () => {},
      on_detect: (detection) => this.onDetect(detection),
    });
  }

  get active() { return !!this.session; }

  consume(buf) {
    try {
      this.sentry.consume(buf);
    } catch (e) {
      // 깨진 ZMODEM 데이터 → 세션 정리하고 화면으로 계속
      this.finish(false, 'ZMODEM 오류: ' + (e.message || e));
    }
  }

  progress(p) { this.conn.mgr.send('xfer:progress', this.conn.tabId, { proto: 'ZMODEM', ...p }); }

  finish(ok, message, extra = {}) {
    const s = this.session;
    this.session = null;
    if (s && !s.has_ended()) { try { s.abort(); } catch (_) {} }
    this.conn.mgr.send('xfer:done', this.conn.tabId, { proto: 'ZMODEM', ok, message, ...extra });
  }

  cancel() { if (this.session) this.finish(false, '사용자가 취소했습니다.'); }

  onDetect(detection) {
    const zs = detection.confirm();
    this.session = zs;
    if (zs.type === 'receive') this.receive(zs);
    else this.send(zs).catch((e) => this.finish(false, String(e.message || e)));
  }

  /** 장비에서 sz 실행 → 내 PC로 받기 */
  receive(zs) {
    const st = this.conn.mgr.store.getSettings();
    const dir = st.transferDir;
    const saved = [];
    let decided = null; // 처음 파일에서 한 번 물어봄
    fs.mkdirSync(dir, { recursive: true });

    zs.on('offer', async (xfer) => {
      const d = xfer.get_details();
      if (decided === null) {
        decided = await this.conn.mgr.ask('zmodem', this.conn.tabId, { name: d.name, size: d.size, dir });
      }
      if (!decided) { xfer.skip(); return; }
      const name = safeFileName(d.name);
      const target = uniquePath(dir, name);
      const fd = fs.openSync(target, 'w');
      let done = 0;
      this.progress({ dir: 'down', name, done, total: d.size || 0 });
      try {
        await xfer.accept({
          on_input: (payload) => {
            fs.writeSync(fd, Buffer.from(payload));
            done += payload.length;
            this.progress({ dir: 'down', name, done, total: d.size || done });
          },
        });
        saved.push(target);
      } finally {
        fs.closeSync(fd);
      }
    });
    zs.on('session_end', () => {
      if (this.session !== zs) return;
      if (decided === false) this.finish(false, '받기를 거절했습니다.');
      else this.finish(!zs.aborted(), zs.aborted() ? '전송이 중단되었습니다.' : `${saved.length}개 받음`, { files: saved, folder: dir });
    });
    zs.start();
  }

  /** 장비에서 rz 실행 → 내 PC 파일 보내기 */
  async send(zs) {
    const files = await this.conn.mgr.pickFiles(this.conn.tabId, 'ZMODEM으로 보낼 파일 선택 (장비에서 rz 실행됨)');
    if (!files || !files.length) {
      try { await zs.close(); } catch (_) { try { zs.abort(); } catch (__) {} }
      this.session = null;
      this.conn.mgr.send('xfer:done', this.conn.tabId, { proto: 'ZMODEM', ok: false, message: '보낼 파일을 고르지 않아 취소했습니다.' });
      return;
    }
    let bytesLeft = files.reduce((a, f) => a + fs.statSync(f).size, 0);
    for (let i = 0; i < files.length; i++) {
      if (this.session !== zs) return;
      const f = files[i];
      const st = fs.statSync(f);
      const name = path.basename(f);
      const xfer = await zs.send_offer({
        name, size: st.size, mtime: new Date(st.mtimeMs), files_remaining: files.length - i, bytes_remaining: bytesLeft,
      });
      bytesLeft -= st.size;
      if (!xfer) continue; // 장비가 건너뜀(이미 있음 등)
      const fd = fs.openSync(f, 'r');
      const chunk = Buffer.alloc(8192);
      let done = 0;
      try {
        for (;;) {
          if (this.session !== zs) return;
          const n = fs.readSync(fd, chunk, 0, chunk.length, null);
          if (!n) break;
          xfer.send(new Uint8Array(chunk.subarray(0, n)));
          done += n;
          this.progress({ dir: 'up', name, done, total: st.size });
          // 너무 한꺼번에 밀어넣지 않게 조금씩 쉬어감
          if (done % (64 * 1024) < 8192) await this.conn.waitDrain();
        }
      } finally { fs.closeSync(fd); }
      await xfer.end();
    }
    await zs.close();
    this.finish(true, `${files.length}개 보냄`);
  }
}

// ============================================================
// XMODEM / XMODEM-1K / YMODEM 보내기
// ============================================================
const SOH = 0x01, STX = 0x02, EOT = 0x04, ACK = 0x06, NAK = 0x15, CAN = 0x18, CRC_C = 0x43, SUB = 0x1a;

function crc16(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let k = 0; k < 8; k++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

class XmodemSender {
  /**
   * @param {object} conn   Connection
   * @param {string} file   보낼 파일
   * @param {'xmodem'|'xmodem1k'|'ymodem'} proto
   */
  constructor(conn, file, proto) {
    this.conn = conn;
    this.file = file;
    this.proto = proto;
    this.label = { xmodem: 'XMODEM', xmodem1k: 'XMODEM-1K', ymodem: 'YMODEM' }[proto] || 'XMODEM';
    this.data = fs.readFileSync(file);
    this.name = path.basename(file);
    this.state = 'wait-start';
    this.crc = true;
    this.blockNo = 1;
    this.offset = 0;
    this.retries = 0;
    this.cans = 0;
    this.timer = null;
    this.ended = false;
  }

  start() {
    this.conn.mgr.send('conn:info', this.conn.tabId, `${this.label} 보내기 준비: ${this.name} (${this.data.length.toLocaleString()} 바이트) — 장비가 받을 준비(C 또는 NAK)를 보내면 시작합니다.`);
    this.progress();
    this.arm(90000, () => this.fail('장비가 받을 준비를 하지 않았습니다 (90초). 장비에서 받기 명령을 먼저 실행하세요.'));
  }

  progress() {
    this.conn.mgr.send('xfer:progress', this.conn.tabId, { proto: this.label, dir: 'up', name: this.name, done: Math.min(this.offset, this.data.length), total: this.data.length });
  }

  arm(ms, fn) { clearTimeout(this.timer); this.timer = setTimeout(fn, ms); }

  fail(msg) { this.end(false, msg); }

  end(ok, msg) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    if (!ok) this.conn.rawWrite(Buffer.from([CAN, CAN, CAN, CAN, CAN]));
    this.conn.xfer = null;
    this.conn.mgr.send('xfer:done', this.conn.tabId, { proto: this.label, ok, message: msg });
  }

  cancel() { this.fail('사용자가 취소했습니다.'); }

  blockSize() {
    if (this.proto === 'xmodem') return 128;
    // 남은 양이 적으면 128바이트 블록으로 (대부분의 수신기가 지원)
    return this.data.length - this.offset <= 128 ? 128 : 1024;
  }

  makeBlock(no, payload, size, pad = SUB) {
    const body = Buffer.alloc(size, pad);
    payload.copy(body);
    const head = Buffer.from([size === 1024 ? STX : SOH, no & 0xff, 0xff - (no & 0xff)]);
    if (this.crc) {
      const c = crc16(body);
      return Buffer.concat([head, body, Buffer.from([c >> 8, c & 0xff])]);
    }
    let sum = 0;
    for (const b of body) sum = (sum + b) & 0xff;
    return Buffer.concat([head, body, Buffer.from([sum])]);
  }

  sendHeaderBlock(empty) {
    // YMODEM 0번 블록: "파일이름\0크기" (빈 블록이면 배치 끝)
    const payload = empty ? Buffer.alloc(0) : Buffer.from(`${this.name}\0${this.data.length}`, 'latin1');
    this.lastBlock = this.makeBlock(0, payload, 128, 0x00); // YMODEM 0번 블록은 NUL로 채움
    this.conn.rawWrite(this.lastBlock);
    this.arm(10000, () => this.retry());
  }

  sendData() {
    if (this.offset >= this.data.length) {
      this.state = 'eot';
      this.conn.rawWrite(Buffer.from([EOT]));
      this.arm(10000, () => this.retry());
      return;
    }
    const size = this.blockSize();
    const payload = this.data.subarray(this.offset, this.offset + size);
    this.curSize = payload.length;
    this.lastBlock = this.makeBlock(this.blockNo, payload, size);
    this.conn.rawWrite(this.lastBlock);
    this.arm(10000, () => this.retry());
  }

  retry() {
    if (++this.retries > 10) return this.fail('응답이 없어 중단했습니다 (재시도 10회).');
    if (this.state === 'eot') this.conn.rawWrite(Buffer.from([EOT]));
    else if (this.lastBlock) this.conn.rawWrite(this.lastBlock);
    this.arm(10000, () => this.retry());
  }

  onData(buf) {
    if (this.ended) return;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b === CAN) { if (++this.cans >= 2) return this.fail('장비가 전송을 취소했습니다.'); continue; }
      this.cans = 0;
      const lastOfChunk = i === buf.length - 1;
      switch (this.state) {
        case 'wait-start':
          // 화면 글자 속 'C'에 속지 않도록, 덩어리의 마지막 바이트로 온 C/NAK만 시작 신호로 봄
          if ((b === CRC_C || b === NAK) && lastOfChunk) {
            this.crc = b === CRC_C;
            if (this.proto === 'ymodem') { this.state = 'ymodem-hdr'; this.sendHeaderBlock(false); } else { this.state = 'data'; this.sendData(); }
          }
          break;
        case 'ymodem-hdr':
          if (b === ACK) { this.state = 'ymodem-wait-c'; this.retries = 0; this.arm(10000, () => { this.state = 'data'; this.sendData(); }); }
          else if (b === NAK) this.retry();
          break;
        case 'ymodem-wait-c':
          if (b === CRC_C) { this.state = 'data'; this.sendData(); }
          break;
        case 'data':
          if (b === ACK) {
            this.offset += this.curSize;
            this.blockNo = (this.blockNo + 1) & 0xff;
            this.retries = 0;
            this.progress();
            this.sendData();
          } else if (b === NAK) this.retry();
          break;
        case 'eot':
          if (b === ACK) {
            if (this.proto === 'ymodem') { this.state = 'ymodem-end'; this.retries = 0; this.arm(10000, () => this.end(true, '보내기 완료')); }
            else return this.end(true, '보내기 완료');
          } else if (b === NAK) this.conn.rawWrite(Buffer.from([EOT]));
          break;
        case 'ymodem-end':
          if (b === CRC_C) { this.state = 'ymodem-fin'; this.sendHeaderBlock(true); }
          break;
        case 'ymodem-fin':
          if (b === ACK) return this.end(true, '보내기 완료');
          break;
        default: break;
      }
    }
  }
}

module.exports = { ZmodemBridge, XmodemSender, safeFileName, uniquePath, crc16 };
