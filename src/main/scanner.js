'use strict';
/* IP 스캔: 핑 + TCP 포트 확인 + 이름(DNS)·배너·MAC·제조사 조회
 * - 외부 명령(ping/arp)은 절대 경로로만 실행하고 인자는 배열로 넘김 (셸 안 씀)
 * - 대상 IP는 사용자가 친 글자를 그대로 쓰지 않고 숫자로 바꾼 뒤 다시 만든 문자열만 사용 */
const net = require('net');
const dns = require('dns');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const MAX_HOSTS = 4096; // /20 한 개
const MAX_PORTS = 32;
const MAX_RUNNING = 2;
const DEFAULT_PORTS = '22,23,80,443,3389';
const BANNER_PORTS = new Set([22, 23]);

// ---------- 주소 ----------
const RE_IP = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function ipToInt(s) {
  const m = RE_IP.exec(String(s).trim());
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] * 16777216) + (o[1] << 16) + (o[2] << 8) + o[3]) >>> 0;
}
const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const maskOf = (prefix) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
// 0.x.x.x, 멀티캐스트/예약(224 이상)은 스캔하지 않음
const usable = (n) => { const a = n >>> 24; return a !== 0 && a < 224; };
function isPrivateInt(n) {
  const a = n >>> 24, b = (n >>> 16) & 255;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** "192.168.0.0/24, 10.1.1.1-50, 10.1.1.1-10.1.2.254, 172.16.0.5" → 숫자 목록 */
function parseTargets(text) {
  const tokens = (typeof text === 'string' ? text : '').slice(0, 4000).split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) return { error: '스캔할 대역을 입력하세요.' };
  if (tokens.length > 64) return { error: '대역은 한 번에 64개까지 넣을 수 있습니다.' };
  const seen = new Set();
  const list = [];
  const add = (a, b, tok) => {
    if (b < a) throw new Error(`"${tok}" 범위의 끝이 시작보다 작습니다.`);
    if (b - a + 1 + list.length > MAX_HOSTS) throw new Error(`한 번에 ${MAX_HOSTS}개(/20)까지만 스캔합니다. 대역을 나눠서 하세요.`);
    for (let n = a; n <= b; n++) {
      if (!usable(n) || seen.has(n)) continue;
      seen.add(n);
      list.push(n);
    }
  };
  try {
    for (const tok of tokens) {
      let m;
      if ((m = /^([\d.]+)\/(\d{1,2})$/.exec(tok))) {
        const ip = ipToInt(m[1]);
        const prefix = Number(m[2]);
        if (ip === null || prefix > 32) throw new Error(`"${tok}" 형식이 잘못됐습니다.`);
        if (prefix < 20) throw new Error(`/${prefix}는 너무 큽니다. /20(4096개)보다 작게 나눠서 하세요.`);
        const netw = (ip & maskOf(prefix)) >>> 0;
        const bc = (netw | (~maskOf(prefix) >>> 0)) >>> 0;
        if (prefix >= 31) add(netw, bc, tok); else add(netw + 1, bc - 1, tok); // 네트워크·브로드캐스트 주소 제외
      } else if ((m = /^([\d.]+)-([\d.]+)$/.exec(tok))) {
        const a = ipToInt(m[1]);
        let b = /^\d{1,3}$/.test(m[2]) && a !== null ? ((a & 0xffffff00) >>> 0) + Number(m[2]) : ipToInt(m[2]);
        if (a === null || b === null || (/^\d{1,3}$/.test(m[2]) && Number(m[2]) > 255)) throw new Error(`"${tok}" 형식이 잘못됐습니다.`);
        b >>>= 0;
        add(a, b, tok);
      } else {
        const ip = ipToInt(tok);
        if (ip === null) throw new Error(`"${tok}"는 IP 주소 형식이 아닙니다. (예: 192.168.0.0/24, 10.1.1.1-50)`);
        add(ip, ip, tok);
      }
    }
  } catch (e) {
    return { error: e.message };
  }
  if (!list.length) return { error: '스캔할 수 있는 주소가 없습니다.' };
  return { list, publicCount: list.filter((n) => !isPrivateInt(n)).length };
}

function parsePorts(text) {
  const out = [];
  const seen = new Set();
  for (const tok of (typeof text === 'string' ? text : '').slice(0, 500).split(/[\s,;]+/).filter(Boolean)) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(tok);
    if (!m) return { error: `포트 "${tok}" 형식이 잘못됐습니다. (예: 22,23,80,443 또는 8000-8010)` };
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || b < a) return { error: `포트 "${tok}" 범위가 잘못됐습니다. (1~65535)` };
    if (b - a + 1 > MAX_PORTS) return { error: `포트는 ${MAX_PORTS}개까지 넣을 수 있습니다.` };
    for (let p = a; p <= b; p++) if (!seen.has(p)) { seen.add(p); out.push(p); }
    if (out.length > MAX_PORTS) return { error: `포트는 ${MAX_PORTS}개까지 넣을 수 있습니다.` };
  }
  return { list: out };
}

