'use strict';
/* 스마트 링크: 터미널 화면의 IP / MAC / URL을 알아보고 밑줄 → Ctrl+클릭(또는 우클릭)으로 메뉴
 * IP: Ping, Traceroute, SSH/Telnet/웹 접속, IP 스캔, 장비에서 ARP 찾기
 * MAC: 제조사(OUI), MAC 테이블 찾기 명령 입력, 형식 바꿔 복사 */

const OCT = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const SMART_RE = new RegExp([
  '(?<url>https?:\\/\\/[^\\s<>"\'`]{2,}[^\\s<>"\'`.,;:!?)\\]])',
  `(?<ip>(?<![\\w.])${OCT}(?:\\.${OCT}){3}(?:\\/(?:3[0-2]|[12]?\\d)(?!\\d))?(?!\\d|\\.\\d))`,
  '(?<mac>(?<![\\w.:-])(?:[0-9a-f]{4}\\.[0-9a-f]{4}\\.[0-9a-f]{4}|[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}|[0-9a-f]{2}:[0-9a-f]{2}(?::[0-9a-f]{2}){4}|[0-9a-f]{2}-[0-9a-f]{2}(?:-[0-9a-f]{2}){4})(?![\\w:-]|\\.[0-9a-f]))',
].join('|'), 'gi');

const SMART_HINT = 'Ctrl+클릭(또는 우클릭): Ping · 접속 · 스캔 메뉴';

/** 화면 한 줄 → 글자와, 글자 위치 → 칸 위치 표 (한글 같은 두 칸 글자 때문에 따로 셈) */
function smartLineCells(line, cols) {
  let str = '';
  const map = [];
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue;
    const ch = cell.getChars() || ' ';
    for (let k = 0; k < ch.length; k++) map.push(x);
    str += ch;
  }
  return { str, map };
}

/** 텍스트 안의 스마트 링크 찾기 (테스트용으로도 씀) */
function smartFind(str) {
  const out = [];
  SMART_RE.lastIndex = 0;
  let m;
  while ((m = SMART_RE.exec(str))) {
    const g = m.groups;
    out.push({ kind: g.url ? 'url' : g.ip ? 'ip' : 'mac', text: m[0], index: m.index });
    if (m[0].length === 0) SMART_RE.lastIndex++;
  }
  return out;
}

function macHex(mac) { return String(mac).replace(/[^0-9a-f]/gi, '').toLowerCase(); }
function macFormats(mac) {
  const x = macHex(mac);
  const pairs = x.match(/../g) || [];
  return { cisco: `${x.slice(0, 4)}.${x.slice(4, 8)}.${x.slice(8, 12)}`, colon: pairs.join(':'), dash: pairs.join('-').toUpperCase() };
}

function fillTemplate(tpl, v) {
  return String(tpl || '').replace(/\{(ip|mac|mac:|mac-)\}/g, (_, k) => (v[k] !== undefined ? v[k] : ''));
}

/** TermTab에 링크 인식 붙이기 */
function attachSmartLinks(tab) {
  const term = tab.term;
  term.registerLinkProvider({
    provideLinks(y, cb) {
      if (tab.app.settings.smartLinks === false) { cb(undefined); return; }
      const line = term.buffer.active.getLine(y - 1);
      if (!line) { cb(undefined); return; }
      const { str, map } = smartLineCells(line, term.cols);
      const links = smartFind(str).map((f) => {
        const end = f.index + f.text.length - 1;
        return {
          range: { start: { x: map[f.index] + 1, y }, end: { x: map[end] + 1, y } },
          text: f.text,
          decorations: { underline: true, pointerCursor: false },
          activate: (e) => { if (e.ctrlKey || e.metaKey) tab.smartMenu(e, f.kind, f.text); },
          hover: () => { tab.hoverLink = { kind: f.kind, text: f.text }; tab.host.title = SMART_HINT; },
          leave: () => { if (tab.hoverLink && tab.hoverLink.text === f.text) tab.hoverLink = null; tab.host.title = ''; },
        };
      });
      cb(links.length ? links : undefined);
    },
  });
}

