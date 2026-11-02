// 统一产物库：任务成果 + 会话文件、过滤、分页与安全预览。
import { $, $$, esc } from '../core/dom.js';
import { api, fetchBlob, downloadUrl, apiErrorMessage } from '../core/api.js';
import { describeApiError } from '../core/api-error.js';
import { fmtSize, relTime, fmtTime, shortId } from '../core/format.js';
import {
  toast, confirmDialog, openDrawer, closeDrawer, errorBlock, emptyBlock, skeletonRows,
  statusBadge, platformDisabledBlock, bindRetry, bindTabKeys,
} from '../core/ui.js';
import { store } from '../core/store.js';

const TEXT_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/html', 'application/json',
  'application/xml', 'text/xml', 'application/x-yaml', 'text/yaml',
]);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);
const MAX_PREVIEW = 512 * 1024;

function normalizeChat(item){
  return {
    id: item.id, source: 'chat', taskId: null, taskTitle: null, taskStatus: null,
    name: item.name, mime: item.mime, size: item.size, kind: 'chat',
    version: null, createdAt: item.created_at,
    download: `/artifacts/${item.id}/download`, delete: `/artifacts/${item.id}`,
  };
}

function artifactRow(item){
  return `<div class="artifact-row">
    <div class="artifact-main">
      <strong>${esc(item.name)}</strong>
      <span class="muted">${esc(item.kind || 'output')}${item.version ? ` · v${item.version}` : ''} · ${fmtSize(item.size)} · ${esc(relTime(item.createdAt))}</span>
      ${item.source === 'task' ? `<a class="muted" href="#/tasks/${esc(item.taskId)}">${esc(item.taskTitle || item.taskId)}</a>` : '<span class="muted">会话文件</span>'}
    </div>
    <div class="row-actions">
      <button class="btn small" data-preview="${esc(item.id)}" data-source="${item.source}">预览</button>
      <button class="btn small" data-download="${esc(item.id)}" data-source="${item.source}">下载</button>
      <button class="btn small danger" data-delete="${esc(item.id)}" data-source="${item.source}" data-name="${esc(item.name)}">删除</button>
    </div>
  </div>`;
}

