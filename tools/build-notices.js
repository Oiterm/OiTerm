// 배포용 오픈소스 고지 만들기
// → build/THIRD-PARTY-NOTICES.txt  (함께 배포되는 모든 라이브러리의 이름·버전·라이선스·전문)
// → build/third_party/noVNC/        (MPL-2.0: 수정한 noVNC 소스 + 변경 내역)
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build');
const pkgRoot = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// 배포본에서 빼는 패키지 (빌드할 때만 쓰는 헤더 등)
const SKIP = new Set(['node-addon-api', '@novnc/novnc']); // noVNC는 아래에서 따로 (묶어서 씀)

function licenseFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(f)).sort();
  } catch (_) { return []; }
}
function repoUrl(p) {
  const r = p.repository;
  const u = typeof r === 'string' ? r : r && r.url;
  return (p.homepage || u || '').replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://');
}
const line = '='.repeat(78);

const dirs = execSync('npm ls --omit=dev --all --parseable', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  .split(/\r?\n/).filter(Boolean).slice(1);
const seen = new Map();
for (const d of dirs) {
  let p;
  try { p = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch (_) { continue; }
  if (SKIP.has(p.name)) continue;
  const key = `${p.name}@${p.version}`;
  if (seen.has(key)) continue;
  const lic = p.license || (Array.isArray(p.licenses) ? p.licenses.map((x) => x.type).join(' OR ') : '') || '(표기 없음)';
  const files = licenseFiles(d).map((f) => ({ f, text: fs.readFileSync(path.join(d, f), 'utf8').trim() }));
  seen.set(key, { name: p.name, version: p.version, license: lic, url: repoUrl(p), files });
}

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));

// 따로 넣는 것들 (npm 목록에 안 잡히거나 다른 형태로 들어간 것)
const nm = (...p) => path.join(ROOT, 'node_modules', ...p);
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '');
const novncPkg = JSON.parse(read(nm('@novnc', 'novnc', 'package.json')) || '{}');
const ouiPkg = JSON.parse(read(nm('oui-data', 'package.json')) || '{}');
const extras = [
  {
    name: 'Electron (Chromium, Node.js 포함)', version: JSON.parse(read(nm('electron', 'package.json')) || '{}').version, license: 'MIT (Chromium·Node.js 구성 요소는 각자의 라이선스)',
    url: 'https://github.com/electron/electron',
    files: [{ f: '안내', text: 'Electron 라이선스는 같은 폴더의 LICENSE.electron.txt, Chromium과 그 구성 요소(FFmpeg 등)의 라이선스는 LICENSES.chromium.html 에 있습니다.' }],
  },
  {
    name: 'noVNC', version: novncPkg.version, license: 'MPL-2.0 (일부 파일 BSD / MIT / Zlib — 아래 LICENSE 전문 참고)', url: 'https://github.com/novnc/noVNC',
    files: [
      { f: '사용 방식', text: 'resources 안의 vendor/novnc.js 로 묶어서 사용합니다. 묶을 때 core/util/browser.js 한 줄(최상위 await)을 Promise로 바꿨습니다.\n수정한 파일을 포함한 noVNC 소스와 변경 내역(OITERM-CHANGES.diff)은 배포 폴더의 third_party/noVNC 에 있습니다.' },
      { f: 'LICENSE.txt', text: read(nm('@novnc', 'novnc', 'LICENSE.txt')) },
      { f: 'vendor/pako/LICENSE', text: read(nm('@novnc', 'novnc', 'vendor', 'pako', 'LICENSE')) },
    ],
  },
  {
    name: 'oui-data (IEEE MAC 제조사 목록)', version: ouiPkg.version, license: ouiPkg.license || 'BSD-2-Clause', url: 'https://github.com/silverwind/oui-data',
    files: [
      { f: '사용 방식', text: '제조사 이름만 뽑아 resources 안의 src/main/oui.json 으로 넣었습니다. 원본 데이터는 IEEE Registration Authority의 공개 목록입니다.' },
      { f: 'LICENSE', text: read(nm('oui-data', 'LICENSE')) },
    ],
  },
  {
    name: 'winpty (node-pty에 포함, 오래된 Windows용)', version: '', license: 'MIT', url: 'https://github.com/rprichard/winpty',
    files: [{ f: 'LICENSE', text: read(nm('node-pty', 'deps', 'winpty', 'LICENSE')) }],
  },
];

