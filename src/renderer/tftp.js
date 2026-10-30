'use strict';
/* TFTP 서버 탭: 장비가 이 PC로 설정을 백업하거나 이미지를 받아갈 때 */

class TftpTab extends BaseTab {
  constructor(app, spec) {
    super(app, spec, 'tftp');
    this.rows = new Map();
    this.st = { running: false, ips: [] };
    const s = app.settings;

    this.root = h('input.inp.grow', { value: s.tftpRoot || '', spellcheck: 'false' });
    this.allowRead = h('input', { type: 'checkbox', checked: s.tftpAllowRead !== false });
    this.allowWrite = h('input', { type: 'checkbox', checked: s.tftpAllowWrite !== false });
    this.autoStop = sel([[0, '안 함'], [10, '10분'], [30, '30분'], [60, '1시간'], [240, '4시간']], s.tftpAutoStop ?? 30);
    this.btn = h('button.btn.primary', { onclick: () => this.toggle() }, '서버 시작');
    this.stateEl = h('span.tftp-state');
    this.ipBox = h('div.tftp-ips');
    this.log = h('div.tftp-log');

    this.body.classList.add('tftp-body');
    this.body.append(h('div.tftp-wrap',
      h('div.tftp-top', this.stateEl, h('span.grow'), this.btn),
      h('div.grid', { style: 'margin-top:14px' },
        h('label', '폴더'), h('div.row', this.root,
          h('button.btn.sm', { onclick: async () => { const d = await window.api.pickFolder({ title: 'TFTP 폴더 선택' }); if (d) this.root.value = d; } }, '찾기'),
          h('button.btn.sm', { onclick: () => window.api.tftpOpenRoot() }, '열기')),
        h('label', '허용'), h('div.row', { style: 'gap:18px' },
          h('label.chk', this.allowRead, 'PC → 장비 (장비가 이미지·파일 받아가기)'),
          h('label.chk', this.allowWrite, '장비 → PC (설정 백업 올리기)')),
        h('label', '자동 중지'), h('div.row', this.autoStop, h('span.hint', '이 시간 동안 전송이 없으면 서버를 멈춥니다')),
      ),
      h('h4.tftp-h', '이 PC 주소 (장비 명령에 넣을 IP)'),
      this.ipBox,
      h('h4.tftp-h', '전송 기록'),
      this.log,
      h('div.hint', { style: 'margin-top:10px;line-height:1.7' },
        'TFTP는 암호도 인증도 없습니다. 쓸 때만 켜고 끝나면 꺼주세요. 처음 시작할 때 Windows 방화벽이 허용 여부를 물으면 "개인 네트워크"만 허용하세요.'),
    ));
    this.log.append(h('div.tftp-empty', '아직 전송이 없습니다.'));
  }

  async connect() {
    this.show(await window.api.tftpStatus());
  }

  show(st) {
    this.st = st;
    this.app.tftpRunning = st.running;
    this.app.updateToolbar();
    this.setState(st.running ? 'connected' : 'closed');
    this.stateEl.innerHTML = '';
    this.stateEl.append(
      h('span.dot.' + (st.running ? 'connected' : 'closed')),
      st.running ? `실행 중 — UDP ${st.port}, 폴더: ${st.root}` : '꺼져 있음',
    );
    this.btn.textContent = st.running ? '서버 중지' : '서버 시작';
    this.btn.classList.toggle('danger', st.running);
    this.btn.classList.toggle('primary', !st.running);
    [this.root, this.allowRead, this.allowWrite, this.autoStop].forEach((e) => { e.disabled = st.running; });
    this.ipBox.innerHTML = '';
    if (!st.ips || !st.ips.length) this.ipBox.append(h('div.hint', '네트워크 주소를 찾지 못했습니다. 랜선/와이파이 연결을 확인하세요.'));
    for (const ip of st.ips || []) {
      const cmd1 = `copy running-config tftp://${ip.address}/`;
      const cmd2 = `copy tftp://${ip.address}/파일이름 flash:`;
      this.ipBox.append(h('div.tftp-ip',
        h('b', ip.address), h('span.hint', ip.name),
        h('span.grow'),
        h('button.btn.sm', { title: cmd1, onclick: () => { window.api.clipWrite(cmd1); toast('복사: ' + cmd1); } }, '백업 명령 복사'),
        h('button.btn.sm', { title: cmd2, onclick: () => { window.api.clipWrite(cmd2); toast('복사: ' + cmd2); } }, '받기 명령 복사'),
        h('button.btn.sm', { onclick: () => { window.api.clipWrite(ip.address); toast('IP 복사: ' + ip.address); } }, 'IP 복사'),
      ));
    }
  }

  async toggle() {
    if (this.st.running) {
      this.show(await window.api.tftpStop());
      return;
    }
    if (!this.allowRead.checked && !this.allowWrite.checked) { toast('허용할 방향을 하나 이상 고르세요.', 'err'); return; }
    const r = await window.api.tftpStart({
      root: this.root.value.trim(), allowRead: this.allowRead.checked, allowWrite: this.allowWrite.checked, autoStopMin: Number(this.autoStop.value),
    });
    if (!r.ok) { toast('TFTP 서버를 시작할 수 없습니다: ' + r.message, 'err'); return; }
    Object.assign(this.app.settings, { tftpRoot: r.status.root, tftpAllowRead: r.status.allowRead, tftpAllowWrite: r.status.allowWrite, tftpAutoStop: Number(this.autoStop.value) });
    this.show(r.status);
  }

  onStopped(msg) {
    toast('TFTP: ' + msg);
    window.api.tftpStatus().then((st) => this.show(st));
  }

  onEvent(e) {
    const empty = $('.tftp-empty', this.log);
    if (empty) empty.remove();
    let row = this.rows.get(e.id);
    if (!row) {
      row = {
        el: h('div.tftp-row'),
        time: new Date(),
      };
      this.rows.set(e.id, row);
      this.log.prepend(row.el);
    }
    const pct = e.total ? Math.min(100, Math.round((e.done / e.total) * 100)) : null;
    const dir = e.kind === 'get' ? 'PC → 장비' : '장비 → PC';
    const statusText = e.status === 'done' ? '완료' : e.status === 'error' ? '실패' : pct !== null ? `${pct}%` : fmtSize(e.done);
    row.el.className = 'tftp-row ' + e.status;
    row.el.innerHTML = '';
    row.el.append(
      h('span.t', fmtDate(row.time.getTime()).slice(11)),
      h('span.d', dir),
      h('span.p', e.peer),
      h('span.f', e.file),
      h('span.s', e.total ? fmtSize(e.total) : fmtSize(e.done)),
      h('span.r', statusText + (e.message ? ' — ' + e.message : '')),
    );
    if (e.status === 'done') toast(`TFTP ${dir}: ${e.file} 완료`, 'ok');
  }

  destroy() {
    window.api.tftpStop().then(() => { this.app.tftpRunning = false; this.app.updateToolbar(); });
    super.destroy();
  }
}
