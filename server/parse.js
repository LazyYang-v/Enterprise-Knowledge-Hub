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

async function parsePdfBuffer(buffer, { maxPages = 200 } = {}){
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const parts = [];
  const pages = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= pages; i++){
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
  const truncated = doc.numPages > pages;
  await doc.destroy();
  return { text: parts.join('\n\n'), note: truncated ? `PDF 页数超过 ${maxPages}，已截断` : '' };
}

async function parseDocxBuffer(buffer){
  const mammoth = (await import('mammoth')).default || await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer });
  return { text: value, note: '' };
}

function csvCell(value){
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function parseXlsxBuffer(buffer, { maxRows = 5000, maxCols = 100 } = {}){
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', sheetRows: maxRows + 1, cellFormula: false, cellHTML: false, cellStyles: false });
  const parts = [];
  let truncated = false;
  for (const name of wb.SheetNames){
    const sheet = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
    if (rows.length > maxRows){
      truncated = true;
      rows.length = maxRows;
    }
    let clipped = false;
    const lines = rows.map(row => {
      if (row.length > maxCols){ clipped = true; row = row.slice(0, maxCols); }
      return row.map(csvCell).join(',');
    }).filter(line => line.trim());
    if (clipped) truncated = true;
    if (lines.length) parts.push(`【工作表：${name}】\n` + lines.join('\n'));
  }
  return { text: parts.join('\n\n'), note: truncated ? `表格超过行列上限（${maxRows} 行 / ${maxCols} 列），已截断` : '' };
}

async function parsePptxBuffer(buffer){
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => num(a.entryName) - num(b.entryName));
  const parts = [];
  for (const entry of entries){
    const xml = entry.getData().toString('utf8');
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]).filter(t => t.trim());
    if (texts.length) parts.push(`【幻灯片 ${num(entry.entryName)}】\n` + texts.join('\n'));
  }
  return { text: parts.join('\n\n'), note: '' };
  function num(name){ return parseInt(name.match(/slide(\d+)\.xml/)?.[1] || '0', 10); }
}

function stripHtml(html){
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

// 从内存 Buffer 抽取文本；成果工具与引用解析共用，避免落临时文件。
export async function extractTextFromBuffer(buffer, ext, {
  maxChars = 200000, maxPages = 200, maxRows = 5000, maxCols = 100,
} = {}){
  const kind = classify(ext);
  try {
    let result;
    if (kind === 'pdf') result = await parsePdfBuffer(buffer, { maxPages });
    else if (kind === 'docx'){
      if (ext === 'doc') return { text: '', note: '旧版 .doc 格式不受支持，请另存为 .docx' };
      result = await parseDocxBuffer(buffer);
    } else if (kind === 'xlsx') result = await parseXlsxBuffer(buffer, { maxRows, maxCols });
    else if (kind === 'pptx') result = await parsePptxBuffer(buffer);
    else if (kind === 'text'){
      let raw = buffer.toString('utf8').replace(/^﻿/, '');
      result = { text: ['html', 'htm'].includes(ext) ? stripHtml(raw) : raw, note: '' };
    } else if (kind === 'image'){
      return { text: '', note: '图片文件仅存档，不参与文本检索' };
    } else {
      return { text: '', note: '该文件类型暂不支持文本抽取，已存档' };
    }
    if (result.text.length > maxChars){
      return { text: result.text.slice(0, maxChars), note: `${result.note ? result.note + '；' : ''}文本超过 ${maxChars} 字符，已截断` };
    }
    return result;
  } catch (e){
    throw new Error(`解析失败：${e.message}`);
  }
}

// 返回 { text, note }
export async function extractText(filePath, ext, opts = {}){
  const buffer = fs.readFileSync(filePath);
  return extractTextFromBuffer(buffer, ext, opts);
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
