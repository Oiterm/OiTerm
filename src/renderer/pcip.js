'use strict';
/* PC IP 바꾸기 창 — 랜카드 고르고 고정 IP / 자동(DHCP), 자주 쓰는 IP 저장, 바꾸기 전으로 되돌리기
 * 실제 변경은 메인 프로세스(pcip.js)가 값 검사 후 Windows 확인 창(UAC)을 거쳐 netsh로 함 */

const PcIpUI = {
  /** opts.forDevice: 장비 IP (스마트 링크에서) → 같은 /24 대역의 PC IP를 미리 채움 */
  async open(opts = {}) {
    const app = window.App;
    const st = app.settings;
    let adapters = [];
    let prev = {};
    let busy = false;

    const adSel = h('select.inp.grow', { onchange: () => { showCurrent(); app.saveSettings({ pcipLastAdapter: curAdapter()?.name || '' }); } });
    const refreshBtn = h('button.btn.sm', { title: '랜카드 목록 새로 읽기', onclick: () => load() }, '새로 고침');
    const cur = h('div.pcip-cur', '랜카드 목록을 읽는 중…');
    const modeDhcp = h('input', { type: 'radio', name: 'pcip-mode', value: 'dhcp', onchange: () => syncMode() });
    const modeStatic = h('input', { type: 'radio', name: 'pcip-mode', value: 'static', checked: true, onchange: () => syncMode() });
    const inp = (ph, w) => h('input.inp', { placeholder: ph, spellcheck: 'false', style: w ? `width:${w}` : '' });
    const fIp = inp('예) 192.168.1.250');
    const fMask = inp('255.255.255.0 또는 24');
    const fGw = inp('비우면 게이트웨이 없음');
    const fDns1 = inp('비워도 됨');
    const fDns2 = inp('비워도 됨');
    const fields = [fIp, fMask, fGw, fDns1, fDns2];
    const presetSel = h('select.inp.grow', { onchange: () => usePreset() });
    const msg = h('div.pcip-msg');
    const restoreBtn = h('button.btn', { onclick: () => restore() }, '되돌리기');
    const applyBtn = h('button.btn.primary', { onclick: () => apply() }, '적용');

    const row = (label, el, hint) => h('div.pcip-row', h('label', label), el, hint ? h('span.hint', hint) : null);
    const body = h('div.pcip',
      h('div.pcip-top', adSel, refreshBtn),
      cur,
      h('div.pcip-mode',
        h('label.chk', modeStatic, '고정 IP'),
        h('label.chk', modeDhcp, '자동 (DHCP)')),
      h('div.pcip-grid',
        row('IP 주소', fIp),
        row('서브넷', fMask),
        row('게이트웨이', fGw, '장비에 직접 붙을 땐 비워두세요 (와이파이 인터넷 그대로)'),
        row('DNS 1', fDns1),
        row('DNS 2', fDns2)),
      h('div.pcip-presets',
        h('span', '자주 쓰는 IP'), presetSel,
        h('button.btn.sm', { onclick: () => savePreset() }, '지금 값 저장…'),
        h('button.btn.sm', { onclick: () => deletePreset() }, '삭제')),
      msg,
      h('div.hint', '적용하면 Windows 확인 창(관리자 권한)이 뜹니다 — "Windows PowerShell"이 변경을 허용할지 묻는 창이에요. 관리자 권한이 없는 계정이면 바꿀 수 없습니다.'),
    );
    const m = openModal({
      title: 'PC IP 바꾸기', cls: 'pcip-modal', body,
      left: [restoreBtn],
      buttons: [h('button.btn', { onclick: () => m.close() }, '닫기'), applyBtn],
    });

    const curAdapter = () => adapters.find((a) => String(a.index) === adSel.value);
    const STATE = { Up: '연결됨', Disconnected: '케이블 빠짐', Disabled: '사용 안 함', 'Not Present': '장치 없음' };
    const fmtAddrs = (a) => a.addrs.filter((x) => x.origin !== 'WellKnown').map((x) => `${x.ip}/${x.prefix}${x.state === 'Duplicate' ? ' (IP 충돌!)' : x.state === 'Tentative' ? ' (확인 중)' : ''}`).join(', ');
    const describePrev = (p) => (p.mode === 'dhcp' ? '자동(DHCP)' : `${p.ip}/${p.mask}${p.gw ? ' GW ' + p.gw : ''}`);

    function setMsg(text, kind = '') { msg.textContent = text || ''; msg.className = 'pcip-msg' + (kind ? ' ' + kind : ''); }

    function syncMode() {
      const isStatic = modeStatic.checked;
      for (const f of fields) f.disabled = !isStatic;
      presetSel.disabled = !isStatic;
    }

    function showCurrent() {
      const a = curAdapter();
      cur.innerHTML = '';
      if (!a) { cur.textContent = adapters.length ? '랜카드를 고르세요.' : '랜카드가 없습니다.'; restoreBtn.disabled = true; return; }
      const addrs = fmtAddrs(a);
      cur.append(
        h('div', h('b', a.name), h('span.hint', ` ${a.desc}`)),
        h('div', `상태: ${STATE[a.status] || a.status}  ·  ${a.bound ? (a.dhcp === 'Enabled' ? '자동(DHCP)' : '고정 IP') : 'IPv4 꺼짐'}  ·  MAC ${a.mac}`),
        h('div', `IP: ${addrs || '없음'}${a.gw.length ? '  ·  게이트웨이 ' + a.gw.join(', ') : ''}${a.dns.length ? '  ·  DNS ' + a.dns.join(', ') : ''}`),
      );
      const p = prev[a.name];
      restoreBtn.disabled = !p;
      restoreBtn.title = p ? `OiTerm으로 처음 바꾸기 전의 원래 설정으로: ${describePrev(p)}` : '되돌릴 원래 설정이 없습니다 (아직 안 바꿈)';
      restoreBtn.textContent = p ? `원래대로 (${describePrev(p)})` : '원래대로';
    }

    function fillPresets() {
      presetSel.innerHTML = '';
      presetSel.append(h('option', { value: '' }, '— 골라서 채우기 —'));
      (st.pcipPresets || []).forEach((p, i) => presetSel.append(h('option', { value: String(i) }, `${p.name}  (${p.ip}/${p.mask}${p.gw ? ' GW ' + p.gw : ''})`)));
    }

    function usePreset() {
      const p = (st.pcipPresets || [])[Number(presetSel.value)];
      if (!p) return;
      fIp.value = p.ip || ''; fMask.value = p.mask || ''; fGw.value = p.gw || ''; fDns1.value = p.dns1 || ''; fDns2.value = p.dns2 || '';
      setMsg('');
    }

    async function savePreset() {
      if (!fIp.value.trim() || !fMask.value.trim()) { setMsg('IP와 서브넷을 넣은 뒤 저장하세요.', 'err'); return; }
      const name = await promptBox('이 IP 설정의 이름', { title: '자주 쓰는 IP 저장', value: `${fIp.value.trim()}/${fMask.value.trim()}`, placeholder: '예) 장비 초기 접속용' });
      if (!name || !name.trim()) return;
      const list = (st.pcipPresets || []).filter((p) => p.name !== name.trim()).slice(0, 49);
      list.push({ name: name.trim().slice(0, 40), ip: fIp.value.trim().slice(0, 15), mask: fMask.value.trim().slice(0, 15), gw: fGw.value.trim().slice(0, 15), dns1: fDns1.value.trim().slice(0, 15), dns2: fDns2.value.trim().slice(0, 15) });
      app.saveSettings({ pcipPresets: list });
      fillPresets();
      presetSel.value = String(list.length - 1);
      toast(`"${name.trim()}" 저장`);
    }

    function deletePreset() {
      const i = Number(presetSel.value);
      const list = (st.pcipPresets || []).slice();
      if (presetSel.value === '' || !list[i]) { setMsg('지울 항목을 먼저 고르세요.', 'err'); return; }
      const [gone] = list.splice(i, 1);
      app.saveSettings({ pcipPresets: list });
      fillPresets();
      toast(`"${gone.name}" 삭제`);
    }

    async function load(keepIndex, clear = true) {
      if (clear) setMsg('');
      refreshBtn.disabled = true;
      const r = await window.api.pcipList();
      refreshBtn.disabled = false;
      if (!r.ok) { cur.textContent = r.message; applyBtn.disabled = true; return; }
      adapters = r.adapters;
      prev = r.prev || {};
      applyBtn.disabled = false;
      adSel.innerHTML = '';
      for (const a of adapters) {
        const ip = a.addrs.find((x) => x.origin !== 'WellKnown');
        adSel.append(h('option', { value: String(a.index) }, `${a.name} — ${STATE[a.status] || a.status}${ip ? ' · ' + ip.ip : ''}`));
      }
      // 고를 랜카드: 방금 쓰던 것 → 지난번 것 → 케이블 꽂힌 유선 → 첫 번째
      const pick = (keepIndex && adapters.find((a) => a.index === keepIndex))
        || adapters.find((a) => a.name === st.pcipLastAdapter)
        || adapters.find((a) => a.status === 'Up' && !/wi-?fi|wireless|무선|wlan/i.test(a.name + a.desc))
        || adapters[0];
      if (pick) adSel.value = String(pick.index);
      showCurrent();
    }

    async function confirmRisk(a, toDhcp) {
      // 지금 이 랜카드로 인터넷/원격에 붙어 있으면 끊길 수 있음
      if (a.status === 'Up' && a.gw.length && (toDhcp ? a.dhcp !== 'Enabled' : true)) {
        return confirmBox(`"${a.name}"은(는) 지금 게이트웨이(${a.gw.join(', ')})로 밖에 나가고 있는 랜카드입니다.\n바꾸면 이 랜카드로 쓰던 인터넷·원격 접속이 끊길 수 있어요. 계속할까요?`, { title: 'PC IP 바꾸기', ok: '바꾸기' });
      }
      return true;
    }

    async function run(fn, label) {
      if (busy) return;
      busy = true;
      applyBtn.disabled = true; restoreBtn.disabled = true;
      setMsg(`${label}… Windows 확인 창이 뜨면 "예"를 누르세요.`);
      let r;
      try { r = await fn(); } finally { busy = false; applyBtn.disabled = false; }
      if (!r.ok) { setMsg(r.message, r.cancelled ? '' : 'err'); showCurrent(); return; }
      prev = r.prev || prev;
      const idx = r.adapter ? r.adapter.index : null;
      await load(idx);
      setMsg(r.message, r.warn ? 'err' : 'ok');
      toast(r.message, r.warn ? 'err' : 'ok');
    }

    async function apply() {
      const a = curAdapter();
      if (!a) { setMsg('랜카드를 고르세요.', 'err'); return; }
      const toDhcp = modeDhcp.checked;
      if (!toDhcp && (!fIp.value.trim() || !fMask.value.trim())) { setMsg('IP 주소와 서브넷을 넣으세요.', 'err'); return; }
      if (!(await confirmRisk(a, toDhcp))) return;
      const req = toDhcp ? { index: a.index, mode: 'dhcp' }
        : { index: a.index, mode: 'static', ip: fIp.value.trim(), mask: fMask.value.trim(), gw: fGw.value.trim(), dns1: fDns1.value.trim(), dns2: fDns2.value.trim() };
      await run(() => window.api.pcipApply(req), toDhcp ? '자동(DHCP)으로 바꾸는 중' : `${req.ip}로 바꾸는 중`);
    }

    async function restore() {
      const a = curAdapter();
      const p = a && prev[a.name];
      if (!p) return;
      if (!(await confirmRisk(a, p.mode === 'dhcp'))) return;
      await run(() => window.api.pcipRestore(a.index), `되돌리는 중 (${describePrev(p)})`);
    }

    fillPresets();
    syncMode();
    await load();
    // 스마트 링크에서 장비 IP로 열었으면 같은 /24에서 PC IP를 제안
    if (opts.forDevice && /^\d{1,3}(\.\d{1,3}){3}$/.test(opts.forDevice)) {
      const parts = opts.forDevice.split('.');
      const host = Number(parts[3]) === 250 ? 251 : 250;
      fIp.value = `${parts[0]}.${parts[1]}.${parts[2]}.${host}`;
      fMask.value = '255.255.255.0';
      fGw.value = ''; fDns1.value = ''; fDns2.value = '';
      setMsg(`장비 ${opts.forDevice}에 붙을 수 있게 같은 대역의 ${fIp.value}/24를 넣어뒀어요 (게이트웨이 없음). 그 IP를 다른 장비가 쓰고 있으면 바꾸세요.`);
    }
    return m;
  },
};
