// 首次启动时注入演示数据：演示用户 + 示例知识库与文档（走真实解析管线）
import fs from 'node:fs';
import path from 'node:path';
import { db, UPLOAD_DIR } from './db.js';
import { $uuid, now } from './util.js';
import { enqueue } from './ingest.js';

const FILES = {
  '平台功能总览.md': `# 企业知识库 · 平台功能总览

## 核心能力

平台围绕企业知识沉淀提供三大能力，全部共享同一套知识库体系：

1. **RAG 问答**：关键词 + 向量混合检索，回答附带原文引用，可点击角标查看出处片段。
2. **智能体**：将模型、知识库与工具组合成可复用的对话助手，支持自定义系统提示词与问答模式。
3. **知识库管理**：统一管理文档与问答对，文档上传后自动解析、分块、向量化入库。

## 支持的文件格式

- PDF、Word（.docx）、Excel（.xlsx）、PowerPoint（.pptx）等 Office 文档
- Markdown、纯文本、HTML、CSV、JSON 等文本格式
- 图片等其余文件支持上传存档管理

## 检索机制

平台采用混合检索：FTS5 关键词检索与向量余弦相似度加权融合。上传文档后会按段落聚合分块（约 520 字符，带重叠），若配置了 Embedding 模型则同步生成向量。未配置向量模型时仅使用关键词通道，仍可正常检索。
`,
  '快速入门指南.md': `# 快速入门指南

## 1. 创建知识库

在「知识库」页面点击右上角「新建知识库」，填写名称与描述即可创建。

知识库统一管理两类内容：上传的文档，以及逐条添加的「问题 + 答案」问答对。

## 2. 上传文档

进入知识库详情，点击「上传文档」添加文件，或点击「新增问答对」逐条添加问答。文档解析状态分为：解析中、已完成、失败（失败可点击重试）。

## 3. 开始提问

点击侧边栏「新对话」，通过知识库芯片选择检索范围，输入问题后即可获得带引用的回答。回答下方的引用卡片可展开查看原文片段。

## 4. 配置模型

在「系统设置 → 模型管理」中添加 OpenAI 兼容接口（如 DeepSeek、Qwen、Ollama 本地模型），分别支持对话模型与 Embedding 向量模型。
`,
  '智能体使用说明.md': `# 智能体使用说明

## 什么是智能体

智能体把「模型 + 知识库 + 工具 + 提示词」打包成可复用的对话助手。创建入口在侧边栏「智能体」页面。

## 创建步骤

1. 点击「创建智能体」，填写名称、描述与头像配色。
2. 选择绑定的对话模型（留空则使用系统默认模型）。
3. 勾选智能体可以检索的知识库。
4. 编写系统提示词，定义角色、语气与回答规范。
5. 按需开启工具，如网络搜索。

## 与普通问答的区别

普通问答使用会话中临时选择的知识库；智能体则固化了知识库范围与提示词，适合售前咨询、HR 问答等固定场景，团队成员可以复用同一套配置。
`,
};

const QA_PAIRS = [
  ['平台支持哪些文件格式？', '支持 PDF、Word（.docx）、Excel（.xlsx）、PowerPoint（.pptx）、Markdown、纯文本、HTML、CSV、JSON 等格式；图片等其余文件仅存档管理，不参与文本检索。'],
  ['忘记密码怎么办？', '联系管理员在系统中重置，或使用登录页的注册功能重新创建账户。演示环境默认账号为 lzy@example.com / password。'],
  ['如何把知识库共享给同事？', '在「共享空间」创建空间并复制邀请码发给同事，随后在知识库设置中选择归属该空间，空间成员即可按角色访问（Owner/Admin 可管理，Contributor 可上传，Viewer 仅查看）。'],
  ['回答里的引用角标是什么？', '形如 [1] 的角标对应回答下方引用卡片中的资料片段，点击卡片可查看原文内容与相似度得分，便于溯源核对。'],
];

