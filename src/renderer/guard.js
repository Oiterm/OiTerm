'use strict';
/* 위험 명령 경고: Enter를 누를 때(또는 여러 줄을 보낼 때) 지금 줄의 명령을 보고
 * reload / write erase / 인터페이스 shutdown 같은 명령이면 확인을 받음.
 * - 규칙 단어는 줄임말도 잡음 (wr er = write erase, rel = reload)
 * - "re:" 로 시작하면 정규식
 * - 단계: confirm(확인) / type(장비 이름을 쳐야 실행) / block(실행 안 함) */

const DANGER_LEVELS = { confirm: 1, type: 2, block: 3 };
const DANGER_LEVEL_NAMES = { confirm: '확인', type: '장비 이름 입력', block: '차단' };
const DANGER_MODE_NAMES = { any: '어디서나', config: '설정 모드', if: '인터페이스 모드' };

const DANGER_PRESETS = [
  { match: 'reload', mode: 'any', level: 'type', note: '장비 재부팅', unless: '^rel\\w*\\s+can' },
  { match: 'write erase', mode: 'any', level: 'type', note: '저장된 설정 삭제' },
  { match: 'erase startup-config', mode: 'any', level: 'type', note: '저장된 설정 삭제' },
  { match: 'erase nvram:', mode: 'any', level: 'type', note: '저장된 설정 삭제' },
  { match: 'format', mode: 'any', level: 'type', note: '저장소(flash·디스크) 포맷' },
  { match: 'configure replace', mode: 'any', level: 'type', note: '설정을 통째로 교체' },
  { match: 'reboot', mode: 'any', level: 'type', note: '재부팅 (AlliedWare Plus·Huawei·리눅스 등)' },
  { match: 'reset saved-configuration', mode: 'any', level: 'type', note: '저장된 설정 삭제 (Huawei/H3C)' },
  { match: 'execute reboot', mode: 'any', level: 'type', note: '재부팅 (FortiGate)' },
  { match: 'execute factoryreset', mode: 'any', level: 'type', note: '공장 초기화 (FortiGate)' },
  { match: 'request system reboot', mode: 'any', level: 'type', note: '재부팅 (Juniper)' },
  { match: 'request system zeroize', mode: 'any', level: 'type', note: '공장 초기화 (Juniper)' },
  { match: 'shutdown', mode: 'if', level: 'confirm', note: '인터페이스 끄기 — 업링크·관리 포트면 접속이 끊깁니다' },
  { match: 're:^sw\\w*\\s+tr\\w*\\s+al\\w*\\s+vl\\w*\\s+\\d', mode: 'if', level: 'confirm', note: '"add" 없이 쓰면 허용 VLAN 목록이 통째로 바뀝니다 (추가는 switchport trunk allowed vlan add)' },
  { match: 'default interface', mode: 'config', level: 'confirm', note: '인터페이스 설정 초기화' },
  { match: 'no interface', mode: 'config', level: 'confirm', note: '인터페이스(VLAN SVI 등) 삭제' },
  { match: 'no router', mode: 'config', level: 'confirm', note: '라우팅 프로토콜 설정 전체 삭제' },
  { match: 'no vlan', mode: 'config', level: 'confirm', note: 'VLAN 삭제' },
  { match: 'no spanning-tree', mode: 'config', level: 'confirm', note: '스패닝트리 끄기 — 루프 위험' },
  { match: 'clear ip bgp', mode: 'any', level: 'confirm', note: 'BGP 세션 리셋' },
  { match: 'delete', mode: 'any', level: 'confirm', note: '파일 삭제 (flash: 이미지·설정 파일)' },
  { match: 're:^(sudo\\s+)?(shutdown\\s+-|poweroff\\b|halt\\b|init\\s+[06]\\b|systemctl\\s+(reboot|poweroff|halt)\\b)', mode: 'any', level: 'type', note: '서버 종료·재부팅 (리눅스)' },
  { match: 're:^(sudo\\s+)?mkfs', mode: 'any', level: 'type', note: '디스크 포맷 (리눅스)' },
  { match: 're:^(sudo\\s+)?rm\\s+(.*\\s)?-[a-zA-Z]*[rR]', mode: 'any', level: 'confirm', note: '폴더째 삭제 (rm -r)' },
  { match: 're:^(sudo\\s+)?dd\\s.*\\bof=', mode: 'any', level: 'confirm', note: '디스크·파일에 직접 쓰기 (dd)' },
  { match: 're:^(remove-item|ri|rm|del|erase|rd|rmdir)\\s.*(\\s-r(ecurse)?\\b|\\/s\\b)', mode: 'any', level: 'confirm', note: '폴더째 삭제 (Windows)' },
  { match: 're:^(restart-computer|stop-computer)\\b|^shutdown(\\.exe)?\\s+[\\/-][rsp]\\b', mode: 'any', level: 'type', note: 'PC 재시작·종료 (Windows)' },
];

