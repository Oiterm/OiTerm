'use strict';
/* 대화상자: 세션 편집 / 빠른 연결 / 설정 / 버튼 편집 / 로그인 / 호스트 키 */

const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

function field(label, control, opts = {}) {
  return [h('label', { title: opts.title || null }, label), opts.wrap ? h('div.row', control) : control];
}

function sel(options, value) {
  return h('select', options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));
}

/**
 * 세션 편집기
 * mode: 'edit' | 'new' | 'quick'
 * 반환: { action: 'save'|'connect'|'saveConnect', session, secrets } | null
 */
function sessionDialog({ mode = 'new', session = {}, folders = [] }) {
  return new Promise((resolve) => {
    const s = {
      protocol: 'ssh', port: '', encoding: '', termType: '', autoLog: 'default', authType: 'password',
      baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none', enableCmd: 'enable', keepalive: 60,
      ...session,
    };
    let protocol = s.protocol;
    let result = null;

    const name = h('input.inp', { value: s.name || '', placeholder: '예: 본관 L3 코어', spellcheck: 'false' });
    const folder = h('input.inp', { value: s.folder || '', placeholder: '예: 고객사A/본관 (비우면 맨 위)', list: 'folder-list', spellcheck: 'false' });
    const folderList = h('datalist#folder-list', folders.map((f) => h('option', { value: f })));

    const segBtns = {};
    const PROTO_NAMES = { ssh: 'SSH', telnet: 'Telnet', serial: '시리얼', sftp: 'SFTP', ftp: 'FTP', vnc: 'VNC', rdp: 'RDP', web: '웹', local: '로컬 셸' };
    const seg = h('div.seg', Object.keys(PROTO_NAMES).map((p) => {
      segBtns[p] = h('button', { type: 'button', onclick: () => setProto(p) }, PROTO_NAMES[p]);
      return segBtns[p];
    }));

    const host = h('input.inp', { value: s.host || '', placeholder: 'IP 또는 호스트 이름', spellcheck: 'false', autofocus: mode === 'quick' });
    const port = h('input.inp', { value: s.port || '', placeholder: '22', style: 'width:90px', inputmode: 'numeric' });

    const serialPort = h('input.inp.grow', { value: s.serialPort || '', placeholder: 'COM3', list: 'com-list', spellcheck: 'false' });
    const comList = h('datalist#com-list');
    const comHint = h('div.hint');
    async function refreshPorts() {
      const ports = await window.api.listSerial();
      comList.innerHTML = '';
      ports.forEach((p) => comList.append(h('option', { value: p.path }, p.label)));
      comHint.textContent = ports.length ? '감지된 포트: ' + ports.map((p) => p.label).join(', ') : '감지된 COM 포트가 없습니다. USB 콘솔 케이블 드라이버를 확인하세요.';
      if (!serialPort.value && ports[0]) serialPort.value = ports[0].path;
    }
    const baud = sel(BAUDS.map((b) => [b, String(b)]), s.baudRate);
    const dataBits = sel([[8, '8'], [7, '7'], [6, '6'], [5, '5']], s.dataBits);
    const parity = sel([['none', '없음'], ['even', '짝수(Even)'], ['odd', '홀수(Odd)'], ['mark', 'Mark'], ['space', 'Space']], s.parity);
    const stopBits = sel([[1, '1'], [2, '2']], s.stopBits);
    const flow = sel([['none', '없음'], ['rtscts', 'RTS/CTS (하드웨어)'], ['xonxoff', 'XON/XOFF (소프트웨어)']], s.flowControl);

    const username = h('input.inp', { value: s.username || '', placeholder: '아이디', spellcheck: 'false' });
    const pw = h('input.inp', { type: 'password', placeholder: s.hasPassword ? '저장됨 — 바꿀 때만 입력' : '비우면 접속할 때 물어봅니다' });
    const pwClear = h('input', { type: 'checkbox' });
    const authType = sel([['password', '비밀번호'], ['key', '개인 키 파일']], s.authType);
    const keyPath = h('input.inp.grow', { value: s.keyPath || '', placeholder: 'C:\\Users\\...\\id_rsa', spellcheck: 'false' });
    const keyBtn = h('button.btn.sm', { type: 'button', onclick: async () => { const f = await window.api.pickFile({ title: '개인 키 파일 선택' }); if (f) keyPath.value = f; } }, '찾기');
    const passphrase = h('input.inp', { type: 'password', placeholder: s.hasPassphrase ? '저장됨 — 바꿀 때만 입력' : '키에 암호가 있으면 입력' });
    const autoLogin = h('input', { type: 'checkbox', checked: s.autoLogin });

    const enable = h('input', { type: 'checkbox', checked: s.enable });
    const enableCmd = h('input.inp', { value: s.enableCmd || 'enable', style: 'width:140px', spellcheck: 'false' });
    const enablePw = h('input.inp', { type: 'password', placeholder: s.hasEnablePassword ? '저장됨 — 바꿀 때만 입력' : '없으면 비워두기' });

    const encoding = sel([['', '기본 설정 따름'], ['utf8', 'UTF-8'], ['cp949', 'EUC-KR (CP949)']], s.encoding || '');
    const termType = sel([['', '기본 설정 따름'], ['xterm', 'xterm'], ['xterm-256color', 'xterm-256color'], ['vt100', 'vt100'], ['ansi', 'ansi']], s.termType || '');
    const backspace = sel([['del', 'DEL (^?) — 기본'], ['ctrlh', 'Ctrl+H (^H)']], s.backspace || 'del');
    const keepalive = h('input.inp', { value: s.keepalive ?? 60, style: 'width:90px', inputmode: 'numeric' });
    const autoLog = sel([['default', '기본 설정 따름'], ['on', '항상 저장'], ['off', '저장 안 함']], s.autoLog || 'default');
    const notes = h('textarea.inp', { rows: 2, placeholder: '메모 (위치, 담당자, 특이사항 등)' }, s.notes || '');
    const domain = h('input.inp', { value: s.domain || '', placeholder: '도메인 (없으면 비움)', spellcheck: 'false' });
    const ftps = h('input', { type: 'checkbox', checked: s.ftps });
    const startPath = h('input.inp', { value: s.startPath || '', placeholder: '비우면 홈 폴더 (예: /flash)', spellcheck: 'false' });
    const rdpSize = sel([['full', '전체 화면'], ['1920x1080', '1920 × 1080 창'], ['1600x900', '1600 × 900 창'], ['1366x768', '1366 × 768 창'], ['1280x800', '1280 × 800 창'], ['1024x768', '1024 × 768 창']], s.rdpSize || 'full');
    const rdpClip = h('input', { type: 'checkbox', checked: s.rdpClipboard !== false });
    const rdpDrives = h('input', { type: 'checkbox', checked: s.rdpDrives });
    const rdpAdmin = h('input', { type: 'checkbox', checked: s.rdpAdmin });
    const viewOnly = h('input', { type: 'checkbox', checked: s.viewOnly });
    const webScheme = sel([['https', 'HTTPS (암호화)'], ['http', 'HTTP']], s.webScheme || 'https');
    const webPath = h('input.inp', { value: s.webPath || '', placeholder: '/ (비우면 첫 화면)', spellcheck: 'false' });

    const rowsNet = h('div.grid', field('호스트', h('div.row', h('div.grow', host), h('span.hint', '포트'), port)));
    host.style.width = '100%';
    const rowsSerial = h('div.grid',
      field('COM 포트', h('div.row', serialPort, h('button.btn.sm', { type: 'button', onclick: refreshPorts }, '새로고침'))),
      h('div.full', comHint),
      field('속도 (bps)', baud),
      field('데이터 / 패리티', h('div.row', dataBits, parity, h('span.hint', '정지 비트'), stopBits)),
      field('흐름 제어', flow),
      h('div.full.hint', '시스코·얼라이드텔레시스·알카텔 등 대부분의 콘솔은 9600 / 8 / 없음 / 1 / 흐름 제어 없음입니다.'),
    );
    const rowAuthType = field('인증 방식', authType);
    const rowKey = field('키 파일', h('div.row', keyPath, keyBtn));
    const rowPass = field('키 암호', passphrase);
    const rowAuto = h('div.full', h('label.chk', autoLogin, '화면에 Username / Password 프롬프트가 나오면 자동으로 입력'));
    const rowPwClear = h('div.full', h('label.chk', pwClear, '저장된 비밀번호 지우기'));

    const rowUser = field('사용자 이름', username);
    const rowDomain = field('도메인', domain);
    const loginGrid = h('div.grid',
      rowAuthType,
      rowUser,
      rowDomain,
      field('비밀번호', pw),
      s.hasPassword ? rowPwClear : null,
      rowKey, rowPass, rowAuto,
    );
    const secEnable = h('div.form-section', h('h4', 'enable (관리자 모드)'),
      h('div.grid',
        h('div.full', h('label.chk', enable, '로그인 후 자동으로 enable 진입')),
        field('enable 명령', enableCmd),
        field('enable 비밀번호', enablePw),
        h('div.full.hint', '얼라이드텔레시스(AlliedWare Plus)는 enable 비밀번호가 없는 경우가 많고, 알카텔 OmniSwitch는 enable이 없습니다.'),
      ),
    );
    const fEnc = field('문자 인코딩', encoding, { title: '한글이 깨지는 국산 장비는 EUC-KR로 바꿔보세요' });
    const fTerm = field('터미널 종류', termType);
    const fBs = field('Backspace 키', h('div.row', backspace, h('span.hint', '지울 때 ^H 나 이상한 글자가 찍히면 바꿔보세요')));
    const fKa = field('Keepalive (초)', h('div.row', keepalive, h('span.hint', '0이면 끔. 장비가 유휴 접속을 끊으면 30~60초로')));
    const secTermAdv = h('div.form-section', h('h4', '고급'),
      h('div.grid', fEnc, fTerm, fBs, fKa, field('로그 저장', autoLog)),
    );
    // 로컬 셸
    const shellSel = h('select');
    const shellPath = h('input.inp.grow', { value: s.shellPath || '', placeholder: 'C:\\...\\셸.exe', spellcheck: 'false' });
    const shellPathBtn = h('button.btn.sm', { type: 'button', onclick: async () => { const f = await window.api.pickShell(); if (f && f.error) toast(f.error, 'err'); else if (f) shellPath.value = f; } }, '찾기');
    const cwd = h('input.inp.grow', { value: s.cwd || '', placeholder: '비우면 사용자 폴더', spellcheck: 'false' });
    const cwdBtn = h('button.btn.sm', { type: 'button', onclick: async () => { const d = await window.api.pickFolder({ title: '시작 폴더' }); if (d) cwd.value = d; } }, '찾기');
    const rowShellPath = field('셸 경로', h('div.row', shellPath, shellPathBtn));
    const syncShell = () => rowShellPath.forEach((e) => { e.hidden = shellSel.value !== 'custom'; });
    shellSel.addEventListener('change', syncShell);
    window.api.localShells().then((list) => {
      shellSel.innerHTML = '';
      for (const x of list) shellSel.append(h('option', { value: x.id, selected: x.id === s.shell }, x.name));
      shellSel.append(h('option', { value: 'custom', selected: s.shell === 'custom' }, '직접 지정…'));
      if (!s.shell && list[0]) shellSel.value = list[0].id;
      syncShell();
    });
    const secLocal = h('div.form-section', h('h4', '로컬 셸'),
      h('div.grid',
        field('셸', shellSel),
        rowShellPath,
        field('시작 폴더', h('div.row', cwd, cwdBtn)),
        h('div.full.hint', '이 PC의 PowerShell / cmd / WSL을 탭으로 엽니다. 장비 접속 탭과 똑같이 분할·로그·스마트 링크·위험 명령 경고가 됩니다.'),
      ),
    );
    const secFiles = h('div.form-section', h('h4', '파일 전송'),
      h('div.grid',
        field('시작 폴더', startPath),
        h('div.full.rowFtps', h('label.chk', ftps, 'FTPS (TLS 암호화) 사용')),
        h('div.full.hint', '시스코 등 일부 장비는 SFTP 대신 SCP만 지원합니다. 장비 쪽에서 "ip scp server enable"이나 SFTP 서버 설정이 필요할 수 있어요.'),
      ),
    );
    const secRdp = h('div.form-section', h('h4', '원격 데스크톱'),
      h('div.grid',
        field('화면 크기', rdpSize),
        h('div.full', h('label.chk', rdpClip, '클립보드 공유 (복사·붙여넣기)')),
        h('div.full', h('label.chk', rdpDrives, '내 PC 드라이브를 원격 PC에서 보기 (파일 옮길 때)')),
        h('div.full', h('label.chk', rdpAdmin, '관리자 세션 (/admin)')),
        h('div.full.hint', 'Windows 원격 데스크톱(mstsc) 창이 따로 열립니다. 비밀번호를 저장하면 Windows 자격 증명에 넣어 자동으로 로그인합니다.'),
      ),
    );
    const secVnc = h('div.form-section', h('h4', 'VNC'),
      h('div.grid',
        h('div.full', h('label.chk', viewOnly, '보기 전용으로 열기 (클릭·키 입력 안 보냄)')),
        h('div.full.hint', 'EVE-NG / PNETLab의 GUI 노드는 보통 비밀번호가 없습니다.'),
      ),
    );
    const secNotes = h('div.form-section', h('div.grid', field('메모', notes)));
    const secWeb = h('div.form-section', h('h4', '웹 GUI'),
      h('div.grid',
        field('방식', webScheme),
        field('경로', webPath),
        h('div.full.hint', '아이디/비밀번호를 저장해두면 HTTP 기본 인증은 자동으로, 로그인 화면은 "로그인 정보 입력" 버튼으로 채웁니다 (세션 주소와 같은 페이지에서만). 장비의 자체 서명 인증서는 처음 접속할 때 지문을 확인하고 허용합니다.'),
      ),
    );

    const secTarget = h('div.form-section', h('h4', '접속 대상'), rowsNet, rowsSerial);
    const secLogin = h('div.form-section', h('h4', '로그인'), loginGrid);
    const body = h('div',
      folderList, comList,
      h('div.form-section',
        h('div.grid',
          mode !== 'quick' ? field('세션 이름', name) : null,
          mode !== 'quick' ? field('폴더', folder) : null,
          field('프로토콜', seg),
        ),
      ),
      secTarget,
      secLogin,
      secLocal, secEnable, secFiles, secRdp, secVnc, secWeb, secTermAdv, secNotes,
    );

    function setProto(p) {
      protocol = p;
      for (const [k, b] of Object.entries(segBtns)) b.classList.toggle('on', k === p);
      const isTerm = ['ssh', 'telnet', 'serial'].includes(p);
      rowsNet.hidden = p === 'serial';
      rowsSerial.hidden = p !== 'serial';
      const sshLike = p === 'ssh' || p === 'sftp';
      rowAuthType.forEach((e) => { e.hidden = !sshLike; });
      const key = sshLike && authType.value === 'key';
      [...rowKey, ...rowPass].forEach((e) => { e.hidden = !key; });
      rowAuto.hidden = !(p === 'telnet' || p === 'serial');
      rowUser.forEach((e) => { e.hidden = p === 'vnc'; });
      rowDomain.forEach((e) => { e.hidden = p !== 'rdp'; });
      secEnable.hidden = !isTerm;
      secTermAdv.hidden = !isTerm && p !== 'local';
      const isLocal = p === 'local';
      secLocal.hidden = !isLocal;
      secTarget.hidden = isLocal;
      secLogin.hidden = isLocal;
      [...fEnc, ...fTerm, ...fBs, ...fKa].forEach((e) => { e.hidden = isLocal; });
      secFiles.hidden = !(p === 'sftp' || p === 'ftp');
      $('.rowFtps', secFiles).hidden = p !== 'ftp';
      secRdp.hidden = p !== 'rdp';
      secVnc.hidden = p !== 'vnc';
      secWeb.hidden = p !== 'web';
      port.placeholder = String({ ssh: 22, telnet: 23, sftp: 22, ftp: 21, vnc: 5900, rdp: 3389, web: webScheme.value === 'http' ? 80 : 443 }[p] || '');
      username.placeholder = p === 'ftp' ? '비우면 anonymous' : '아이디';
      if (p === 'serial' && !comList.children.length) refreshPorts();
    }
    authType.addEventListener('change', () => setProto(protocol));
    webScheme.addEventListener('change', () => setProto(protocol));

    function collect() {
      const out = {
        ...session,
        name: name.value.trim(),
        folder: folder.value.trim().replace(/^\/+|\/+$/g, ''),
        protocol,
        host: host.value.trim(),
        port: port.value.trim() ? Number(port.value.trim()) : '',
        username: username.value.trim(),
        authType: (protocol === 'ssh' || protocol === 'sftp') ? authType.value : 'password',
        keyPath: keyPath.value.trim(),
        serialPort: serialPort.value.trim(),
        baudRate: Number(baud.value), dataBits: Number(dataBits.value), parity: parity.value,
        stopBits: Number(stopBits.value), flowControl: flow.value,
        autoLogin: (protocol === 'telnet' || protocol === 'serial') && autoLogin.checked,
        enable: enable.checked, enableCmd: enableCmd.value.trim() || 'enable',
        encoding: encoding.value, termType: termType.value, backspace: backspace.value,
        keepalive: Number(keepalive.value) || 0,
        autoLog: autoLog.value,
        notes: notes.value,
        domain: domain.value.trim(),
        ftps: protocol === 'ftp' && ftps.checked,
        startPath: startPath.value.trim(),
        rdpSize: rdpSize.value, rdpClipboard: rdpClip.checked, rdpDrives: rdpDrives.checked, rdpAdmin: rdpAdmin.checked,
        viewOnly: viewOnly.checked,
        webScheme: webScheme.value,
        webPath: webPath.value.trim(),
        shell: shellSel.value,
        shellPath: shellPath.value.trim(),
        shellName: shellSel.value === 'custom' ? (shellPath.value.trim().split(/[\\/]/).pop() || '로컬 셸') : ((shellSel.selectedOptions[0] || {}).textContent || ''),
        cwd: cwd.value.trim(),
      };
      if (!out.name) out.name = protocol === 'serial' ? out.serialPort : protocol === 'local' ? out.shellName : out.host;
      const secrets = {};
      if (pw.value) secrets.password = pw.value; else if (pwClear.checked) secrets.password = '';
      if (enablePw.value) secrets.enablePassword = enablePw.value;
      if (passphrase.value) secrets.passphrase = passphrase.value;
      return { session: out, secrets };
    }

    async function validate(c) {
      if (c.session.protocol === 'local') {
        if (c.session.shell === 'custom' && !c.session.shellPath) { toast('셸 실행 파일(.exe)을 고르세요.', 'err'); shellPath.focus(); return false; }
        return true;
      }
      if (c.session.protocol === 'serial' ? !c.session.serialPort : !c.session.host) {
        toast(c.session.protocol === 'serial' ? 'COM 포트를 입력하세요.' : '호스트(IP)를 입력하세요.', 'err');
        (c.session.protocol === 'serial' ? serialPort : host).focus();
        return false;
      }
      const pt = Number(c.session.port);
      if (pt && (pt < 1 || pt > 65535)) { toast('포트는 1~65535 사이 숫자입니다.', 'err'); port.focus(); return false; }
      // 흔한 실수: 다른 프로토콜의 기본 포트를 넣은 경우
      const WRONG = {
        sftp: { 20: 'FTP 데이터', 21: 'FTP', 23: '텔넷' }, ftp: { 22: 'SSH/SFTP' }, ssh: { 21: 'FTP', 23: '텔넷', 80: '웹', 443: '웹' },
        telnet: { 22: 'SSH' }, vnc: { 3389: 'RDP', 22: 'SSH' }, rdp: { 5900: 'VNC', 22: 'SSH' },
        web: c.session.webScheme === 'https' ? { 80: 'HTTP', 22: 'SSH', 23: '텔넷' } : { 443: 'HTTPS', 22: 'SSH', 23: '텔넷' },
      };
      const w = (WRONG[c.session.protocol] || {})[pt];
      if (w) {
        const def = { ssh: 22, sftp: 22, telnet: 23, ftp: 21, vnc: 5900, rdp: 3389, web: c.session.webScheme === 'http' ? 80 : 443 }[c.session.protocol];
        const ok = await confirmBox(`${pt}번은 보통 ${w}용 포트입니다.\n${PROTO_NAMES[c.session.protocol]}는 보통 ${def}번을 씁니다. 이대로 할까요?`, { title: '포트 확인', ok: '이대로 진행', cancel: '포트 고치기' });
        if (!ok) { port.focus(); port.select(); return false; }
      }
      return true;
    }

    const done = (action) => async () => {
      const c = collect();
      if (!(await validate(c))) return;
      result = { action, ...c };
      m.close();
    };

    const buttons = mode === 'quick'
      ? [h('button.btn', { onclick: () => m.close() }, '취소'), h('button.btn', { onclick: done('saveConnect') }, '저장하고 연결'), h('button.btn.primary', { onclick: done('connect') }, '연결')]
      : [h('button.btn', { onclick: () => m.close() }, '취소'), h('button.btn', { onclick: done('saveConnect') }, '저장하고 연결'), h('button.btn.primary', { onclick: done('save') }, '저장')];

    const m = openModal({
      title: mode === 'quick' ? '빠른 연결' : mode === 'edit' ? `세션 편집 — ${s.name || ''}` : '새 세션',
      cls: 'wide', body, buttons,
      onClose: () => resolve(result),
    });
    setProto(protocol);
    if (mode !== 'quick') setTimeout(() => (s.name ? host : name).focus(), 30);
  });
}

