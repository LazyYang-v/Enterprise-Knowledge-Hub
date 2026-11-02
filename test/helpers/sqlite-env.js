// 在任何会触碰 SQLite 的模块求值之前，为测试进程指定独立数据目录。
// 必须作为测试文件的第一个静态 import：ESM 按 import 声明顺序求值依赖，
// 否则 server/db.js 会在 process.env.EKH_DATA_DIR 赋值前以仓库 data/ 打开数据库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.EKH_DATA_DIR){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekh-pg-'));
  process.env.EKH_DATA_DIR = dir;
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
}
