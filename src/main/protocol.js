'use strict';
// EVE-NG / PNETLab Native Console 링크(telnet:// vnc:// rdp://)를 OiTerm으로 열도록 Windows에 등록
// 관리자 권한 없이 현재 사용자(HKCU)에만 기록한다.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMES = ['telnet', 'vnc', 'rdp'];
const DEFAULT_PORT = { telnet: 23, ssh: 22, vnc: 5900, rdp: 3389 };
const progId = (scheme) => `OiTerm.${scheme}`;
const ucKey = (scheme) => `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`;

/** 링크 파싱: telnet://host:port, vnc://host:port, rdp://host:port, ?name=노드이름, #노드이름 */
function parseLink(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/^"|"$/g, '');
  if (!/^(telnet|ssh|vnc|rdp):\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    const protocol = u.protocol.replace(':', '').toLowerCase();
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!host) return null;
    const port = Number(u.port) || DEFAULT_PORT[protocol];
    const name = (u.searchParams.get('name') || decodeURIComponent((u.hash || '').slice(1)) || '').trim();
    return { protocol, host, port, username: decodeURIComponent(u.username || ''), name };
  } catch (_) {
    return null;
  }
}

function extractLinks(argv) {
  return (argv || []).map(parseLink).filter(Boolean);
}

/** 브라우저가 실행할 명령줄 */
function launchCommand(app) {
  const exe = process.execPath;
  if (app.isPackaged) return { exe, cmd: `"${exe}" "%1"` };
  const appDir = path.resolve(process.argv[1] || '.');
  return { exe, cmd: `"${exe}" "${appDir}" "%1"` };
}

// .reg 파일 문자열 이스케이프
const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const HK = 'HKEY_CURRENT_USER';

function buildRegisterReg(exe, cmd, schemes = SCHEMES) {
  const L = ['Windows Registry Editor Version 5.00', ''];
  for (const sc of schemes) {
    const pid = progId(sc);
    L.push(
      `[${HK}\\Software\\Classes\\${pid}]`, `@=${q(`URL:${sc} Protocol (OiTerm)`)}`, '"URL Protocol"=""', '',
      `[${HK}\\Software\\Classes\\${pid}\\DefaultIcon]`, `@=${q(`"${exe}",0`)}`, '',
      `[${HK}\\Software\\Classes\\${pid}\\shell\\open\\command]`, `@=${q(cmd)}`, '',
      `[-${HK}\\Software\\Classes\\${sc}\\shell]`, '',
      `[${HK}\\Software\\Classes\\${sc}]`, `@=${q(`URL:${sc} Protocol`)}`, '"URL Protocol"=""', '',
      `[${HK}\\Software\\Classes\\${sc}\\DefaultIcon]`, `@=${q(`"${exe}",0`)}`, '',
      `[${HK}\\Software\\Classes\\${sc}\\shell\\open\\command]`, `@=${q(cmd)}`, '',
    );
  }
  L.push(
    `[${HK}\\Software\\OiTerm\\Capabilities]`, '"ApplicationName"="OiTerm"', `"ApplicationDescription"=${q('SSH / Telnet / Serial / VNC terminal')}`, '',
    `[${HK}\\Software\\OiTerm\\Capabilities\\URLAssociations]`,
    ...schemes.map((sc) => `${q(sc)}=${q(progId(sc))}`), '',
    `[${HK}\\Software\\RegisteredApplications]`, `"OiTerm"=${q('Software\\OiTerm\\Capabilities')}`, '',
  );
  return L.join('\r\n');
}

function buildUnregisterReg(schemes, prev = {}) {
  const L = ['Windows Registry Editor Version 5.00', ''];
  for (const sc of schemes) {
    L.push(`[-${HK}\\Software\\Classes\\${progId(sc)}]`, '', `[-${HK}\\Software\\Classes\\${sc}]`, '');
    if (prev[sc]) {
      L.push(
        `[${HK}\\Software\\Classes\\${sc}]`, `@=${q(`URL:${sc} Protocol`)}`, '"URL Protocol"=""', '',
        `[${HK}\\Software\\Classes\\${sc}\\shell\\open\\command]`, `@=${q(prev[sc])}`, '',
      );
    }
  }
  return L.join('\r\n');
}

