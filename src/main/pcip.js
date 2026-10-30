'use strict';
/* PC IP 바꾸기 — 이 PC 랜카드의 IPv4를 고정 IP / DHCP로 바꿈 (Windows)
 *
 * - 랜카드 목록: PowerShell(일반 권한)로 읽기만
 * - 바꾸기: 관리자 권한이 필요해서 UAC 확인을 한 번 받고, 그 안에서 System32\netsh.exe만 실행
 * - 화면에서 온 값은 여기서 전부 다시 검사(숫자·점만, 범위·같은 대역)하고, 랜카드는 번호(ifIndex)로만 지정
 *   → netsh에 들어가는 글자는 [a-z0-9.=]뿐이라 명령을 끼워 넣을 틈이 없음
 * - 바꾸기 전 설정을 저장해 두고 "되돌리기" 가능 */
const path = require('path');
const { execFile } = require('child_process');

const OCT = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCT}(\\.${OCT}){3}$`);
const toInt = (ip) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0) >>> 0;
const fromInt = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
const maskOf = (prefix) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

/** "24", "/24", "255.255.255.0" → 접두사 길이 (틀리면 null) */
function parsePrefix(v) {
  const s = String(v == null ? '' : v).trim();
  let m = /^\/?(\d{1,2})$/.exec(s);
  if (m) { const p = Number(m[1]); return p >= 1 && p <= 32 ? p : null; }
  if (!IPV4.test(s)) return null;
  const n = toInt(s);
  const inv = (~n) >>> 0;
  if ((inv & (inv + 1)) !== 0) return null; // 1이 앞쪽에 연속이어야 마스크
  let p = 0;
  for (let i = 31; i >= 0; i--) { if ((n >>> i) & 1) p++; else break; }
  return p >= 1 ? p : null;
}

/** PC에 줄 수 있는 IPv4인지 (0.x, 127.x, 멀티캐스트 이상은 안 됨) */
function hostIp(v) {
  const s = String(v == null ? '' : v).trim();
  if (!IPV4.test(s)) return null;
  const first = Number(s.split('.')[0]);
  if (first === 0 || first === 127 || first >= 224) return null;
  return s;
}

/** 화면에서 온 고정 IP 설정 검사 → { ok, cfg } 또는 { ok:false, message } */
function validateStatic(req) {
  const ip = hostIp(req.ip);
  if (!ip) return { ok: false, message: 'IP 주소가 올바르지 않습니다. (예: 192.168.1.10)' };
  const prefix = parsePrefix(req.mask);
  if (!prefix) return { ok: false, message: '서브넷이 올바르지 않습니다. (예: 255.255.255.0 또는 24)' };
  const mask = maskOf(prefix);
  const net = (toInt(ip) & mask) >>> 0;
  const bcast = (net | (~mask >>> 0)) >>> 0;
  if (prefix <= 30 && (toInt(ip) === net || toInt(ip) === bcast)) return { ok: false, message: `${ip}/${prefix}는 대역의 네트워크 주소나 브로드캐스트 주소라 PC에 줄 수 없습니다.` };
  let gw = '';
  if (String(req.gw || '').trim()) {
    gw = hostIp(req.gw);
    if (!gw) return { ok: false, message: '게이트웨이 주소가 올바르지 않습니다. 없으면 비워두세요.' };
    if (gw === ip) return { ok: false, message: '게이트웨이가 PC IP와 같습니다.' };
    if (((toInt(gw) & mask) >>> 0) !== net) return { ok: false, message: `게이트웨이 ${gw}가 ${fromInt(net)}/${prefix} 대역 밖입니다.` };
  }
  const dns = [];
  for (const d of [req.dns1, req.dns2]) {
    if (!String(d || '').trim()) continue;
    const x = hostIp(d);
    if (!x) return { ok: false, message: `DNS 주소(${String(d).slice(0, 40)})가 올바르지 않습니다.` };
    if (!dns.includes(x)) dns.push(x);
  }
  return { ok: true, cfg: { ip, prefix, mask: fromInt(mask), gw, dns } };
}

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const winPath = (...p) => path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...p);
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');

// 랜카드 목록 (한글 이름이 깨지지 않게 ASCII 밖 글자는 \uXXXX로 내보냄)
const LIST_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$list = @(Get-NetAdapter | Sort-Object -Property ifIndex | ForEach-Object {
  $i = $_.ifIndex
  $ipif = Get-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4
  [pscustomobject]@{
    index  = [int]$i
    name   = [string]$_.Name
    desc   = [string]$_.InterfaceDescription
    status = [string]$_.Status
    mac    = [string]$_.MacAddress
    bound  = [bool]$ipif
    dhcp   = [string]$ipif.Dhcp
    addrs  = @(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 | ForEach-Object { '{0}/{1}/{2}/{3}' -f $_.IPAddress, $_.PrefixLength, $_.AddressState, $_.PrefixOrigin })
    gw     = @(Get-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' | ForEach-Object { [string]$_.NextHop } | Select-Object -Unique)
    dns    = @((Get-DnsClientServerAddress -InterfaceIndex $i -AddressFamily IPv4).ServerAddresses)
  }
})
$json = ConvertTo-Json -InputObject $list -Depth 4 -Compress
$out = ''
foreach ($c in $json.ToCharArray()) { $n = [int]$c; if ($n -gt 126) { $out += ('\\u{0:x4}' -f $n) } else { $out += $c } }
$out
`;

