import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { db, UPLOAD_DIR } from '../db.js';
import { $uuid, now, err, fmtSize, fixFileName } from '../util.js';
import { authRequired } from '../auth.js';
import { enqueue } from '../ingest.js';
import { iconFor } from '../parse.js';
import { kbAccess, canWrite, visibleKbs } from '../knowledge/acl.js';

// 兼容旧 import：ACL 实现已迁到 knowledge/acl.js。
export { kbAccess, canWrite };

function kbRow(user, kb){
  const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(kb.owner_id);
  const org = kb.org_id ? db.prepare('SELECT name FROM orgs WHERE id = ?').get(kb.org_id) : null;
  const docs = db.prepare("SELECT COUNT(*) c, SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) ready FROM documents WHERE kb_id = ? AND deleted_at IS NULL").get(kb.id);
  const fav = !!db.prepare('SELECT 1 FROM kb_favorites WHERE user_id = ? AND kb_id = ?').get(user.id, kb.id);
  return {
    id: kb.id, name: kb.name, description: kb.description,
    owner_id: kb.owner_id, owner_name: owner?.name || '未知',
    org_id: kb.org_id, org_name: org?.name || '',
    pinned: !!kb.pinned,
    docs: docs.c || 0, ready_docs: docs.ready || 0,
    fav, created_at: kb.created_at, updated_at: kb.updated_at,
  };
}
export { kbRow };

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, $uuid());
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    // 文件夹上传时文件名可能是 "目录/子目录/文件名"，落盘前去掉路径分隔符
    filename: (req, file, cb) => cb(null, fixFileName(file.originalname).replace(/[\\/]+/g, '__')),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

const router = Router();
router.use(authRequired);

// —— 知识库列表 ——
router.get('/kbs', (req, res) => {
  const { scope = 'all', q = '' } = req.query;
  let visible = visibleKbs(req.user.id);
  if (q) visible = visible.filter(kb => (kb.name + kb.description).toLowerCase().includes(String(q).toLowerCase()));
  const favSet = new Set(db.prepare('SELECT kb_id FROM kb_favorites WHERE user_id = ?').all(req.user.id).map(r => r.kb_id));
  let list = visible;
  if (scope === 'mine') list = visible.filter(kb => kb.owner_id === req.user.id);
  else if (scope === 'shared') list = visible.filter(kb => kb.owner_id !== req.user.id);
  else if (scope === 'fav') list = visible.filter(kb => favSet.has(kb.id));
  else if (scope === 'recent') list = visible.slice(0, 8);
  res.json({ kbs: list.map(kb => kbRow(req.user, kb)) });
});

router.post('/kbs', (req, res) => {
  const { name, description = '' } = req.body || {};
  if (!name || !String(name).trim()) return err(res, 400, '请填写知识库名称');
  const id = $uuid();
  db.prepare('INSERT INTO knowledge_bases(id, name, description, owner_id, created_at, updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, String(name).trim().slice(0, 60), String(description).slice(0, 300),
      req.user.id, now(), now());
  const kb = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(id);
  res.json({ kb: kbRow(req.user, kb) });
});

router.get('/kbs/:id', (req, res) => {
  const kb = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(req.params.id);
  if (!kb) return err(res, 404, '知识库不存在');
  const access = kbAccess(req.user, kb);
  if (!access.visible) return err(res, 403, '无权访问该知识库');
  res.json({ kb: kbRow(req.user, kb), role: access.role });
});

