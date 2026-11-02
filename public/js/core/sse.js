// SSE 客户端：标准帧解析、Last-Event-ID 续传、gap 回调与退避重连。
import { getToken } from './api.js';

function parseFrame(frame, handlers, state){
  let id = null;
  let event = 'message';
  const data = [];
  for (const line of frame.split('\n')){
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (id != null && id !== '') state.lastEventId = id;
  if (!data.length) return;
  let payload = data.join('\n');
  let parsed = payload;
  try { parsed = JSON.parse(payload); } catch {}
  if (event === 'gap'){
    handlers.onGap?.(parsed);
    return;
  }
  if (event === 'end'){
    state.ended = true;
    handlers.onEnd?.(parsed);
    return;
  }
  if (event === 'error'){
    handlers.onError?.(parsed, 'stream');
    return;
  }
  handlers.onEvent?.({ event, data: parsed, id: state.lastEventId });
}

export class SSEClient {
  constructor({ url, lastEventId = null, onEvent, onState, onGap, onEnd, onError, maxRetries = Infinity } = {}){
    this.url = url;
    this.handlers = { onEvent, onState, onGap, onEnd, onError };
    this.lastEventId = lastEventId;
    this.maxRetries = maxRetries;
    this.retries = 0;
    this.closed = false;
    this.ended = false;
    this.controller = null;
    this.timer = null;
  }

  setState(state){
    this.handlers.onState?.(state);
  }

  start(){
    this.closed = false;
    this.ended = false;
    this._connect();
  }

  async _connect(){
    if (this.closed || this.ended) return;
    this.setState(this.retries === 0 ? 'connecting' : 'reconnecting');
    const controller = new AbortController();
    this.controller = controller;
    const headers = { Accept: 'text/event-stream' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.lastEventId != null) headers['Last-Event-ID'] = String(this.lastEventId);
    const url = this.lastEventId != null
      ? `${this.url}${this.url.includes('?') ? '&' : '?'}after=${encodeURIComponent(this.lastEventId)}`
      : this.url;
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok){
        if (res.status === 401 || res.status === 403 || res.status === 404){
          this.setState('error');
          this.handlers.onError?.({ status: res.status }, 'http');
          this.closed = true;
          return;
        }
        throw new Error(`SSE ${res.status}`);
      }
      if (!res.body) throw new Error('SSE 响应缺少 body');
      this.retries = 0;
      this.setState('live');
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      while (!this.closed){
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0){
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (frame.trim()) parseFrame(frame, this.handlers, this);
        }
      }
      if (buffer.trim()) parseFrame(buffer, this.handlers, this);
      if (this.ended || this.closed) {
        this.setState(this.ended ? 'ended' : 'error');
        return;
      }
      this._scheduleReconnect();
    } catch (error){
      if (this.closed || error.name === 'AbortError') return;
      this.handlers.onError?.(error, 'network');
      this.setState('reconnecting');
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect(){
    if (this.closed || this.ended) return;
    if (this.retries >= this.maxRetries){
      this.setState('error');
      return;
    }
    this.retries += 1;
    const base = Math.min(15000, 1000 * 2 ** (this.retries - 1));
    const delay = base + Math.floor(Math.random() * 400);
    this.setState('reconnecting');
    this.timer = setTimeout(() => {
      this.timer = null;
      this._connect();
    }, delay);
  }

  close(){
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.setState('ended');
  }
}
