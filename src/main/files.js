'use strict';
// 파일 전송 탭: SFTP(ssh2) / FTP·FTPS(basic-ftp)
const fs = require('fs');
const path = require('path');
const { Client: SshClient } = require('ssh2');
const ftp = require('basic-ftp');
const { SSH_ALGORITHMS, friendlyError, makeHostVerifier, probe } = require('./ssh-common');

const posix = path.posix;

function fmtMode(mode) {
  if (typeof mode !== 'number') return '';
  const t = (mode & 0o170000) === 0o040000 ? 'd' : (mode & 0o170000) === 0o120000 ? 'l' : '-';
  const r = (b, c) => ((mode & b) ? c : '-');
  return t + r(0o400, 'r') + r(0o200, 'w') + r(0o100, 'x') + r(0o040, 'r') + r(0o020, 'w') + r(0o010, 'x') + r(0o004, 'r') + r(0o002, 'w') + r(0o001, 'x');
}

class FileSession {
  constructor(mgr, tabId, cfg, secrets) {
    this.mgr = mgr;
    this.tabId = tabId;
    this.cfg = cfg;
    this.secrets = secrets;
    this.kind = cfg.protocol === 'ftp' ? 'ftp' : 'sftp';
    this.queue = Promise.resolve();
    this.closed = false;
  }

