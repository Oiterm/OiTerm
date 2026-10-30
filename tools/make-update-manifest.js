// 릴리즈용 latest.json 만들고 업데이트 서명 키로 서명
//   OITERM_UPDATE_KEY (PEM 개인 키, GitHub Secrets) 또는  --key <파일>
//   결과: dist/latest.json, dist/latest.json.sig, dist/RELEASE_NOTES.md
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verifyManifest, PUBLIC_KEY } = require('../src/main/updater');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const v = pkg.version;

const keyArg = process.argv.indexOf('--key');
const keyPem = keyArg > 0 ? fs.readFileSync(process.argv[keyArg + 1], 'utf8') : process.env.OITERM_UPDATE_KEY;
if (!keyPem || !keyPem.includes('PRIVATE KEY')) { console.error('업데이트 서명 키가 없습니다 (OITERM_UPDATE_KEY 또는 --key)'); process.exit(1); }

function fileInfo(name) {
  const f = path.join(DIST, name);
  if (!fs.existsSync(f)) { console.error('파일이 없습니다: ' + f); process.exit(1); }
  const buf = fs.readFileSync(f);
  return { name, size: buf.length, sha512: crypto.createHash('sha512').update(buf).digest('base64') };
}

// CHANGELOG.md 에서 이번 버전 부분만
let notes = '';
const cl = path.join(ROOT, 'CHANGELOG.md');
if (fs.existsSync(cl)) {
  const text = fs.readFileSync(cl, 'utf8');
  const m = new RegExp(`^## ${v.replace(/\./g, '\\.')}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(text);
  if (m) notes = m[1].trim();
}

const manifest = {
  name: 'OiTerm',
  version: v,
  date: new Date().toISOString(),
  notes,
  files: {
    setup: fileInfo(`OiTerm-Setup-${v}.exe`),
    zip: fileInfo(`OiTerm-${v}-win-x64.zip`),
  },
};
const json = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
const sig = crypto.sign(null, json, crypto.createPrivateKey(keyPem)).toString('base64');

// 앱에 들어 있는 공개 키로 다시 확인 — 키가 바뀌었으면 여기서 멈춤 (잘못된 키로 릴리즈 방지)
verifyManifest(json, sig, PUBLIC_KEY);

fs.writeFileSync(path.join(DIST, 'latest.json'), json);
fs.writeFileSync(path.join(DIST, 'latest.json.sig'), sig + '\n');
fs.writeFileSync(path.join(DIST, 'RELEASE_NOTES.md'), `${notes || `OiTerm ${v}`}\n\n---\n- **설치 버전**: \`OiTerm-Setup-${v}.exe\` (설치 후 자동 업데이트)\n- **무설치 버전**: \`OiTerm-${v}-win-x64.zip\` (압축 풀고 OiTerm.exe)\n- 업데이트 정보(latest.json)는 OiTerm 서명 키로 서명되어 있고, 앱은 서명과 SHA-512가 맞는 파일만 설치합니다.\n`);
console.log(`latest.json ${v} 서명 완료 (setup ${manifest.files.setup.size} B, zip ${manifest.files.zip.size} B)`);
