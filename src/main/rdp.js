'use strict';
// RDP: Windows 원격 데스크톱(mstsc)을 .rdp 파일로 실행
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { safeName } = require('./logger');

const SIZES = { full: null, '1920x1080': [1920, 1080], '1600x900': [1600, 900], '1366x768': [1366, 768], '1280x800': [1280, 800], '1024x768': [1024, 768] };

function buildRdp(cfg) {
  const port = Number(cfg.port) || 3389;
  const addr = port === 3389 ? cfg.host : `${cfg.host}:${port}`;
  const user = cfg.username ? (cfg.domain ? `${cfg.domain}\\${cfg.username}` : cfg.username) : '';
  const size = SIZES[cfg.rdpSize || 'full'];
  const lines = [
    `full address:s:${addr}`,
    `screen mode id:i:${size ? 1 : 2}`,
    size ? `desktopwidth:i:${size[0]}` : null,
    size ? `desktopheight:i:${size[1]}` : null,
    'session bpp:i:32',
    'smart sizing:i:1',
    'dynamic resolution:i:1',
    'use multimon:i:0',
    `redirectclipboard:i:${cfg.rdpClipboard === false ? 0 : 1}`,
    `drivestoredirect:s:${cfg.rdpDrives ? '*' : ''}`,
    `administrative session:i:${cfg.rdpAdmin ? 1 : 0}`,
    'authentication level:i:2',
    'prompt for credentials:i:0',
    'autoreconnection enabled:i:1',
    'audiomode:i:0',
    user ? `username:s:${user}` : null,
  ].filter(Boolean);
  return { text: lines.join('\r\n') + '\r\n', user };
}

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true }, (err) => resolve(!err)));
}

async function launch(app, cfg, secrets) {
  if (process.platform !== 'win32') return { ok: false, message: 'RDP는 Windows에서만 열 수 있습니다.' };
  if (!cfg.host) return { ok: false, message: '호스트가 없습니다.' };
  const { text, user } = buildRdp(cfg);
  // 비밀번호가 저장돼 있으면 Windows 자격 증명에 넣어서 자동 로그인 (mstsc가 직접 읽음)
  if (secrets && secrets.password && user) {
    await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmdkey.exe'), [`/generic:TERMSRV/${cfg.host}`, `/user:${user}`, `/pass:${secrets.password}`]);
  }
  const dir = path.join(app.getPath('userData'), 'rdp');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeName(cfg.name || cfg.host)}.rdp`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mstsc.exe'), [file], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return { ok: true };
}

module.exports = { launch, buildRdp };
