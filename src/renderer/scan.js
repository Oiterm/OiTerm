'use strict';
/* IP 스캔 탭: 대역 안에서 살아있는 장비와 열린 포트를 찾고, 결과에서 바로 접속 */

const SCAN_PORT_INFO = {
  21: ['FTP', 'ftp'], 22: ['SSH', 'ssh'], 23: ['Telnet', 'telnet'],
  80: ['HTTP', 'http'], 8000: ['HTTP', 'http'], 8080: ['HTTP', 'http'], 8888: ['HTTP', 'http'],
  443: ['HTTPS', 'https'], 4443: ['HTTPS', 'https'], 8443: ['HTTPS', 'https'],
  3389: ['RDP', 'rdp'], 445: ['SMB', null], 830: ['NETCONF', null], 161: ['SNMP', null],
};
function scanPortInfo(p) {
  if (SCAN_PORT_INFO[p]) return SCAN_PORT_INFO[p];
  if (p >= 5900 && p <= 5999) return ['VNC', 'vnc'];
  return ['', null];
}
function scanIpNum(ip) { return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0); }
function ttlHint(t) {
  if (!t) return '';
  if (t <= 64) return `TTL ${t} → 처음 값 64 추정: 리눅스 기반 장비·서버`;
  if (t <= 128) return `TTL ${t} → 처음 값 128 추정: Windows PC·서버`;
  return `TTL ${t} → 처음 값 255 추정: 네트워크 장비(Cisco IOS 등)`;
}