/** XMODEM / YMODEM 보내기 */
function transferDialog(target) {
  return new Promise((resolve) => {
    let result = null;
    const file = h('input.inp.grow', { value: localStorage.getItem('xferLastFile') || '', placeholder: '보낼 파일 (펌웨어 이미지 등)', spellcheck: 'false' });
    const proto = sel([['xmodem1k', 'XMODEM-1K (빠름, 대부분 지원)'], ['xmodem', 'XMODEM (128바이트, 오래된 장비)'], ['ymodem', 'YMODEM (파일 이름·크기 같이 보냄)']], localStorage.getItem('xferLastProto') || 'xmodem1k');
    const m = openModal({
      title: `파일 보내기 — ${target}`,
      body: h('div',
        h('div.grid',
          field('파일', h('div.row', file, h('button.btn.sm', { onclick: async () => { const f = await window.api.pickFile({ title: '보낼 파일 선택' }); if (f) file.value = f; } }, '찾기'))),
          field('방식', proto),
        ),
        h('div.hint', { style: 'margin-top:14px;line-height:1.7' },
          '1) 장비에서 먼저 XMODEM/YMODEM 받기 명령을 실행하세요. (예: 시스코 ROMMON의 xmodem, 부트로더의 copy xmodem: flash:)', h('br'),
          '2) 화면에 C 글자가 찍히거나 "전송을 시작하라"는 문구가 나오면 아래 "보내기"를 누르세요.', h('br'),
          '3) 9600bps 콘솔은 매우 느립니다 (수십 MB는 몇 시간). 가능하면 장비와 세션 속도를 115200으로 올린 뒤 보내세요.', h('br'),
          'ZMODEM은 이 창이 필요 없습니다: 장비에서 rz를 실행하면 파일 선택창이, sz 파일이름을 실행하면 받기가 자동으로 시작됩니다.'),
      ),
      buttons: [
        h('button.btn', { onclick: () => m.close() }, '취소'),
        h('button.btn.primary', {
          onclick: () => {
            if (!file.value.trim()) { toast('보낼 파일을 고르세요.', 'err'); return; }
            localStorage.setItem('xferLastFile', file.value.trim());
            localStorage.setItem('xferLastProto', proto.value);
            result = { file: file.value.trim(), proto: proto.value };
            m.close();
          },
        }, '보내기'),
      ],
      onClose: () => resolve(result),
    });
  });
}

