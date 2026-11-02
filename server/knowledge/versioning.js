// 知识面版本化辅助：内容哈希与定位信息。
// 定位优先使用解析器写入的页/工作表/幻灯片标记，缺失时回退到 chunk 序号。
import crypto from 'node:crypto';
import fs from 'node:fs';

export function hashBuffer(buf){
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function hashText(text){
  return hashBuffer(Buffer.from(String(text ?? ''), 'utf8'));
}

export function hashFile(filePath){
  try { return hashBuffer(fs.readFileSync(filePath)); } catch { return null; }
}

export function chunkContentHash(content){
  return hashText(content);
}

/** 文件优先用源文件字节哈希；问答对/无文件文档用抽取文本哈希。 */
export function documentContentHash(doc, text){
  if (doc?.kind === 'file' && doc.path){
    const h = hashFile(doc.path);
    if (h) return h;
  }
  return hashText(text || '');
}

export function normalizeDocStatus(status){
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  return 'processing';
}

/**
 * 为每个 chunk 生成 locator：
 * { chunk_index, char_start, char_end, page?, sheet?, slide? }
 */
export function buildLocators(fullText, chunks){
  const text = String(fullText || '');
  let cursor = 0;
  return chunks.map((chunk, i) => {
    const at = text.indexOf(chunk, cursor);
    const start = at >= 0 ? at : cursor;
    const end = start + chunk.length;
    cursor = end;
    const prefix = text.slice(0, start);
    const loc = { chunk_index: i, char_start: start, char_end: end };
    const page = [...prefix.matchAll(/【第\s*(\d+)\s*页】/g)].pop();
    const sheet = [...prefix.matchAll(/【工作表：([^】]+)】/g)].pop();
    const slide = [...prefix.matchAll(/【幻灯片\s*(\d+)】/g)].pop();
    if (page) loc.page = Number(page[1]);
    if (sheet) loc.sheet = sheet[1];
    if (slide) loc.slide = Number(slide[1]);
    return loc;
  });
}
