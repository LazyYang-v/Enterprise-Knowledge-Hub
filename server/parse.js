// 文档文本抽取：PDF / Word / Excel / PPT / Markdown / HTML / 纯文本（图片仅存档）
import fs from 'node:fs';

export const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'xml', 'html', 'htm', 'srt', 'vtt']);

export function classify(ext){
  ext = (ext || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx' || ext === 'doc') return 'docx';
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
  if (ext === 'pptx' || ext === 'ppt') return 'pptx';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) return 'image';
  return 'binary';
}

export const DOC_ICONS = {
  pdf: 'pdf', docx: 'doc', xlsx: 'xls', pptx: 'ppt', text: 'md', image: 'img', binary: 'file',
};
export function iconFor(ext){
  const kind = classify(ext);
  if (kind === 'text'){
    if (ext === 'pdf') return 'pdf';
    if (['md', 'markdown'].includes(ext)) return 'md';
    if (['csv', 'tsv'].includes(ext)) return 'xls';
    return 'txt';
  }
  return DOC_ICONS[kind] || 'file';
}

async function parsePdf(filePath){
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const parts = [];
  for (let i = 1; i <= doc.numPages; i++){
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '', lastY = null;
    for (const item of content.items){
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 2) text += '\n';
      text += item.str;
      if (item.hasEOL) text += '\n';
      lastY = item.transform[5];
    }
    if (text.trim()) parts.push(`【第 ${i} 页】\n` + text.trim());
    page.cleanup();
  }
  await doc.destroy();
  return parts.join('\n\n');
}

async function parseDocx(filePath){
  const mammoth = (await import('mammoth')).default || await import('mammoth');
  const { value } = await mammoth.extractRawText({ path: filePath });
  return value;
}

async function parseXlsx(filePath){
  const XLSX = await import('xlsx');
  const wb = XLSX.readFile(filePath);
  const parts = [];
  for (const name of wb.SheetNames){
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    if (csv.trim()) parts.push(`【工作表：${name}】\n` + csv.trim());
  }
  return parts.join('\n\n');
}

async function parsePptx(filePath){
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries().filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => num(a.entryName) - num(b.entryName));
  const parts = [];
  for (const entry of entries){
    const xml = entry.getData().toString('utf8');
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]).filter(t => t.trim());
    if (texts.length) parts.push(`【幻灯片 ${num(entry.entryName)}】\n` + texts.join('\n'));
  }
  return parts.join('\n\n');
  function num(name){ return parseInt(name.match(/slide(\d+)\.xml/)?.[1] || '0', 10); }
}

function stripHtml(html){
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

// 返回 { text, note }
export async function extractText(filePath, ext){
  const kind = classify(ext);
  try {
    if (kind === 'pdf') return { text: await parsePdf(filePath), note: '' };
    if (kind === 'docx'){
      if (ext === 'doc') return { text: '', note: '旧版 .doc 格式不受支持，请另存为 .docx' };
      return { text: await parseDocx(filePath), note: '' };
    }
    if (kind === 'xlsx') return { text: await parseXlsx(filePath), note: '' };
    if (kind === 'pptx') return { text: await parsePptx(filePath), note: '' };
    if (kind === 'text'){
      const raw = fs.readFileSync(filePath, 'utf8');
      const text = ['html', 'htm'].includes(ext) ? stripHtml(raw) : raw;
      return { text, note: '' };
    }
    if (kind === 'image'){
      return { text: '', note: '图片文件仅存档，不参与文本检索' };
    }
    return { text: '', note: '该文件类型暂不支持文本抽取，已存档' };
  } catch (e){
    throw new Error(`解析失败：${e.message}`);
  }
}

// —— 分块：按段落聚合，目标 chunkSize 字符，带 overlap ——
export function chunkText(text, { chunkSize = 520, overlap = 60 } = {}){
  const clean = String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n+/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ''; };
  for (const p of paras){
    if (p.length > chunkSize * 1.6){
      flush();
      for (let i = 0; i < p.length; i += chunkSize - overlap){
        chunks.push(p.slice(i, i + chunkSize));
        if (i + chunkSize >= p.length) break;
      }
      continue;
    }
    if ((buf + '\n' + p).length > chunkSize && buf) flush();
    buf = buf ? buf + '\n' + p : p;
  }
  flush();
  return chunks;
}