/** 웹 인증서 확인 (장비 자체 서명 인증서 등) */
function certDialog(p) {
  return new Promise((resolve) => {
    let result = null;
    const fmt = (t) => (t ? new Date(t * 1000).toLocaleDateString('ko-KR') : '?');
    const reason = { 'net::ERR_CERT_AUTHORITY_INVALID': '신뢰할 수 있는 기관이 발급하지 않은 인증서 (자체 서명)', 'net::ERR_CERT_COMMON_NAME_INVALID': '인증서의 이름이 접속한 주소와 다름', 'net::ERR_CERT_DATE_INVALID': '인증서 유효기간이 지났거나 아직 시작 전', 'net::ERR_CERT_WEAK_SIGNATURE_ALGORITHM': '약한 서명 알고리즘(SHA-1 등)' }[p.error] || p.error;
    const body = h('div',
      p.changed
        ? h('div.warn-box', h('b', '경고: 이 장비의 인증서가 바뀌었습니다!'), h('br'), '장비 인증서를 새로 만들었거나 교체했다면 정상이지만, 그런 적이 없다면 중간에서 가로채는 것일 수 있습니다.')
        : h('div', { style: 'margin-bottom:12px;line-height:1.6' }, '이 장비의 HTTPS 인증서는 브라우저가 기본으로 믿지 않는 인증서입니다. 장비 관리 화면은 대부분 자체 서명 인증서라 흔한 일이지만, 지문이 맞는지 확인하고 허용하세요.'),
      h('div.grid',
        field('장비', h('div', p.host)),
        field('이유', h('div', reason)),
        field('발급 대상', h('div', p.subject || '')),
        field('발급자', h('div', p.issuer || '')),
        field('유효기간', h('div', `${fmt(p.validStart)} ~ ${fmt(p.validExpiry)}`)),
      ),
      h('div', { style: 'margin:12px 0 6px', class: 'hint' }, '인증서 지문'),
      h('div.fp', p.fingerprint),
      p.changed ? [h('div', { style: 'margin:12px 0 6px', class: 'hint' }, '이전에 허용한 지문'), h('div.fp', p.oldFingerprint)] : null,
    );
    const m = openModal({
      title: p.changed ? '인증서 변경 감지' : '인증서 확인',
      body,
      buttons: [
        h('button.btn', { onclick: () => m.close() }, '거부'),
        h('button.btn', { onclick: () => { result = 'once'; m.close(); } }, '이번만 허용'),
        h('button.btn' + (p.changed ? '.danger' : '.primary'), { onclick: () => { result = 'save'; m.close(); } }, p.changed ? '새 인증서로 바꾸고 저장' : '허용하고 저장'),
      ],
      onClose: () => resolve(result),
    });
  });
}