export function seedDemo(){
  const u1 = db.prepare("SELECT id FROM users WHERE email = 'lzy@example.com'").get();
  const u2 = db.prepare("SELECT id FROM users WHERE email = 'zhangwei@example.com'").get();
  const org = db.prepare("SELECT id FROM orgs LIMIT 1").get();
  if (!u1 || db.prepare('SELECT COUNT(*) c FROM knowledge_bases').get().c > 0) return;

  const insKb = db.prepare('INSERT INTO knowledge_bases(id, name, description, owner_id, org_id, pinned, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)');
  const insDoc = db.prepare("INSERT INTO documents(id, kb_id, owner_id, kind, name, mime, ext, size, path, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?, 'pending', ?, ?)");
  const insQa = db.prepare("INSERT INTO documents(id, kb_id, owner_id, kind, name, answer, status, created_at, updated_at) VALUES(?,?,?,?,?,?, 'pending', ?, ?)");

  // 产品知识库（我的，置顶）
  const kbProduct = $uuid();
  insKb.run(kbProduct, '产品知识库', '产品手册、功能说明与使用指南，售前售后首选知识来源。', u1.id, null, 1, now() - 86400000 * 2, now() - 3600000);
  for (const [name, content] of Object.entries(FILES)){
    const dir = path.join(UPLOAD_DIR, $uuid());
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'source.md');
    fs.writeFileSync(p, content);
    const id = $uuid();
    insDoc.run(id, kbProduct, u1.id, 'file', name, 'text/markdown', 'md', Buffer.byteLength(content), p, now() - 86400000, now() - 86400000);
    enqueue(id);
  }

  // 客服 FAQ（我的）
  const kbFaq = $uuid();
  insKb.run(kbFaq, '客服 FAQ', '高频客户问题与标准答复话术，支持问答对直接检索。', u1.id, null, 0, now() - 86400000 * 3, now() - 86400000);
  for (const [q, a] of QA_PAIRS){
    const id = $uuid();
    insQa.run(id, kbFaq, u1.id, 'qa', q, a, now() - 86400000, now() - 86400000);
    enqueue(id);
  }

  // 研发技术文档（我的）
  const kbDev = $uuid();
  insKb.run(kbDev, '研发技术文档', '架构设计、接口规范与部署运维手册，研发团队知识沉淀。', u1.id, null, 0, now() - 86400000 * 4, now() - 86400000 * 2);
  const arch = `# 系统架构说明

## 技术栈

- 后端：Node.js 24（内置 SQLite 数据库，零外部依赖）+ Express
- 前端：原生 HTML/CSS/JavaScript，无构建步骤
- 存储：SQLite 单文件数据库（data/app.db），上传文件保存在 data/uploads/
- 模型：OpenAI 兼容协议，支持 DeepSeek / Qwen / Ollama 等任意供应商

## 模块划分

- server/auth.js：注册登录与令牌认证
- server/parse.js：多格式文档文本抽取
- server/ingest.js：解析 → 分块 → 向量化摄取管线
- server/search.js：FTS5 关键词与向量余弦的混合检索
- server/routes/：REST API 路由（知识库、会话、智能体、空间、系统）
- public/：前端静态资源

## 部署

\`\`\`bash
npm install
npm start   # 默认 http://localhost:3210
\`\`\`

数据全部保留在本地 data/ 目录，可通过环境变量 PORT 修改端口。
`;
  const dir2 = path.join(UPLOAD_DIR, $uuid());
  fs.mkdirSync(dir2, { recursive: true });
  const p2 = path.join(dir2, 'source.md');
  fs.writeFileSync(p2, arch);
  const id2 = $uuid();
  insDoc.run(id2, kbDev, u1.id, 'file', '系统架构说明.md', 'text/markdown', 'md', Buffer.byteLength(arch), p2, now() - 86400000 * 3, now() - 86400000 * 3);
  enqueue(id2);

  // 制度合规中心（张伟所有，共享到空间）
  if (u2 && org){
    const kbComp = $uuid();
    insKb.run(kbComp, '制度合规中心', '公司制度、合规要求与审计要点，由合规部统一维护。', u2.id, org.id, 0, now() - 86400000 * 5, now() - 86400000);
    const policy = `# 信息安全管理制度（节选）

## 账号与密码

1. 系统账号实行一人一号，禁止共享或转借。
2. 密码长度不少于 8 位，须包含字母与数字，每 90 天更换一次。
3. 离职当日由 IT 中心回收全部系统权限。

## 数据分级

- 公开：可在公司官网与外部渠道发布。
- 内部：仅限员工访问，如制度文档、流程说明。
- 机密：仅限授权名单内人员访问，外发需部门负责人审批。

## 违规处理

首次违规予以警告并记录；造成数据泄露的，依据公司奖惩制度追究责任。
`;
    const dir3 = path.join(UPLOAD_DIR, $uuid());
    fs.mkdirSync(dir3, { recursive: true });
    const p3 = path.join(dir3, 'source.md');
    fs.writeFileSync(p3, policy);
    const id3 = $uuid();
    insDoc.run(id3, kbComp, u2.id, 'file', '信息安全管理制度.md', 'text/markdown', 'md', Buffer.byteLength(policy), p3, now() - 86400000 * 5, now() - 86400000 * 5);
    enqueue(id3);
  }

  console.log('[seed] 演示知识库与文档已注入');
}