/** 관리자 권한으로 돌릴 스크립트: netsh만, 정해진 인자만. soft 단계는 실패해도 계속 */
function buildApplyScript(index, plan, netshPath = winPath('netsh.exe')) {
  const lines = [
    `$n = ${psQuote(netshPath)}`,
    // 이름 주의: R, S 같은 짧은 이름은 PowerShell 기본 별칭(r = Invoke-History)이 먼저 잡힘
    'function Invoke-OiNetshStep([int]$s, [string[]]$a) { & $n @a | Out-Null; if ($LASTEXITCODE -ne 0) { exit (10 + $s) } }',
    'function Invoke-OiNetshSoft([string[]]$a) { & $n @a | Out-Null }',
  ];
  let step = 0;
  for (const st of plan) {
    for (const a of st.args) if (!/^[a-z0-9.=/]+$/.test(a)) throw new Error('잘못된 인자: ' + a);
    const list = `@(${st.args.map((a) => `'${a}'`).join(',')})`;
    lines.push(st.soft ? `Invoke-OiNetshSoft ${list}` : `Invoke-OiNetshStep ${++step} ${list}`);
  }
  lines.push('exit 0');
  return lines.join('\n');
}

/** UAC로 관리자 PowerShell을 띄워 위 스크립트를 실행하고 끝날 때까지 기다리는 스크립트 */
function buildElevateScript(innerScript, psPath = winPath('WindowsPowerShell', 'v1.0', 'powershell.exe')) {
  return [
    'try {',
    `  $p = Start-Process -FilePath ${psQuote(psPath)} -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand','${encode(innerScript)}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru`,
    '  exit $p.ExitCode',
    '} catch {',
    '  $e = $_.Exception',
    '  while ($e) { if ($e.NativeErrorCode -eq 1223) { exit 1223 }; $e = $e.InnerException }',
    '  exit 2',
    '}',
  ].join('\n');
}

/** netsh 순서 만들기 (ifIndex 숫자로만 지정). [{ args, soft }] — 단계 번호는 soft 아닌 것만 셈 */
function buildPlan(index, cfg, current) {
  const name = `name=${index}`;
  const R = (...args) => ({ args });
  if (cfg.mode === 'dhcp') {
    const p = [];
    if (!current || current.dhcp !== 'Enabled') {
      // 고정 → DHCP: 예전 고정 게이트웨이가 남는 경우가 있어 먼저 지움 (없으면 실패해도 그만)
      if (current && current.gw && current.gw.length) p.push({ args: ['interface', 'ipv4', 'delete', 'route', 'prefix=0.0.0.0/0', `interface=${index}`], soft: true });
      p.push(R('interface', 'ipv4', 'set', 'address', name, 'source=dhcp'));
    }
    p.push(R('interface', 'ipv4', 'set', 'dnsservers', name, 'source=dhcp'));
    return p;
  }
  const p = [R('interface', 'ipv4', 'set', 'address', name, 'source=static', `address=${cfg.ip}`, `mask=${cfg.mask}`, `gateway=${cfg.gw || 'none'}`)];
  if (cfg.dns.length) {
    p.push(R('interface', 'ipv4', 'set', 'dnsservers', name, 'source=static', `address=${cfg.dns[0]}`, 'register=primary', 'validate=no'));
    cfg.dns.slice(1).forEach((d, i) => p.push(R('interface', 'ipv4', 'add', 'dnsservers', name, `address=${d}`, `index=${i + 2}`, 'validate=no')));
  } else {
    p.push(R('interface', 'ipv4', 'set', 'dnsservers', name, 'source=static', 'address=none', 'register=primary', 'validate=no'));
  }
  return p;
}