/** SSH 로그인 정보 묻기 */
function authDialog(p) {
  return new Promise((resolve) => {
    let result = null;
    const user = h('input.inp', { value: p.username || '', placeholder: '아이디', spellcheck: 'false' });
    const pw = h('input.inp', { type: 'password', placeholder: '비밀번호', autofocus: !p.needUser || !!p.username });
    const save = h('input', { type: 'checkbox' });
    const m = openModal({
      title: p.title || '로그인', cls: 'narrow',
      body: h('div',
        p.retry ? h('div.warn-box', '아이디 또는 비밀번호가 맞지 않습니다.') : null,
        h('div.hint', { style: 'margin-bottom:12px' }, p.host),
        h('div.grid', field('사용자 이름', user), field('비밀번호', pw),
          p.canSave ? h('div.full', h('label.chk', save, '이 세션에 비밀번호 저장')) : null),
      ),
      buttons: [
        h('button.btn', { onclick: () => m.close() }, '취소'),
        h('button.btn.primary', { onclick: () => { result = { username: user.value.trim(), password: pw.value, save: save.checked }; m.close(); } }, '로그인'),
      ],
      onClose: () => resolve(result),
    });
    setTimeout(() => ((p.username && !p.retry) ? pw : (user.value ? pw : user)).focus(), 30);
  });
}