/** 프롬프트에서 호스트 이름·모드·명령 분리. 프롬프트가 아니면 null */
function parsePrompt(line) {
  const s = String(line || '').replace(/\s+$/, ' ').replace(/^\s+/, '');
  let m;
  // Cisco / AlliedWare Plus / 대부분의 장비: SW1#  R1>  core(config-if)#
  if ((m = /^([A-Za-z0-9][\w.\-\/]{0,62})(\([^)\s]{0,40}\))?\s?([#>])\s?(.*)$/.exec(s))) {
    const mode = !m[2] ? 'exec' : /config-(sub)?if/i.test(m[2]) ? 'if' : /config/i.test(m[2]) ? 'config' : 'exec';
    return { host: m[1], mode, cmd: m[4].trim() };
  }
  // Huawei / H3C: <HOST>  [HOST]  [HOST-GigabitEthernet0/0/1]
  if ((m = /^<([^>\s]{1,63})>\s?(.*)$/.exec(s))) return { host: m[1], mode: 'exec', cmd: m[2].trim() };
  if ((m = /^\[~?\*?([^\]\s]{1,80})\]\s?(.*)$/.exec(s))) {
    const i = m[1].indexOf('-');
    return { host: i > 0 ? m[1].slice(0, i) : m[1], mode: i > 0 ? 'if' : 'config', cmd: m[2].trim() };
  }
  // 리눅스: user@host:~$   [user@host dir]#
  if ((m = /^\[?[\w.\-]+@([\w.\-]+)[^\s$#%]*(?:\s[^\]]{0,80}\])?\s?[$#%]\s?(.*)$/.exec(s))) return { host: m[1], mode: 'exec', cmd: m[2].trim() };
  // PowerShell / cmd
  if ((m = /^PS [^>]{1,250}>\s?(.*)$/.exec(s))) return { host: '', mode: 'exec', cmd: m[1].trim() };
  if ((m = /^[A-Za-z]:\\[^>]{0,250}>(.*)$/.exec(s))) return { host: '', mode: 'exec', cmd: m[1].trim() };
  // Alcatel-Lucent OmniSwitch: "-> "
  if ((m = /^->\s?(.*)$/.exec(s))) return { host: '', mode: 'exec', cmd: m[1].trim() };
  return null;
}

function normalizeCmd(c) {
  return String(c || '').replace(/[\x00-\x1f]/g, '').trim().replace(/\s+/g, ' ').replace(/^do\s+/i, '');
}

function ruleMatches(rule, cmd, mode) {
  if (!rule || !rule.match || !cmd) return false;
  if (rule.mode === 'if' && mode !== 'if') return false;
  if (rule.mode === 'config' && mode !== 'config' && mode !== 'if') return false;
  try { if (rule.unless && new RegExp(rule.unless, 'i').test(cmd)) return false; } catch (_) {}
  if (rule.match.startsWith('re:')) {
    try { return new RegExp(rule.match.slice(3), 'i').test(cmd); } catch (_) { return false; }
  }
  // 줄임말: 입력한 단어가 규칙 단어의 앞부분이면 같은 단어로 봄 (첫 단어는 2글자 이상)
  const rw = rule.match.toLowerCase().split(/\s+/).filter(Boolean);
  const iw = cmd.toLowerCase().split(' ');
  if (iw.length < rw.length) return false;
  for (let i = 0; i < rw.length; i++) {
    const w = iw[i];
    if (w.length < (i === 0 ? Math.min(2, rw[i].length) : 1) || !rw[i].startsWith(w)) return false;
  }
  return true;
}

/** 모드 따라가기 (여러 줄 보낼 때): conf t → 설정, interface → 인터페이스, exit/end */
function nextMode(mode, cmd) {
  const c = cmd.toLowerCase();
  if (/^conf(i(g(u(r(e)?)?)?)?)?(\s+t(e(r(m(i(n(a(l)?)?)?)?)?)?)?)?$/.test(c)) return mode === 'exec' ? 'config' : mode;
  if (mode !== 'exec' && /^int(e(r(f(a(c(e)?)?)?)?)?)?\s+\S/.test(c)) return 'if';
  if (/^end$/.test(c)) return 'exec';
  if (/^exit$/.test(c)) return mode === 'if' ? 'config' : mode === 'config' ? 'exec' : mode;
  return mode;
}

const Guard = {
  rules(app) { return Array.isArray(app.settings.dangerRules) ? app.settings.dangerRules : DANGER_PRESETS; },
  active(tab) { return tab.app.settings.dangerEnabled !== false && !tab.guardOff && tab.term && tab.term.buffer.active.type === 'normal'; },

  strictest(app, cmd, mode) {
    let best = null;
    for (const r of this.rules(app)) {
      if (!DANGER_LEVELS[r.level] || !ruleMatches(r, cmd, mode)) continue;
      if (!best || DANGER_LEVELS[r.level] > DANGER_LEVELS[best.level]) best = r;
    }
    return best;
  },

  /** Enter 직전: 화면의 현재 줄 + 직접 친 글자 둘 다 확인 (장비 echo가 늦어도, 히스토리로 불러와도 잡음) */
  checkEnter(tab) {
    const p = parsePrompt(tab.currentLine());
    if (p) tab.lastMode = p.mode;
    const mode = p ? p.mode : (tab.lastMode || 'exec');
    const cands = [];
    if (p && p.cmd) cands.push(normalizeCmd(p.cmd));
    if (typeof tab.typed === 'string' && tab.typed.trim()) cands.push(normalizeCmd(tab.typed));
    let hit = null;
    for (const c of cands) {
      const r = this.strictest(tab.app, c, mode);
      if (r && (!hit || DANGER_LEVELS[r.level] > DANGER_LEVELS[hit.rule.level])) hit = { cmd: c, rule: r };
    }
    return hit ? { hits: [hit], host: (p && p.host) || '' } : null;
  },

  /** 여러 줄 (붙여넣기·버튼·명령창) */
  checkLines(tab, lines) {
    const p = parsePrompt(tab.currentLine());
    let mode = p ? p.mode : (tab.lastMode || 'exec');
    const hits = [];
    lines.forEach((line, i) => {
      const c = normalizeCmd(line);
      if (!c) return;
      const r = this.strictest(tab.app, c, mode);
      if (r) hits.push({ cmd: c, rule: r, n: i + 1 });
      mode = nextMode(mode, c);
    });
    return hits.length ? { hits, host: (p && p.host) || '' } : null;
  },

  /** 여러 줄 보내기 전에 호출 → 보내도 되면 true */
  async allowLines(tab, lines, targets) {
    if (!tab || !this.active(tab)) return true;
    const found = this.checkLines(tab, lines);
    if (!found) return true;
    return this.confirm(tab, found, targets);
  },

  /** 경고 창. Enter를 한 번 더 눌러도 실행되지 않게 (확인 단계는 Enter = 취소) */
  confirm(tab, found, targets = [tab]) {
    return new Promise((resolve) => {
      const level = found.hits.reduce((a, x) => (DANGER_LEVELS[x.rule.level] > DANGER_LEVELS[a] ? x.rule.level : a), 'confirm');
      const name = found.host || tab.title.replace(/ \(\d+\)$/, '');
      let ok = false;
      const list = h('div.danger-list', found.hits.slice(0, 20).map((x) => h('div.danger-item',
        h('code', (x.n ? `${x.n}행: ` : '') + x.cmd),
        h('span.danger-note', x.rule.note || ''),
        h('span.danger-lv.' + x.rule.level, DANGER_LEVEL_NAMES[x.rule.level]))));
      const multi = targets.length > 1
        ? h('div.warn-box.danger-multi', `동시 입력 중 — ${targets.length}개 장비에 함께 들어갑니다: ${targets.map((t) => t.title).join(', ')}`)
        : null;
      const where = h('div.hint', { style: 'margin:8px 0 0' }, `대상: ${tab.title}${found.host && found.host !== tab.title ? ` (프롬프트: ${found.host})` : ''}`);
      let body;
      let buttons;
      const cancelBtn = h('button.btn', { onclick: () => m.close() }, '취소');
      if (level === 'block') {
        body = h('div', h('div', '설정에서 "차단"으로 정한 명령이라 보내지 않습니다.'), list, multi, where);
        const close = h('button.btn.primary', { onclick: () => m.close() }, '닫기');
        buttons = [close];
        setTimeout(() => close.focus(), 40);
      } else if (level === 'type') {
        const inp = h('input.inp', { placeholder: name, spellcheck: 'false', autocomplete: 'off' });
        const run = h('button.btn.danger', { disabled: true, onclick: () => { ok = true; m.close(); } }, '실행');
        const matches = () => inp.value.trim().toLowerCase() === name.toLowerCase();
        inp.addEventListener('input', () => { run.disabled = !matches(); });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && matches()) { e.preventDefault(); ok = true; m.close(); } });
        body = h('div', list, multi, where,
          h('div', { style: 'margin-top:14px' }, '계속하려면 장비 이름 ', h('b.danger-name', name), ' 을(를) 그대로 입력하세요.'),
          h('div', { style: 'margin-top:8px' }, inp));
        buttons = [cancelBtn, run];
        setTimeout(() => inp.focus(), 40);
      } else {
        body = h('div', list, multi, where, h('div.hint', { style: 'margin-top:10px' }, 'Enter를 누르면 취소됩니다. 실행하려면 "실행" 버튼을 누르세요.'));
        const run = h('button.btn.danger', { onclick: () => { ok = true; m.close(); } }, '실행');
        const cancel = h('button.btn.primary', { onclick: () => m.close() }, '취소');
        buttons = [run, cancel];
        setTimeout(() => cancel.focus(), 40);
      }
      const m = openModal({ title: level === 'block' ? '차단된 명령' : '위험 명령 확인', cls: 'narrow danger-modal', body, buttons, onClose: () => resolve(ok) });
    });
  },
};
