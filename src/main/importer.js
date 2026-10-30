'use strict';
// SecureCRT 세션 폴더(Config\Sessions) 가져오기. 비밀번호는 SecureCRT 전용 암호화라 가져오지 않음
const fs = require('fs');
const path = require('path');

function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  return buf.toString('utf8');
}

function parseIni(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([SD]):"([^"]+)"=(.*)$/.exec(line);
    if (!m) continue;
    const [, kind, key, val] = m;
    out[key] = kind === 'D' ? parseInt(val, 16) : val;
  }
  return out;
}

function toSession(ini, name, folder) {
  const proto = String(ini['Protocol Name'] || '').toLowerCase();
  const base = { name, folder, username: ini['Username'] || '' };
  if (proto.startsWith('ssh')) {
    return { ...base, protocol: 'ssh', host: ini['Hostname'] || '', port: ini['[SSH2] Port'] || ini['[SSH1] Port'] || 22 };
  }
  if (proto === 'telnet') {
    return { ...base, protocol: 'telnet', host: ini['Hostname'] || '', port: ini['Port'] || 23 };
  }
  if (proto === 'serial') {
    const parity = ['none', 'odd', 'even', 'mark', 'space'][ini['Parity'] || 0] || 'none';
    const stop = [1, 1.5, 2][ini['Stop Bits'] || 0] || 1;
    let flow = 'none';
    if (ini['CTS Flow']) flow = 'rtscts';
    else if (ini['XON Flow']) flow = 'xonxoff';
    return {
      ...base, protocol: 'serial', serialPort: ini['Com Port'] || 'COM1',
      baudRate: ini['Baud Rate'] || 9600, dataBits: ini['Data Bits'] || 8, parity, stopBits: stop === 1.5 ? 1 : stop, flowControl: flow,
    };
  }
  return null;
}

function importSecureCRT(rootDir) {
  const results = [];
  let skipped = 0;
  function walk(dir, rel) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full, rel ? `${rel}/${ent.name}` : ent.name); continue; }
      if (!ent.name.toLowerCase().endsWith('.ini')) continue;
      if (/^(__FolderData__|Default)\.ini$/i.test(ent.name)) continue;
      try {
        const s = toSession(parseIni(readText(full)), ent.name.replace(/\.ini$/i, ''), rel);
        if (s && (s.host || s.serialPort)) results.push(s); else skipped++;
      } catch (_) { skipped++; }
    }
  }
  walk(rootDir, '');
  return { sessions: results, skipped };
}

module.exports = { importSecureCRT };