/** PowerShell 결과 → 화면용 랜카드 정보 */
function normalize(raw) {
  return arr(raw).filter((a) => a && Number.isInteger(a.index)).map((a) => ({
    index: a.index,
    name: String(a.name || ''),
    desc: String(a.desc || ''),
    status: String(a.status || ''),
    mac: String(a.mac || ''),
    bound: a.bound !== false,
    dhcp: String(a.dhcp || ''),
    addrs: arr(a.addrs).map((s) => { const [ip, prefix, state, origin] = String(s).split('/'); return { ip, prefix: Number(prefix), state: state || '', origin: origin || '' }; })
      .filter((x) => IPV4.test(x.ip)),
    gw: arr(a.gw).map(String).filter((g) => IPV4.test(g) && g !== '0.0.0.0'),
    dns: arr(a.dns).map(String).filter((d) => IPV4.test(d)),
  }));
}

const STATE_KO = { Up: '연결됨', Disconnected: '케이블 빠짐', Disabled: '사용 안 함', 'Not Present': '장치 없음' };

class PcIp {
  /** runPs(script, { elevated }) → Promise<{ code, stdout }> (시험할 때 바꿔 끼움) */
  constructor({ store, runPs }) {
    this.store = store;
    this.runPs = runPs || runPowerShell;
    this.adapters = [];
    this.busy = false;
  }

  supported() { return process.platform === 'win32' || this.runPs !== runPowerShell; }

  async list() {
    if (!this.supported()) return { ok: false, message: 'PC IP 바꾸기는 Windows에서만 됩니다.' };
    const r = await this.runPs(LIST_SCRIPT, { elevated: false });
    let raw;
    try { raw = JSON.parse(String(r.stdout || '').trim() || '[]'); } catch (_) {
      return { ok: false, message: '랜카드 목록을 읽지 못했습니다. PowerShell이 막혀 있는 PC일 수 있습니다.' };
    }
    this.adapters = normalize(raw);
    return { ok: true, adapters: this.adapters, prev: this.prevAll() };
  }

  prevAll() {
    const p = this.store.data.pcipPrev;
    return p && typeof p === 'object' ? p : {};
  }

  /** 지금 설정을 "되돌리기"용으로 저장 (랜카드 이름 기준). 이미 있으면 처음 것을 그대로 둠 */
  snapshot(a) {
    const cur = a.addrs.find((x) => x.origin !== 'WellKnown' && x.origin !== 'RouterAdvertisement') || a.addrs[0];
    const snap = a.dhcp === 'Enabled' || !cur
      ? { mode: 'dhcp' }
      : { mode: 'static', ip: cur.ip, mask: String(cur.prefix), gw: a.gw[0] || '', dns1: a.dns[0] || '', dns2: a.dns[1] || '' };
    snap.savedAt = Date.now();
    return snap;
  }

  /** 성공한 뒤에만 기록: 처음 바꾸기 전 설정을 계속 들고 있다가, 원래대로 돌아오면 지움 */
  rememberAfter(name, before, cfg) {
    if (!this.store.data.pcipPrev || typeof this.store.data.pcipPrev !== 'object') this.store.data.pcipPrev = {};
    const p = this.store.data.pcipPrev;
    if (!p[name]) p[name] = before;
    const o = p[name];
    const back = cfg.mode === 'dhcp' ? o.mode === 'dhcp' : (o.mode === 'static' && o.ip === cfg.ip && Number(o.mask) === cfg.prefix);
    if (back) delete p[name];
    this.store.save();
  }