/** 이 PC의 네트워크 (스캔 대역 추천용). /20보다 크면 내 IP가 속한 /24를 추천 */
function localNets() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = ipToInt(a.address);
      const mask = ipToInt(a.netmask);
      if (ip === null || mask === null || (ip >>> 16) === 0xa9fe) continue; // 169.254 자동 주소 제외
      let prefix = 0;
      for (let m = mask; m & 0x80000000; m = (m << 1) >>> 0) prefix++;
      const usePrefix = prefix < 24 ? 24 : prefix;
      out.push({ name, address: a.address, prefix, cidr: `${intToIp((ip & maskOf(usePrefix)) >>> 0)}/${usePrefix}` });
    }
  }
  return out;
}

// ---------- 제조사 (IEEE OUI) ----------
let OUI = null;
function vendorOf(mac) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) return '';
  if (parseInt(hex[1], 16) & 2) return '(랜덤/로컬 MAC)';
  if (!OUI) {
    try { OUI = JSON.parse(fs.readFileSync(path.join(__dirname, 'oui.json'), 'utf8')); } catch (_) { OUI = { v: [], p: {} }; }
  }
  for (const len of [9, 7, 6]) {
    const i = OUI.p[hex.slice(0, len)];
    if (i !== undefined) return OUI.v[i] || '';
  }
  return '';
}

// ---------- 외부 명령 ----------
const sys32 = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
function findBin(cands) {
  for (const c of cands) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {} }
  return null;
}
function pingBinary() {
  if (process.platform === 'win32') return findBin([sys32('PING.EXE')]);
  return findBin(['/sbin/ping', '/bin/ping', '/usr/bin/ping', '/usr/sbin/ping']);
}
function pingArgs(ip, t) {
  if (process.platform === 'win32') return ['-n', '1', '-w', String(t), '-4', ip];
  if (process.platform === 'darwin') return ['-n', '-c', '1', '-W', String(t), ip];
  return ['-n', '-c', '1', '-W', String(Math.max(1, Math.ceil(t / 1000))), ip];
}
/** ping 출력에서 TTL/시간 (영어·한글 Windows, 리눅스 모두). "TTL=" 이 없으면 응답 없음 */
function parsePing(out) {
  const ttl = /\bTTL=(\d{1,3})\b/i.exec(out);
  if (!ttl) return null;
  const tm = /(?:time|시간)\s*([=<])\s*([\d.]+)\s*ms/i.exec(out);
  if (!tm) return { ttl: Number(ttl[1]), rtt: null };
  const v = Number(tm[2]);
  return { ttl: Number(ttl[1]), rtt: tm[1] === '<' || v < 1 ? '<1' : String(Math.round(v)) };
}

/** arp -a (Windows 한글/영문), /proc/net/arp 출력 → Map(ip → mac) */
function parseArp(txt, map = new Map()) {
  for (const line of String(txt).split(/\r?\n/)) {
    const m = /(\d{1,3}(?:\.\d{1,3}){3})\b.*?\b([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})\b/i.exec(line);
    if (!m) continue;
    const mac = m[2].toLowerCase().replace(/-/g, ':');
    if (/^(ff:ff:ff:ff:ff:ff|00:00:00:00:00:00|01:00:5e)/.test(mac)) continue;
    map.set(m[1], mac);
  }
  return map;
}

function readArp() {
  return new Promise((resolve) => {
    const map = new Map();
    const parse = (txt) => parseArp(txt, map);
    if (process.platform === 'linux') {
      try { parse(fs.readFileSync('/proc/net/arp', 'utf8')); } catch (_) {}
      resolve(map);
      return;
    }
    const bin = process.platform === 'win32' ? sys32('ARP.EXE') : '/usr/sbin/arp';
    const args = process.platform === 'win32' ? ['-a'] : ['-an'];
    execFile(bin, args, { windowsHide: true, timeout: 8000, encoding: 'latin1', maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (out) parse(out);
      resolve(map);
    });
  });
}

// ---------- 배너 ----------
/** 텔넷 협상(IAC) 바이트와 제어 문자를 지우고 보이는 첫 줄만 (최대 100자) */
function bannerText(buf, port) {
  const bytes = [];
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0xff && port === 23) {
      const cmd = buf[i + 1];
      if (cmd >= 251 && cmd <= 254) { i += 2; continue; }
      if (cmd === 250) { while (i < buf.length && !(buf[i] === 0xff && buf[i + 1] === 240)) i++; i++; continue; }
      i++;
      continue;
    }
    bytes.push(c);
  }
  const text = Buffer.from(bytes).toString('latin1').replace(/[^\x20-\x7e\n]/g, '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (port === 23 ? lines.slice(0, 2).join(' / ') : (lines[0] || '')).slice(0, 100);
}

