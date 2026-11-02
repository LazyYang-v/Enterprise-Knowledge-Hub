// P0-5 文件工具：只读写当前任务的成果文件，所有磁盘路径由成果服务生成。
import { config } from '../config.js';
import { extractTextFromBuffer } from '../parse.js';
import { normalizeArtifactName, extensionOf } from '../artifacts/paths.js';
import { mimeForName, isTextExtension } from '../artifacts/mime.js';
import { inspectZip, readZipEntry, buildZip, ZipGuardError } from '../artifacts/zip-guard.js';
import { createDocx } from '../artifacts/docx.js';

function toolError(code, message, { retryable = false } = {}){
  const e = new Error(message);
  e.code = code;
  e.retryable = retryable;
  return e;
}

function artifactService(ctx){
  if (!ctx?.artifacts) throw toolError('artifact_unavailable', '成果服务不可用', { retryable: true });
  return ctx.artifacts;
}

function limitsOf(ctx){
  return ctx?.artifacts?.fileLimits || config.files;
}

function taskIds(ctx){
  return { tenantId: ctx.task.tenant_id, taskId: ctx.task.id };
}

async function readInput(ctx, args){
  const svc = artifactService(ctx);
  try {
    return await svc.getForRead({
      ...taskIds(ctx),
      artifactId: args.artifact_id || null,
      name: args.name || null,
    });
  } catch (e){
    if (e?.code) throw toolError(e.code, e.message);
    throw e;
  }
}

function artifactRef(meta){
  return {
    artifact_id: meta.id,
    name: meta.name,
    version: meta.version,
    mime: meta.mime,
    size_bytes: meta.size_bytes,
    sha256: meta.sha256,
  };
}

async function writeOutput(ctx, { name, buffer, mime, scan = false }){
  try {
    const meta = await artifactService(ctx).ingest({
      ...taskIds(ctx),
      stepId: ctx.stepId || null,
      toolCallId: ctx.toolCallId || null,
      workerId: ctx.workerId || null,
      leaseEpoch: ctx.leaseEpoch ?? null,
      name, kind: 'output', buffer, mime,
      createdBy: `tool:${ctx.toolCallId || 'unknown'}`,
      scan,
    });
    return artifactRef(meta);
  } catch (e){
    if (e?.code) throw toolError(e.code, e.message, { retryable: !!e.retryable });
    throw e;
  }
}