  /** req = { index, mode:'dhcp'|'static', ip, mask, gw, dns1, dns2 } */
  async apply(req, { restoring = false } = {}) {
    if (!this.supported()) return { ok: false, message: 'PC IP 바꾸기는 Windows에서만 됩니다.' };
    if (!req || typeof req !== 'object') return { ok: false, message: '잘못된 요청입니다.' };
    if (this.busy) return { ok: false, message: '이미 바꾸는 중입니다.' };
    const index = Number(req.index);
    if (!Number.isInteger(index) || index < 1 || index > 1e6) return { ok: false, message: '랜카드를 고르세요.' };
    let cfg;
    if (req.mode === 'dhcp') cfg = { mode: 'dhcp' };
    else if (req.mode === 'static') {
      const v = validateStatic(req);
      if (!v.ok) return v;
      cfg = { mode: 'static', ...v.cfg };
    } else return { ok: false, message: '자동(DHCP) 또는 고정 IP를 고르세요.' };

    this.busy = true;
    try {
      const listed = await this.list();
      if (!listed.ok) return listed;
      const a = this.adapters.find((x) => x.index === index);
      if (!a) return { ok: false, message: '고른 랜카드가 없어졌습니다. 목록을 새로 고치세요.' };
      if (!a.bound) return { ok: false, message: `"${a.name}"에는 IPv4가 꺼져 있습니다 (어댑터 속성에서 IPv4 켜기).` };
      const before = this.snapshot(a);

      const plan = buildPlan(index, cfg, a);
      const r = await this.runPs(buildElevateScript(buildApplyScript(index, plan)), { elevated: true });
      if (r.code === 1223) return { ok: false, cancelled: true, message: 'Windows 확인 창에서 취소했습니다. 바뀐 건 없습니다.' };
      if (r.code !== 0) {
        const labels = plan.filter((st) => !st.soft).map((st) => (st.args[3] === 'address' ? 'IP 주소' : 'DNS'));
        const step = r.code >= 11 && r.code <= 10 + labels.length ? r.code - 10 : 0;
        const what = step ? labels[step - 1] : '관리자 권한 실행';
        return { ok: false, message: `${what} 설정에 실패했습니다 (코드 ${r.code}). 관리자 권한이 없는 계정이거나 회사 정책으로 막혀 있을 수 있습니다.` };
      }

      if (!restoring) this.rememberAfter(a.name, before, cfg);
      // 실제로 바뀌었는지 다시 읽어서 확인
      await new Promise((res) => setTimeout(res, 1500));
      await this.list();
      const now = this.adapters.find((x) => x.index === index) || a;
      const out = { ok: true, adapter: now, prev: this.prevAll() };
      if (cfg.mode === 'dhcp') {
        out.message = `"${now.name}"을(를) 자동(DHCP)으로 바꿨습니다.` + (now.status === 'Up' ? '' : ` (지금 ${STATE_KO[now.status] || now.status} 상태라 IP는 연결되면 받습니다)`);
      } else {
        const got = now.addrs.find((x) => x.ip === cfg.ip);
        if (got && got.state === 'Duplicate') { out.warn = true; out.message = `${cfg.ip}를 이미 다른 장비가 쓰고 있습니다 (IP 충돌). 다른 IP로 바꾸세요.`; }
        else if (!got && now.status === 'Up') { out.warn = true; out.message = `설정은 보냈지만 ${cfg.ip}가 아직 안 보입니다. 잠시 뒤 새로 고쳐 확인하세요.`; }
        else out.message = `"${now.name}" → ${cfg.ip}/${cfg.prefix}${cfg.gw ? ' · 게이트웨이 ' + cfg.gw : ' · 게이트웨이 없음'}${cfg.dns.length ? ' · DNS ' + cfg.dns.join(', ') : ''}` + (now.status === 'Up' ? '' : ` (지금 ${STATE_KO[now.status] || now.status})`);
      }
      return out;
    } catch (e) {
      return { ok: false, message: 'IP를 바꾸지 못했습니다: ' + e.message };
    } finally {
      this.busy = false;
    }
  }

  /** 바꾸기 전 설정으로 */
  async restore(index) {
    const a = this.adapters.find((x) => x.index === Number(index));
    if (!a) return { ok: false, message: '랜카드를 고르세요.' };
    const snap = this.prevAll()[a.name];
    if (!snap) return { ok: false, message: '되돌릴 이전 설정이 없습니다.' };
    const r = await this.apply({ index: a.index, mode: snap.mode, ip: snap.ip, mask: snap.mask, gw: snap.gw, dns1: snap.dns1, dns2: snap.dns2 }, { restoring: true });
    if (r.ok) { delete this.store.data.pcipPrev[a.name]; this.store.save(); r.prev = this.prevAll(); }
    return r;
  }
}

/** PowerShell 실행 (System32 절대 경로, 셸 없이, 스크립트는 -EncodedCommand로) */
function runPowerShell(script, { elevated } = {}) {
  return new Promise((resolve) => {
    execFile(winPath('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)],
      { windowsHide: true, timeout: elevated ? 180000 : 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || '') }));
  });
}

module.exports = { PcIp, validateStatic, parsePrefix, hostIp, buildPlan, buildApplyScript, buildElevateScript, normalize, LIST_SCRIPT, encode };