export async function mountArtifacts(ctx, signal){
  const section = $('#view-artifacts');
  if (!store.platformEnabled){
    section.innerHTML = `<div class="page">${platformDisabledBlock()}</div>`;
    return;
  }
  let source = ['all', 'task', 'chat'].includes(ctx.query.source) ? ctx.query.source : 'all';
  let kind = ctx.query.kind || '';
  let query = ctx.query.q || '';
  let taskItems = [];
  let chatItems = [];
  let cursor = null;
  let nextCursor = null;
  let loading = false;
  let error = null;

  section.innerHTML = `<div class="page console-page">
    <header class="page-header">
      <div><h2 tabindex="-1">产物</h2><p class="subtitle">任务生成的文件与会话附件，集中预览、下载与清理。</p></div>
      <div class="header-actions"><button class="btn" data-refresh>刷新</button></div>
    </header>
    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="产物来源">
        ${[['all', '全部'], ['task', '任务成果'], ['chat', '会话文件']].map(([key, label]) => `<button class="tab${key === source ? ' active' : ''}" role="tab" data-source-tab="${key}" aria-selected="${key === source}">${label}</button>`).join('')}
      </div>
      <div class="toolbar-group">
        <select class="select" data-kind aria-label="产物类型">
          <option value="">全部类型</option>
          <option value="output"${kind === 'output' ? ' selected' : ''}>输出</option>
          <option value="input"${kind === 'input' ? ' selected' : ''}>输入</option>
          <option value="intermediate"${kind === 'intermediate' ? ' selected' : ''}>中间产物</option>
        </select>
        <input class="input search-input" type="search" data-search value="${esc(query)}" placeholder="搜索文件名…" aria-label="搜索产物">
      </div>
    </div>
    <div class="content-scroll" data-list>${skeletonRows(3)}</div>
  </div>`;

  const list = $('[data-list]', section);
  const tabs = $$('[data-source-tab]', section);
  const kindSelect = $('[data-kind]', section);
  const search = $('[data-search]', section);

  function items(){
    const merged = source === 'task' ? [...taskItems] : source === 'chat' ? [...chatItems] : [...taskItems, ...chatItems];
    return merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  function render(){
    if (error){
      list.innerHTML = errorBlock(error);
      bindRetry(list, () => load(true));
      return;
    }
    const rows = items();
    if (!rows.length){
      list.innerHTML = emptyBlock('没有产物', query ? '换一个关键词或清空筛选。' : '任务生成的文件与会话附件会出现在这里。');
      return;
    }
    list.innerHTML = `<div class="artifact-list">${rows.map(artifactRow).join('')}</div>
      ${nextCursor && source !== 'chat' ? '<div class="load-more"><button class="btn" data-more>加载更多</button></div>' : ''}`;
    $('[data-more]', list)?.addEventListener('click', () => load(false));
    $$('[data-preview]', list).forEach(button => button.addEventListener('click', () => preview(button.dataset.preview, button.dataset.source)));
    $$('[data-download]', list).forEach(button => button.addEventListener('click', () => download(button.dataset.download, button.dataset.source)));
    $$('[data-delete]', list).forEach(button => button.addEventListener('click', () => remove(button.dataset.delete, button.dataset.source, button.dataset.name)));
  }

  function selectSource(next){
    source = next;
    tabs.forEach(tab => {
      const active = tab.dataset.sourceTab === next;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    history.replaceState(null, '', `#/artifacts?source=${next}`);
    load(true);
  }
  tabs.forEach(tab => tab.addEventListener('click', () => selectSource(tab.dataset.sourceTab)));
  bindTabKeys(tabs, tab => selectSource(tab.dataset.sourceTab));

  let debounce = null;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      query = search.value.trim();
      history.replaceState(null, '', `#/artifacts?source=${source}${query ? `&q=${encodeURIComponent(query)}` : ''}`);
      load(true);
    }, 300);
  });
  kindSelect.addEventListener('change', () => {
    kind = kindSelect.value;
    load(true);
  });
  $('[data-refresh]', section).addEventListener('click', () => load(true));

  async function load(reset){
    if (loading) return;
    loading = true;
    error = null;
    if (reset){
      taskItems = [];
      chatItems = [];
      cursor = null;
      nextCursor = null;
      list.innerHTML = skeletonRows(3);
    }
    try {
      const requests = [];
      if (source !== 'chat'){
        const params = new URLSearchParams({ limit: '50' });
        if (kind) params.set('kind', kind);
        if (query) params.set('q', query);
        if (!reset && cursor) params.set('cursor', cursor);
        requests.push(api.get(`/task-artifacts?${params}`, { signal }).then(data => {
          const page = (data.artifacts || []).map(item => ({
            id: item.id, source: 'task', taskId: item.task_id, taskTitle: item.task_title,
            taskStatus: item.task_status, name: item.name, mime: item.mime,
            size: item.size_bytes, kind: item.kind, version: item.version,
            createdAt: item.created_at,
            download: `/tasks/${item.task_id}/artifacts/${item.id}/download`,
            delete: `/tasks/${item.task_id}/artifacts/${item.id}`,
          }));
          taskItems = reset ? page : taskItems.concat(page);
          nextCursor = data.next_cursor || null;
          cursor = data.next_cursor || null;
        }));
      }
      if (source !== 'task'){
        requests.push(api.get('/artifacts', { signal }).then(data => {
          chatItems = (data.artifacts || [])
            .filter(item => !query || String(item.name).toLowerCase().includes(query.toLowerCase()))
            .map(normalizeChat);
          if (source === 'chat') nextCursor = null;
        }));
      }
      await Promise.all(requests);
      if (signal.aborted) return;
      render();
    } catch (e){
      if (signal.aborted || e.name === 'AbortError') return;
      error = e;
      render();
    } finally {
      loading = false;
    }
  }

  function findItem(id, itemSource){
    return items().find(item => item.id === id && (!itemSource || item.source === itemSource));
  }

  async function download(id, itemSource){
    const item = findItem(id, itemSource);
    if (!item) return;
    try { await downloadUrl(item.download, item.name); }
    catch (e){ toast(apiErrorMessage(e), false); }
  }

  async function remove(id, itemSource, name){
    const item = findItem(id, itemSource);
    if (!item) return;
    const ok = await confirmDialog({ title: '删除产物', message: `确定删除「${name}」？`, confirmText: '删除', danger: true });
    if (!ok) return;
    try {
      await api.del(item.delete);
      toast('已删除');
      await load(true);
    } catch (e){ toast(describeApiError(e), false); }
  }

  async function preview(id, itemSource){
    const item = findItem(id, itemSource);
    if (!item) return;
    const { el, close } = openDrawer({
      title: item.name,
      wide: true,
      body: `<div class="artifact-preview" data-preview-body>${skeletonRows(2)}</div>`,
      footer: `<button class="btn" data-drawer-close>关闭</button>
        <button class="btn primary" data-preview-download>下载</button>`,
    });
    $('[data-preview-download]', el).addEventListener('click', () => download(id, itemSource));
    const body = $('[data-preview-body]', el);
    let objectUrl = null;
    try {
      if (Number(item.size) > MAX_PREVIEW){
        body.innerHTML = emptyBlock('文件较大', `预览上限 ${fmtSize(MAX_PREVIEW)}，请下载后查看。`);
        return;
      }
      const blob = await fetchBlob(item.download, { signal });
      const mime = (item.mime || blob.type || '').split(';')[0].trim().toLowerCase();
      if (IMAGE_TYPES.has(mime)){
        objectUrl = URL.createObjectURL(blob);
        body.innerHTML = `<img class="preview-image" alt="${esc(item.name)}">`;
        $('.preview-image', body).src = objectUrl;
      } else if (TEXT_TYPES.has(mime) || mime.startsWith('text/')){
        const text = await blob.text();
        body.innerHTML = `<pre class="code-block preview-text"></pre>`;
        const target = $('.preview-text', body);
        if (mime === 'application/json') {
          try { target.textContent = JSON.stringify(JSON.parse(text), null, 2); }
          catch { target.textContent = text; }
        } else target.textContent = text;
      } else {
        body.innerHTML = emptyBlock('不支持内联预览', `${mime || '未知类型'} 只能下载查看。`);
      }
    } catch (e){
      if (!signal.aborted) body.innerHTML = errorBlock(e);
    }
    const originalClose = close;
    el.querySelectorAll('[data-drawer-close]').forEach(button => button.addEventListener('click', () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      originalClose();
    }));
    // 抽屉被遮罩/Esc 关闭时也释放 object URL。
    const observer = new MutationObserver(() => {
      if (!document.body.contains(el)){
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        observer.disconnect();
      }
    });
    observer.observe(document.getElementById('drawer-slot'), { childList: true });
  }

  signal.addEventListener('abort', () => { clearTimeout(debounce); closeDrawer(); }, { once: true });

  await load(true);
  if (ctx.query.preview){
    const item = findItem(ctx.query.preview);
    if (item) preview(item.id, item.source);
  }
}
