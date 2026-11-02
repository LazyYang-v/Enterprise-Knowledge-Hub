// 控制面 PostgreSQL 连接池。P0-0 只提供连接与事务封装，仓储在 P0-2 增加。
import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;
let pool = null;

export function requireDatabaseUrl(connectionString = config.databaseUrl){
  if (!connectionString){
    throw new Error('DATABASE_URL 未配置。请先 `docker compose up -d postgres` 并设置 DATABASE_URL（见 .env.example）。');
  }
  return connectionString;
}

export function getPool(connectionString = config.databaseUrl){
  if (!pool){
    pool = new Pool({
      connectionString: requireDatabaseUrl(connectionString),
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

export async function withTransaction(fn){
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e){
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool(){
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