const cleanName = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 253);

// ---------- 스캔 1회 ----------
class Scan extends EventEmitter {
  constructor(opts) {
    super();
    this.targets = opts.targets;
    this.ports = opts.ports;
    this.timeout = opts.timeout;
    this.concurrency = opts.concurrency;
    this.useDns = opts.dns;
    this.portsWhenNoPing = opts.portsWhenNoPing;
    this.results = new Map();
    this.procs = new Set();
    this.socks = new Set();
    this.cancelled = false;
    this.done = 0;
    this.lastProgress = 0;
    this.selfIPs = new Set(localNets().map((n) => n.address));
    this.resolver = new dns.promises.Resolver({ timeout: 1500, tries: 1 });
  }

  async run() {
    const started = Date.now();
    this.pingBin = pingBinary();
    if (!this.pingBin) {
      this.portsWhenNoPing = true;
      this.emit('warn', 'ping 명령을 찾지 못해 포트 응답으로만 찾습니다.');
    }
    let next = 0;
    const worker = async () => {
      while (!this.cancelled && next < this.targets.length) {
        const n = this.targets[next++];
        try { await this.scanHost(n); } catch (_) {}
        this.done++;
        this.progress(false);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, this.targets.length) }, worker));
    if (!this.cancelled && this.results.size) {
      const arp = await readArp();
      for (const r of this.results.values()) {
        const mac = arp.get(r.ip);
        if (!mac) continue;
        r.mac = mac;
        r.vendor = vendorOf(mac);
        this.emit('host', r);
      }
    }
    this.progress(true);
    this.emit('done', { cancelled: this.cancelled, alive: this.results.size, total: this.targets.length, elapsed: Date.now() - started });
  }

  progress(force) {
    const now = Date.now();
    if (!force && now - this.lastProgress < 150) return;
    this.lastProgress = now;
    this.emit('progress', { done: this.done, total: this.targets.length, alive: this.results.size });
  }

  async scanHost(n) {
    const ip = intToIp(n);
    const r = { ip, alive: false, via: '', rtt: null, ttl: null, name: '', ports: [], banner: '', mac: '', vendor: '', self: this.selfIPs.has(ip) };
    if (this.pingBin) {
      const p = await this.ping(ip);
      if (p) Object.assign(r, { alive: true, via: 'ping', ttl: p.ttl, rtt: p.rtt });
    }
    if (this.cancelled) return;
    if (this.ports.length && (r.alive || this.portsWhenNoPing)) {
      for (let i = 0; i < this.ports.length && !this.cancelled; i += 8) {
        const chunk = this.ports.slice(i, i + 8);
        const res = await Promise.all(chunk.map((port) => this.probe(ip, port)));
        res.forEach((x, k) => {
          if (x.state === 'open') {
            r.ports.push(chunk[k]);
            if (x.banner && !r.banner) r.banner = x.banner;
          }
          // 닫힌 포트(RST)도 "장비가 살아 있다"는 뜻
          if ((x.state === 'open' || x.state === 'closed') && !r.alive) Object.assign(r, { alive: true, via: 'tcp' });
        });
      }
    }
    if (!r.alive || this.cancelled) return;
    if (this.useDns) r.name = await this.reverse(ip);
    this.results.set(ip, r);
    this.emit('host', r);
  }

  ping(ip) {
    return new Promise((resolve) => {
      let out = '';
      let fin = false;
      let child;
      const end = (v) => {
        if (fin) return;
        fin = true;
        clearTimeout(timer);
        this.procs.delete(child);
        resolve(v);
      };
      const timer = setTimeout(() => { try { child.kill(); } catch (_) {} end(null); }, this.timeout + 2500);
      try {
        child = spawn(this.pingBin, pingArgs(ip, this.timeout), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], shell: false });
      } catch (_) { end(null); return; }
      this.procs.add(child);
      child.stdout.on('data', (d) => { if (out.length < 4096) out += d.toString('latin1'); });
      child.on('error', () => end(null));
      child.on('close', () => end(parsePing(out)));
    });
  }

  probe(ip, port) {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      let fin = false;
      let connected = false;
      let buf = Buffer.alloc(0);
      let timer;
      const end = (v) => {
        if (fin) return;
        fin = true;
        clearTimeout(timer);
        this.socks.delete(sock);
        sock.destroy();
        resolve(v);
      };
      this.socks.add(sock);
      timer = setTimeout(() => end({ state: 'timeout' }), this.timeout);
      sock.once('connect', () => {
        connected = true;
        if (!BANNER_PORTS.has(port)) { end({ state: 'open' }); return; }
        clearTimeout(timer);
        timer = setTimeout(() => end({ state: 'open', banner: bannerText(buf, port) }), 1200);
        sock.on('data', (d) => {
          buf = Buffer.concat([buf, d]).subarray(0, 1024);
          if ((port === 22 && buf.includes(10)) || buf.length >= 512) end({ state: 'open', banner: bannerText(buf, port) });
        });
      });
      sock.once('error', (e) => end(connected ? { state: 'open', banner: bannerText(buf, port) } : { state: e.code === 'ECONNREFUSED' ? 'closed' : 'filtered' }));
      sock.once('close', () => end(connected ? { state: 'open', banner: bannerText(buf, port) } : { state: 'filtered' }));
      sock.connect({ host: ip, port });
    });
  }

  async reverse(ip) {
    try {
      const names = await Promise.race([
        this.resolver.reverse(ip),
        new Promise((res) => setTimeout(() => res([]), 2500)),
      ]);
      return cleanName(names && names[0]);
    } catch (_) { return ''; }
  }

  stop() {
    this.cancelled = true;
    for (const c of this.procs) { try { c.kill(); } catch (_) {} }
    for (const s of this.socks) s.destroy();
    try { this.resolver.cancel(); } catch (_) {}
  }
}