const textOrArtifactRef = {
  type: 'object',
  properties: {
    artifact_id: { type: 'string', minLength: 1, maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
  },
  additionalProperties: false,
};

const entriesRef = {
  type: 'array',
  minItems: 1,
  maxItems: 50,
  items: {
    type: 'object',
    properties: {
      artifact_id: { type: 'string', minLength: 1, maxLength: 64 },
      name: { type: 'string', minLength: 1, maxLength: 200 },
    },
    additionalProperties: false,
  },
};

function csvCell(value){
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const FILE_TOOLS = Object.freeze([
  {
    name: 'artifact.create',
    version: '1.0.0',
    source: 'builtin',
    description: '把文本或 base64 内容写入当前任务的成果文件，返回 artifact_id。写入前会扫描疑似密钥。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200, description: '文件名（单段，含扩展名）' },
        content: { type: 'string', minLength: 1, maxLength: 30000, description: '文件内容' },
        mime: { type: 'string', maxLength: 200, description: '可选 MIME；默认按扩展名推断' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: '默认 utf8' },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    side_effect: 'write_workspace',
    approval_policy: 'risk_based',
    timeout_ms: 30000,
    idempotency: 'required',
    resource_scope: 'task',
    sandbox_profile: 'workspace_write',
    handler: async (args, ctx) => {
      const name = normalizeArtifactName(args.name);
      const encoding = args.encoding || 'utf8';
      const buffer = encoding === 'base64'
        ? Buffer.from(args.content, 'base64')
        : Buffer.from(args.content, 'utf8');
      if (!buffer.length) throw toolError('artifact_invalid_content', '内容为空');
      const mime = args.mime || mimeForName(name);
      const artifact = await writeOutput(ctx, { name, buffer, mime, scan: encoding === 'utf8' });
      return { artifact };
    },
  },
  {
    name: 'document.read',
    version: '1.0.0',
    source: 'builtin',
    description: '读取当前任务中某个文档成果的文本（PDF/DOCX/XLSX/PPTX/纯文本），支持分页。',
    input_schema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string', minLength: 1, maxLength: 64 },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        offset: { type: 'integer', minimum: 0, description: '起始字符偏移，默认 0' },
        limit: { type: 'integer', minimum: 1, maximum: 100000, description: '返回字符上限' },
      },
      anyOf: [{ required: ['artifact_id'] }, { required: ['name'] }],
      additionalProperties: false,
    },
    side_effect: 'read',
    approval_policy: 'never',
    timeout_ms: 30000,
    idempotency: 'none',
    resource_scope: 'task',
    sandbox_profile: 'read_only',
    handler: async (args, ctx) => {
      const lim = limitsOf(ctx);
      const { artifact, buffer } = await readInput(ctx, args);
      const ext = extensionOf(artifact.name);
      let parsed;
      try {
        parsed = await extractTextFromBuffer(buffer, ext, {
          maxChars: lim.extractMaxChars, maxRows: lim.sheetMaxRows, maxCols: lim.sheetMaxCols,
        });
      } catch (e){
        throw toolError('document_parse_failed', e.message);
      }
      const offset = Math.max(0, Number(args.offset) || 0);
      const limit = Math.min(Math.max(Number(args.limit) || lim.maxReadChars, 1), lim.maxReadChars);
      const text = parsed.text.slice(offset, offset + limit);
      const next = offset + text.length < parsed.text.length ? offset + text.length : null;
      return {
        artifact: artifactRef(artifact),
        text,
        offset,
        next_offset: next,
        truncated: next != null || text.length < parsed.text.length,
        note: parsed.note,
      };
    },
  },
  {
    name: 'document.write',
    version: '1.0.0',
    source: 'builtin',
    description: '把文本写成成果文档：.md/.txt/.json/.csv/.yaml 或最小 .docx。不支持 PDF/XLSX。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        content: { type: 'string', minLength: 1, maxLength: 30000 },
        format: { type: 'string', enum: ['md', 'txt', 'json', 'csv', 'docx'], description: '可选；默认按扩展名' },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    side_effect: 'write_workspace',
    approval_policy: 'risk_based',
    timeout_ms: 30000,
    idempotency: 'required',
    resource_scope: 'task',
    sandbox_profile: 'workspace_write',
    handler: async (args, ctx) => {
      const name = normalizeArtifactName(args.name);
      const ext = (args.format || extensionOf(name)).toLowerCase();
      const nameExt = extensionOf(name);
      if (args.format && nameExt && nameExt !== ext && !(ext === 'md' && nameExt === 'markdown')){
        throw toolError('document_write_unsupported', `文件名扩展名与 format 不一致：.${nameExt} / ${ext}`);
      }
      if (['pdf', 'xlsx', 'xls', 'pptx', 'ppt'].includes(ext)){
        throw toolError('document_write_unsupported', `不支持写入 .${ext}；请改用 .docx/.md/.txt/.json/.csv`);
      }
      if (!['md', 'markdown', 'txt', 'json', 'csv', 'yaml', 'yml', 'docx'].includes(ext)){
        throw toolError('document_write_unsupported', `不支持的文档类型：${ext || '未知'}`);
      }
      let buffer;
      if (ext === 'docx'){
        buffer = createDocx({ paragraphs: [args.content] });
      } else if (ext === 'json'){
        let pretty;
        try { pretty = JSON.stringify(JSON.parse(args.content), null, 2) + '\n'; }
        catch { throw toolError('document_invalid_json', 'JSON 内容不合法'); }
        buffer = Buffer.from(pretty, 'utf8');
      } else {
        buffer = Buffer.from(args.content, 'utf8');
      }
      const artifact = await writeOutput(ctx, { name, buffer, mime: mimeForName(name), scan: ext !== 'docx' });
      return { artifact };
    },
  },
  {
    name: 'spreadsheet.read',
    version: '1.0.0',
    source: 'builtin',
    description: '读取当前任务中的 XLSX 成果，返回工作表名与 CSV 片段（行列受限）。',
    input_schema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string', minLength: 1, maxLength: 64 },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        sheet: { type: 'string', maxLength: 100, description: '工作表名；默认第一张' },
        offset: { type: 'integer', minimum: 0, description: '起始行，默认 0' },
        limit_rows: { type: 'integer', minimum: 1, maximum: 1000 },
        limit_cols: { type: 'integer', minimum: 1, maximum: 200 },
      },
      anyOf: [{ required: ['artifact_id'] }, { required: ['name'] }],
      additionalProperties: false,
    },
    side_effect: 'read',
    approval_policy: 'never',
    timeout_ms: 30000,
    idempotency: 'none',
    resource_scope: 'task',
    sandbox_profile: 'read_only',
    handler: async (args, ctx) => {
      const lim = limitsOf(ctx);
      const { artifact, buffer } = await readInput(ctx, args);
      const ext = extensionOf(artifact.name);
      if (!['xlsx', 'xls', 'xlsm', 'csv'].includes(ext)){
        throw toolError('artifact_unsupported_type', `不是表格文件：${ext || '未知'}`);
      }
      const XLSX = await import('xlsx');
      let wb;
      try {
        wb = XLSX.read(buffer, { type: 'buffer', sheetRows: lim.sheetMaxRows + 1, cellFormula: false, cellHTML: false });
      } catch (e){
        throw toolError('document_parse_failed', `表格解析失败：${e.message}`);
      }
      const sheetName = args.sheet && wb.SheetNames.includes(args.sheet) ? args.sheet : wb.SheetNames[0];
      if (!sheetName) throw toolError('document_parse_failed', '工作簿没有工作表');
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: '', blankrows: false });
      const offset = Math.max(0, Number(args.offset) || 0);
      const limitRows = Math.min(Math.max(Number(args.limit_rows) || 200, 1), lim.sheetMaxRows);
      const limitCols = Math.min(Math.max(Number(args.limit_cols) || lim.sheetMaxCols, 1), lim.sheetMaxCols);
      let clipped = rows.length > lim.sheetMaxRows;
      const selected = rows.slice(offset, offset + limitRows).map(row => {
        if (row.length > limitCols) clipped = true;
        return row.slice(0, limitCols);
      });
      const csv = selected.map(row => row.map(csvCell).join(',')).join('\n');
      return {
        artifact: artifactRef(artifact),
        sheets: wb.SheetNames,
        sheet: sheetName,
        csv,
        offset,
        next_offset: offset + selected.length < rows.length ? offset + selected.length : null,
        truncated: clipped || offset + selected.length < rows.length,
      };
    },
  },
  {
    name: 'spreadsheet.write',
    version: '1.0.0',
    source: 'builtin',
    description: '把二维表格写成 XLSX 成果。所有单元格按字面量写入，不解析公式。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        sheets: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 100 },
              rows: { type: 'array', maxItems: 5000, items: { type: 'array', maxItems: 200, items: {} } },
            },
            required: ['name', 'rows'],
            additionalProperties: false,
          },
        },
      },
      required: ['name', 'sheets'],
      additionalProperties: false,
    },
    side_effect: 'write_workspace',
    approval_policy: 'risk_based',
    timeout_ms: 60000,
    idempotency: 'required',
    resource_scope: 'task',
    sandbox_profile: 'workspace_write',
    handler: async (args, ctx) => {
      const lim = limitsOf(ctx);
      const name = normalizeArtifactName(args.name);
      if (!['xlsx', 'xls'].includes(extensionOf(name))){
        throw toolError('artifact_unsupported_type', '表格成果必须使用 .xlsx 扩展名');
      }
      if (args.sheets.length > 10) throw toolError('spreadsheet_too_large', '工作表数量超限');
      const sheetNames = new Set();
      for (const sheet of args.sheets){
        const trimmed = sheet.name.slice(0, 31);
        if (!trimmed) throw toolError('spreadsheet_invalid_sheet', '工作表名不能为空');
        if (sheetNames.has(trimmed.toLowerCase())) throw toolError('spreadsheet_invalid_sheet', `工作表名重复：${trimmed}`);
        sheetNames.add(trimmed.toLowerCase());
        if (sheet.rows.length > lim.sheetMaxRows) throw toolError('spreadsheet_too_large', '行数超限');
        for (const row of sheet.rows){
          if (row.length > lim.sheetMaxCols) throw toolError('spreadsheet_too_large', '列数超限');
        }
      }
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      for (const sheet of args.sheets){
        const ws = XLSX.utils.aoa_to_sheet(sheet.rows.map(row => row.map(v => {
          if (v == null) return '';
          if (typeof v === 'object') return JSON.stringify(v);
          return v;
        })));
        XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
      }
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
      const artifact = await writeOutput(ctx, { name, buffer, mime: mimeForName(name), scan: false });
      return {
        artifact,
        sheets: args.sheets.map(s => ({ name: s.name, rows: s.rows.length })),
      };
    },
  },
  {
    name: 'archive.read',
    version: '1.0.0',
    source: 'builtin',
    description: '列出当前任务中的 ZIP 成果条目；可选抽取文本类条目。路径遍历、符号链接与压缩炸弹会被拒绝。',
    input_schema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string', minLength: 1, maxLength: 64 },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        entries: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 1024 } },
        include_text: { type: 'boolean', description: '是否抽取文本类条目，默认 false' },
        max_chars: { type: 'integer', minimum: 1, maximum: 20000 },
      },
      anyOf: [{ required: ['artifact_id'] }, { required: ['name'] }],
      additionalProperties: false,
    },
    side_effect: 'read',
    approval_policy: 'never',
    timeout_ms: 30000,
    idempotency: 'none',
    resource_scope: 'task',
    sandbox_profile: 'read_only',
    handler: async (args, ctx) => {
      const lim = limitsOf(ctx);
      const { artifact, buffer } = await readInput(ctx, args);
      if (!['zip', 'docx', 'xlsx', 'pptx'].includes(extensionOf(artifact.name))){
        throw toolError('artifact_unsupported_type', '不是 ZIP 文件');
      }
      let inspected;
      try {
        inspected = inspectZip(buffer, {
          maxEntries: lim.zipMaxEntries,
          maxEntryBytes: lim.zipMaxEntryBytes,
          maxTotalBytes: lim.zipMaxTotalBytes,
          maxRatio: lim.zipMaxRatio,
        });
      } catch (e){
        if (e instanceof ZipGuardError) throw toolError(e.code, e.message);
        throw e;
      }
      const wanted = Array.isArray(args.entries) && args.entries.length ? new Set(args.entries) : null;
      const selected = inspected.entries.filter(e => !wanted || wanted.has(e.name));
      if (wanted && selected.length !== wanted.size){
        throw toolError('archive_entry_not_found', '请求的 ZIP 条目不存在');
      }
      const totalLimit = Math.min(Math.max(Number(args.max_chars) || lim.maxReadChars, 1), lim.maxReadChars);
      const entries = selected.map(e => ({ name: e.name, size: e.size, is_dir: e.isDir }));
      let used = 0;
      const texts = [];
      if (args.include_text){
        for (const e of selected){
          if (e.isDir || used >= totalLimit) continue;
          const ext = extensionOf(e.name);
          if (!isTextExtension(ext) && !['pdf', 'docx', 'xlsx', 'pptx'].includes(ext)) continue;
          if (['zip', 'docx', 'xlsx', 'pptx'].includes(ext) && ext !== extensionOf(artifact.name)){
            // 嵌套归档只列出，不自动展开。
            entries.find(x => x.name === e.name).note = 'nested_archive_not_expanded';
            continue;
          }
          let data;
          try {
            data = readZipEntry(inspected.zip, e.name, {
              maxEntries: lim.zipMaxEntries,
              maxEntryBytes: lim.zipMaxEntryBytes,
              maxTotalBytes: lim.zipMaxTotalBytes,
              maxRatio: lim.zipMaxRatio,
            });
          } catch (err){
            if (err instanceof ZipGuardError) throw toolError(err.code, err.message);
            throw err;
          }
          let parsed;
          try {
            parsed = await extractTextFromBuffer(data, ext, {
              maxChars: Math.max(1, totalLimit - used),
              maxRows: lim.sheetMaxRows, maxCols: lim.sheetMaxCols,
            });
          } catch {
            continue;
          }
          const text = parsed.text.slice(0, Math.max(0, totalLimit - used));
          if (text){
            texts.push({ name: e.name, text });
            used += text.length;
          }
        }
      }
      return {
        artifact: artifactRef(artifact),
        entries,
        texts,
        truncated: used >= totalLimit,
      };
    },
  },
  {
    name: 'archive.create',
    version: '1.0.0',
    source: 'builtin',
    description: '把当前任务的成果文件打包成 ZIP。条目名取自成果文件名；不允许外部路径。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        entries: entriesRef,
        include_all: { type: 'boolean', description: '打包当前任务全部成果（默认排除 ZIP 自身）' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    side_effect: 'write_workspace',
    approval_policy: 'risk_based',
    timeout_ms: 60000,
    idempotency: 'required',
    resource_scope: 'task',
    sandbox_profile: 'workspace_write',
    handler: async (args, ctx) => {
      const lim = limitsOf(ctx);
      const name = normalizeArtifactName(args.name);
      if (extensionOf(name) !== 'zip') throw toolError('artifact_unsupported_type', '打包成果必须使用 .zip 扩展名');
      const svc = artifactService(ctx);
      const refs = Array.isArray(args.entries) ? args.entries : [];
      if (!refs.length && !args.include_all){
        throw toolError('archive_empty', '需要 entries 或 include_all=true');
      }
      const items = [];
      const seen = new Set();
      for (const ref of refs){
        const { artifact, buffer } = await readInput(ctx, ref);
        const entryName = artifact.name;
        if (seen.has(entryName.toLowerCase())) throw toolError('archive_duplicate_entry', `条目重复：${entryName}`);
        seen.add(entryName.toLowerCase());
        items.push({ name: entryName, data: buffer });
      }
      if (args.include_all){
        const list = await svc.list({ ...taskIds(ctx), limit: 200 });
        for (const item of list){
          if (item.name === name) continue;
          if (item.kind === 'input') continue;
          if (seen.has(item.name.toLowerCase())) continue;
          const read = await svc.getForRead({ ...taskIds(ctx), artifactId: item.id });
          seen.add(item.name.toLowerCase());
          items.push({ name: item.name, data: read.buffer });
        }
      }
      let buffer;
      try {
        buffer = buildZip(items, {
          maxEntries: lim.zipMaxEntries,
          maxEntryBytes: lim.zipMaxEntryBytes,
          maxTotalBytes: lim.zipMaxTotalBytes,
          maxRatio: lim.zipMaxRatio,
        });
      } catch (e){
        if (e instanceof ZipGuardError) throw toolError(e.code, e.message);
        throw e;
      }
      const artifact = await writeOutput(ctx, { name, buffer, mime: 'application/zip', scan: false });
      return { artifact, entries: items.map(x => x.name) };
    },
  },
]);

const BY_NAME = new Map(FILE_TOOLS.map(t => [t.name, t]));

export function fileToolDescriptors(){
  return FILE_TOOLS.map(({ handler, ...rest }) => rest);
}

export function getFileTool(name){
  return BY_NAME.get(String(name)) || null;
}

export function fileToolHandler(name){
  return BY_NAME.get(String(name))?.handler || null;
}

export { textOrArtifactRef };