/** SSH 호스트 키 확인 */
function hostKeyDialog(p) {
  return new Promise((resolve) => {
    let result = null;
    const body = h('div',
      p.changed
        ? h('div.warn-box', h('b', '경고: 호스트 키가 바뀌었습니다!'), h('br'),
          '장비를 교체했거나 OS를 재설치했다면 정상이지만, 그런 일이 없었다면 중간에서 누군가 가로채는 것일 수 있습니다.')
        : h('div', { style: 'margin-bottom:12px;line-height:1.6' }, '처음 접속하는 장비입니다. 아래 지문이 맞는지 확인하고 수락하세요.'),
      h('div.grid', field('장비', h('div', p.host)), field('키 종류', h('div', p.type))),
      h('div', { style: 'margin:12px 0 6px', class: 'hint' }, '새 지문'),
      h('div.fp', p.fingerprint),
      p.changed ? [h('div', { style: 'margin:12px 0 6px', class: 'hint' }, '이전에 저장된 지문'), h('div.fp', p.oldFingerprint)] : null,
    );
    const m = openModal({
      title: p.changed ? '호스트 키 변경 감지' : '새 호스트 키',
      body,
      buttons: [
        h('button.btn', { onclick: () => m.close() }, '거부'),
        h('button.btn', { onclick: () => { result = 'once'; m.close(); } }, '이번만 수락'),
        h('button.btn' + (p.changed ? '.danger' : '.primary'), { onclick: () => { result = 'save'; m.close(); } }, p.changed ? '새 키로 교체하고 저장' : '수락하고 저장'),
      ],
      onClose: () => resolve(result),
    });
  });
}

/** 버튼바 편집 */
function buttonsDialog(buttons) {
  return new Promise((resolve) => {
    let result = null;
    let list = buttons.map((b) => ({ ...b }));
    const wrap = h('div.list-editor');
    function render() {
      wrap.innerHTML = '';
      list.forEach((b, i) => {
        const label = h('input.inp', { value: b.label, placeholder: '버튼 이름', style: 'width:150px', oninput: (e) => { b.label = e.target.value; } });
        const cmd = h('textarea.inp', { rows: Math.min(6, Math.max(1, (b.command || '').split('\n').length)), placeholder: '보낼 명령 (여러 줄 가능)', style: 'flex:1', oninput: (e) => { b.command = e.target.value; } }, b.command || '');
        wrap.append(h('div.list-row',
          h('div.handle',
            h('button', { title: '위로', onclick: () => { if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; render(); } } }, '▲'),
            h('button', { title: '아래로', onclick: () => { if (i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; render(); } } }, '▼'),
          ),
          label, cmd,
          h('button.icon-btn', { title: '삭제', html: icon('x'), onclick: () => { list.splice(i, 1); render(); } }),
        ));
      });
      if (!list.length) wrap.append(h('div.hint', '버튼이 없습니다. 아래 "버튼 추가"를 누르세요.'));
    }
    render();
    const m = openModal({
      title: '버튼바 편집', cls: 'wide',
      body: h('div',
        h('div.hint', { style: 'margin-bottom:12px' }, '버튼을 누르면 명령이 현재 탭으로 전송됩니다. Shift+클릭하면 연결된 모든 탭에 보냅니다. 여러 줄은 한 줄씩 Enter와 함께 보냅니다.'),
        wrap,
      ),
      left: [
        h('button.btn', { onclick: () => { list.push({ label: '', command: '' }); render(); const ins = wrap.querySelectorAll('input'); ins[ins.length - 1].focus(); } }, '버튼 추가'),
        h('button.btn', { onclick: async () => { if (await confirmBox('버튼을 기본값으로 되돌릴까요?')) { list = App.defaults.buttons.map((b) => ({ ...b })); render(); } } }, '기본값'),
      ],
      buttons: [
        h('button.btn', { onclick: () => m.close() }, '취소'),
        h('button.btn.primary', { onclick: () => { result = list.filter((b) => b.label.trim() || b.command.trim()).map((b) => ({ label: b.label.trim() || b.command.split('\n')[0].slice(0, 16), command: b.command })); m.close(); } }, '저장'),
      ],
      onClose: () => resolve(result),
    });
  });
}

/** 설정 */
function labSection(s) {
  const statusBox = h('div.fp', { style: 'font-family:inherit;line-height:1.6' }, '확인 중…');
  const autoEnter = h('input', { type: 'checkbox', checked: s.linkAutoEnter !== false, onchange: (e) => { s.linkAutoEnter = e.target.checked; } });
  const autoLog = h('input', { type: 'checkbox', checked: s.linkAutoLog !== false, onchange: (e) => { s.linkAutoLog = e.target.checked; } });
  const scTelnet = h('input', { type: 'checkbox', checked: true });
  const scVnc = h('input', { type: 'checkbox', checked: true });
  const scRdp = h('input', { type: 'checkbox', checked: true });
  const btnReg = h('button.btn.sm.primary', { onclick: () => act('register') }, '선택한 링크를 OiTerm으로 열기');
  const btnUnreg = h('button.btn.sm', { onclick: () => act('unregister') }, '등록 해제');
  const btnApps = h('button.btn.sm', { onclick: () => window.api.openDefaultApps() }, 'Windows 기본 앱 설정 열기');
  const btnTest = h('button.btn.sm', { onclick: () => { window.api.linkTest(); toast('테스트 링크를 열었습니다. 새 탭이 생기면 연동 성공입니다.'); } }, '테스트');

  function show(st) {
    statusBox.innerHTML = '';
    if (!st || !st.supported) { statusBox.append('이 기능은 Windows에서만 동작합니다.'); [btnReg, btnUnreg, btnApps, btnTest].forEach((b) => { b.disabled = true; }); return; }
    const what = { telnet: '텔넷 콘솔 (telnet://)', vnc: 'GUI 노드 (vnc://)', rdp: 'Windows 노드 (rdp://)' };
    let anyRegistered = false;
    for (const sc of ['telnet', 'vnc', 'rdp']) {
      const x = st.schemes[sc];
      anyRegistered = anyRegistered || x.registered;
      let line;
      if (x.ours) line = [h('span', { style: 'color:var(--ok)' }, '● OiTerm'), ' — 노드를 누르면 OiTerm으로 열립니다.'];
      else if (x.registered && x.userChoice) line = [h('span', { style: 'color:var(--warn)' }, '● 거의 다 됨'), ` — Windows "기본 앱"에서 ${x.other || '다른 프로그램'}이(가) 우선입니다. "Windows 기본 앱 설정 열기" → "링크 유형별 기본값" → ${sc.toUpperCase()} → OiTerm`];
      else if (x.otherOiTerm) line = [h('span', { style: 'color:var(--warn)' }, '● 다른 OiTerm'), ` — 다른 폴더의 OiTerm으로 열립니다${x.otherExists ? '' : ' (그 파일은 이제 없음)'}: `, h('code', { style: 'word-break:break-all' }, x.otherPath), '. "선택한 링크를 OiTerm으로 열기"를 누르면 지금 이 OiTerm으로 바뀝니다.'];
      else line = [h('span', { style: 'color:var(--muted)' }, '● 연결 안 됨'), x.other ? ` — 지금은 ${x.other}(으)로 열립니다.` : ' — 열 프로그램이 없습니다.'];
      statusBox.append(h('div', h('b', { style: 'display:inline-block;min-width:170px' }, what[sc]), ...line));
    }
    btnUnreg.disabled = !anyRegistered;
  }
  async function act(kind) {
    const schemes = [scTelnet.checked && 'telnet', scVnc.checked && 'vnc', scRdp.checked && 'rdp'].filter(Boolean);
    const r = kind === 'register' ? await window.api.linkRegister(schemes) : await window.api.linkUnregister();
    if (!r.ok) { toast(r.message, 'err'); return; }
    show(r.status);
    toast(kind === 'register' ? '등록했습니다.' : '등록을 해제했습니다.', 'ok');
  }
  window.api.linkStatus().then(show);

  return h('div.form-section', { id: 'settings-lab' }, h('h4', 'EVE-NG / PNETLab 연동'),
    statusBox,
    h('div.row', { style: 'margin:10px 0 4px;flex-wrap:wrap;gap:14px' },
      h('label.chk', scTelnet, 'telnet:// (콘솔)'), h('label.chk', scVnc, 'vnc:// (GUI 노드 → VNC 탭)'), h('label.chk', scRdp, 'rdp:// (Windows 노드 → 원격 데스크톱)')),
    h('div.row', { style: 'margin:6px 0 10px;flex-wrap:wrap' }, btnReg, btnUnreg, btnApps, btnTest),
    h('div.grid',
      h('div.full', h('label.chk', autoEnter, '링크로 열면 접속 후 Enter를 한 번 보내 프롬프트 띄우기')),
      h('div.full', h('label.chk', autoLog, '링크로 연 탭도 로그 저장 (파일 이름은 노드 이름으로)')),
    ),
    h('div.hint', { style: 'margin-top:8px;line-height:1.7' },
      '1) EVE-NG / PNETLab 로그인 화면에서 콘솔을 Native(Default) Console로 고릅니다.', h('br'),
      '2) 노드를 클릭했을 때 브라우저가 "OiTerm 열기"를 물으면 "항상 허용"에 체크하세요.', h('br'),
      '탭 이름은 랩에서 보내주는 노드 이름을 쓰고, 그게 없으면 프롬프트의 호스트 이름(SW1# → SW1)을 씁니다.'),
  );
}

