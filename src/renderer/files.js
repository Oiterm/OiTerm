'use strict';
/* 파일 전송 탭 (SFTP / FTP / FTPS): 원격 폴더 탐색, 업로드·다운로드 */

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const pjoin = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
const pparent = (p) => { if (!p || p === '/') return '/'; const x = p.replace(/\/+$/, '').split('/'); x.pop(); return x.join('/') || '/'; };

class FileTab extends BaseTab {
  constructor(app, spec) {
    super(app, spec, 'files');
    this.cwd = '';
    this.items = [];
    this.sel = new Set();
    this.anchor = null;
    this.busy = false;

    const tb = (iconName, label, title, fn) => h('button.btn.sm', { title, onclick: fn, html: icon(iconName) + (label ? `<span>${esc(label)}</span>` : '') });
    this.pathInput = h('input.inp.path', { spellcheck: 'false', onkeydown: (e) => { if (e.key === 'Enter') this.load(this.pathInput.value.trim() || '/'); } });
    this.toolbar = h('div.files-bar',
      tb('up', '', '상위 폴더 (Backspace)', () => this.load(pparent(this.cwd))),
      tb('refresh', '', '새로고침 (F5)', () => this.load(this.cwd)),
      this.pathInput,
      tb('upload', '올리기', '내 PC 파일을 이 폴더로 올리기 (탐색기에서 끌어다 놓아도 됨)', () => this.uploadPick()),
      tb('download', '받기', '선택한 파일을 받기', () => this.download(false)),
      tb('folderplus', '새 폴더', '새 폴더 만들기', () => this.mkdir()),
      tb('edit', '', '이름 바꾸기 (F2)', () => this.rename()),
      tb('trash', '', '삭제 (Delete)', () => this.remove()),
    );
    this.list = h('div.files-list', { tabindex: '0' });
    this.status = h('div.files-status');
    this.prog = h('div.files-prog', h('div.bar'));
    this.msg = h('div.vnc-msg');
    this.msg.hidden = true;
    this.body.classList.add('files-body');
    this.body.append(this.toolbar, h('div.files-head', h('span', '이름'), h('span', '크기'), h('span', '수정한 날짜'), h('span', '권한')), this.list, this.prog, this.status, this.msg);

    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.list.addEventListener('contextmenu', (e) => { if (!e.target.closest('.frow')) { e.preventDefault(); this.bgMenu(e); } });
    // 탐색기에서 파일 끌어다 놓기 → 업로드
    this.body.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); this.list.classList.add('dropping'); } });
    this.body.addEventListener('dragleave', (e) => { if (!this.body.contains(e.relatedTarget)) this.list.classList.remove('dropping'); });
    this.body.addEventListener('drop', (e) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      this.list.classList.remove('dropping');
      const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
      if (paths.length) this.upload(paths);
    });
  }

  setStatus(text) { this.status.textContent = text; }

  async connect() {
    window.api.filesClose(this.id);
    this.setState('connecting');
    this.msg.hidden = true;
    const proto = (this.meta.protocol || 'sftp').toUpperCase() + (this.meta.ftps ? 'S' : '');
    this.setStatus(`${proto} ${this.meta.host}:${this.meta.port || (this.meta.protocol === 'ftp' ? 21 : 22)} 접속 중…`);
    const r = await window.api.filesOpen(this.id, this.req);
    if (!r.ok) {
      this.setState('error');
      this.setStatus('');
      this.showMsg('[접속 실패] ' + r.error);
      return;
    }
    if (this.req.sessionId) this.app.addRecent(this.req.sessionId);
    this.setState('connected');
    await this.load(r.path || '/');
    this.list.focus();
  }

  showMsg(text) {
    this.msg.innerHTML = '';
    this.msg.append(h('div', text), h('button.btn.primary', { style: 'margin-top:14px', onclick: () => this.connect() }, '다시 연결'));
    this.msg.hidden = false;
  }

  onClosed() {
    this.setState('closed');
    this.showMsg('[연결 종료] 서버와의 연결이 끊겼습니다.');
  }

  disconnect() { window.api.filesClose(this.id); this.onClosed(); }

  async load(dir) {
    if (this.state !== 'connected') return;
    this.setStatus('불러오는 중…');
    const r = await window.api.filesList(this.id, dir);
    if (!r.ok) { this.setStatus(''); toast('폴더를 열 수 없습니다: ' + r.error, 'err'); this.pathInput.value = this.cwd; return; }
    this.cwd = dir;
    this.pathInput.value = dir;
    this.items = r.result.sort((a, b) => {
      const da = a.type === 'd' ? 0 : 1; const db = b.type === 'd' ? 0 : 1;
      return da - db || a.name.localeCompare(b.name, 'ko', { numeric: true });
    });
    this.sel.clear();
    this.render();
    const files = this.items.filter((i) => i.type !== 'd').length;
    this.setStatus(`폴더 ${this.items.length - files}개, 파일 ${files}개`);
  }

  render() {
    this.list.innerHTML = '';
    if (this.cwd !== '/') {
      this.list.append(h('div.frow.parent', { ondblclick: () => this.load(pparent(this.cwd)) }, h('span.n', { html: icon('up') + '<span>..</span>' }), h('span'), h('span'), h('span')));
    }
    this.items.forEach((it, i) => {
      const row = h('div.frow' + (this.sel.has(i) ? '.sel' : ''), {
        dataset: { i },
        onmousedown: (e) => this.select(i, e),
        ondblclick: () => this.open(it),
        oncontextmenu: (e) => { e.preventDefault(); if (!this.sel.has(i)) this.select(i, {}); this.rowMenu(e); },
      },
      h('span.n', { html: icon(it.type === 'd' ? 'folder' : 'file', it.type === 'd' ? 'dir' : '') + `<span>${esc(it.name)}${it.type === 'l' ? ' →' : ''}</span>` }),
      h('span.s', it.type === 'd' ? '' : fmtSize(it.size)),
      h('span.d', fmtDate(it.mtime) || it.mtimeRaw || ''),
      h('span.p', it.perms || ''));
      this.list.append(row);
    });
    if (!this.items.length) this.list.append(h('div.files-empty', '빈 폴더입니다. 탐색기에서 파일을 끌어다 놓으면 올라갑니다.'));
  }

  select(i, e) {
    if (e.shiftKey && this.anchor !== null) {
      this.sel.clear();
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      for (let k = a; k <= b; k++) this.sel.add(k);
    } else if (e.ctrlKey) {
      if (this.sel.has(i)) this.sel.delete(i); else this.sel.add(i);
      this.anchor = i;
    } else {
      this.sel.clear(); this.sel.add(i); this.anchor = i;
    }
    $$('.frow[data-i]', this.list).forEach((r) => r.classList.toggle('sel', this.sel.has(Number(r.dataset.i))));
  }

  selected() { return [...this.sel].sort((a, b) => a - b).map((i) => this.items[i]).filter(Boolean); }

  async open(it) {
    if (it.type === 'd') return this.load(pjoin(this.cwd, it.name));
    if (it.type === 'l') {
      const r = await window.api.filesIsDir(this.id, pjoin(this.cwd, it.name));
      if (r.ok && r.result) return this.load(pjoin(this.cwd, it.name));
    }
    return this.download(false, [it]);
  }

  onKey(e) {
    if (e.key === 'Enter') { const s = this.selected(); if (s.length === 1) this.open(s[0]); }
    else if (e.key === 'Backspace') this.load(pparent(this.cwd));
    else if (e.key === 'Delete') this.remove();
    else if (e.key === 'F2') this.rename();
    else if (e.key === 'F5') this.load(this.cwd);
    else if (e.ctrlKey && e.key.toLowerCase() === 'a') { e.preventDefault(); this.items.forEach((_, i) => this.sel.add(i)); this.render(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const cur = this.anchor ?? -1;
      const n = Math.max(0, Math.min(this.items.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
      this.select(n, e);
      const row = $(`.frow[data-i="${n}"]`, this.list);
      if (row) row.scrollIntoView({ block: 'nearest' });
    } else return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') e.preventDefault();
  }

  rowMenu(e) {
    const s = this.selected();
    showMenu(e.clientX, e.clientY, [
      s.length === 1 && s[0].type === 'd' ? { label: '열기', key: 'Enter', action: () => this.open(s[0]) } : null,
      { label: `받기${s.length > 1 ? ` (${s.length}개)` : ''}`, action: () => this.download(false) },
      { label: '받을 폴더 골라서 받기…', action: () => this.download(true) },
      '-',
      { label: '이름 바꾸기…', key: 'F2', disabled: s.length !== 1, action: () => this.rename() },
      { label: '경로 복사', action: () => { window.api.clipWrite(s.map((x) => pjoin(this.cwd, x.name)).join('\n')); toast('경로를 복사했습니다.'); } },
      '-',
      { label: '삭제', key: 'Delete', danger: true, action: () => this.remove() },
    ]);
  }

  bgMenu(e) {
    showMenu(e.clientX, e.clientY, [
      { label: '올리기…', action: () => this.uploadPick() },
      { label: '새 폴더…', action: () => this.mkdir() },
      { label: '새로고침', key: 'F5', action: () => this.load(this.cwd) },
      { label: '현재 경로 복사', action: () => window.api.clipWrite(this.cwd) },
    ]);
  }

  // ---------- 작업 ----------
  onProgress(p) {
    const bar = this.prog.firstChild;
    if (p.finished) {
      this.prog.classList.remove('on');
      bar.style.width = '0';
      return;
    }
    this.prog.classList.add('on');
    const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    bar.style.width = pct + '%';
    this.setStatus(`${p.dir === 'up' ? '올리는 중' : '받는 중'}: ${p.name}  ${pct}%  (${fmtSize(p.done)} / ${fmtSize(p.total)})`);
  }

  async download(ask, items) {
    items = items || this.selected();
    if (!items.length) { toast('받을 파일을 고르세요.'); return; }
    const r = await window.api.filesDownload(this.id, this.cwd, items, ask);
    if (r.canceled) return;
    if (!r.ok) { toast('받기 실패: ' + r.error, 'err'); this.setStatus(''); return; }
    this.setStatus(`받기 완료 → ${r.target}`);
    const t = h('div.toast.ok', `${items.length}개 받기 완료 `, h('a', { href: '#', style: 'color:var(--accent);margin-left:6px', onclick: (e) => { e.preventDefault(); window.api.showFolder(r.target); } }, '폴더 열기'));
    $('#toast-root').append(t);
    t.style.pointerEvents = 'auto';
    setTimeout(() => t.remove(), 6000);
  }

  async uploadPick() {
    const r = await window.api.filesUploadPick(this.id, this.cwd);
    if (r.canceled) return;
    this.afterUpload(r);
  }

  async upload(paths) {
    const r = await window.api.filesUpload(this.id, paths, this.cwd);
    this.afterUpload(r);
  }

  async afterUpload(r) {
    if (!r.ok) { toast('올리기 실패: ' + r.error, 'err'); this.setStatus(''); }
    else toast('올리기 완료', 'ok');
    await this.load(this.cwd);
  }

  async mkdir() {
    const name = await promptBox('새 폴더 이름', { title: '새 폴더' });
    if (!name || !name.trim()) return;
    const r = await window.api.filesMkdir(this.id, pjoin(this.cwd, name.trim()));
    if (!r.ok) toast('폴더를 만들 수 없습니다: ' + r.error, 'err');
    await this.load(this.cwd);
  }

  async rename() {
    const s = this.selected();
    if (s.length !== 1) { toast('이름을 바꿀 항목 하나를 고르세요.'); return; }
    const name = await promptBox('새 이름', { title: '이름 바꾸기', value: s[0].name });
    if (!name || !name.trim() || name === s[0].name) return;
    const r = await window.api.filesRename(this.id, pjoin(this.cwd, s[0].name), pjoin(this.cwd, name.trim()));
    if (!r.ok) toast('이름을 바꿀 수 없습니다: ' + r.error, 'err');
    await this.load(this.cwd);
  }

  async remove() {
    const s = this.selected();
    if (!s.length) return;
    const dirs = s.filter((x) => x.type === 'd').length;
    const msg = s.length === 1 ? `"${s[0].name}"을(를) 삭제할까요?` : `${s.length}개 항목을 삭제할까요?`;
    if (!(await confirmBox(msg + (dirs ? '\n폴더는 안의 내용까지 모두 지워집니다.' : ''), { title: '삭제', ok: '삭제', danger: true }))) return;
    this.setStatus('삭제 중…');
    const r = await window.api.filesRemove(this.id, this.cwd, s.map((x) => ({ name: x.name, type: x.type })));
    if (!r.ok) toast('삭제 실패: ' + r.error, 'err');
    await this.load(this.cwd);
  }

  focus() { this.list.focus(); }

  destroy() {
    window.api.filesClose(this.id);
    super.destroy();
  }
}
