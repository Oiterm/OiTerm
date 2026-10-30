'use strict';
/* 자동 업데이트 — GitHub 릴리즈의 latest.json을 받아 OiTerm 서명 키로 확인한 뒤에만 설치
 *
 * 믿는 것: 이 파일에 박힌 공개 키 하나뿐. GitHub나 중간 네트워크가 바꿔치기해도
 *   1) latest.json 서명(Ed25519)이 안 맞으면 버림
 *   2) 받은 설치 파일의 SHA-512가 서명된 값과 다르면 버림
 *   3) 지금 버전보다 낮거나 같은 버전(되돌리기 공격)은 무시
 * 설치는 "설치 프로그램으로 깐 OiTerm"만 자동, zip(무설치) 버전은 다운로드 페이지만 열어줌 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'c1hangmin/OiTerm';
const FEED = `https://github.com/${REPO}/releases/latest/download/`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
// 업데이트 서명 공개 키 (개인 키는 GitHub 저장소 Secrets와 만든 사람 PC에만 있음)
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAPLq21NWUxWR0Ar6wLMJkYobEER9YjlmZ2nI8ERhQxdc=
-----END PUBLIC KEY-----`;
const ALLOWED_HOSTS = /^(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|github-releases\.githubusercontent\.com)$/i;
const MAX_JSON = 64 * 1024;
const MAX_SIG = 1024;
const MAX_FILE = 600 * 1024 * 1024;
const SETUP_NAME = /^OiTerm-Setup-(\d+\.\d+\.\d+)\.exe$/;

/** 1.2.3 비교 (숫자 세 개만) */
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}
const isVer = (v) => typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v);

/** latest.json + 서명 확인 → 내용 (틀리면 예외) */
function verifyManifest(jsonBuf, sigText, publicKeyPem = PUBLIC_KEY) {
  let sig;
  try { sig = Buffer.from(String(sigText).trim(), 'base64'); } catch (_) { throw new Error('서명 형식이 잘못됐습니다.'); }
  if (sig.length !== 64) throw new Error('서명 형식이 잘못됐습니다.');
  const ok = crypto.verify(null, jsonBuf, crypto.createPublicKey(publicKeyPem), sig);
  if (!ok) throw new Error('업데이트 정보의 서명이 맞지 않습니다. (OiTerm이 만든 파일이 아님)');
  let m;
  try { m = JSON.parse(jsonBuf.toString('utf8')); } catch (_) { throw new Error('업데이트 정보를 읽을 수 없습니다.'); }
  if (!m || m.name !== 'OiTerm' || !isVer(m.version)) throw new Error('업데이트 정보가 OiTerm 것이 아닙니다.');
  const s = m.files && m.files.setup;
  if (!s || !SETUP_NAME.test(s.name || '') || SETUP_NAME.exec(s.name)[1] !== m.version) throw new Error('설치 파일 정보가 잘못됐습니다.');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(s.sha512 || '') || !(Number(s.size) > 0 && Number(s.size) <= MAX_FILE)) throw new Error('설치 파일 정보가 잘못됐습니다.');
  return m;
}