router.put('/kbs/:id', (req, res) => {
  const kb = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(req.params.id);
  if (!kb) return err(res, 404, '知识库不存在');
  const access = kbAccess(req.user, kb);
  if (!access.visible) return err(res, 403, '无权访问该知识库');
  if (!canWrite(access.role)) return err(res, 403, '没有编辑权限');
  const { name, description, pinned, org_id } = req.body || {};
  if (name != null) db.prepare('UPDATE knowledge_bases SET name = ? WHERE id = ?').run(String(name).trim().slice(0, 60) || kb.name, kb.id);
  if (description != null) db.prepare('UPDATE knowledge_bases SET description = ? WHERE id = ?').run(String(description).slice(0, 300), kb.id);
  if (pinned != null) db.prepare('UPDATE knowledge_bases SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, kb.id);
  if (org_id !== undefined){
    if (org_id === null || org_id === ''){
      db.prepare('UPDATE knowledge_bases SET org_id = NULL WHERE id = ?').run(kb.id);
    } else {
      const m = db.prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?').get(org_id, req.user.id);
      if (!m || !['owner', 'admin'].includes(m.role)) return err(res, 403, '没有向该空间共享的权限');
      db.prepare('UPDATE knowledge_bases SET org_id = ? WHERE id = ?').run(org_id, kb.id);
    }
  }
  db.prepare('UPDATE knowledge_bases SET updated_at = ? WHERE id = ?').run(now(), kb.id);
  const fresh = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(kb.id);
  res.json({ kb: kbRow(req.user, fresh) });
});

router.delete('/kbs/:id', (req, res) => {
  const kb = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(req.params.id);
  if (!kb) return err(res, 404, '知识库不存在');
  const access = kbAccess(req.user, kb);
  if (access.role !== 'owner') return err(res, 403, '只有创建者可以删除知识库');
  const docs = db.prepare('SELECT id, path FROM documents WHERE kb_id = ? AND deleted_at IS NULL').all(kb.id);
  for (const d of docs){
    db.prepare("UPDATE documents SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), d.id);
    if (d.path){ try { fs.rmSync(path.dirname(d.path), { recursive: true, force: true }); } catch {} }
  }
  db.prepare('DELETE FROM kb_favorites WHERE kb_id = ?').run(kb.id);
  db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(kb.id);
  res.json({ ok: true });
});

router.post('/kbs/:id/favorite', (req, res) => {
  const kb = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(req.params.id);
  if (!kb) return err(res, 404, '知识库不存在');
  const exists = db.prepare('SELECT 1 FROM kb_favorites WHERE user_id = ? AND kb_id = ?').get(req.user.id, kb.id);
  if (exists){
    db.prepare('DELETE FROM kb_favorites WHERE user_id = ? AND kb_id = ?').run(req.user.id, kb.id);
    return res.json({ fav: false });
  }
  db.prepare('INSERT INTO kb_favorites(user_id, kb_id) VALUES(?,?)').run(req.user.id, kb.id);
  res.json({ fav: true });
});

// —— 文档列表 ——
router.get('/kbs/:id/documents', (req, res) => {
  const kb = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(req.params.id);
  if (!kb) return err(res, 404, '知识库不存在');
  if (!kbAccess(req.user, kb).visible) return err(res, 403, '无权访问该知识库');
  const q = String(req.query.q || '').toLowerCase();
  let docs = db.prepare('SELECT * FROM documents WHERE kb_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(kb.id);
  if (q) docs = docs.filter(d => d.name.toLowerCase().includes(q));
  res.json({ docs: docs.map(d => docRow(d)) });
});

export function docRow(d){
  return {
    id: d.id, kb_id: d.kb_id, session_id: d.session_id, kind: d.kind,
    name: d.name, ext: d.ext, mime: d.mime, size: d.size,
    status: d.status, progress: d.progress, error: d.error || '',
    chunk_count: d.chunk_count, current_version: d.current_version ?? 1,
    content_hash: d.content_hash || '', deleted_at: d.deleted_at || null,
    created_at: d.created_at, updated_at: d.updated_at,
  };
}

router.post('/kbs/:id/documents', upload.array('files', 200), (req, res) => {
  const kb = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(req.params.id);
  if (!kb) return err(res, 404, '知识库不存在');
  const access = kbAccess(req.user, kb);
  if (!canWrite(access.role)) return err(res, 403, '没有上传权限');
  const files = req.files || [];
  if (!files.length) return err(res, 400, '未选择文件');
  // 文件夹上传时前端随每个文件附带相对路径（paths 字段），用于在文档名中保留目录结构
  const relPaths = [].concat(req.body.paths || []);
  const created = [];
  for (const [i, f] of files.entries()){
    const ext = path.extname(f.originalname).replace('.', '').toLowerCase();
    const id = $uuid();
    const finalPath = path.join(path.dirname(f.path), 'source.' + (ext || 'bin'));
    fs.renameSync(f.path, finalPath);
    db.prepare(`INSERT INTO documents(id, kb_id, owner_id, kind, name, mime, ext, size, path, status, created_at, updated_at)
                VALUES(?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`)
      .run(id, kb.id, req.user.id, 'file', fixFileName(relPaths[i] || f.originalname).slice(0, 200), f.mimetype || '', ext, f.size, finalPath, now(), now());
    enqueue(id);
    created.push(id);
  }
  db.prepare('UPDATE knowledge_bases SET updated_at = ? WHERE id = ?').run(now(), kb.id);
  res.json({ ids: created });
});

// 新增问答对
router.post('/kbs/:id/qa', (req, res) => {
  const kb = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(req.params.id);
  if (!kb) return err(res, 404, '知识库不存在');
  const access = kbAccess(req.user, kb);
  if (!canWrite(access.role)) return err(res, 403, '没有编辑权限');
  const { question, answer } = req.body || {};
  if (!question || !answer) return err(res, 400, '问题与答案不能为空');
  const id = $uuid();
  db.prepare(`INSERT INTO documents(id, kb_id, owner_id, kind, name, answer, ext, size, status, created_at, updated_at)
              VALUES(?,?,?,?,?,?, '', 0, 'pending', ?, ?)`)
    .run(id, kb.id, req.user.id, 'qa', String(question).trim().slice(0, 300), String(answer).slice(0, 20000), now(), now());
  enqueue(id);
  res.json({ id });
});

// —— 文档操作 ——
function getDocForRead(req, res){
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc || doc.deleted_at){ err(res, 404, '文档不存在'); return null; }
  let ok = doc.owner_id === req.user.id;
  if (!ok && doc.kb_id){
    const kb = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(doc.kb_id);
    if (kb) ok = kbAccess(req.user, kb).visible;
  }
  if (!ok && doc.session_id){
    const sess = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(doc.session_id);
    if (sess) ok = sess.user_id === req.user.id;
  }
  if (!ok){ err(res, 403, '无权访问该文档'); return null; }
  return doc;
}

router.get('/documents/:id', (req, res) => {
  const doc = getDocForRead(req, res);
  if (!doc) return;
  const requested = Number(req.query.version);
  const version = Number.isInteger(requested) && requested > 0 ? requested : (Number(doc.current_version) || 1);
  const chunks = db.prepare('SELECT id, idx, content, content_hash, locator_json FROM chunks WHERE document_id = ? AND document_version = ? ORDER BY idx').all(doc.id, version);
  res.json({ doc: docRow(doc), version, chunks });
});

router.get('/documents/:id/download', (req, res) => {
  const doc = getDocForRead(req, res);
  if (!doc) return;
  if (doc.kind === 'qa' || !doc.path || !fs.existsSync(doc.path)){
    const content = doc.kind === 'qa' ? `问题：${doc.name}\n回答：${doc.answer}` : '';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="doc.txt"`);
    return res.send(content);
  }
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`);
  res.sendFile(doc.path);
});

router.post('/documents/:id/reparse', (req, res) => {
  const doc = getDocForRead(req, res);
  if (!doc) return;
  db.prepare("UPDATE documents SET status = 'pending', progress = 0, error = '' WHERE id = ?").run(doc.id);
  enqueue(doc.id, { force: true });
  res.json({ ok: true });
});

router.delete('/documents/:id', (req, res) => {
  const doc = getDocForRead(req, res);
  if (!doc) return;
  const kb = doc.kb_id ? db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(doc.kb_id) : null;
  if (kb && !canWrite(kbAccess(req.user, kb).role)) return err(res, 403, '没有删除权限');
  // 软删除：保留版本/chunks 以支持历史引用与证据回读，仅从列表与检索中排除。
  db.prepare("UPDATE documents SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), doc.id);
  if (doc.path){ try { fs.rmSync(path.dirname(doc.path), { recursive: true, force: true }); } catch {} }
  res.json({ ok: true });
});

// 批量打包下载
router.post('/kbs/:id/batch-download', (req, res) => {
  const kb = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(req.params.id);
  if (!kb) return err(res, 404, '知识库不存在');
  if (!kbAccess(req.user, kb).visible) return err(res, 403, '无权访问该知识库');
  const { ids = [] } = req.body || {};
  let docs = db.prepare('SELECT * FROM documents WHERE kb_id = ? AND deleted_at IS NULL').all(kb.id);
  if (ids.length) docs = docs.filter(d => ids.includes(d.id));
  docs = docs.filter(d => d.path && fs.existsSync(d.path));
  if (!docs.length) return err(res, 400, '没有可下载的文件');
  import('adm-zip').then(async ({ default: AdmZip }) => {
    const zip = new AdmZip();
    for (const d of docs) zip.addLocalFile(d.path, '', d.name);
    const buf = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(kb.name + '-documents.zip')}`);
    res.send(buf);
  });
});

export default router;
