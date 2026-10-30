'use strict';
/* 새 버전 알림 (오른쪽 아래) + 설정 화면의 "지금 확인" */

const UpdateUI = {
  el: null,
  info: null,

  bind() {
    window.api.onUpdateAvailable((info) => this.show(info));
    window.api.onUpdateProgress((p) => this.progress(p));
  },

  close() { if (this.el) { this.el.remove(); this.el = null; } },

  show(info) {
    this.close();
    this.info = info;
    this.status = h('div.upd-status');
    const main = info.installable
      ? h('button.btn.primary.sm', { onclick: () => this.install() }, '업데이트')
      : h('button.btn.primary.sm', { onclick: () => { window.api.updateOpenPage(); this.close(); } }, '다운로드 페이지');
    this.el = h('div#update-banner',
      h('div.upd-head', h('b', `OiTerm ${info.version}`), h('span.hint', ` 새 버전 (지금 ${info.current})`),
        h('button.icon-btn', { title: '닫기', html: icon('x'), onclick: () => this.close() })),
      info.installable ? null : h('div.hint', '무설치(zip) 버전이라 자동으로 바꿀 수 없어요. 새 zip을 받아 같은 폴더에 덮어쓰거나, 설치 버전을 쓰면 다음부터는 자동입니다.'),
      this.status,
      h('div.upd-btns',
        info.notes ? h('button.btn.sm', { onclick: () => this.notes() }, '변경 내용') : null,
        h('button.btn.sm', { onclick: () => { window.api.updateSkip(info.version); this.close(); toast(`${info.version}은 건너뜁니다. 설정 → 업데이트에서 언제든 확인할 수 있어요.`); } }, '이 버전 건너뛰기'),
        main),
    );
    document.body.append(this.el);
  },

  notes() {
    const i = this.info;
    const m = openModal({
      title: `OiTerm ${i.version} 변경 내용`,
      body: h('div.upd-notes', i.notes),
      buttons: [h('button.btn.primary', { onclick: () => m.close() }, '닫기')],
    });
  },

  async install() {
    const live = App.tabs.filter((t) => t.state === 'connected' && t.kind !== 'scan' && t.kind !== 'tftp').length;
    const ok = await confirmBox(`OiTerm ${this.info.version}을(를) 받아서 설치합니다.\n설치가 끝나면 OiTerm이 다시 시작됩니다.${live ? `\n\n연결된 탭 ${live}개가 끊깁니다. 작업을 저장했는지 확인하세요.` : ''}`, { title: '업데이트', ok: '업데이트' });
    if (!ok) return;
    this.status.textContent = '받는 중…';
    const r = await window.api.updateInstall();
    if (!r.ok) { this.status.textContent = ''; toast('업데이트 실패: ' + r.message, 'err'); return; }
    this.status.textContent = '설치 중… 잠시 후 다시 시작됩니다.';
  },

  progress(p) {
    if (!this.status) return;
    const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
    this.status.textContent = `받는 중… ${pct}% (${fmtSize(p.done)} / ${fmtSize(p.total)})`;
  },

  /** 설정 화면의 "지금 확인" */
  async manualCheck(out) {
    out.textContent = '확인 중…';
    const r = await window.api.updateCheck();
    if (!r.ok) { out.textContent = '확인하지 못했습니다: ' + r.message; return; }
    if (!r.available) { out.textContent = `최신 버전입니다 (${r.current}).`; return; }
    out.textContent = `새 버전 ${r.version}이 있습니다.`;
    this.show(r);
  },
};