/** 설치 프로그램으로 깐 OiTerm인지 (같은 폴더에 제거 프로그램이 있음) */
function isInstalled() {
  if (process.platform !== 'win32') return false;
  try { return fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall OiTerm.exe')); } catch (_) { return false; }
}

class Updater {
  constructor({ app, net, send, store, quit }) {
    this.app = app;
    this.quit = quit || (() => app.quit());
    this.net = net;
    this.send = send;
    this.store = store;
    this.found = null;     // 확인된 새 버전 정보
    this.busy = false;
    // 개발 중 테스트용으로만 주소·키를 바꿀 수 있음 (배포본은 고정)
    this.feed = !app.isPackaged && process.env.OITERM_UPDATE_FEED ? process.env.OITERM_UPDATE_FEED : FEED;
    this.publicKey = !app.isPackaged && process.env.OITERM_UPDATE_PUBKEY ? process.env.OITERM_UPDATE_PUBKEY : PUBLIC_KEY;
    this.devAllowHttp = !app.isPackaged && !!process.env.OITERM_UPDATE_FEED;
  }

  /** 받을 수 있는 주소인지: https + GitHub 주소만 (개발 테스트 때만 로컬 http 허용) */
  allowed(u) {
    let url;
    try { url = new URL(u); } catch (_) { return false; }
    if (this.devAllowHttp && /^http:$/.test(url.protocol) && url.hostname === '127.0.0.1') return true;
    return url.protocol === 'https:' && ALLOWED_HOSTS.test(url.hostname);
  }

  /** 크기 제한을 두고 받기. 리다이렉트도 한 번씩 주소를 확인하며 따라감. onChunk가 있으면 흘려보내고, 없으면 Buffer로 */
  fetchLimited(url, limit, onChunk) {
    return new Promise((resolve, reject) => {
      if (!this.allowed(url)) { reject(new Error('허용되지 않은 주소입니다: ' + url)); return; }
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; try { req.abort(); } catch (_) {} reject(e); } };
      const req = this.net.request({ url, redirect: 'manual', useSessionCookies: false, cache: 'no-cache' });
      req.setHeader('User-Agent', `OiTerm/${this.app.getVersion()}`);
      let hops = 0;
      req.on('redirect', (_status, _method, to) => {
        if (++hops > 5) return fail(new Error('리다이렉트가 너무 많습니다.'));
        if (!this.allowed(to)) return fail(new Error('허용되지 않은 주소로 이동하려 합니다: ' + (() => { try { return new URL(to).hostname; } catch (_) { return to; } })()));
        req.followRedirect();
      });
      req.on('response', (res) => {
        if (res.statusCode !== 200) return fail(new Error(res.statusCode === 404 ? '아직 올라온 업데이트가 없습니다.' : `서버 응답 ${res.statusCode}`));
        const len = Number([].concat(res.headers['content-length'] || [0])[0]) || 0;
        if (len > limit) return fail(new Error('파일이 너무 큽니다.'));
        const parts = [];
        let got = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          got += chunk.length;
          if (got > limit) return fail(new Error('파일이 너무 큽니다.'));
          try { if (onChunk) onChunk(chunk, got, len); else parts.push(chunk); } catch (e) { fail(e); }
        });
        res.on('end', () => { if (!settled) { settled = true; resolve(onChunk ? got : Buffer.concat(parts)); } });
        res.on('error', (e) => fail(e));
        res.on('aborted', () => fail(new Error('받는 중에 끊겼습니다.')));
      });
      req.on('error', (e) => fail(new Error('연결할 수 없습니다: ' + e.message)));
      req.end();
    });
  }

  /** 새 버전 확인 → { ok, available, version, notes, installable } */
  async check({ manual = false } = {}) {
    if (this.busy) return { ok: false, message: '이미 확인 중입니다.' };
    this.busy = true;
    try {
      const json = await this.fetchLimited(this.feed + 'latest.json', MAX_JSON);
      const sig = await this.fetchLimited(this.feed + 'latest.json.sig', MAX_SIG);
      const m = verifyManifest(json, sig.toString('utf8'), this.publicKey);
      const us = this.state();
      us.lastCheck = Date.now();
      this.store.save();
      const current = this.app.getVersion();
      if (cmpVer(m.version, current) <= 0) { this.found = null; return { ok: true, available: false, current }; }
      if (!manual && us.skip === m.version) return { ok: true, available: false, current, skipped: m.version };
      this.found = m;
      const info = { ok: true, available: true, current, version: m.version, notes: String(m.notes || '').slice(0, 4000), date: m.date || '', installable: isInstalled(), page: RELEASES_PAGE };
      if (!manual) this.send('update:available', info);
      return info;
    } catch (e) {
      return { ok: false, message: e.message };
    } finally {
      this.busy = false;
    }
  }

  /** 하루 한 번 (켜져 있을 때만) */
  autoCheck() {
    if (this.store.getSettings().updateCheck === false) return;
    if (Date.now() - (this.state().lastCheck || 0) < 20 * 3600e3) return;
    setTimeout(() => this.check().catch(() => {}), 8000);
  }

  /** 받아서 확인하고 설치 (설치형만) */
  async install() {
    const m = this.found;
    if (!m) return { ok: false, message: '먼저 업데이트를 확인하세요.' };
    if (!isInstalled()) return { ok: false, message: 'zip(무설치) 버전은 자동 설치가 안 됩니다. 릴리즈 페이지에서 받아주세요.', page: RELEASES_PAGE };
    if (this.busy) return { ok: false, message: '이미 진행 중입니다.' };
    this.busy = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oiterm-update-'));
    const file = path.join(dir, m.files.setup.name);
    try {
      const hash = crypto.createHash('sha512');
      const fd = fs.openSync(file, 'wx');
      let last = 0;
      try {
        // 서명된 크기보다 1바이트라도 더 오면 바로 끊음
        await this.fetchLimited(this.feed + m.files.setup.name, Number(m.files.setup.size), (chunk, got) => {
          hash.update(chunk);
          fs.writeSync(fd, chunk);
          if (Date.now() - last > 200) { last = Date.now(); this.send('update:progress', { done: got, total: Number(m.files.setup.size) }); }
        });
      } finally { fs.closeSync(fd); }
      const digest = hash.digest('base64');
      const size = fs.statSync(file).size;
      if (size !== Number(m.files.setup.size) || digest !== m.files.setup.sha512) {
        throw new Error('받은 설치 파일이 서명된 정보와 다릅니다. 설치하지 않았습니다.');
      }
      // 조용히 설치하고 끝나면 OiTerm 다시 실행 (설치 위치·설정은 그대로)
      const child = spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => {});
      child.unref();
      setTimeout(() => this.quit(), 300);
      return { ok: true };
    } catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      return { ok: false, message: e.message };
    } finally {
      this.busy = false;
    }
  }

  skip(version) {
    if (!isVer(version)) return;
    this.state().skip = version;
    this.store.save();
  }

  /** 마지막 확인 시각·건너뛴 버전 (설정과 따로 보관: 화면 쪽 설정 저장이 덮어쓰지 않게) */
  state() {
    if (!this.store.data.updateState || typeof this.store.data.updateState !== 'object') this.store.data.updateState = {};
    return this.store.data.updateState;
  }
}

module.exports = { Updater, verifyManifest, cmpVer, isInstalled, PUBLIC_KEY, RELEASES_PAGE };
