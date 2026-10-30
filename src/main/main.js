'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, session } = require('electron');
const { Store } = require('./store');
const { ConnectionManager } = require('./connections');
const { importSecureCRT } = require('./importer');
const protocol = require('./protocol');
const { FileManager } = require('./files');
const vncproxy = require('./vncproxy');
const rdp = require('./rdp');
const { TftpServer } = require('./tftp');
const { WebManager } = require('./web');
const { ScanManager, toCsv, vendorOf } = require('./scanner');
const { NetTools } = require('./nettools');
const localshell = require('./localshell');

let win = null;
let store = null;
let mgr = null;
let fileMgr = null;
const tftp = new TftpServer();
let webMgr = null;
let scanMgr = null;
let netTools = null;
let askSeq = 0;
const pending = new Map();
let rendererReady = false;
const notices = [];
function flushNotices() { if (!rendererReady) return; while (notices.length) send('app:notice', notices.shift()); }
const pendingLinks = [];

/** EVE-NG / PNETLab에서 누른 telnet:// 링크를 탭으로 열기 */
function openLinks(links) {
  for (const l of links) {
    if (rendererReady) send('link:open', l); else pendingLinks.push(l);
  }
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function ask(kind, tabId, payload) {
  return new Promise((resolve) => {
    const id = ++askSeq;
    pending.set(id, resolve);
    send('ask', id, kind, tabId, payload);
  });
}

/** 폴더일 때만 탐색기로 열기 (파일 경로가 들어와도 실행되지 않게) */
function openDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); if (fs.statSync(d).isDirectory()) shell.openPath(d); } catch (_) {}
}

const isWebUrl = (u) => /^https?:\/\//i.test(String(u || ''));

/** IPC는 우리 창의 메인 프레임(file://)에서 온 것만 받음 */
function trusted(e) {
  return !!(win && !win.isDestroyed() && e.sender === win.webContents && e.senderFrame && String(e.senderFrame.url).startsWith('file://'));
}
const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => { if (!trusted(e)) throw new Error('blocked'); return fn(e, ...a); });
const on = (ch, fn) => ipcMain.on(ch, (e, ...a) => { if (trusted(e)) fn(e, ...a); });

