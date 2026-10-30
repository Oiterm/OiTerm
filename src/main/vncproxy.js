'use strict';
// VNC 중계: 화면(noVNC)은 WebSocket만 쓸 수 있어서, 127.0.0.1에서 WebSocket ↔ TCP(VNC 서버)를 이어줌
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

let server = null;
let port = 0;
const tokens = new Map(); // token -> { host, port, created }

function ensureServer() {
  if (port) return Promise.resolve(port);
  return new Promise((resolve, reject) => {
    server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
    const wss = new WebSocketServer({
      server,
      maxPayload: 64 * 1024 * 1024,
      handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : [...protocols][0] || false),
    });
    wss.on('connection', (ws, req) => {
      // 우리 화면(file://)에서 온 연결만. 다른 웹페이지가 로컬 포트를 두드리는 경우 차단
      const origin = req.headers.origin;
      if (origin && origin !== 'file://' && origin !== 'null') { ws.close(1008, 'origin'); return; }
      const token = (req.url || '').replace(/^\//, '');
      const target = tokens.get(token);
      tokens.delete(token);
      if (!target) { ws.close(1008, 'invalid token'); return; }
      const sock = net.connect({ host: target.host, port: target.port });
      sock.setNoDelay(true);
      sock.setTimeout(15000, () => sock.destroy(new Error('VNC 서버 응답 없음 (시간 초과)')));
      sock.on('connect', () => sock.setTimeout(0));
      sock.on('data', (d) => { if (ws.readyState === 1) ws.send(d); });
      sock.on('error', (e) => { if (ws.readyState === 1) ws.close(1011, String(e.code || e.message).slice(0, 100)); });
      sock.on('close', () => { if (ws.readyState === 1) ws.close(1000); });
      ws.on('message', (d) => { if (!sock.destroyed) sock.write(d); });
      ws.on('close', () => sock.destroy());
      ws.on('error', () => sock.destroy());
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve(port);
    });
  });
}

/** 한 번 쓰고 버리는 주소 발급 */
async function openTarget(host, targetPort) {
  const p = await ensureServer();
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { host, port: Number(targetPort) || 5900, created: Date.now() });
  // 30초 안에 안 쓰면 폐기
  setTimeout(() => tokens.delete(token), 30000);
  return `ws://127.0.0.1:${p}/${token}`;
}

module.exports = { openTarget };