  // FTP는 한 번에 한 작업만 가능 → 순서대로 실행
  run(fn) {
    if (this.kind === 'sftp') return fn();
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async connect() {
    if (this.kind === 'ftp') return this.connectFtp();
    return this.connectSftp();
  }

  async connectFtp() {
    const c = new ftp.Client(20000);
    c.ftp.verbose = false;
    await c.access({
      host: this.cfg.host,
      port: Number(this.cfg.port) || 21,
      user: this.cfg.username || 'anonymous',
      password: this.secrets.password || (this.cfg.username ? '' : 'anonymous@'),
      secure: !!this.cfg.ftps,
      secureOptions: { rejectUnauthorized: false },
    });
    this.ftp = c;
    const home = await c.pwd();
    return this.cfg.startPath || home || '/';
  }

  async connectSftp(attempt = 1) {
    const cfg = this.cfg;
    let username = cfg.username || '';
    let password = this.secrets.password || '';
    let privateKey = null;
    if (cfg.authType === 'key' && cfg.keyPath) privateKey = fs.readFileSync(cfg.keyPath);
    if (attempt === 1) await probe(cfg.host, Number(cfg.port) || 22); // 포트가 닫혀 있으면 비밀번호 묻기 전에 바로 알림
    if (!username || (!password && !privateKey) || attempt > 1) {
      const ans = await this.mgr.ask('auth', this.tabId, {
        title: attempt > 1 ? '인증 실패 — 다시 입력하세요' : `${cfg.name || cfg.host} 로그인 (SFTP)`,
        host: `${cfg.host}:${cfg.port || 22}`, username, needUser: true, canSave: !!cfg.id, retry: attempt > 1,
      });
      if (!ans) throw new Error('사용자가 로그인을 취소했습니다.');
      username = ans.username || username;
      password = ans.password || '';
      if (ans.save && cfg.id) this.mgr.store.upsertSession({ id: cfg.id, username }, { password });
      this.cfg.username = username;
      this.secrets.password = password;
    }
    const hostport = `${cfg.host}:${Number(cfg.port) || 22}`;
    let rejected = false;
    try {
      await new Promise((resolve, reject) => {
        const client = new SshClient();
        client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => password)));
        client.on('ready', () => {
          client.sftp((err, sftp) => {
            if (err) { client.end(); return reject(new Error('이 장비는 SFTP를 지원하지 않습니다: ' + err.message)); }
            this.ssh = client;
            this.sftp = sftp;
            resolve();
          });
        });
        client.on('error', reject);
        client.on('close', () => { if (!this.closed && this.sftp) this.mgr.send('files:closed', this.tabId); });
        client.connect({
          host: cfg.host, port: Number(cfg.port) || 22, username,
          password: password || undefined, privateKey: privateKey || undefined,
          passphrase: this.secrets.passphrase || undefined,
          tryKeyboard: true, readyTimeout: 20000, keepaliveInterval: 30000,
          algorithms: SSH_ALGORITHMS,
          hostVerifier: makeHostVerifier(this.mgr, this.tabId, hostport, () => { rejected = true; }),
        });
      });
    } catch (e) {
      if (rejected) throw new Error('호스트 키를 거부했습니다.');
      if (e.level === 'client-authentication' && attempt < 3) return this.connectSftp(attempt + 1);
      throw e;
    }
    const home = await new Promise((res) => this.sftp.realpath('.', (err, p) => res(err ? '/' : p)));
    return this.cfg.startPath || home;
  }

  // ---------- 목록 ----------
  list(dir) {
    return this.run(async () => {
      if (this.kind === 'ftp') {
        const items = await this.ftp.list(dir);
        return items.filter((i) => i.name !== '.' && i.name !== '..').map((i) => ({
          name: i.name,
          type: i.isDirectory ? 'd' : i.isSymbolicLink ? 'l' : 'f',
          size: i.size || 0,
          mtime: i.modifiedAt ? i.modifiedAt.getTime() : null,
          mtimeRaw: i.rawModifiedAt || '',
          perms: i.permissions ? `${i.permissions.user}${i.permissions.group}${i.permissions.world}` : '',
        }));
      }
      const items = await new Promise((res, rej) => this.sftp.readdir(dir, (err, list) => (err ? rej(err) : res(list))));
      return items.filter((i) => i.filename !== '.' && i.filename !== '..').map((i) => {
        const m = i.attrs.mode;
        let type = (m & 0o170000) === 0o040000 ? 'd' : (m & 0o170000) === 0o120000 ? 'l' : 'f';
        if (type === 'f' && /^d/.test(i.longname || '')) type = 'd';
        return { name: i.filename, type, size: i.attrs.size || 0, mtime: i.attrs.mtime ? i.attrs.mtime * 1000 : null, perms: fmtMode(m) };
      });
    });
  }

  /** 심볼릭 링크가 폴더인지 확인 */
  isDir(p) {
    return this.run(async () => {
      if (this.kind === 'ftp') {
        try { const cur = await this.ftp.pwd(); await this.ftp.cd(p); await this.ftp.cd(cur); return true; } catch (_) { return false; }
      }
      return new Promise((res) => this.sftp.stat(p, (err, st) => res(!err && st.isDirectory())));
    });
  }

  // ---------- 전송 ----------
  progress(job, done, total) {
    const now = Date.now();
    if (job.last && now - job.last < 150 && done < total) return;
    job.last = now;
    this.mgr.send('files:progress', this.tabId, { id: job.id, name: job.name, dir: job.dir, done, total });
  }

  async downloadOne(remote, local, job, total) {
    if (this.kind === 'ftp') {
      this.ftp.trackProgress((info) => this.progress(job, info.bytes, total));
      try { await this.ftp.downloadTo(local, remote); } finally { this.ftp.trackProgress(); }
      return;
    }
    await new Promise((res, rej) => this.sftp.fastGet(remote, local, {
      step: (done, _c, tot) => this.progress(job, done, tot),
    }, (err) => (err ? rej(err) : res())));
  }

  async uploadOne(local, remote, job) {
    const total = fs.statSync(local).size;
    if (this.kind === 'ftp') {
      this.ftp.trackProgress((info) => this.progress(job, info.bytes, total));
      try { await this.ftp.uploadFrom(local, remote); } finally { this.ftp.trackProgress(); }
      return;
    }
    await new Promise((res, rej) => this.sftp.fastPut(local, remote, {
      step: (done, _c, tot) => this.progress(job, done, tot),
    }, (err) => (err ? rej(err) : res())));
  }

  async mkdirRaw(p) {
    if (this.kind === 'ftp') { await this.ftp.send('MKD ' + p).catch(() => {}); return; }
    await new Promise((res) => this.sftp.mkdir(p, () => res()));
  }

  /** items: [{ name, type, size }] (원격 폴더 dir 안의 항목들) → 로컬 폴더 localDir로 */
  download(dir, items, localDir, jobId) {
    return this.run(async () => {
      const walk = async (rdir, item, ldir) => {
        const rpath = posix.join(rdir, item.name);
        const lpath = path.join(ldir, item.name.replace(/[\\/:*?"<>|]/g, '_'));
        if (item.type === 'd') {
          fs.mkdirSync(lpath, { recursive: true });
          const children = await this.listRaw(rpath);
          for (const c of children) await walk(rpath, c, lpath);
        } else {
          await this.downloadOne(rpath, lpath, { id: jobId, name: item.name, dir: 'down' }, item.size || 0);
        }
      };
      for (const it of items) await walk(dir, it, localDir);
    });
  }

  // run() 안에서 다시 run()을 부르면 FTP 큐가 막히므로 내부용 목록
  async listRaw(dir) {
    if (this.kind === 'ftp') {
      const items = await this.ftp.list(dir);
      return items.filter((i) => i.name !== '.' && i.name !== '..').map((i) => ({ name: i.name, type: i.isDirectory ? 'd' : 'f', size: i.size || 0 }));
    }
    const items = await new Promise((res, rej) => this.sftp.readdir(dir, (err, list) => (err ? rej(err) : res(list))));
    return items.filter((i) => i.filename !== '.' && i.filename !== '..').map((i) => ({
      name: i.filename, type: (i.attrs.mode & 0o170000) === 0o040000 ? 'd' : 'f', size: i.attrs.size || 0,
    }));
  }

  /** 로컬 파일/폴더 경로들 → 원격 폴더 dir */
  upload(localPaths, dir, jobId) {
    return this.run(async () => {
      const walk = async (lpath, rdir) => {
        const name = path.basename(lpath);
        const rpath = posix.join(rdir, name);
        const st = fs.statSync(lpath);
        if (st.isDirectory()) {
          await this.mkdirRaw(rpath);
          for (const c of fs.readdirSync(lpath)) await walk(path.join(lpath, c), rpath);
        } else {
          await this.uploadOne(lpath, rpath, { id: jobId, name, dir: 'up' });
        }
      };
      for (const p of localPaths) await walk(p, dir);
    });
  }

  mkdir(p) { return this.run(() => this.mkdirRaw(p)); }

  remove(dir, items) {
    return this.run(async () => {
      const rm = async (rpath, type) => {
        if (this.kind === 'ftp') {
          if (type === 'd') await this.ftp.removeDir(rpath); else await this.ftp.remove(rpath);
          return;
        }
        if (type === 'd') {
          const children = await this.listRaw(rpath);
          for (const c of children) await rm(posix.join(rpath, c.name), c.type);
          await new Promise((res, rej) => this.sftp.rmdir(rpath, (e) => (e ? rej(e) : res())));
        } else {
          await new Promise((res, rej) => this.sftp.unlink(rpath, (e) => (e ? rej(e) : res())));
        }
      };
      for (const it of items) await rm(posix.join(dir, it.name), it.type);
    });
  }

  rename(from, to) {
    return this.run(async () => {
      if (this.kind === 'ftp') return this.ftp.rename(from, to);
      return new Promise((res, rej) => this.sftp.rename(from, to, (e) => (e ? rej(e) : res())));
    });
  }

  close() {
    this.closed = true;
    try { if (this.ftp) this.ftp.close(); } catch (_) {}
    try { if (this.ssh) this.ssh.end(); } catch (_) {}
  }
}

class FileManager {
  constructor({ store, send, ask, resolve }) {
    this.store = store;
    this.send = send;
    this.ask = ask;
    this.resolveReq = resolve;
    this.sessions = new Map();
    this.jobSeq = 0;
  }

  async open(tabId, req) {
    this.close(tabId);
    const r = this.resolveReq(req);
    if (!r) return { ok: false, error: '세션을 찾을 수 없습니다.' };
    const fsn = new FileSession(this, tabId, r.cfg, r.secrets);
    this.sessions.set(tabId, fsn);
    try {
      const start = await fsn.connect();
      return { ok: true, path: start, kind: fsn.kind, meta: { ...r.cfg } };
    } catch (e) {
      this.sessions.delete(tabId);
      fsn.close();
      const port = Number(r.cfg.port) || (fsn.kind === 'ftp' ? 21 : 22);
      return { ok: false, error: friendlyError(e, fsn.kind, `${r.cfg.host}:${port}`) };
    }
  }

  get(tabId) {
    const s = this.sessions.get(tabId);
    if (!s) throw new Error('연결이 끊겼습니다. 다시 연결하세요.');
    return s;
  }

  async call(tabId, fn) {
    try { return { ok: true, result: await fn(this.get(tabId)) }; } catch (e) { return { ok: false, error: friendlyError(e, 'files') }; }
  }

  list(tabId, dir) { return this.call(tabId, (s) => s.list(dir)); }
  isDir(tabId, p) { return this.call(tabId, (s) => s.isDir(p)); }
  mkdir(tabId, p) { return this.call(tabId, (s) => s.mkdir(p)); }
  remove(tabId, dir, items) { return this.call(tabId, (s) => s.remove(dir, items)); }
  rename(tabId, from, to) { return this.call(tabId, (s) => s.rename(from, to)); }

  async download(tabId, dir, items, localDir) {
    const id = ++this.jobSeq;
    const r = await this.call(tabId, (s) => s.download(dir, items, localDir, id));
    this.send('files:progress', tabId, { id, done: 1, total: 1, finished: true, ok: r.ok, error: r.error, dir: 'down' });
    return r;
  }

  async upload(tabId, localPaths, dir) {
    const id = ++this.jobSeq;
    const r = await this.call(tabId, (s) => s.upload(localPaths, dir, id));
    this.send('files:progress', tabId, { id, done: 1, total: 1, finished: true, ok: r.ok, error: r.error, dir: 'up' });
    return r;
  }

  close(tabId) {
    const s = this.sessions.get(tabId);
    if (s) { s.close(); this.sessions.delete(tabId); }
  }

  closeAll() { for (const id of [...this.sessions.keys()]) this.close(id); }
}

module.exports = { FileManager };
