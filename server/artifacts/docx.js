// 最小 DOCX 生成器：只用 adm-zip 手写 OOXML，保证 Word/WPS/LibreOffice 可打开。
// 不支持样式、图片、表格；文本内容做 XML 转义。
import AdmZip from 'adm-zip';

function escapeXml(value){
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function runsFor(text){
  const lines = String(text ?? '').split(/\r?\n/);
  return lines.map((line, i) => (
    `<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>${i < lines.length - 1 ? '<w:r><w:br/></w:r>' : ''}`
  )).join('');
}

function paragraphXml(text, { bold = false, size = null } = {}){
  const rPr = bold || size
    ? `<w:rPr>${bold ? '<w:b/>' : ''}${size ? `<w:sz w:val="${Number(size)}"/>` : ''}</w:rPr>`
    : '';
  return `<w:p><w:pPr>${rPr}</w:pPr>${runsFor(text).replace(/<w:r>/g, `<w:r>${rPr}`)}</w:p>`;
}

export function createDocx({ title = null, paragraphs = [], author = 'Enterprise Knowledge Hub', createdAt = new Date() } = {}){
  const contentParts = [];
  if (title){
    contentParts.push(paragraphXml(String(title), { bold: true, size: 36 }));
  }
  for (const p of paragraphs){
    contentParts.push(paragraphXml(String(p ?? '')));
  }
  if (!contentParts.length) contentParts.push('<w:p/>');

  const stamp = new Date(createdAt).toISOString();
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${contentParts.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title || '')}</dc:title><dc:creator>${escapeXml(author)}</dc:creator><cp:lastModifiedBy>${escapeXml(author)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`;

  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(contentTypes, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(rels, 'utf8'));
  zip.addFile('docProps/core.xml', Buffer.from(core, 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  return zip.toBuffer();
}
