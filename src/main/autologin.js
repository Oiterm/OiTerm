'use strict';
// 자동 로그인 + enable 진입: 장비 출력에서 프롬프트를 보고 아이디/비밀번호/enable을 대신 입력
const STRIP = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()*+#].|[@-_])/g;

const RE_USER = /(user\s*name|login|user|userid)\s*:\s*$/i;
const RE_PASS = /pass(word|code)?\s*:\s*$/i;
const RE_USER_PROMPT = /[\w.\-()\/@:\[\]]+\s?>\s*$/;
const RE_PRIV_PROMPT = /[\w.\-()\/@:\[\]]+\s?#\s*$/;
const RE_FAIL = /(login invalid|authentication failed|access denied|login incorrect|bad password|% bad secrets)/i;

class AutoLogin {
  /**
   * @param {object} o
   * @param {(s:string)=>void} o.send  장비로 문자열 전송
   * @param {boolean} o.login           텔넷/시리얼처럼 화면에서 로그인해야 하는지
   */
  constructor({ send, login, username, password, enable, enableCmd, enablePassword, onDone }) {
    this.send = send;
    this.username = username || '';
    this.password = password || '';
    this.enable = !!enable;
    this.enableCmd = (enableCmd || 'enable').trim() || 'enable';
    this.enablePassword = enablePassword || '';
    this.onDone = onDone || (() => {});
    this.tail = '';
    this.userSent = false;
    this.passSent = false;
    this.stage = login && (this.username || this.password) ? 'login' : (this.enable ? 'enable' : 'done');
    this.timer = setTimeout(() => this.finish('시간 초과'), 60000);
    if (this.stage === 'done') this.finish();
  }

  finish(reason) {
    if (this.stage === 'stopped') return;
    this.stage = 'stopped';
    clearTimeout(this.timer);
    this.onDone(reason);
  }

  _type(s) {
    this.tail = '';
    // 프롬프트가 완전히 뜬 뒤 입력하도록 살짝 늦춤
    setTimeout(() => this.send(s + '\r'), 120);
  }

  feed(text) {
    if (this.stage === 'stopped') return;
    this.tail = (this.tail + text.replace(STRIP, '')).slice(-400);
    const t = this.tail.replace(/[\r\n]+$/g, '').replace(/[ \t]+$/g, '');
    const lastLine = t.split(/\r?\n|\r/).pop();

    if (this.passSent && RE_FAIL.test(this.tail)) {
      return this.finish(this.stage === 'enwait' ? 'enable 실패' : '로그인 실패');
    }

    if (this.stage === 'login') {
      if (RE_USER.test(lastLine) && !RE_PASS.test(lastLine)) {
        if (this.userSent || !this.username) return this.finish(this.userSent ? '로그인 실패' : undefined);
        this.userSent = true;
        return this._type(this.username);
      }
      if (RE_PASS.test(lastLine)) {
        if (this.passSent || !this.password) return this.finish(this.passSent ? '로그인 실패' : undefined);
        this.passSent = true;
        this.stage = 'postlogin';
        return this._type(this.password);
      }
      return;
    }

    if (this.stage === 'postlogin') {
      if (RE_PRIV_PROMPT.test(lastLine)) return this.finish();
      if (RE_USER_PROMPT.test(lastLine)) {
        if (!this.enable) return this.finish();
        this.stage = 'enable';
      } else if (RE_USER.test(lastLine) || RE_PASS.test(lastLine)) {
        return this.finish('로그인 실패');
      } else return;
    }

    if (this.stage === 'enable') {
      if (RE_PRIV_PROMPT.test(lastLine)) return this.finish();
      if (RE_USER_PROMPT.test(lastLine)) {
        this.stage = 'enpass';
        return this._type(this.enableCmd);
      }
      return;
    }

    if (this.stage === 'enpass') {
      if (RE_PASS.test(lastLine)) {
        this.stage = 'enwait';
        return this._type(this.enablePassword);
      }
      if (RE_PRIV_PROMPT.test(lastLine)) return this.finish();
      return;
    }

    if (this.stage === 'enwait') {
      if (RE_PRIV_PROMPT.test(lastLine)) return this.finish();
      if (RE_USER_PROMPT.test(lastLine) || RE_PASS.test(lastLine)) return this.finish('enable 실패');
    }
  }
}

module.exports = { AutoLogin };
