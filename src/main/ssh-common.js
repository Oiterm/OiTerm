'use strict';
// SSH 터미널과 SFTP가 같이 쓰는 것들: 구형 장비용 알고리즘, 오류 메시지, 호스트 키 확인
const crypto = require('crypto');
const net = require('net');

/** 아이디/비밀번호를 묻기 전에 포트가 열려 있는지 먼저 확인 (닫혀 있으면 바로 오류) */
function probe(host, port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const done = (err) => { s.destroy(); if (err) reject(err); else resolve(); };
    s.setTimeout(timeoutMs, () => done(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    s.once('connect', () => done());
    s.once('error', done);
  });
}
const sshConst = require('ssh2/lib/protocol/constants');

// 오래된 장비(구형 IOS, 방화벽 등)도 붙도록 레거시 알고리즘을 뒤에 추가
function legacy(list, supported) { return list.filter((a) => supported.includes(a)); }
const SSH_ALGORITHMS = {
  kex: { append: legacy(['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'], sshConst.SUPPORTED_KEX) },
  cipher: { append: legacy(['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'], sshConst.SUPPORTED_CIPHER) },
  serverHostKey: { append: legacy(['ssh-dss'], sshConst.SUPPORTED_SERVER_HOST_KEY) },
  hmac: { append: legacy(['hmac-md5', 'hmac-sha1-96', 'hmac-md5-96'], sshConst.SUPPORTED_MAC) },
};

const PROTO_NAME = { ssh: 'SSH', telnet: '텔넷', serial: '시리얼', sftp: 'SFTP(SSH)', ftp: 'FTP', files: '파일 전송' };

/**
 * 접속 오류를 알아듣기 쉬운 말로. where: "192.168.100.2:22" 처럼 접속한 주소 (포트 확인용)
 */
function friendlyError(err, proto, where) {
  const msg = (err && err.message) || String(err);
  const code = err && err.code;
  const at = where ? ` (${where})` : '';
  const name = PROTO_NAME[proto] || '';
  if (code === 'ECONNREFUSED') {
    let hint = '포트 번호를 확인하세요.';
    const port = where ? Number(String(where).split(':').pop()) : 0;
    if (proto === 'sftp' && port !== 22) hint = 'SFTP는 보통 22번(SSH 포트)입니다. 포트 번호를 확인하세요.';
    else if (proto === 'ftp' && port !== 21) hint = 'FTP는 보통 21번입니다.';
    else if (proto === 'ssh' && port !== 22) hint = 'SSH는 보통 22번입니다.';
    else if (proto === 'telnet' && port !== 23) hint = '텔넷은 보통 23번입니다 (EVE/PNETLab 콘솔은 32769 같은 큰 번호).';
    return `연결 거부됨${at} — 이 주소에서 ${name || '해당'} 서비스가 실행 중이 아니거나 포트가 닫혀 있습니다. ${hint}`;
  }
  if (code === 'ETIMEDOUT' || /timed out/i.test(msg)) return `시간 초과${at} — 장비가 응답하지 않습니다. IP, 경로, 방화벽을 확인하세요.`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `호스트에 도달할 수 없습니다${at} — 라우팅이나 PC 네트워크를 확인하세요.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `호스트 이름을 찾을 수 없습니다${at}.`;
  if (code === 'ECONNRESET') return `상대방이 연결을 끊었습니다${at}.`;
  if (err && err.level === 'client-authentication') return `인증 실패${at} — 아이디/비밀번호를 확인하세요.`;
  if (/no matching/i.test(msg)) return `알고리즘 협상 실패${at} — 장비가 지원하는 암호화 방식이 맞지 않습니다. (${msg})`;
  if (proto === 'serial' && /(access denied|resource busy|cannot open|file not found|no such file)/i.test(msg)) {
    return `COM 포트를 열 수 없습니다${at} — 포트 번호를 확인하고, 다른 프로그램이 쓰고 있지 않은지 확인하세요.`;
  }
  if (/530|login (incorrect|failed)|authentication failed/i.test(msg) && proto === 'ftp') return `FTP 로그인 실패${at} — 아이디/비밀번호를 확인하세요.`;
  return where && !msg.includes(where) ? `${msg}${at}` : msg;
}

function fingerprint(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}
function keyType(keyBuf) {
  try {
    const len = keyBuf.readUInt32BE(0);
    return keyBuf.slice(4, 4 + len).toString('ascii');
  } catch (_) { return 'unknown'; }
}

/** 호스트 키 확인: 처음 보는 키·바뀐 키면 화면에 물어봄 */
function makeHostVerifier(mgr, tabId, hostport, onReject) {
  return (key, verify) => {
    const fp = fingerprint(key);
    const type = keyType(key);
    const known = mgr.store.getHostKey(hostport);
    if (known && known.fingerprint === fp) return verify(true);
    mgr.ask('hostkey', tabId, {
      host: hostport, type, fingerprint: fp,
      changed: !!known, oldFingerprint: known ? known.fingerprint : '',
    }).then((ans) => {
      if (ans === 'save') mgr.store.setHostKey(hostport, { fingerprint: fp, type, saved: new Date().toISOString() });
      if (!ans && onReject) onReject();
      verify(!!ans);
    });
  };
}

module.exports = { probe, SSH_ALGORITHMS, friendlyError, fingerprint, keyType, makeHostVerifier };
