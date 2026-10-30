'use strict';
/* 로컬 셸 탭 (PowerShell / cmd / WSL / Git Bash) — node-pty(ConPTY)로 실행
 * - 실행 파일은 정해진 목록(시스템 경로) 또는 설정에서 고른 .exe만
 * - 화면 쪽에서 임의의 명령줄/인자를 넘길 수 없음 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const sys32 = (...p) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...p);
const progFiles = (...p) => path.join(process.env.ProgramFiles || 'C:\\Program Files', ...p);

function candidates() {
  if (process.platform === 'win32') {
    return [
      { id: 'powershell', name: 'Windows PowerShell', file: sys32('WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] },
      { id: 'pwsh', name: 'PowerShell 7', file: progFiles('PowerShell', '7', 'pwsh.exe'), args: ['-NoLogo'] },
      { id: 'cmd', name: '명령 프롬프트 (cmd)', file: sys32('cmd.exe'), args: [] },
      { id: 'wsl', name: 'WSL (리눅스)', file: sys32('wsl.exe'), args: [] },
      { id: 'gitbash', name: 'Git Bash', file: progFiles('Git', 'bin', 'bash.exe'), args: ['--login', '-i'] },
    ];
  }
  return [
    { id: 'bash', name: 'bash', file: '/bin/bash', args: ['-i'] },
    { id: 'zsh', name: 'zsh', file: '/bin/zsh', args: ['-i'] },
    { id: 'sh', name: 'sh', file: '/bin/sh', args: [] },
  ];
}

const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } };
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } };

/** 이 PC에 있는 셸 목록 */
function list() {
  return candidates().filter((c) => isFile(c.file)).map(({ id, name, file }) => ({ id, name, file }));
}

/** 직접 지정한 셸: 절대 경로의 실행 파일(.exe)만 */
function validCustom(p) {
  if (typeof p !== 'string' || !p || p.length > 500 || !path.isAbsolute(p) || !isFile(p)) return false;
  if (process.platform === 'win32') return /\.exe$/i.test(p);
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; }
}

/** 세션 설정 → { file, args, name }. 없으면 예외 */
function resolve(cfg) {
  const shells = candidates().filter((c) => isFile(c.file));
  if (cfg.shell === 'custom') {
    if (!validCustom(cfg.shellPath)) throw new Error(`직접 지정한 셸을 실행할 수 없습니다: ${cfg.shellPath || '(비어 있음)'} — 실행 파일(.exe) 경로를 확인하세요.`);
    return { file: cfg.shellPath, args: [], name: path.basename(cfg.shellPath) };
  }
  const found = shells.find((c) => c.id === cfg.shell) || shells[0];
  if (!found) throw new Error('실행할 수 있는 셸을 찾지 못했습니다.');
  if (cfg.shell && found.id !== cfg.shell) throw new Error(`${cfg.shell} 셸이 이 PC에 없습니다. 세션 편집에서 다른 셸을 고르세요.`);
  return { file: found.file, args: found.args, name: found.name };
}

function cwdFor(cfg) {
  const d = typeof cfg.cwd === 'string' ? cfg.cwd.trim() : '';
  if (d && path.isAbsolute(d) && isDir(d)) return d;
  return os.homedir();
}

/** 자식 프로세스에 넘길 환경 변수 (Electron 전용 변수는 뺌) */
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^ELECTRON_|^NODE_OPTIONS$|^NODE_PATH$/i.test(k)) continue;
    env[k] = v;
  }
  if (process.platform !== 'win32') env.TERM = 'xterm-256color';
  env.TERM_PROGRAM = 'OiTerm';
  return env;
}

let pty = null;
/** node-pty: 배포본에서는 asar 밖(app.asar.unpacked)에 풀린 걸 직접 불러옴 (ConPTY 보조 스크립트가 실제 파일이어야 함) */
function loadPty(app) {
  if (pty) return pty;
  const unpacked = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', 'node-pty');
  const dir = app && app.isPackaged && isDir(unpacked) ? unpacked : path.dirname(require.resolve('node-pty/package.json'));
  pty = require(dir);
  if (process.platform === 'win32') {
    // node-pty는 셸을 끌 때 콘솔 프로세스 목록을 얻으려고 실행 파일(OiTerm.exe)을 Node 모드로 하나 더 띄우는데,
    // OiTerm은 보안 설정(RunAsNode 퓨즈 꺼짐)으로 그게 안 되므로 그 단계를 건너뛰고 taskkill로 자식까지 정리함
    try {
      const agent = require(path.join(dir, 'lib', 'windowsPtyAgent'));
      agent.WindowsPtyAgent.prototype._getConsoleProcessList = function () { return Promise.resolve([]); };
    } catch (_) {}
  }
  return pty;
}

/** 셸과 그 안에서 돌던 프로그램(ping -t 등)까지 끄기 */
function killTree(p) {
  let done = false;
  const kill = () => { if (done) return; done = true; try { p.kill(); } catch (_) {} };
  if (process.platform === 'win32' && p && p.pid) {
    // 셸이 먼저 죽으면 자식 목록을 못 찾으니 taskkill이 끝난 뒤 pty를 닫음
    try {
      require('child_process').execFile(sys32('taskkill.exe'), ['/T', '/F', '/PID', String(p.pid)], { windowsHide: true, timeout: 3000 }, kill);
      setTimeout(kill, 3500);
      return;
    } catch (_) {}
  }
  kill();
}

module.exports = { list, resolve, cwdFor, childEnv, loadPty, killTree, validCustom };