/** 스마트 메뉴 항목 */
async function smartMenuItems(tab, kind, text) {
  const app = tab.app;
  const st = app.settings;
  const copy = (v, label) => ({ label, action: () => { window.api.clipWrite(v); toast('복사: ' + v); } });
  const canType = tab.state === 'connected';
  if (kind === 'ip') {
    const ip = text.split('/')[0];
    const cidr = text.includes('/') ? text : null;
    const net24 = ip.replace(/\.\d+$/, '.0/24');
    const cmd = fillTemplate(st.smartIpCmd ?? 'show ip arp {ip}', { ip });
    return [
      { label: `Ping ${ip}`, action: () => ToolDock.run('ping', ip) },
      { label: 'Ping 계속 (멈출 때까지)', action: () => ToolDock.run('ping', ip, { continuous: true }) },
      { label: 'Traceroute', action: () => ToolDock.run('trace', ip) },
      '-',
      { label: 'SSH로 새 탭', action: () => app.openHost('ssh', ip) },
      { label: 'Telnet으로 새 탭', action: () => app.openHost('telnet', ip) },
      { label: '웹 열기 (HTTPS)', action: () => app.openHost('https', ip) },
      { label: '웹 열기 (HTTP)', action: () => app.openHost('http', ip) },
      '-',
      { label: `IP 스캔: ${ip}`, action: () => app.openScan(ip, { start: true }) },
      { label: `대역 스캔: ${cidr || net24}`, action: () => app.openScan(cidr || net24) },
      { label: `내 PC IP를 이 대역으로… (${ip.replace(/\.\d+$/, '.x')}/24)`, action: () => PcIpUI.open({ forDevice: ip }) },
      '-',
      cmd.trim() ? { label: `장비에 입력: ${cmd}`, disabled: !canType, action: () => tab.typeText(cmd) } : null,
      copy(ip, 'IP 복사'),
      cidr ? copy(cidr, `복사: ${cidr}`) : null,
    ];
  }
  if (kind === 'mac') {
    const f = macFormats(text);
    const vendor = await window.api.macVendor(f.colon);
    const cmd = fillTemplate(st.smartMacCmd ?? 'show mac address-table address {mac}', { mac: f.cisco, 'mac:': f.colon, 'mac-': f.dash });
    return [
      { info: true, label: `제조사: ${vendor || '알 수 없음 (목록에 없음)'}` },
      '-',
      cmd.trim() ? { label: `장비에 입력: ${cmd}`, disabled: !canType, action: () => tab.typeText(cmd) } : null,
      copy(f.cisco, `복사 (시스코): ${f.cisco}`),
      copy(f.colon, `복사 (콜론): ${f.colon}`),
      copy(f.dash, `복사 (하이픈): ${f.dash}`),
    ];
  }
  // URL
  return [
    { label: '웹 탭으로 열기', action: () => app.openUrl(text) },
    { label: '브라우저로 열기', action: () => window.api.openExternal(text) },
    copy(text, '주소 복사'),
  ];
}

/* ---------- 아래쪽 도구 창 (Ping / Traceroute 결과) ---------- */
const ToolDock = {
  job: null,
  el() { return $('#tooldock'); },

  bind() {
    $('#td-stop').onclick = () => this.stop();
    $('#td-again').onclick = () => { if (this.job) this.run(this.job.kind, this.job.ip, this.job.opts); };
    $('#td-copy').onclick = () => { window.api.clipWrite($('#td-out').textContent); toast('결과를 복사했습니다.'); };
    $('#td-close').onclick = () => { this.stop(); this.el().hidden = true; App.focusActive(); };
    window.api.onToolData((id, t) => this.onData(id, t));
    window.api.onToolExit((id, code) => this.onExit(id, code));
  },

  async run(kind, ip, opts = {}) {
    if (this.job && this.job.running) window.api.toolStop(this.job.id);
    const r = await window.api.toolRun(kind, ip, opts);
    if (!r.ok) { toast(r.message, 'err'); return; }
    this.job = { id: r.id, kind, ip, opts, running: true };
    this.el().hidden = false;
    $('#td-out').textContent = `> ${r.command}\n`;
    this.title();
    App.fitAll && App.fitAll();
  },

  title() {
    const j = this.job;
    if (!j) return;
    $('#td-title').textContent = `${j.kind === 'ping' ? 'Ping' : 'Traceroute'} ${j.ip}${j.opts.continuous ? ' (계속)' : ''} — ${j.running ? '실행 중' : '끝남'}`;
    $('#td-stop').disabled = !j.running;
  },

  onData(id, text) {
    if (!this.job || id !== this.job.id) return;
    const out = $('#td-out');
    out.textContent = (out.textContent + text.replace(/\r\n/g, '\n').replace(/\r/g, '')).slice(-200000);
    out.scrollTop = out.scrollHeight;
  },

  onExit(id) {
    if (!this.job || id !== this.job.id) return;
    this.job.running = false;
    this.title();
  },

  stop() { if (this.job && this.job.running) window.api.toolStop(this.job.id); },
};