// ---------- 관리 ----------
class ScanManager {
  constructor(send) {
    this.send = send;
    this.scans = new Map(); // tabId → Scan
  }

  preview(targets) {
    const t = parseTargets(targets);
    if (t.error) return { ok: false, message: t.error };
    return { ok: true, total: t.list.length, publicCount: t.publicCount };
  }

  start(tabId, opts = {}) {
    if (typeof tabId !== 'string' || !tabId || tabId.length > 100) return { ok: false, message: '잘못된 요청입니다.' };
    if (typeof opts.targets !== 'string' || (opts.ports !== undefined && typeof opts.ports !== 'string')) return { ok: false, message: '잘못된 요청입니다.' };
    const t = parseTargets(opts.targets);
    if (t.error) return { ok: false, message: t.error };
    if (t.publicCount && opts.allowPublic !== true) return { ok: false, needConfirm: 'public', message: '사설 IP가 아닌 주소가 들어 있습니다.' };
    const p = parsePorts(opts.ports === undefined ? DEFAULT_PORTS : opts.ports);
    if (p.error) return { ok: false, message: p.error };
    const prev = this.scans.get(tabId);
    if (prev) prev.stop();
    const running = [...this.scans.values()].filter((s) => !s.finished).length;
    if (running >= MAX_RUNNING) return { ok: false, message: `스캔은 동시에 ${MAX_RUNNING}개까지 돌릴 수 있습니다. 다른 스캔이 끝나면 하세요.` };
    const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
    const scan = new Scan({
      targets: t.list,
      ports: p.list,
      timeout: clamp(opts.timeout, 200, 5000, 1000),
      concurrency: clamp(opts.concurrency, 1, 128, 64),
      dns: opts.dns !== false,
      portsWhenNoPing: opts.portsWhenNoPing === true,
    });
    this.scans.set(tabId, scan);
    scan.on('host', (r) => this.send('scan:host', tabId, r));
    scan.on('progress', (pr) => this.send('scan:progress', tabId, pr));
    scan.on('warn', (m) => this.send('scan:warn', tabId, m));
    scan.on('done', (d) => { scan.finished = true; this.send('scan:done', tabId, d); });
    scan.run().catch((e) => { scan.finished = true; this.send('scan:done', tabId, { error: e.message }); });
    return { ok: true, total: t.list.length, ports: p.list };
  }

  stop(tabId) {
    const s = this.scans.get(tabId);
    if (s) s.stop();
  }

  forget(tabId) {
    this.stop(tabId);
    this.scans.delete(tabId);
  }

  stopAll() { for (const s of this.scans.values()) s.stop(); }

  results(tabId) {
    const s = this.scans.get(tabId);
    if (!s) return [];
    return [...s.results.values()].sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
  }
}

// ---------- CSV ----------
/** 엑셀에서 =,+,-,@ 로 시작하는 칸이 수식으로 실행되지 않게 앞에 ' 를 붙임 */
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows) {
  const head = ['IP', '응답(ms)', 'TTL', '이름(DNS)', 'MAC', '제조사', '열린 포트', '배너', '확인 방법'];
  const lines = [head, ...rows.map((r) => [r.ip, r.rtt, r.ttl, r.name, r.mac, r.vendor, (r.ports || []).join(' '), r.banner, r.via === 'ping' ? '핑' : 'TCP'])];
  return '\ufeff' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { ScanManager, parseArp, parseTargets, parsePorts, parsePing, bannerText, vendorOf, localNets, readArp, toCsv, csvCell, ipToInt, intToIp, DEFAULT_PORTS };