// 이름 변경 전(SwitchTerm) 등록 흔적 지우기 — 우리가 만든 키만
const LEGACY_CLEANUP_REG = ['Windows Registry Editor Version 5.00', '',
  ...SCHEMES.flatMap((sc) => [`[-${HK}\\Software\\Classes\\SwitchTerm.${sc}]`, '']),
  `[-${HK}\\Software\\SwitchTerm]`, '', `[${HK}\\Software\\RegisteredApplications]`, '"SwitchTerm"=-', ''].join('\r\n');

const UNREGISTER_APP_REG = ['Windows Registry Editor Version 5.00', '',
  `[-${HK}\\Software\\OiTerm]`, '', `[${HK}\\Software\\RegisteredApplications]`, '"OiTerm"=-', ''].join('\r\n');

const clearUserChoiceReg = (sc) => ['Windows Registry Editor Version 5.00', '',
  `[-${ucKey(sc).replace('HKCU', HK)}]`, '', `[-${ucKey(sc).replace('HKCU', HK)}Latest]`, ''].join('\r\n');

// 이름만 쓰면 현재 폴더의 reg.exe가 먼저 실행될 수 있어서 System32 절대 경로로 실행
const REG_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

/** 값 하나 읽기 (기본값이면 name 생략). 한글 Windows의 "(기본값)" 표기와 무관하게 REG_SZ 줄로 파싱 */
async function regGet(key, name) {
  const args = ['query', key];
  if (name) args.push('/v', name); else args.push('/ve');
  const r = await run(REG_EXE, args);
  if (!r.ok) return null;
  const m = /REG_(?:EXPAND_)?SZ[ \t]*(.*)$/m.exec(r.stdout);
  return m ? m[1].trim() : null;
}

async function regImport(content) {
  const file = path.join(os.tmpdir(), `oiterm-${process.pid}-${Date.now()}.reg`);
  // reg import는 UTF-16LE(BOM) .reg 파일을 가장 안정적으로 읽음
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]));
  const r = await run(REG_EXE, ['import', file]);
  try { fs.unlinkSync(file); } catch (_) {}
  return r;
}

/** "기본 앱"에서 고른 프로그램 (Windows 11 24H2부터는 UserChoiceLatest도 확인) */
async function userChoiceProgId(sc) {
  return (await regGet(ucKey(sc), 'ProgId'))
    || (await regGet(ucKey(sc) + 'Latest', 'ProgId'))
    || (await regGet(ucKey(sc) + 'Latest\\ProgId', 'ProgId'));
}

const isOurs = (cmd) => !!cmd && cmd.toLowerCase().includes(process.execPath.toLowerCase());

async function schemeStatus(sc) {
  const hkcuCmd = await regGet(`HKCU\\Software\\Classes\\${sc}\\shell\\open\\command`);
  const userChoice = await userChoiceProgId(sc);
  let effectiveCmd = null;
  if (userChoice) {
    effectiveCmd = await regGet(`HKCU\\Software\\Classes\\${userChoice}\\shell\\open\\command`)
      || await regGet(`HKLM\\Software\\Classes\\${userChoice}\\shell\\open\\command`);
  } else {
    effectiveCmd = hkcuCmd || await regGet(`HKLM\\Software\\Classes\\${sc}\\shell\\open\\command`);
  }
  const ours = isOurs(effectiveCmd);
  let other = '';
  if (!ours && effectiveCmd) {
    const m = /"?([^"]+?\.(?:exe|cmd|bat|vbs))"?/i.exec(effectiveCmd);
    other = m ? path.basename(m[1]) : effectiveCmd;
    if (/url\.dll/i.test(effectiveCmd)) other = 'Windows 기본 텔넷';
  }
  return { registered: isOurs(hkcuCmd), ours, userChoice, other };
}

/** 각 링크 종류가 지금 어떤 프로그램으로 열리는지 */
async function status() {
  if (process.platform !== 'win32') return { supported: false };
  const out = { supported: true, schemes: {} };
  for (const sc of SCHEMES) out.schemes[sc] = await schemeStatus(sc);
  return out;
}