class ScanTab extends BaseTab {
  constructor(app, spec) {
    super(app, spec, 'scan');
    const s = app.settings;
    this.rows = new Map(); // ip → { r, el, n }
    this.running = false;
    this.scanPorts = [];

    this.target = h('input.inp.grow', {
      value: (spec.meta && spec.meta.target) || s.scanLastTarget || '',
      placeholder: '예) 192.168.0.0/24 , 10.1.1.1-50 , 10.1.1.1-10.1.2.254 (여러 개는 쉼표)',
      spellcheck: 'false',
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.toggle(); } },
    });
    this.netSel = h('select.inp.scan-net', { title: '이 PC가 붙어 있는 네트워크', onchange: () => { if (this.netSel.value) this.target.value = this.netSel.value; this.netSel.value = ''; } });
    this.ports = h('input.inp.scan-ports', { value: s.scanPorts ?? '22,23,80,443,3389', spellcheck: 'false', title: '쉼표로 구분, 8000-8010 같은 범위 가능 (최대 32개). 비우면 핑만 합니다.' });
    this.timeout = sel([[300, '0.3초'], [500, '0.5초'], [1000, '1초'], [2000, '2초']], s.scanTimeout || 1000);
    this.conc = sel([[16, '16'], [32, '32'], [64, '64'], [128, '128']], s.scanConcurrency || 64);
    this.optDns = h('input', { type: 'checkbox', checked: s.scanDns !== false });
    this.optNoPing = h('input', { type: 'checkbox', checked: !!s.scanNoPing });
    this.btn = h('button.btn.primary', { onclick: () => this.toggle() }, '스캔 시작');
    this.exportBtn = h('button.btn.sm', { onclick: () => this.exportCsv(), disabled: true }, 'CSV 저장');
    this.filter = h('input.inp.sm.scan-filter', { placeholder: '결과에서 찾기 (IP·이름·제조사·배너)', spellcheck: 'false', oninput: () => this.applyFilter() });
    this.bar = h('div.scan-bar-fill');
    this.sum = h('span.scan-sum', '대역을 넣고 스캔을 시작하세요. 결과를 두 번 누르면 바로 접속합니다.');
    this.tbody = h('tbody');
    this.empty = h('div.scan-empty', '아직 결과가 없습니다.');
    const th = (t, title) => h('th', { title }, t);
    this.table = h('table.scan-table',
      h('thead', h('tr', th(''), th('IP'), th('응답'), th('TTL', '64: 리눅스 기반 장비·서버 / 128: Windows / 255: Cisco IOS 등 네트워크 장비'),
        th('이름(DNS)'), th('MAC', '같은 대역(같은 VLAN)일 때만 보입니다'), th('제조사'), th('열린 포트', '누르면 바로 접속'), th('배너', 'SSH/Telnet 접속 시 장비가 먼저 보내는 글자'))),
      this.tbody);

    this.inputs = [this.target, this.netSel, this.ports, this.timeout, this.conc, this.optDns, this.optNoPing];
    this.body.classList.add('scan-body');
    this.body.append(h('div.scan-wrap',
      h('div.scan-top', this.target, this.netSel, this.btn),
      h('div.scan-opts',
        h('label', '포트'), this.ports,
        h('label', '대기'), this.timeout,
        h('label', '동시'), this.conc,
        h('label.chk', this.optDns, '이름 조회(DNS)'),
        h('label.chk', { title: '방화벽이 핑을 막는 장비도 찾습니다. 대신 느려집니다.' }, this.optNoPing, '핑 없어도 포트 확인'),
      ),
      h('div.scan-prog', this.bar),
      h('div.scan-mid', this.sum, h('span.grow'), this.filter, this.exportBtn),
      h('div.scan-list', this.table, this.empty),
      h('div.hint.scan-warn', '고객사 망에서는 방화벽·IPS가 스캔을 공격으로 보고 차단하거나 경보를 낼 수 있습니다. 허락받은 대역만, 동시 수는 낮게 하세요.'),
    ));
  }

  async connect() {
    if (this.netsLoaded) return;
    this.netsLoaded = true;
    const nets = await window.api.scanLocalNets();
    this.netSel.innerHTML = '';
    this.netSel.append(h('option', { value: '' }, nets.length ? '내 네트워크 ▾' : '네트워크 없음'));
    for (const n of nets) this.netSel.append(h('option', { value: n.cidr }, `${n.cidr}  (${n.name} · 내 IP ${n.address}${n.prefix < 24 ? ` · 원래 /${n.prefix}` : ''})`));
    if (!this.target.value && nets.length) this.target.value = nets[0].cidr;
  }

  focus() { if (!this.running) this.target.focus(); }
  disconnect() { if (this.running) window.api.scanStop(this.id); }

  async toggle() {
    if (this.running) { window.api.scanStop(this.id); this.btn.disabled = true; return; }
    const targets = this.target.value.trim();
    const pv = await window.api.scanPreview(targets);
    if (!pv.ok) { toast(pv.message, 'err'); return; }
    let allowPublic = false;
    if (pv.publicCount) {
      const ok = await confirmBox(`사설 IP가 아닌 주소가 ${pv.publicCount}개 들어 있습니다.\n관리하지 않는 인터넷 장비를 스캔하면 문제가 될 수 있습니다. 관리하는 장비가 맞을 때만 진행하세요.`, { title: '공인 IP 스캔 확인', ok: '스캔' });
      if (!ok) return;
      allowPublic = true;
    }
    if (pv.total > 1024) {
      const ok = await confirmBox(`${pv.total}개 주소를 스캔합니다. 시간이 걸리고 망에 부하가 갈 수 있습니다. 진행할까요?`, { title: '큰 대역 스캔', ok: '스캔' });
      if (!ok) return;
    }
    const opts = {
      targets, ports: this.ports.value, timeout: Number(this.timeout.value), concurrency: Number(this.conc.value),
      dns: this.optDns.checked, portsWhenNoPing: this.optNoPing.checked, allowPublic,
    };
    const r = await window.api.scanStart(this.id, opts);
    if (!r.ok) { toast(r.message, 'err'); return; }
    this.app.saveSettings({
      scanPorts: this.ports.value.trim(), scanTimeout: opts.timeout, scanConcurrency: opts.concurrency,
      scanDns: opts.dns, scanNoPing: opts.portsWhenNoPing, scanLastTarget: targets.slice(0, 300),
    });
    this.clear();
    this.scanPorts = r.ports || [];
    this.empty.textContent = '찾는 중…';
    const first = targets.split(/[\s,;]+/)[0];
    this.title = this.app.uniqueTitle('스캔 ' + first + (targets.includes(',') ? ' 외' : ''), this);
    this.setRunning(true);
    this.onProgress({ done: 0, total: r.total, alive: 0 });
  }

  setRunning(on) {
    this.running = on;
    this.btn.disabled = false;
    this.btn.textContent = on ? '중지' : '스캔 시작';
    this.btn.classList.toggle('danger', on);
    this.btn.classList.toggle('primary', !on);
    for (const e of this.inputs) e.disabled = on;
    this.setState(on ? 'connecting' : 'connected');
    this.app.updateToolbar();
  }

  clear() {
    this.rows.clear();
    this.tbody.innerHTML = '';
    this.empty.hidden = false;
    this.exportBtn.disabled = true;
    this.bar.style.width = '0%';
  }

  onProgress(p) {
    this.progress = p;
    this.bar.style.width = (p.total ? Math.round((p.done / p.total) * 100) : 0) + '%';
    if (this.running) this.sum.textContent = `스캔 중… ${p.done} / ${p.total} · 응답 ${p.alive}개`;
    if (this.app.active === this) this.app.updateStatus();
  }

  onDone(d) {
    this.setRunning(false);
    this.bar.style.width = '100%';
    if (d.error) { this.sum.textContent = '스캔 실패: ' + d.error; toast('IP 스캔 실패: ' + d.error, 'err'); return; }
    this.sum.textContent = `${d.cancelled ? '중지됨' : '완료'} — ${d.total}개 중 ${d.alive}개 응답 · ${(d.elapsed / 1000).toFixed(1)}초`;
    if (!this.rows.size) this.empty.textContent = d.cancelled ? '중지했습니다.' : '응답한 장비가 없습니다. 방화벽이 핑을 막는 망이면 "핑 없어도 포트 확인"을 켜보세요.';
    if (this.app.active !== this && !d.cancelled) toast(`IP 스캔 완료: ${d.alive}개 응답`, 'ok');
    if (this.app.active === this) this.app.updateStatus();
  }

  onWarn(msg) { toast(msg); }

  onHost(r) {
    let row = this.rows.get(r.ip);
    if (!row) {
      row = { r, n: scanIpNum(r.ip), el: h('tr') };
      row.el.addEventListener('dblclick', () => this.openDefault(row.r));
      row.el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.rowMenu(e, row.r); });
      this.rows.set(r.ip, row);
      const after = [...this.tbody.children].find((tr) => Number(tr.dataset.n) > row.n);
      this.tbody.insertBefore(row.el, after || null);
    }
    row.r = r;
    this.renderRow(row);
    this.empty.hidden = true;
    this.exportBtn.disabled = false;
    this.filterRow(row, this.filter.value.trim().toLowerCase());
  }

  renderRow(row) {
    const r = row.r;
    row.el.dataset.n = row.n;
    row.el.className = r.self ? 'self' : '';
    row.el.innerHTML = '';
    const ports = r.ports.length
      ? r.ports.map((p) => {
        const [label, kind] = scanPortInfo(p);
        return h('button.port' + (kind ? '.k-' + kind : ''), {
          title: kind ? `${label} 접속 (${r.ip}:${p})` : `${r.ip}:${p} 복사`,
          onclick: (e) => { e.stopPropagation(); this.openPort(r, p); },
        }, label ? `${p} ${label}` : String(p));
      })
      : h('span.hint', this.scanPorts.length ? '없음' : '—');
    row.el.append(
      h('td.st', h('span.dot.connected'), h('span.via', r.self ? '이 PC' : r.via === 'ping' ? '핑' : 'TCP')),
      h('td.ip', r.ip),
      h('td.rtt', r.rtt === null || r.rtt === undefined ? '' : r.rtt + 'ms'),
      h('td.ttl', { title: ttlHint(r.ttl) }, r.ttl || ''),
      h('td.name', { title: r.name }, r.name),
      h('td.mac', r.mac),
      h('td.vendor', { title: r.vendor }, r.vendor),
      h('td.ports', ports),
      h('td.banner', { title: r.banner }, r.banner),
    );
  }

  rowText(r) { return [r.ip, r.name, r.mac, r.vendor, r.banner, r.ports.join(' ')].join(' ').toLowerCase(); }
  filterRow(row, q) { row.el.hidden = !!q && !this.rowText(row.r).includes(q); }
  applyFilter() {
    const q = this.filter.value.trim().toLowerCase();
    for (const row of this.rows.values()) this.filterRow(row, q);
  }

  displayName(r) { return r.name ? r.name.split('.')[0] : r.ip; }

  /** kind: ssh | telnet | http | https | rdp | vnc | ftp. port를 안 주면 열린 포트 중 그 종류, 없으면 기본 포트 */
  openAs(r, kind, port) {
    const defaults = { ssh: 22, telnet: 23, http: 80, https: 443, rdp: 3389, vnc: 5900, ftp: 21 };
    if (!port) port = r.ports.find((p) => scanPortInfo(p)[1] === kind) || defaults[kind];
    const name = this.displayName(r);
    if (kind === 'http' || kind === 'https') {
      const std = (kind === 'http' && port === 80) || (kind === 'https' && port === 443);
      const url = `${kind}://${r.ip}${std ? '' : ':' + port}/`;
      const s = { protocol: 'web', url, host: r.ip, port, name };
      this.app.openTab({ title: name, req: { session: s, secrets: {} }, meta: s });
      return;
    }
    if (kind === 'rdp') {
      window.api.launchRdp({ session: { protocol: 'rdp', host: r.ip, port, name } })
        .then((res) => { if (!res.ok) toast(res.message, 'err'); else toast('원격 데스크톱 창을 열었습니다.'); });
      return;
    }
    const s = { protocol: kind, host: r.ip, port, username: '', name };
    this.app.openTab({ title: name, req: { session: s, secrets: {} }, meta: s });
  }

  openPort(r, p) {
    const kind = scanPortInfo(p)[1];
    if (kind) { this.openAs(r, kind, p); return; }
    window.api.clipWrite(`${r.ip}:${p}`);
    toast(`복사: ${r.ip}:${p}`);
  }

  openDefault(r) {
    for (const kind of ['ssh', 'telnet', 'https', 'http', 'rdp', 'vnc']) {
      const p = r.ports.find((x) => scanPortInfo(x)[1] === kind);
      if (p) { this.openAs(r, kind, p); return; }
    }
    toast('열린 포트가 없습니다. 우클릭 메뉴에서 접속 방식을 고르세요.');
  }

  saveAsSession(r) {
    const open = (kind) => r.ports.find((p) => scanPortInfo(p)[1] === kind);
    let preset;
    if (open('ssh')) preset = { protocol: 'ssh', port: open('ssh') === 22 ? '' : open('ssh') };
    else if (open('telnet')) preset = { protocol: 'telnet', port: open('telnet') === 23 ? '' : open('telnet') };
    else if (open('https') || open('http')) {
      const kind = open('https') ? 'https' : 'http';
      const p = open(kind);
      preset = { protocol: 'web', webScheme: kind, port: (kind === 'https' && p === 443) || (kind === 'http' && p === 80) ? '' : p };
    } else if (open('rdp')) preset = { protocol: 'rdp' };
    else preset = { protocol: 'ssh' };
    this.app.newSession('', { ...preset, host: r.ip, name: r.name ? r.name.split('.')[0] : '' });
  }

  rowMenu(e, r) {
    const line = [r.ip, r.name, r.mac, r.vendor, r.ports.join(' '), r.banner].filter(Boolean).join('\t');
    const visible = [...this.rows.values()].filter((x) => !x.el.hidden).map((x) => x.r.ip);
    showMenu(e.clientX, e.clientY, [
      { label: 'SSH 접속', action: () => this.openAs(r, 'ssh') },
      { label: 'Telnet 접속', action: () => this.openAs(r, 'telnet') },
      { label: '웹 열기 (HTTPS)', action: () => this.openAs(r, 'https') },
      { label: '웹 열기 (HTTP)', action: () => this.openAs(r, 'http') },
      { label: '원격 데스크톱 (RDP)', action: () => this.openAs(r, 'rdp') },
      '-',
      { label: '세션으로 저장…', action: () => this.saveAsSession(r) },
      { label: '이 대역(/24) 다시 스캔', action: () => this.app.openScan(r.ip.replace(/\.\d+$/, '.0/24')) },
      '-',
      { label: 'IP 복사', action: () => { window.api.clipWrite(r.ip); toast('IP 복사: ' + r.ip); } },
      { label: '이 줄 복사', action: () => { window.api.clipWrite(line); toast('복사했습니다.'); } },
      { label: `보이는 IP 전부 복사 (${visible.length}개)`, action: () => { window.api.clipWrite(visible.join('\r\n')); toast(`${visible.length}개 IP를 복사했습니다.`); } },
    ]);
  }

  async exportCsv() {
    const r = await window.api.scanExport(this.id);
    if (r.ok) toast('저장했습니다: ' + r.path.split(/[\\/]/).pop(), 'ok');
    else if (!r.canceled) toast(r.message, 'err');
  }

  statusText() {
    const p = this.progress;
    if (this.running && p) return `IP 스캔 · ${p.done}/${p.total} · 응답 ${p.alive}개`;
    return `IP 스캔 · ${this.rows.size ? `응답 ${this.rows.size}개` : '대기'}`;
  }

  destroy() {
    window.api.scanForget(this.id);
    super.destroy();
  }
}
