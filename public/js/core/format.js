// 展示格式化：时间、大小、时长、百分比与短 ID。
export function fmtSize(bytes){
  if (bytes == null || !Number.isFinite(Number(bytes))) return '—';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

const pad = n => String(n).padStart(2, '0');

export function fmtTime(value){
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDate(value){
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function relTime(value){
  if (!value) return '—';
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return '—';
  const diff = Date.now() - ts;
  if (diff < 0) return fmtTime(value);
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
  return fmtDate(value);
}

export function fmtDuration(ms){
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  const seconds = Math.floor(n / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export function fmtPercent(value){
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n)}%`;
}

export function shortId(value, length = 8){
  const text = String(value || '');
  return text.length > length ? text.slice(0, length) : text;
}

export function cloneJson(value){
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

export function prettyJson(value){
  try { return JSON.stringify(value ?? null, null, 2); } catch { return String(value); }
}

export function countdown(value, now = Date.now()){
  if (!value) return '—';
  const diff = new Date(value).getTime() - now;
  if (!Number.isFinite(diff)) return '—';
  if (diff <= 0) return '已过期';
  const seconds = Math.ceil(diff / 1000);
  if (seconds < 60) return `${seconds} 秒后过期`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟后过期`;
  return `${Math.ceil(seconds / 3600)} 小时后过期`;
}

/** 先转义再处理换行与 fenced code，避免把模型输出当 HTML。 */
export function renderTextMarkdown(text){
  const escaped = String(text ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
  const blocks = escaped.split(/```/);
  return blocks.map((block, index) => {
    if (index % 2 === 1){
      const firstBreak = block.indexOf('\n');
      const code = firstBreak >= 0 ? block.slice(firstBreak + 1) : block;
      return `<pre class="code-block"><code>${code}</code></pre>`;
    }
    return block
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }).join('');
}
