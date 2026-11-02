// SQLite 知识面读取：只做数据访问，不在这里做权限判断。
import { db } from '../db.js';
import { visibleKbIds, visibleKbs } from './acl.js';
import { getModel } from '../model-registry.js';
import { embed } from '../llm.js';

export function createSqliteKnowledgeStore(){
  return {
    listVisibleKbIds(userId){ return visibleKbIds(userId); },
    listVisibleKbs(userId){ return visibleKbs(userId); },
    listAllKbIds(){ return db.prepare('SELECT id FROM knowledge_bases').all().map(r => r.id); },
    getKb(kbId){ return db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(kbId) || null; },
    getKbsByIds(ids){
      const unique = [...new Set((ids || []).map(String).filter(Boolean))];
      if (!unique.length) return [];
      return db.prepare(`SELECT * FROM knowledge_bases WHERE id IN (${unique.map(() => '?').join(',')})`).all(...unique);
    },
    getSession(sessionId){ return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId) || null; },
    getDocument(documentId){ return db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId) || null; },
    getDocumentVersion(documentId, version){
      const row = db.prepare('SELECT * FROM document_versions WHERE document_id = ? AND version = ?').get(documentId, version);
      if (row) return row;
      return null;
    },
    listDocumentVersions(documentId){
      return db.prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY version DESC').all(documentId);
    },
    listChunks(documentId, version){
      return db.prepare(`
        SELECT id, idx, content, content_hash, locator_json, document_version
        FROM chunks WHERE document_id = ? AND document_version = ? ORDER BY idx
      `).all(documentId, version);
    },
    getChunk(chunkId){
      return db.prepare(`
        SELECT c.*, d.name AS doc_name, d.deleted_at, d.current_version,
               k.name AS kb_name
        FROM chunks c
        LEFT JOIN documents d ON d.id = c.document_id
        LEFT JOIN knowledge_bases k ON k.id = c.kb_id
        WHERE c.id = ?
      `).get(chunkId) || null;
    },
    getEmbeddingModel(){ return getModel('embedding'); },
    embed(model, texts){ return embed(model, texts); },
    health(){ db.prepare('SELECT 1').get(); return true; },
  };
}
