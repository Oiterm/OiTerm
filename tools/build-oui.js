// IEEE OUI 목록(oui-data)에서 회사 이름 첫 줄만 뽑아 작은 파일로 만듦 → src/main/oui.json
// { v: [회사 이름...], p: { "00000C": 3, ... } }  (MA-L 6자리, MA-M 7자리, MA-S 9자리)
const fs = require('fs');
const path = require('path');
const src = require('oui-data');

const names = [];
const index = new Map();
const p = {};
for (const [prefix, text] of Object.entries(src)) {
  if (!/^[0-9A-F]{6,9}$/.test(prefix)) continue;
  const name = String(text).split('\n')[0].replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().replace(/[,.]$/, '').slice(0, 60);
  if (!name) continue;
  if (!index.has(name)) { index.set(name, names.length); names.push(name); }
  p[prefix] = index.get(name);
}
const out = path.join(__dirname, '..', 'src', 'main', 'oui.json');
fs.writeFileSync(out, JSON.stringify({ v: names, p }));
console.log(`OUI ${Object.keys(p).length}개, 회사 ${names.length}곳 → ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