let out = '﻿';
out += `OiTerm ${pkgRoot.version} — 오픈소스 고지 (Third-party notices)\n${line}\n\n`;
out += 'OiTerm 자체 코드는 MIT 라이선스입니다 (LICENSE.txt).\n';
out += '아래는 OiTerm에 함께 들어 있는 오픈소스 소프트웨어와 그 라이선스입니다.\n';
out += '배포할 때는 이 파일, LICENSE.txt, LICENSE.electron.txt, LICENSES.chromium.html, third_party 폴더를 함께 두세요.\n\n';
out += '목록\n';
for (const e of [...extras, ...entries]) out += `  - ${e.name}${e.version ? ' ' + e.version : ''} — ${e.license}\n`;
out += '\n';
for (const e of [...extras, ...entries]) {
  out += `${line}\n${e.name}${e.version ? ' ' + e.version : ''}\n라이선스: ${e.license}\n${e.url ? '출처: ' + e.url + '\n' : ''}${line}\n`;
  if (!e.files.length) out += '(패키지에 라이선스 파일이 없습니다. 위 라이선스 표기를 따릅니다.)\n';
  for (const f of e.files) if (f.text) out += `--- ${f.f} ---\n${f.text}\n\n`;
  out += '\n';
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'THIRD-PARTY-NOTICES.txt'), out.replace(/\r?\n/g, '\r\n'));

// noVNC 소스 (MPL-2.0 3.2: 실행 형태로 배포하면 소스도 받을 수 있어야 함)
const nv = path.join(OUT, 'third_party', 'noVNC');
fs.rmSync(nv, { recursive: true, force: true });
fs.mkdirSync(nv, { recursive: true });
for (const f of ['core', 'vendor', 'LICENSE.txt', 'AUTHORS', 'README.md', 'package.json']) {
  const src = nm('@novnc', 'novnc', f);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(nv, f), { recursive: true });
}
// 수정 내용 적용한 파일 + diff
const bf = path.join(nv, 'core', 'util', 'browser.js');
const orig = fs.readFileSync(bf, 'utf8');
const re = /supportsWebCodecsH264Decode = await (_checkWebCodecsH264DecodeSupport\(\));/;
const patched = orig.replace(re, '$1.then((v) => { supportsWebCodecsH264Decode = v; });');
if (patched === orig) throw new Error('noVNC 수정 위치를 찾지 못했습니다 (tools/build-novnc.js와 맞춰야 함)');
const lines0 = orig.split('\n');
const idx = lines0.findIndex((l) => re.test(l));
fs.writeFileSync(bf, patched);
fs.writeFileSync(path.join(nv, 'OITERM-CHANGES.diff'), [
  `OiTerm이 noVNC ${novncPkg.version}에서 바꾼 부분 (이 폴더의 core/util/browser.js 에 이미 적용됨)`,
  '이유: 한 파일로 묶을(esbuild IIFE) 때 최상위 await를 쓸 수 없어서 같은 동작을 Promise로 바꿈',
  '',
  '--- a/core/util/browser.js',
  '+++ b/core/util/browser.js',
  `@@ -${idx + 1},1 +${idx + 1},1 @@`,
  '-' + lines0[idx],
  '+' + lines0[idx].replace(re, '$1.then((v) => { supportsWebCodecsH264Decode = v; });'),
  '',
].join('\r\n'));
console.log(`고지 ${entries.length + extras.length}개 → build/THIRD-PARTY-NOTICES.txt (${(fs.statSync(path.join(OUT, 'THIRD-PARTY-NOTICES.txt')).size / 1024).toFixed(0)} KB), noVNC 소스 → build/third_party/noVNC`);
