'use strict';
/* 터미널 화면의 IP에서 바로 Ping / Traceroute (이 PC에서 실행)
 * - IP는 숫자로 검사한 뒤 다시 만든 문자열만 사용, 실행 파일은 절대 경로, 셸 없음 */
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const { spawn } = require('child_process');
const { ipToInt, intToIp } = require('./scanner');

const MAX_JOBS = 4;
const sys32 = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
function findBin(cands) {
  for (const c of cands) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {} }
  return null;
}

function command(kind, ip, opts = {}) {
  const win = process.platform === 'win32';
  if (kind === 'ping') {
    const bin = win ? findBin([sys32('PING.EXE')]) : findBin(['/sbin/ping', '/bin/ping', '/usr/bin/ping']);
    if (!bin) return null;
    if (win) return { bin, args: opts.continuous ? ['-t', '-4', ip] : ['-n', '4', '-4', ip] };
    return { bin, args: opts.continuous ? ['-n', ip] : ['-n', '-c', '4', ip] };
  }
  if (kind === 'trace') {
    if (win) { const bin = findBin([sys32('TRACERT.EXE')]); return bin && { bin, args: ['-d', '-w', '1000', '-h', '30', ip] }; }
    const bin = findBin(['/usr/sbin/traceroute', '/usr/bin/traceroute', '/usr/bin/tracepath', '/bin/tracepath']);
    if (!bin) return null;
    return { bin, args: /tracepath$/.test(bin) ? ['-n', ip] : ['-n', '-w', '1', '-m', '30', ip] };
  }
  return null;
}

class NetTools {
  constructor(send) {
    this.send = send;
    this.jobs = new Map(); // jobId → child
    this.seq = 0;
  }

  run(kind, ipText, opts = {}) {
    if (kind !== 'ping' && kind !== 'trace') return { ok: false, message: '잘못된 요청입니다.' };
    const n = typeof ipText === 'string' ? ipToInt(ipText) : null;
    if (n === null) return { ok: false, message: 'IP 주소 형식이 아닙니다.' };
    const ip = intToIp(n);
    if (this.jobs.size >= MAX_JOBS) return { ok: false, message: `동시에 ${MAX_JOBS}개까지 실행할 수 있습니다. 실행 중인 것을 멈추고 하세요.` };
    const cmd = command(kind, ip, { continuous: opts.continuous === true });
    if (!cmd) return { ok: false, message: kind === 'ping' ? 'ping 명령을 찾지 못했습니다.' : 'tracert(traceroute) 명령을 찾지 못했습니다.' };
    const id = 'job' + (++this.seq);
    let child;
    try {
      child = spawn(cmd.bin, cmd.args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return { ok: false, message: e.message }; }
    const dec = iconv.getDecoder(process.platform === 'win32' ? 'cp949' : 'utf8');
    const out = (d) => { const t = dec.write(d); if (t) this.send('tool:data', id, t); };
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    child.on('error', (e) => { this.send('tool:data', id, `\n실행 실패: ${e.message}\n`); });
    child.on('close', (code) => {
      this.jobs.delete(id);
      const tail = dec.end();
      if (tail) this.send('tool:data', id, tail);
      this.send('tool:exit', id, code);
    });
    // 계속 핑은 최대 1시간, 나머지는 3분 지나면 자동 정지
    const limit = opts.continuous ? 3600e3 : 180e3;
    setTimeout(() => { if (this.jobs.has(id)) this.stop(id); }, limit).unref();
    this.jobs.set(id, child);
    return { ok: true, id, command: `${path.basename(cmd.bin)} ${cmd.args.join(' ')}` };
  }

  stop(id) {
    const c = this.jobs.get(id);
    if (!c) return;
    try { c.kill(); } catch (_) {}
  }

  stopAll() { for (const id of [...this.jobs.keys()]) this.stop(id); }
}

module.exports = { NetTools };
