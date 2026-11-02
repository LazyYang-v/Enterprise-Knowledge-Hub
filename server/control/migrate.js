// 轻量迁移执行器：读取 migrations/*.sql，按文件名顺序执行，记录到 schema_migrations。
// 每个迁移在独立事务中执行；dry-run 只读，不创建表、不写库。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(HERE, '../../migrations');
const TABLE = 'schema_migrations';

function checksum(sql){
  return crypto.createHash('sha256').update(sql).digest('hex');
}

export function listMigrations(dir = MIGRATIONS_DIR){
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(file => {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      return { version: file.replace(/\.sql$/, ''), file, sql, checksum: checksum(sql) };
    });
}

async function tableExists(client){
  const r = await client.query('SELECT to_regclass($1) AS name', [`public.${TABLE}`]);
  return !!r.rows[0]?.name;
}

async function appliedMigrations(client){
  if (!await tableExists(client)) return new Map();
  const r = await client.query(`SELECT version, checksum FROM ${TABLE}`);
  return new Map(r.rows.map(row => [row.version, row.checksum]));
}

export async function migrate({ connectionString, dir = MIGRATIONS_DIR, dryRun = false, log = console.log } = {}){
  if (!connectionString) throw new Error('DATABASE_URL 未配置');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    if (!dryRun){
      await client.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    }
    const applied = await appliedMigrations(client);
    const migrations = listMigrations(dir);
    const result = { applied: [], pending: [], skipped: [] };

    for (const m of migrations){
      if (applied.has(m.version)){
        if (applied.get(m.version) !== m.checksum){
          throw new Error(`迁移 ${m.version} 的校验和与已执行记录不一致，请人工核对（不要直接改写已执行迁移）。`);
        }
        result.skipped.push(m.version);
        continue;
      }
      if (dryRun){
        result.pending.push(m.version);
        log(`[dry-run] 待执行 ${m.version}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(`INSERT INTO ${TABLE} (version, checksum) VALUES ($1, $2)`, [m.version, m.checksum]);
        await client.query('COMMIT');
      } catch (e){
        await client.query('ROLLBACK');
        throw new Error(`迁移 ${m.version} 失败：${e.message}`);
      }
      result.applied.push(m.version);
      log(`[migrate] 已执行 ${m.version}`);
    }

    return result;
  } finally {
    await client.end();
  }
}

export async function status({ connectionString, dir = MIGRATIONS_DIR } = {}){
  if (!connectionString) throw new Error('DATABASE_URL 未配置');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const applied = await appliedMigrations(client);
    const migrations = listMigrations(dir);
    return {
      applied: migrations.filter(m => applied.has(m.version)).map(m => m.version),
      pending: migrations.filter(m => !applied.has(m.version)).map(m => m.version),
      unknown: [...applied.keys()].filter(v => !migrations.some(m => m.version === v)),
    };
  } finally {
    await client.end();
  }
}