function settingsDialog(st, section) {
  return new Promise((resolve) => {
    let result = null;
    const s = JSON.parse(JSON.stringify(st));
    const fontFamily = h('input.inp', { value: s.fontFamily, spellcheck: 'false' });
    const fontSize = h('input.inp', { type: 'number', min: 8, max: 32, value: s.fontSize, style: 'width:90px' });
    const theme = sel([['dark', '다크'], ['classic', '클래식 (검정 바탕)'], ['light', '라이트 (흰 바탕)']], s.theme);
    const scrollback = h('input.inp', { type: 'number', min: 1000, max: 200000, step: 1000, value: s.scrollback, style: 'width:120px' });
    const cursorBlink = h('input', { type: 'checkbox', checked: s.cursorBlink });
    const copyOnSelect = h('input', { type: 'checkbox', checked: s.copyOnSelect });
    const rightClickPaste = h('input', { type: 'checkbox', checked: s.rightClickPaste });
    const confirmPaste = h('input', { type: 'checkbox', checked: s.confirmMultiLinePaste });
    const lineDelay = h('input.inp', { type: 'number', min: 0, max: 2000, value: s.lineDelay, style: 'width:90px' });
    const logDir = h('input.inp.grow', { value: s.logDir, spellcheck: 'false' });
    const autoLogAll = h('input', { type: 'checkbox', checked: s.autoLogAll });
    const logTs = h('input', { type: 'checkbox', checked: s.logTimestamps });
    const logLayout = sel([['flat', '한 폴더에 모두'], ['date', '날짜별 폴더'], ['date-device', '날짜별 폴더 → 장비별 폴더']], s.logLayout || 'flat');
    const logDaily = h('input', { type: 'checkbox', checked: !!s.logDaily });
    const logPreview = h('div.full.hint.log-preview');
    const updLogPreview = () => {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      const ymd = day.replace(/-/g, '');
      const t = `${ymd}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const f = logDaily.checked ? (logLayout.value === 'flat' ? `SW1_${ymd}.log` : 'SW1.log') : `SW1_${t}.log`;
      const sub = logLayout.value === 'flat' ? '' : logLayout.value === 'date' ? `${day}\\` : `${day}\\SW1\\`;
      logPreview.textContent = `예) ${(logDir.value || '로그 폴더').replace(/[\\/]+$/, '')}\\${sub}${f}` + (logDaily.checked ? '   — 같은 날 다시 접속하면 이 파일에 이어서 씁니다' : '');
    };
    logLayout.addEventListener('change', updLogPreview);
    logDaily.addEventListener('change', updLogPreview);
    logDir.addEventListener('input', updLogPreview);
    updLogPreview();
    const logHostName = sel([['auto', '콘솔·IP로 바로 접속한 탭은 장비 호스트 이름으로 (추천)'], ['always', '항상 장비 호스트 이름으로'], ['off', '세션 이름 그대로 (EVE 링크만 호스트 이름)']], s.logHostName || 'auto');
    const defEnc = sel([['utf8', 'UTF-8'], ['cp949', 'EUC-KR (CP949)']], s.defaultEncoding);
    const defTerm = sel([['xterm', 'xterm'], ['xterm-256color', 'xterm-256color'], ['vt100', 'vt100'], ['ansi', 'ansi']], s.defaultTermType);
    const hlOn = h('input', { type: 'checkbox', checked: s.highlightEnabled });
    const zmodemOn = h('input', { type: 'checkbox', checked: s.zmodemEnabled !== false });
    const transferDir = h('input.inp.grow', { value: s.transferDir || '', spellcheck: 'false' });

    // 스마트 링크
    const smartOn = h('input', { type: 'checkbox', checked: s.smartLinks !== false });
    const smartRc = h('input', { type: 'checkbox', checked: s.smartRightClick !== false });
    const smartIp = h('input.inp', { value: s.smartIpCmd ?? 'show ip arp {ip}', spellcheck: 'false', style: 'font-family:Consolas,monospace' });
    const smartMac = h('input.inp', { value: s.smartMacCmd ?? 'show mac address-table address {mac}', spellcheck: 'false', style: 'font-family:Consolas,monospace' });
    // 위험 명령
    const dangerOn = h('input', { type: 'checkbox', checked: s.dangerEnabled !== false });
    let rules = (Array.isArray(s.dangerRules) ? s.dangerRules : DANGER_PRESETS).map((r) => ({ ...r }));
    let rulesTouched = Array.isArray(s.dangerRules);
    const rulesWrap = h('div.list-editor.danger-rules');
    function renderRules() {
      rulesWrap.innerHTML = '';
      rules.forEach((r, i) => {
        const touch = () => { rulesTouched = true; };
        const m = h('input.inp.m', { value: r.match, placeholder: '명령 (예: write erase) 또는 re:정규식', spellcheck: 'false', title: r.unless ? `제외: ${r.unless}` : '' });
        const check = () => { let bad = !m.value.trim(); if (m.value.startsWith('re:')) { try { new RegExp(m.value.slice(3)); } catch (_) { bad = true; } } m.style.borderColor = bad ? 'var(--err)' : ''; };
        m.addEventListener('input', () => { r.match = m.value; touch(); check(); });
        check();
        const mode = sel(Object.entries(DANGER_MODE_NAMES), r.mode || 'any');
        mode.addEventListener('change', () => { r.mode = mode.value; touch(); });
        const level = sel(Object.entries(DANGER_LEVEL_NAMES), r.level || 'confirm');
        level.addEventListener('change', () => { r.level = level.value; touch(); });
        const note = h('input.inp.n', { value: r.note || '', placeholder: '설명 (경고 창에 표시)', oninput: (e) => { r.note = e.target.value; touch(); } });
        rulesWrap.append(h('div.list-row', m, mode, level, note, h('button.icon-btn', { title: '삭제', html: icon('x'), onclick: () => { rules.splice(i, 1); touch(); renderRules(); } })));
      });
    }
    renderRules();
    // 로컬 셸
    const localShell = h('select');
    const localLog = h('input', { type: 'checkbox', checked: !!s.localAutoLog });
    window.api.localShells().then((list) => { for (const x of list) localShell.append(h('option', { value: x.id, selected: x.id === s.localShell }, x.name)); });
    const updOn = h('input', { type: 'checkbox', checked: s.updateCheck !== false });
    const updOut = h('span.hint');
    const aboutBox = h('div.hint');
    window.api.about().then((a) => { aboutBox.textContent = `OiTerm ${a.version} · MIT 라이선스 오픈소스. 함께 들어 있는 오픈소스 목록과 라이선스 전문은 아래 버튼으로 볼 수 있습니다.${a.notices ? '' : ' (개발 중 실행이라 라이선스 파일이 아직 없습니다)'}`; });

    let hl = (s.highlights || []).map((r) => ({ ...r }));
    const hlWrap = h('div.list-editor');
    function renderHl() {
      hlWrap.innerHTML = '';
      hl.forEach((r, i) => {
        const sw = h('span.swatch', { style: `background:${HL_SWATCH[r.color] || '#888'}` });
        const color = sel(Object.keys(HL_COLORS).map((c) => [c, { red: '빨강', green: '초록', yellow: '노랑', blue: '파랑', magenta: '보라', cyan: '청록' }[c]]), r.color);
        color.style.width = '90px';
        color.addEventListener('change', () => { r.color = color.value; sw.style.background = HL_SWATCH[r.color]; });
        const pat = h('input.inp', { value: r.pattern, style: 'flex:1;font-family:Consolas,monospace', spellcheck: 'false', oninput: (e) => { r.pattern = e.target.value; check(); } });
        const check = () => { try { new RegExp(pat.value); pat.style.borderColor = ''; } catch (_) { pat.style.borderColor = 'var(--err)'; } };
        check();
        hlWrap.append(h('div.list-row', sw, color, pat, h('button.icon-btn', { title: '삭제', html: icon('x'), onclick: () => { hl.splice(i, 1); renderHl(); } })));
      });
    }
    renderHl();

    const body = h('div',
      h('div.form-section', h('h4', '터미널'),
        h('div.grid',
          field('글꼴', fontFamily),
          field('글자 크기', h('div.row', fontSize, h('span.hint', 'Ctrl + 마우스 휠 / Ctrl + = / Ctrl + - 로도 조절'))),
          field('색 테마', theme),
          field('스크롤백 줄 수', scrollback),
          h('div.full', h('label.chk', cursorBlink, '커서 깜빡임')),
        )),
      h('div.form-section', h('h4', '마우스 / 붙여넣기'),
        h('div.grid',
          h('div.full', h('label.chk', copyOnSelect, '마우스로 선택하면 바로 복사 (SecureCRT/PuTTY 방식)')),
          h('div.full', h('label.chk', rightClickPaste, '오른쪽 클릭 = 붙여넣기 (Shift+오른쪽 클릭은 메뉴)')),
          h('div.full', h('label.chk', confirmPaste, '여러 줄 붙여넣기 전에 확인 (운영 장비 실수 방지)')),
          field('줄 간격 (ms)', h('div.row', lineDelay, h('span.hint', '여러 줄 붙여넣기·버튼·명령창에서 한 줄 보내고 기다리는 시간. 콘솔(9600)에 긴 설정을 넣을 땐 100~300'))),
        )),
      h('div.form-section', h('h4', '로그'),
        h('div.grid',
          field('로그 폴더', h('div.row', logDir, h('button.btn.sm', { onclick: async () => { const d = await window.api.pickFolder({ title: '로그 폴더 선택' }); if (d) logDir.value = d; } }, '찾기'))),
          h('div.full', h('label.chk', autoLogAll, '모든 세션을 자동으로 로그 저장 (세션별로 끌 수 있음)')),
          h('div.full', h('label.chk', logTs, '로그 줄마다 시간 기록 [YYYY-MM-DD HH:MM:SS] (끄면 장비 화면과 똑같이 저장)')),
          field('폴더 구조', logLayout),
          h('div.full', h('label.chk', logDaily, '하루에 장비당 파일 하나 (같은 날 다시 접속하면 같은 파일에 이어서 저장)')),
          logPreview,
          field('탭·로그 파일 이름', logHostName),
          h('div.full.hint', '프롬프트(SW1# 등)에서 호스트 이름을 읽어 탭 이름과 로그 파일 이름(호스트이름_날짜_시간.log)으로 씁니다. 콘솔에서 케이블을 다른 장비로 옮기면 로그 파일도 새로 만듭니다. 탭 이름을 직접 바꾸면 그 탭은 그대로 둡니다.'),
        )),
      h('div.form-section', h('h4', '기본값'),
        h('div.grid', field('문자 인코딩', defEnc), field('터미널 종류', defTerm))),
      h('div.form-section', h('h4', '키워드 색칠'),
        h('div.grid', h('div.full', h('label.chk', hlOn, '장비 출력에서 키워드를 색으로 표시 (down, err-disabled, %LINK-3-UPDOWN 등)'))),
        h('div.hint', { style: 'margin:8px 0' }, '정규식으로 씁니다. \\b는 단어 경계, | 는 "또는". 대소문자는 구분하지 않습니다.'),
        hlWrap,
        h('div.row', { style: 'margin-top:8px' },
          h('button.btn.sm', { onclick: () => { hl.push({ color: 'cyan', pattern: '' }); renderHl(); } }, '규칙 추가'),
          h('button.btn.sm', { onclick: () => { hl = App.defaults.settings.highlights.map((r) => ({ ...r })); renderHl(); } }, '기본값 복원'),
        )),
      h('div.form-section', { id: 'settings-smart' }, h('h4', '스마트 링크 (화면의 IP · MAC 인식)'),
        h('div.grid',
          h('div.full', h('label.chk', smartOn, '장비 출력의 IP·MAC·웹 주소에 마우스를 올리면 밑줄, Ctrl+클릭하면 메뉴 (Ping, Traceroute, 접속, IP 스캔, 제조사 조회)')),
          h('div.full', h('label.chk', smartRc, '오른쪽 클릭 붙여넣기를 써도, 밑줄 친 IP·MAC 위에서 오른쪽 클릭하면 메뉴')),
          field('IP → 장비에 입력', smartIp),
          field('MAC → 장비에 입력', smartMac),
          h('div.full.hint', '메뉴의 "장비에 입력"을 누르면 현재 탭에 이 명령을 쳐 줍니다(Enter는 안 누름). {ip}, {mac}(aabb.ccdd.eeff), {mac:}(aa:bb:..), {mac-}(AA-BB-..) 자리에 값이 들어갑니다. 예) 얼라이드: show mac address-table | include {mac}'),
        )),
      h('div.form-section', { id: 'settings-danger' }, h('h4', '위험 명령 경고'),
        h('div.grid', h('div.full', h('label.chk', dangerOn, 'Enter를 누를 때 위험한 명령이면 확인 받기 (붙여넣기·버튼·명령창으로 보낼 때도)'))),
        h('div.hint', { style: 'margin:8px 0;line-height:1.7' },
          '명령은 줄임말도 잡습니다: "write erase" 규칙은 wr er, write era 도 잡고, "reload"는 rel 도 잡습니다. "re:"로 시작하면 정규식입니다.', h('br'),
          '단계 — 확인: 실행 버튼을 눌러야 함(Enter는 취소) / 장비 이름 입력: 프롬프트의 장비 이름을 똑같이 쳐야 실행 / 차단: 아예 안 보냄.', h('br'),
          '모드 — 인터페이스 모드: SW1(config-if)# 에서만 (예: shutdown). 랩 장비 탭은 탭 우클릭 메뉴에서 그 탭만 끌 수 있습니다.'),
        rulesWrap,
        h('div.row', { style: 'margin-top:8px' },
          h('button.btn.sm', { onclick: () => { rules.push({ match: '', mode: 'any', level: 'confirm', note: '' }); rulesTouched = true; renderRules(); } }, '규칙 추가'),
          h('button.btn.sm', { onclick: () => { rules = DANGER_PRESETS.map((r) => ({ ...r })); rulesTouched = false; renderRules(); } }, '기본값 복원'),
        )),
      h('div.form-section', h('h4', '로컬 셸'),
        h('div.grid',
          field('기본 셸', h('div.row', localShell, h('span.hint', '툴바 "로컬" / Ctrl+Shift+` 로 여는 셸'))),
          h('div.full', h('label.chk', localLog, '로컬 셸 탭도 로그 저장')),
        )),
      h('div.form-section', h('h4', '터미널 파일 전송 (ZMODEM)'),
        h('div.grid',
          h('div.full', h('label.chk', zmodemOn, '장비에서 rz / sz를 실행하면 ZMODEM 전송 자동 시작')),
          field('받은 파일 폴더', h('div.row', transferDir, h('button.btn.sm', { onclick: async () => { const d = await window.api.pickFolder({ title: '받은 파일 폴더' }); if (d) transferDir.value = d; } }, '찾기'))),
        )),
      labSection(s),
      h('div.form-section', { id: 'settings-update' }, h('h4', '업데이트'),
        h('div.grid',
          h('div.full', h('label.chk', updOn, '하루 한 번 새 버전 확인 (GitHub 릴리즈)')),
          h('div.full', h('div.row', h('button.btn.sm', { onclick: () => UpdateUI.manualCheck(updOut) }, '지금 확인'), updOut)),
          h('div.full.hint', 'OiTerm 서명 키로 서명된 파일만 설치합니다. 인터넷이 막힌 망에서 쓰면 꺼두세요. 확인할 때 github.com에만 접속하고, 보내는 정보는 없습니다(OiTerm 버전이 적힌 User-Agent뿐).'),
        )),
      h('div.form-section', h('h4', '정보 / 오픈소스 라이선스'),
        aboutBox,
        h('div.row', { style: 'margin-top:8px' },
          h('button.btn.sm', { onclick: () => window.api.openNotices('notices') }, '오픈소스 라이선스 보기'),
          h('button.btn.sm', { onclick: () => window.api.openNotices('license') }, 'OiTerm 라이선스 (MIT)'),
        )),
      h('div.form-section', h('h4', '세션 가져오기 / 백업'),
        h('div.row',
          h('button.btn.sm', { onclick: async () => { if (await confirmBox('웹 GUI 탭의 쿠키·로그인 상태·캐시와 허용해둔 인증서를 모두 지울까요?', { ok: '지우기', danger: true })) { await window.api.webClearData(); toast('웹 데이터를 지웠습니다.', 'ok'); } } }, '웹 로그인·쿠키 지우기'),
          h('button.btn.sm', { onclick: () => App.importSecureCRT() }, 'SecureCRT 세션 가져오기'),
          h('button.btn.sm', { onclick: () => App.exportBackup() }, '백업 내보내기'),
          h('button.btn.sm', { onclick: () => App.importBackup() }, '백업 가져오기'),
        ),
        h('div.hint', { style: 'margin-top:8px' }, '백업 파일과 SecureCRT 가져오기에는 비밀번호가 포함되지 않습니다. 설정 파일 위치: %APPDATA%\\OiTerm'),
      ),
    );

    const m = openModal({
      title: '설정', cls: 'wide', body,
      buttons: [
        h('button.btn', { onclick: () => m.close() }, '취소'),
        h('button.btn.primary', {
          onclick: () => {
            result = {
              ...s,
              fontFamily: fontFamily.value.trim() || App.defaults.settings.fontFamily,
              fontSize: Math.min(32, Math.max(8, Number(fontSize.value) || 14)),
              theme: theme.value,
              scrollback: Math.min(200000, Math.max(1000, Number(scrollback.value) || 20000)),
              cursorBlink: cursorBlink.checked,
              copyOnSelect: copyOnSelect.checked,
              rightClickPaste: rightClickPaste.checked,
              confirmMultiLinePaste: confirmPaste.checked,
              lineDelay: Math.max(0, Number(lineDelay.value) || 0),
              logDir: logDir.value.trim() || s.logDir,
              autoLogAll: autoLogAll.checked,
              logTimestamps: logTs.checked,
              logHostName: logHostName.value,
              logLayout: logLayout.value,
              logDaily: logDaily.checked,
              defaultEncoding: defEnc.value,
              defaultTermType: defTerm.value,
              highlightEnabled: hlOn.checked,
              highlights: hl.filter((r) => r.pattern.trim()),
              linkAutoEnter: s.linkAutoEnter !== false,
              zmodemEnabled: zmodemOn.checked,
              transferDir: transferDir.value.trim() || s.transferDir,
              linkAutoLog: s.linkAutoLog !== false,
              smartLinks: smartOn.checked,
              smartRightClick: smartRc.checked,
              smartIpCmd: smartIp.value,
              smartMacCmd: smartMac.value,
              dangerEnabled: dangerOn.checked,
              dangerRules: rulesTouched ? rules.filter((r) => r.match && r.match.trim()).map((r) => ({ match: r.match.trim(), mode: r.mode || 'any', level: r.level || 'confirm', note: r.note || '', ...(r.unless ? { unless: r.unless } : {}) })) : null,
              localShell: localShell.value || s.localShell || '',
              localAutoLog: localLog.checked,
              updateCheck: updOn.checked,
            };
            m.close();
          },
        }, '저장'),
      ],
      onClose: () => resolve(result),
    });
    if (section) setTimeout(() => { const el = document.getElementById('settings-' + section); if (el) el.scrollIntoView({ block: 'start' }); }, 50);
  });
}