function createWindow() {
  const bounds = store.data.windowBounds || { width: 1400, height: 860 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 500,
    title: 'OiTerm',
    backgroundColor: '#1b1d23',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: true, // 웹 GUI 탭용. 붙일 때 web.js가 설정을 강제로 잠금
    },
  });
  if (store.data.windowMaximized) win.maximize();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  // 새 창은 절대 안 띄움. http(s) 링크만 기본 브라우저로 (file:, ms-msdt: 같은 위험한 주소 차단)
  win.webContents.setWindowOpenHandler(({ url }) => { if (isWebUrl(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e, prefs, params) => webMgr.onWillAttach(e, prefs, params));

  win.on('close', (e) => {
    if (!win.forceClose && ((mgr.conns.size > 0 && [...mgr.conns.values()].some((c) => !c.closed)) || fileMgr.sessions.size > 0)) {
      const r = dialog.showMessageBoxSync(win, {
        type: 'question', buttons: ['종료', '취소'], defaultId: 1, cancelId: 1,
        title: 'OiTerm', message: '연결된 세션이 있습니다. 모두 끊고 종료할까요?',
      });
      if (r !== 0) { e.preventDefault(); return; }
    }
    store.data.windowMaximized = win.isMaximized();
    if (!win.isMaximized()) store.data.windowBounds = win.getBounds();
    try { store.save(); } catch (_) {}
    mgr.closeAll();
    fileMgr.closeAll();
    tftp.stop();
    if (scanMgr) scanMgr.stopAll();
    if (netTools) netTools.stopAll();
  });
  win.on('closed', () => { win = null; rendererReady = false; });
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
}

/** 배포본: exe 옆, 개발 중: 프로젝트 폴더 (정해진 파일만 엶) */
function bundledDoc(name) {
  const cands = app.isPackaged ? [path.join(path.dirname(process.execPath), name)] : [path.join(__dirname, '..', '..', 'build', name), path.join(__dirname, '..', '..', name)];
  return cands.find((f) => fs.existsSync(f)) || '';
}
const noticesPath = () => bundledDoc('THIRD-PARTY-NOTICES.txt');
const licensePath = () => bundledDoc('LICENSE.txt');

function registerIpc() {
  handle('store:load', () => ({
    sessions: store.listSessions(),
    settings: store.getSettings(),
    buttons: store.getButtons(),
    defaults: store.defaults(),
    version: app.getVersion(),
    platform: process.platform,
  }));
  handle('session:upsert', (_e, s, secrets) => store.upsertSession(s, secrets));
  handle('session:duplicate', (_e, id) => store.duplicateSession(id));
  handle('session:delete', (_e, id) => { store.deleteSession(id); return true; });
  handle('session:list', () => store.listSessions());
  handle('folder:rename', (_e, from, to) => { store.renameFolder(from, to); return store.listSessions(); });
  handle('settings:save', (_e, st) => store.saveSettings(st));
  handle('buttons:save', (_e, b) => store.saveButtons(b));

  on('conn:open', (_e, tabId, req, cols, rows) => mgr.open(tabId, req, cols, rows));
  on('conn:write', (_e, tabId, data) => mgr.write(tabId, data));
  on('conn:resize', (_e, tabId, cols, rows) => mgr.resize(tabId, cols, rows));
  on('conn:close', (_e, tabId) => mgr.close(tabId));
  on('conn:disconnect', (_e, tabId) => mgr.disconnect(tabId));
  on('conn:break', (_e, tabId) => mgr.sendBreak(tabId));
  handle('log:start', (_e, tabId) => mgr.startLog(tabId));
  on('log:stop', (_e, tabId) => mgr.stopLog(tabId));
  on('log:openFolder', () => {
    openDir(store.getSettings().logDir);
  });
  on('log:showFile', (_e, file) => { if (typeof file === 'string' && fs.existsSync(file) && fs.statSync(file).isFile()) shell.showItemInFolder(file); });
  on('app:openExternal', (_e, url) => { if (isWebUrl(url)) shell.openExternal(url); });
  on('ask:answer', (_e, id, value) => {
    const r = pending.get(id);
    if (r) { pending.delete(id); r(value); }
  });

  handle('serial:list', async () => {
    try {
      const { SerialPort } = require('serialport');
      const ports = await SerialPort.list();
      return ports.map((p) => ({ path: p.path, label: p.friendlyName || [p.path, p.manufacturer].filter(Boolean).join(' - ') }));
    } catch (e) { return []; }
  });

  handle('clip:read', () => clipboard.readText());
  on('clip:write', (_e, text) => clipboard.writeText(String(text || '')));

  handle('dialog:pickFile', async (_e, opts = {}) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'showHiddenFiles'], ...opts });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:pickFolder', async (_e, opts = {}) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], ...opts });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('import:securecrt', async () => {
    const def = path.join(app.getPath('appData'), 'VanDyke', 'Config', 'Sessions');
    const r = await dialog.showOpenDialog(win, {
      title: 'SecureCRT 세션 폴더 선택 (보통 %APPDATA%\\VanDyke\\Config\\Sessions)',
      defaultPath: fs.existsSync(def) ? def : undefined,
      properties: ['openDirectory'],
    });
    if (r.canceled) return null;
    const { sessions, skipped } = importSecureCRT(r.filePaths[0]);
    for (const s of sessions) store.upsertSession({ ...s, folder: s.folder ? `SecureCRT/${s.folder}` : 'SecureCRT' });
    return { count: sessions.length, skipped, sessions: store.listSessions() };
  });

  handle('backup:export', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: '세션 백업 내보내기 (비밀번호 제외)',
      defaultPath: path.join(app.getPath('documents'), 'oiterm-sessions.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled) return null;
    const data = {
      app: 'OiTerm', exported: new Date().toISOString(),
      sessions: store.data.sessions.map(({ secret, ...rest }) => rest),
      buttons: store.getButtons(),
    };
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
    return r.filePath;
  });

  handle('backup:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: '세션 백업 가져오기', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return null;
    const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    let count = 0;
    for (const s of data.sessions || []) {
      const exists = s.id && store.getSession(s.id);
      store.upsertSession(exists ? s : { ...s, id: undefined });
      count++;
    }
    if (Array.isArray(data.buttons) && data.buttons.length) store.saveButtons(data.buttons);
    return { count, sessions: store.listSessions(), buttons: store.getButtons() };
  });

  on('app:rendererReady', () => {
    rendererReady = true;
    while (pendingLinks.length) send('link:open', pendingLinks.shift());
    flushNotices();
  });
  handle('link:status', () => protocol.status());
  handle('link:register', (_e, schemes) => protocol.register(app, store, schemes));
  handle('link:unregister', () => protocol.unregister(store));
  on('link:test', () => shell.openExternal('telnet://127.0.0.1:23/?name=' + encodeURIComponent('연동 테스트')));
  on('link:openDefaultApps', () => shell.openExternal('ms-settings:defaultapps?registeredAppUser=OiTerm').catch(() => shell.openExternal('ms-settings:defaultapps')));

  // ---- RDP ----
  handle('rdp:launch', (_e, req) => {
    const r = mgr.resolve(req);
    if (!r) return { ok: false, message: '세션을 찾을 수 없습니다.' };
    return rdp.launch(app, r.cfg, r.secrets);
  });

  // ---- VNC ----
  handle('vnc:open', async (_e, req) => {
    const r = mgr.resolve(req);
    if (!r) return { ok: false, message: '세션을 찾을 수 없습니다.' };
    const url = await vncproxy.openTarget(r.cfg.host, Number(r.cfg.port) || 5900);
    return { ok: true, url, password: r.secrets.password || '', meta: r.cfg };
  });

  // ---- 파일 전송 (SFTP / FTP) ----
  handle('files:open', (_e, tabId, req) => fileMgr.open(tabId, req));
  handle('files:list', (_e, tabId, dir) => fileMgr.list(tabId, dir));
  handle('files:isDir', (_e, tabId, p) => fileMgr.isDir(tabId, p));
  handle('files:mkdir', (_e, tabId, p) => fileMgr.mkdir(tabId, p));
  handle('files:remove', (_e, tabId, dir, items) => fileMgr.remove(tabId, dir, items));
  handle('files:rename', (_e, tabId, from, to) => fileMgr.rename(tabId, from, to));
  handle('files:upload', (_e, tabId, paths, dir) => fileMgr.upload(tabId, paths, dir));
  handle('files:uploadPick', async (_e, tabId, dir) => {
    const r = await dialog.showOpenDialog(win, { title: '업로드할 파일 선택', properties: ['openFile', 'multiSelections'] });
    if (r.canceled || !r.filePaths.length) return { ok: true, canceled: true };
    return fileMgr.upload(tabId, r.filePaths, dir);
  });
  handle('files:download', async (_e, tabId, dir, items, ask) => {
    let target = store.data.lastDownloadDir || app.getPath('downloads');
    if (ask || !store.data.lastDownloadDir) {
      const r = await dialog.showOpenDialog(win, { title: '받을 폴더 선택', defaultPath: target, properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled) return { ok: true, canceled: true };
      target = r.filePaths[0];
      store.data.lastDownloadDir = target;
      store.save();
    }
    const res = await fileMgr.download(tabId, dir, items, target);
    return { ...res, target };
  });
  on('files:close', (_e, tabId) => fileMgr.close(tabId));
  // 폴더만 열기 (실행 파일 경로가 넘어와도 실행되지 않게)
  on('files:showFolder', (_e, p) => { if (typeof p === 'string' && fs.existsSync(p) && fs.statSync(p).isDirectory()) shell.openPath(p); });

  // ---- 터미널 파일 전송 (XMODEM / YMODEM / ZMODEM) ----
  handle('xfer:xmodem', (_e, tabId, file, proto) => {
    try {
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return { ok: false, message: '파일이 없습니다.' };
      mgr.startXmodem(tabId, file, ['xmodem', 'xmodem1k', 'ymodem'].includes(proto) ? proto : 'xmodem1k');
      return { ok: true };
    } catch (e) { return { ok: false, message: e.message }; }
  });
  on('xfer:cancel', (_e, tabId) => mgr.cancelTransfer(tabId));
  on('xfer:showFolder', () => openDir(store.getSettings().transferDir));

  // ---- 웹 GUI ----
  handle('web:open', (_e, tabId, req) => {
    const r = mgr.resolve(req);
    if (!r) return { ok: false, message: '세션을 찾을 수 없습니다.' };
    return webMgr.open(tabId, r);
  });
  handle('web:register', (_e, tabId, wcId) => webMgr.register(tabId, Number(wcId)));
  handle('web:fill', (_e, tabId) => webMgr.fill(tabId));
  on('web:close', (_e, tabId) => webMgr.close(tabId));
  handle('web:clearData', () => webMgr.clearData());

  // ---- TFTP 서버 ----
  handle('tftp:status', () => tftp.status());
  handle('tftp:start', async (_e, opts) => {
    const st = store.getSettings();
    const cfg = {
      root: (opts && opts.root) || st.tftpRoot,
      allowRead: opts ? !!opts.allowRead : st.tftpAllowRead,
      allowWrite: opts ? !!opts.allowWrite : st.tftpAllowWrite,
      autoStopMin: opts && Number.isFinite(opts.autoStopMin) ? opts.autoStopMin : st.tftpAutoStop,
    };
    store.saveSettings({ ...st, tftpRoot: cfg.root, tftpAllowRead: cfg.allowRead, tftpAllowWrite: cfg.allowWrite, tftpAutoStop: cfg.autoStopMin });
    try { return { ok: true, status: await tftp.start({ ...cfg, port: 69 }) }; } catch (e) { return { ok: false, message: e.message }; }
  });
  handle('tftp:stop', () => { tftp.stop(); return tftp.status(); });
  on('tftp:openRoot', () => openDir((tftp.cfg && tftp.cfg.root) || store.getSettings().tftpRoot));

  // ---- IP 스캔 ----
  handle('scan:preview', (_e, targets) => scanMgr.preview(typeof targets === 'string' ? targets : ''));
  handle('scan:start', (_e, tabId, opts) => scanMgr.start(typeof tabId === 'string' ? tabId : '', opts && typeof opts === 'object' ? opts : {}));
  on('scan:stop', (_e, tabId) => { if (typeof tabId === 'string') scanMgr.stop(tabId); });
  on('scan:forget', (_e, tabId) => { if (typeof tabId === 'string') scanMgr.forget(tabId); });
  handle('scan:localNets', () => require('./scanner').localNets());
  handle('scan:export', async (_e, tabId) => {
    const rows = scanMgr.results(typeof tabId === 'string' ? tabId : '');
    if (!rows.length) return { ok: false, message: '저장할 결과가 없습니다.' };
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `IP스캔-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
    const r = await dialog.showSaveDialog(win, { title: '스캔 결과 저장', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'CSV (엑셀)', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try { fs.writeFileSync(r.filePath, toCsv(rows), 'utf8'); return { ok: true, path: r.filePath }; } catch (e) { return { ok: false, message: e.message }; }
  });

  // ---- 터미널 화면의 IP / MAC (스마트 링크) ----
  handle('tool:run', (_e, kind, ip, opts) => netTools.run(kind, ip, opts && typeof opts === 'object' ? opts : {}));
  on('tool:stop', (_e, id) => { if (typeof id === 'string') netTools.stop(id); });
  handle('smart:vendor', (_e, mac) => (typeof mac === 'string' && mac.length < 40 ? vendorOf(mac) : ''));

  // ---- 로컬 셸 ----
  handle('local:shells', () => localshell.list());
  handle('local:pickShell', async () => {
    const r = await dialog.showOpenDialog(win, { title: '셸 실행 파일 선택', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: '실행 파일', extensions: ['exe'] }] : [] });
    if (r.canceled || !r.filePaths[0]) return null;
    return localshell.validCustom(r.filePaths[0]) ? r.filePaths[0] : { error: '실행 파일(.exe)만 고를 수 있습니다.' };
  });

  // ---- 오픈소스 라이선스 ----
  handle('app:about', () => ({ version: app.getVersion(), notices: noticesPath(), license: licensePath() }));
  on('app:openNotices', (_e, which) => {
    const f = which === 'license' ? licensePath() : noticesPath();
    if (f) shell.openPath(f);
  });

  on('app:forceQuit', () => { if (win) { win.forceClose = true; win.close(); } });
  on('app:setTitle', (_e, t) => { if (win) win.setTitle(t ? `${String(t).slice(0, 120)} - OiTerm` : 'OiTerm'); });
}

// 이름 변경(SwitchTerm → OiTerm): 예전 설정 폴더(세션·암호화된 비밀번호·웹 쿠키·최근 목록)를 그대로 옮김
// 반드시 단일 실행 잠금(설정 폴더에 잠금 파일을 만듦)보다 먼저
(function migrateUserData() {
  if (app.commandLine.hasSwitch('user-data-dir')) return; // 테스트·특수 실행은 건드리지 않음
  const newDir = app.getPath('userData');
  const oldDir = path.join(app.getPath('appData'), 'SwitchTerm');
  if (path.resolve(newDir).toLowerCase() === path.resolve(oldDir).toLowerCase()) return;
  const has = (d, f) => fs.existsSync(path.join(d, f));
  // 새 폴더에 이미 OiTerm 데이터가 있거나, 예전 폴더에 옮길 데이터가 없으면 할 일 없음
  if (has(newDir, 'oiterm-config.json') || has(newDir, 'switchterm-config.json') || !has(oldDir, 'switchterm-config.json')) return;
  try {
    // 새 폴더가 없거나 비어 있으면 통째로 옮기고, 이미 뭔가 생겼으면(실행 초기 파일 등) 내용만 복사 (예전 폴더는 백업으로 남김)
    if (fs.existsSync(newDir) && fs.readdirSync(newDir).length === 0) fs.rmdirSync(newDir);
    if (!fs.existsSync(newDir)) fs.renameSync(oldDir, newDir);
    else fs.cpSync(oldDir, newDir, { recursive: true, force: false, errorOnExist: false });
  } catch (_) {
    app.setPath('userData', oldDir); // 옮기지 못하면(예전 프로그램 실행 중 등) 예전 폴더를 그대로 사용
  }
}());

// 프로그램은 하나만 실행. 이미 켜져 있으면 링크를 기존 창에 넘기고 종료
const firstLinks = protocol.extractLinks(process.argv);
const gotLock = app.requestSingleInstanceLock({ links: firstLinks });

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, _cwd, data) => {
    const links = data && Array.isArray(data.links) && data.links.length ? data.links : protocol.extractLinks(argv);
    openLinks(links);
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    // 카메라·마이크·위치·알림 등 브라우저 권한은 전부 거절
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    store = new Store();
    mgr = new ConnectionManager({
      store, send, ask,
      pickFiles: async (_tabId, title) => {
        const r = await dialog.showOpenDialog(win, { title, properties: ['openFile', 'multiSelections'] });
        return r.canceled ? [] : r.filePaths;
      },
    });
    webMgr = new WebManager({ store, send, ask });
    webMgr.init();
    tftp.on('transfer', (info) => send('tftp:event', info));
    tftp.on('stopped', (msg) => send('tftp:stopped', msg));
    scanMgr = new ScanManager(send);
    netTools = new NetTools(send);
    fileMgr = new FileManager({ store, send, ask, resolve: (req) => mgr.resolve(req) });
    registerIpc();
    createWindow();
    // 예전 이름(SwitchTerm.exe)으로 걸려 있던 링크 연동을 새 exe로 옮김
    protocol.migrateLegacy(app, store).then((moved) => {
      if (moved && moved.length) notices.push(`EVE-NG / PNETLab 링크 연동(${moved.join(', ')})을 OiTerm으로 옮겼습니다.`);
      flushNotices();
    }).catch(() => {});
    if (firstLinks.length) openLinks(firstLinks);
  });

  app.on('window-all-closed', () => app.quit());
}