async function register(app, store, schemes = SCHEMES) {
  if (process.platform !== 'win32') return { ok: false, message: 'Windows에서만 지원합니다.' };
  schemes = schemes.filter((s) => SCHEMES.includes(s));
  if (!schemes.length) return { ok: false, message: '등록할 링크 종류를 고르세요.' };
  // 원래 걸려 있던 프로그램은 해제할 때 되돌리려고 보관
  store.data.prevLinkCommands = store.data.prevLinkCommands || {};
  if (store.data.prevTelnetCommand) { store.data.prevLinkCommands.telnet = store.data.prevTelnetCommand; delete store.data.prevTelnetCommand; }
  for (const sc of schemes) {
    const prev = await regGet(`HKCU\\Software\\Classes\\${sc}\\shell\\open\\command`);
    // 예전 이름(SwitchTerm.exe)은 "원래 쓰던 프로그램"으로 기억하지 않음
    if (prev && !isOurs(prev) && !/switchterm\.exe/i.test(prev)) store.data.prevLinkCommands[sc] = prev;
  }
  store.save();
  const { exe, cmd } = launchCommand(app);
  const r = await regImport(buildRegisterReg(exe, cmd, schemes));
  if (!r.ok) return { ok: false, message: '레지스트리에 쓰지 못했습니다: ' + (r.stderr || r.err.message).trim() };
  await regImport(LEGACY_CLEANUP_REG);
  // "기본 앱"에서 다른 프로그램(PuTTY, UltraVNC 등)을 골라둔 기록이 있으면 지워야 우리 등록이 적용됨
  for (const sc of schemes) {
    const uc = await userChoiceProgId(sc);
    if (uc && uc !== progId(sc) && uc.toLowerCase() !== sc) await regImport(clearUserChoiceReg(sc));
  }
  return { ok: true, status: await status() };
}

async function unregister(store) {
  if (process.platform !== 'win32') return { ok: false, message: 'Windows에서만 지원합니다.' };
  const prev = { ...(store.data.prevLinkCommands || {}) };
  if (store.data.prevTelnetCommand) prev.telnet = store.data.prevTelnetCommand;
  const st = await status();
  const mine = SCHEMES.filter((sc) => st.schemes[sc].registered);
  let r = { ok: true };
  if (mine.length) r = await regImport(buildUnregisterReg(mine, prev));
  await regImport(UNREGISTER_APP_REG);
  await regImport(LEGACY_CLEANUP_REG);
  if (!r.ok) return { ok: false, message: '레지스트리를 정리하지 못했습니다: ' + (r.stderr || r.err.message).trim() };
  delete store.data.prevLinkCommands;
  delete store.data.prevTelnetCommand;
  store.save();
  return { ok: true, status: await status() };
}

/** 설치 프로그램으로 깐 OiTerm인지 (같은 폴더에 제거 프로그램) */
function installedHere() {
  try { return fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall OiTerm.exe')); } catch (_) { return false; }
}

/** 예전 SwitchTerm.exe나 다른 위치의 OiTerm.exe로 등록돼 있던 링크 종류를 지금 exe로 다시 등록 (사용자가 이미 켜둔 것만) */
async function migrateLegacy(app, store) {
  if (process.platform !== 'win32') return [];
  const legacy = [];
  const here = installedHere();
  for (const sc of SCHEMES) {
    const cmd = await regGet(`HKCU\\Software\\Classes\\${sc}\\shell\\open\\command`);
    if (!cmd || isOurs(cmd)) continue;
    if (/switchterm\.exe/i.test(cmd)) { legacy.push(sc); continue; }
    // 다른 위치의 OiTerm.exe로 걸려 있음: 그 파일이 없어졌거나(zip 폴더 삭제·이동), 지금 것이 설치 버전이면 지금 것으로
    const m = /"([^"]*oiterm\.exe)"/i.exec(cmd);
    if (m && (!fs.existsSync(m[1]) || here)) legacy.push(sc);
  }
  if (!legacy.length) return [];
  const r = await register(app, store, legacy);
  return r.ok ? legacy : [];
}

module.exports = { migrateLegacy, parseLink, extractLinks, status, register, unregister, buildRegisterReg, buildUnregisterReg, launchCommand, SCHEMES };
