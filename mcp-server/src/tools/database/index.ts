import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Pool as PgPool } from "pg";

// ─── Tool definitions ─────────────────────────────────────────────────────────
export const dbTools: Tool[] = [
  {
    name: "query_database",
    description: "Execute a READ-ONLY SELECT query against PostgreSQL, MySQL, MongoDB, or Redis. Auto-detects which DB to use based on database_type.",
    inputSchema: {
      type: "object",
      properties: {
        database_type: { type: "string", enum: ["postgresql", "mysql", "mongodb", "redis"], default: "postgresql" },
        database_name: { type: "string", description: "Database/collection name override" },
        query: { type: "string", description: "SELECT for SQL, JSON filter for MongoDB (e.g. {collection:'users',filter:{}}), key pattern for Redis (e.g. 'GET mykey' or 'KEYS pattern*')" },
        timeout_seconds: { type: "number", default: 30 },
      },
      required: ["query"],
    },
  },
  {
    name: "check_db_connections",
    description: "Check active connections, pool status, and limits for PostgreSQL, MySQL, MongoDB, or Redis.",
    inputSchema: {
      type: "object",
      properties: {
        database_type: { type: "string", enum: ["postgresql", "mysql", "mongodb", "redis", "all"], default: "all" },
      },
    },
  },
  {
    name: "get_slow_queries",
    description: "Get slow/running queries for PostgreSQL (pg_stat_activity) or MySQL (processlist).",
    inputSchema: {
      type: "object",
      properties: {
        database_type: { type: "string", enum: ["postgresql", "mysql"], default: "postgresql" },
        threshold_ms: { type: "number", default: 1000 },
      },
    },
  },
  {
    name: "check_db_size",
    description: "Check database and table/collection sizes across PostgreSQL, MySQL, MongoDB.",
    inputSchema: {
      type: "object",
      properties: {
        database_type: { type: "string", enum: ["postgresql", "mysql", "mongodb", "all"], default: "all" },
        include_table_breakdown: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "check_db_locks",
    description: "Check for locks, deadlocks, and blocking queries in PostgreSQL or MySQL.",
    inputSchema: {
      type: "object",
      properties: {
        database_type: { type: "string", enum: ["postgresql", "mysql"], default: "postgresql" },
      },
    },
  },
  {
    name: "check_redis_health",
    description: "Check Redis memory, hit rate, connected clients, and key stats.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "check_mongodb_health",
    description: "Check MongoDB server status, connections, oplog, and collection stats.",
    inputSchema: {
      type: "object",
      properties: {
        database_name: { type: "string", description: "Database to inspect (optional)" },
      },
    },
  },
];

// ─── Connection helpers ───────────────────────────────────────────────────────
let _pgPool: PgPool | null = null;
function getPgPool(): PgPool {
  if (!_pgPool) {
    _pgPool = new PgPool({
      host: process.env.POSTGRES_HOST || process.env.DB_HOST || "localhost",
      port: parseInt(process.env.POSTGRES_PORT || "5432"),
      database: process.env.POSTGRES_DB || process.env.DB_NAME || "postgres",
      user: process.env.POSTGRES_USER || process.env.DB_USER || "postgres",
      password: process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD || "",
      max: 3, connectionTimeoutMillis: 5000, statement_timeout: 30000,
    });
  }
  return _pgPool;
}

function isPgConfigured() { return !!(process.env.POSTGRES_HOST || process.env.DB_HOST); }
function isMysqlConfigured() { return !!(process.env.MYSQL_HOST); }
function isMongoConfigured() { return !!(process.env.MONGO_URI || process.env.MONGODB_URI); }
function isRedisConfigured() { return !!(process.env.REDIS_HOST || process.env.REDIS_URL); }

function notConfigured(dbType: string) {
  const envVars: Record<string, string[]> = {
    postgresql: ["POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"],
    mysql: ["MYSQL_HOST", "MYSQL_PORT", "MYSQL_DB", "MYSQL_USER", "MYSQL_PASSWORD"],
    mongodb: ["MONGO_URI (e.g. mongodb://host:27017/dbname)"],
    redis: ["REDIS_HOST", "REDIS_PORT", "REDIS_PASSWORD (optional)"],
  };
  return {
    connected: false,
    database_type: dbType,
    error: `${dbType} not configured`,
    required_env_vars: envVars[dbType] || [],
    timestamp: new Date().toISOString(),
  };
}

// ─── MySQL helper ─────────────────────────────────────────────────────────────
async function mysqlQuery(sql: string): Promise<unknown[]> {
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST!,
    port: parseInt(process.env.MYSQL_PORT || "3306"),
    database: process.env.MYSQL_DB || process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER!,
    password: process.env.MYSQL_PASSWORD!,
    connectTimeout: 5000,
  });
  try {
    const [rows] = await conn.execute(sql);
    return rows as unknown[];
  } finally {
    await conn.end();
  }
}

// ─── MongoDB helper ───────────────────────────────────────────────────────────
async function getMongoClient() {
  const { MongoClient } = await import("mongodb");
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI!;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  return client;
}

// ─── Redis helper ─────────────────────────────────────────────────────────────
async function getRedisClient() {
  const { default: Redis } = await import("ioredis");
  const client = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    password: process.env.REDIS_PASSWORD || undefined,
    connectTimeout: 5000,
    lazyConnect: true,
  });
  await client.connect();
  return client;
}

// ─── Tool handlers ────────────────────────────────────────────────────────────
export const dbToolHandlers: Record<string, (args: unknown) => Promise<unknown>> = {

  query_database: async (args: unknown) => {
    const { database_type = "postgresql", query, timeout_seconds = 30 } = args as {
      database_type?: string; database_name?: string; query: string; timeout_seconds?: number;
    };

    // Block writes
    const up = query.trim().toUpperCase();
    if (["INSERT","UPDATE","DELETE","DROP","CREATE","ALTER","TRUNCATE"].some(op => up.startsWith(op))) {
      return { error: "BLOCKED: Only read operations are permitted", query };
    }

    if (database_type === "postgresql" || (!database_type && isPgConfigured())) {
      if (!isPgConfigured()) return notConfigured("postgresql");
      try {
        const pool = getPgPool();
        const start = Date.now();
        const result = await pool.query({ text: query, rowMode: "array" });
        return {
          database_type: "postgresql",
          columns: result.fields.map(f => f.name),
          rows: result.rows.slice(0, 500),
          row_count: result.rowCount,
          execution_ms: Date.now() - start,
          timestamp: new Date().toISOString(),
        };
      } catch (e) { return { error: (e as Error).message, database_type: "postgresql" }; }
    }

    if (database_type === "mysql") {
      if (!isMysqlConfigured()) return notConfigured("mysql");
      try {
        const rows = await mysqlQuery(query);
        return { database_type: "mysql", rows, row_count: (rows as unknown[]).length, timestamp: new Date().toISOString() };
      } catch (e) { return { error: (e as Error).message, database_type: "mysql" }; }
    }

    if (database_type === "mongodb") {
      if (!isMongoConfigured()) return notConfigured("mongodb");
      try {
        const client = await getMongoClient();
        try {
          // query format: JSON string like {"collection":"users","filter":{},"limit":10}
          const params = JSON.parse(query);
          const db = client.db(params.database || process.env.MONGO_DB);
          const coll = db.collection(params.collection);
          const docs = await coll.find(params.filter || {}).limit(params.limit || 50).toArray();
          return { database_type: "mongodb", collection: params.collection, documents: docs, count: docs.length, timestamp: new Date().toISOString() };
        } finally { await client.close(); }
      } catch (e) { return { error: (e as Error).message, database_type: "mongodb", hint: 'Query format: {"collection":"myCollection","filter":{"status":"active"},"limit":10}' }; }
    }

    if (database_type === "redis") {
      if (!isRedisConfigured()) return notConfigured("redis");
      try {
        const redis = await getRedisClient();
        try {
          const parts = query.trim().split(/\s+/);
          const cmd = parts[0].toUpperCase();
          if (!["GET","HGET","HGETALL","LRANGE","SMEMBERS","ZRANGE","KEYS","SCAN","TYPE","TTL","STRLEN","LLEN","SCARD","ZCARD"].includes(cmd)) {
            return { error: `Command ${cmd} not allowed. Read-only commands only.` };
          }
          const result = await (redis as unknown as Record<string, (...args: string[]) => Promise<unknown>>)[cmd.toLowerCase()](...parts.slice(1));
          return { database_type: "redis", command: query, result, timestamp: new Date().toISOString() };
        } finally { redis.disconnect(); }
      } catch (e) { return { error: (e as Error).message, database_type: "redis" }; }
    }

    return { error: `Unknown database_type: ${database_type}` };
  },

  check_db_connections: async (args: unknown) => {
    const { database_type = "all" } = args as { database_type?: string };
    const results: Record<string, unknown> = {};

    const checkPg = async () => {
      if (!isPgConfigured()) return notConfigured("postgresql");
      try {
        const pool = getPgPool();
        const [settings, activity, waiting] = await Promise.all([
          pool.query("SELECT setting::int AS max FROM pg_settings WHERE name='max_connections'"),
          pool.query(`SELECT state, COUNT(*) as count, MAX(EXTRACT(EPOCH FROM(NOW()-query_start))*1000)::int as max_ms FROM pg_stat_activity WHERE pid<>pg_backend_pid() GROUP BY state`),
          pool.query("SELECT COUNT(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock'"),
        ]);
        const maxConn = settings.rows[0]?.max || 100;
        const total = activity.rows.reduce((s: number, r: { count: string }) => s + parseInt(r.count), 0);
        const idle = activity.rows.find((r: { state: string }) => r.state === "idle in transaction")?.count || 0;
        const active = activity.rows.find((r: { state: string }) => r.state === "active")?.count || 0;
        const pct = Math.round(total / maxConn * 100);
        return {
          connected: true, max_connections: maxConn, current: total,
          active: parseInt(active), idle_in_transaction: parseInt(idle),
          waiting_on_locks: parseInt(waiting.rows[0]?.n || "0"),
          usage_percent: pct,
          by_state: activity.rows,
          alerts: [
            pct > 80 ? `CRITICAL: ${pct}% connections used (${total}/${maxConn})` : null,
            parseInt(idle) > 5 ? `${idle} idle-in-transaction connections — possible leak` : null,
          ].filter(Boolean),
        };
      } catch (e) { return { connected: false, error: (e as Error).message }; }
    };

    const checkMysql = async () => {
      if (!isMysqlConfigured()) return notConfigured("mysql");
      try {
        const [status, processlist] = await Promise.all([
          mysqlQuery("SHOW STATUS LIKE 'Threads_%'"),
          mysqlQuery("SHOW PROCESSLIST"),
        ]);
        const statusMap = Object.fromEntries((status as Array<{Variable_name: string; Value: string}>).map(r => [r.Variable_name, r.Value]));
        return {
          connected: true,
          threads_connected: parseInt(statusMap["Threads_connected"] || "0"),
          threads_running: parseInt(statusMap["Threads_running"] || "0"),
          threads_cached: parseInt(statusMap["Threads_cached"] || "0"),
          processlist: processlist,
        };
      } catch (e) { return { connected: false, error: (e as Error).message }; }
    };

    const checkMongo = async () => {
      if (!isMongoConfigured()) return notConfigured("mongodb");
      try {
        const client = await getMongoClient();
        try {
          const status = await client.db("admin").command({ serverStatus: 1 });
          const conns = status.connections as Record<string, number>;
          return {
            connected: true,
            current: conns.current, available: conns.available, totalCreated: conns.totalCreated,
            alerts: conns.current > conns.available * 0.8 ? ["MongoDB connections near limit"] : [],
          };
        } finally { await client.close(); }
      } catch (e) { return { connected: false, error: (e as Error).message }; }
    };

    const checkRedis = async () => {
      if (!isRedisConfigured()) return notConfigured("redis");
      try {
        const redis = await getRedisClient();
        try {
          const info = await redis.info("clients");
          const lines = info.split("\r\n");
          const get = (key: string) => lines.find(l => l.startsWith(key))?.split(":")[1]?.trim();
          return {
            connected: true,
            connected_clients: parseInt(get("connected_clients") || "0"),
            blocked_clients: parseInt(get("blocked_clients") || "0"),
            tracking_clients: parseInt(get("tracking_clients") || "0"),
          };
        } finally { redis.disconnect(); }
      } catch (e) { return { connected: false, error: (e as Error).message }; }
    };

    if (database_type === "all") {
      const [pg, mysql, mongo, redis] = await Promise.allSettled([checkPg(), checkMysql(), checkMongo(), checkRedis()]);
      return {
        postgresql: pg.status === "fulfilled" ? pg.value : { error: String(pg.reason) },
        mysql: mysql.status === "fulfilled" ? mysql.value : { error: String(mysql.reason) },
        mongodb: mongo.status === "fulfilled" ? mongo.value : { error: String(mongo.reason) },
        redis: redis.status === "fulfilled" ? redis.value : { error: String(redis.reason) },
        timestamp: new Date().toISOString(),
      };
    }
    if (database_type === "postgresql") return { postgresql: await checkPg(), timestamp: new Date().toISOString() };
    if (database_type === "mysql") return { mysql: await checkMysql(), timestamp: new Date().toISOString() };
    if (database_type === "mongodb") return { mongodb: await checkMongo(), timestamp: new Date().toISOString() };
    if (database_type === "redis") return { redis: await checkRedis(), timestamp: new Date().toISOString() };
  },

  get_slow_queries: async (args: unknown) => {
    const { database_type = "postgresql", threshold_ms = 1000 } = args as { database_type?: string; threshold_ms?: number };

    if (database_type === "postgresql") {
      if (!isPgConfigured()) return notConfigured("postgresql");
      try {
        const pool = getPgPool();
        const running = await pool.query(`
          SELECT pid, usename, state, wait_event_type, wait_event,
            EXTRACT(EPOCH FROM (NOW()-query_start))*1000 AS duration_ms,
            LEFT(query, 500) AS query
          FROM pg_stat_activity
          WHERE state='active' AND query_start IS NOT NULL
            AND EXTRACT(EPOCH FROM (NOW()-query_start))*1000 > $1
            AND query NOT LIKE '%pg_stat_activity%'
          ORDER BY duration_ms DESC LIMIT 20`, [threshold_ms]);

        let historical: unknown[] = [];
        try {
          const hist = await pool.query(`
            SELECT LEFT(query,300) AS query, calls,
              ROUND(mean_exec_time::numeric,2) AS avg_ms,
              ROUND(max_exec_time::numeric,2) AS max_ms, rows
            FROM pg_stat_statements
            WHERE mean_exec_time > $1 AND query NOT LIKE '%pg_stat_statements%'
            ORDER BY avg_ms DESC LIMIT 20`, [threshold_ms]);
          historical = hist.rows;
        } catch { /* pg_stat_statements not enabled */ }

        return {
          database_type: "postgresql", threshold_ms,
          currently_running: running.rows,
          historical_slow: historical,
          note: historical.length === 0 ? "Enable pg_stat_statements for historical data" : undefined,
          timestamp: new Date().toISOString(),
        };
      } catch (e) { return { error: (e as Error).message, database_type: "postgresql" }; }
    }

    if (database_type === "mysql") {
      if (!isMysqlConfigured()) return notConfigured("mysql");
      try {
        const processlist = await mysqlQuery(`SELECT * FROM information_schema.PROCESSLIST WHERE TIME > ${threshold_ms/1000} AND COMMAND != 'Sleep' ORDER BY TIME DESC`);
        return { database_type: "mysql", threshold_ms, slow_queries: processlist, timestamp: new Date().toISOString() };
      } catch (e) { return { error: (e as Error).message, database_type: "mysql" }; }
    }

    return { error: "slow queries only supported for postgresql and mysql" };
  },

  check_db_size: async (args: unknown) => {
    const { database_type = "all", include_table_breakdown = true } = args as { database_type?: string; include_table_breakdown?: boolean };

    const checkPg = async () => {
      if (!isPgConfigured()) return notConfigured("postgresql");
      try {
        const pool = getPgPool();
        const [dbs, tables] = await Promise.all([
          pool.query("SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size, pg_database_size(datname) AS bytes FROM pg_database WHERE datistemplate=false ORDER BY bytes DESC"),
          include_table_breakdown ? pool.query(`SELECT schemaname||'.'||tablename AS table, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total, pg_total_relation_size(schemaname||'.'||tablename) AS bytes, n_live_tup AS rows, ROUND(100.0*n_dead_tup/NULLIF(n_live_tup+n_dead_tup,0),1) AS bloat_pct FROM pg_stat_user_tables ORDER BY bytes DESC LIMIT 20`) : { rows: [] },
        ]);
        return { connected: true, databases: dbs.rows, tables: tables.rows };
      } catch (e) { return { connected: false, error: (e as Error).message }; }
    };

    const checkMysql = async () => {
      if (!isMysqlConfigured()) return notConfigured("mysql");
      try {
        const sizes = await mysqlQuery(`SELECT table_schema AS db, ROUND(SUM(data_length+index_length)/1024/1024,2) AS size_mb FROM information_schema.tables GROUP BY table_schema ORDER BY size_mb DESC`);
        const tables = include_table_breakdown ? await mysqlQuery(`SELECT table_schema, table_name, ROUND((data_length+index_length)/1024/1024,2) AS size_mb, table_rows FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','mysql','performance_schema') ORDER BY size_mb DESC LIMIT 20`) : [];
        return { connected: true, databases: sizes, tables };
      } catch (e) { return { connected: false, error: (e as Error).message }; }
    };

    const checkMongo = async () => {
      if (!isMongoConfigured()) return notConfigured("mongodb");
      try {
        const client = await getMongoClient();
        try {
          const adminDb = client.db("admin");
          const dbs = await adminDb.admin().listDatabases();
          return { connected: true, databases: dbs.databases };
        } finally { await client.close(); }
      } catch (e) { return { connected: false, error: (e as Error).message }; }
    };

    if (database_type === "all") {
      const [pg, mysql, mongo] = await Promise.allSettled([checkPg(), checkMysql(), checkMongo()]);
      return {
        postgresql: pg.status === "fulfilled" ? pg.value : { error: String(pg.reason) },
        mysql: mysql.status === "fulfilled" ? mysql.value : { error: String(mysql.reason) },
        mongodb: mongo.status === "fulfilled" ? mongo.value : { error: String(mongo.reason) },
        timestamp: new Date().toISOString(),
      };
    }
    if (database_type === "postgresql") return { ...(await checkPg()), timestamp: new Date().toISOString() };
    if (database_type === "mysql") return { ...(await checkMysql()), timestamp: new Date().toISOString() };
    if (database_type === "mongodb") return { ...(await checkMongo()), timestamp: new Date().toISOString() };
  },

  check_db_locks: async (args: unknown) => {
    const { database_type = "postgresql" } = args as { database_type?: string };

    if (database_type === "postgresql") {
      if (!isPgConfigured()) return notConfigured("postgresql");
      try {
        const pool = getPgPool();
        const locks = await pool.query(`
          SELECT bl.pid AS blocked_pid, ba.usename AS blocked_user,
            LEFT(ba.query,200) AS blocked_query,
            EXTRACT(EPOCH FROM(NOW()-ba.query_start))::int AS blocked_secs,
            kl.pid AS blocking_pid, ka.usename AS blocking_user,
            LEFT(ka.query,200) AS blocking_query
          FROM pg_locks bl
          JOIN pg_stat_activity ba ON bl.pid=ba.pid
          JOIN pg_locks kl ON kl.transactionid=bl.transactionid AND kl.pid!=bl.pid
          JOIN pg_stat_activity ka ON kl.pid=ka.pid
          WHERE NOT bl.granted ORDER BY blocked_secs DESC LIMIT 20`);
        return {
          database_type: "postgresql",
          lock_conflicts: locks.rows,
          count: locks.rows.length,
          alerts: locks.rows.length > 0 ? [`${locks.rows.length} lock conflicts — queries are blocked`] : [],
          timestamp: new Date().toISOString(),
        };
      } catch (e) { return { error: (e as Error).message }; }
    }

    if (database_type === "mysql") {
      if (!isMysqlConfigured()) return notConfigured("mysql");
      try {
        const locks = await mysqlQuery("SELECT * FROM information_schema.INNODB_LOCKS LIMIT 20");
        const waits = await mysqlQuery("SELECT * FROM information_schema.INNODB_LOCK_WAITS LIMIT 20");
        return { database_type: "mysql", locks, waits, timestamp: new Date().toISOString() };
      } catch (e) { return { error: (e as Error).message }; }
    }
  },

  check_redis_health: async () => {
    if (!isRedisConfigured()) return notConfigured("redis");
    try {
      const redis = await getRedisClient();
      try {
        const [info, keyspace] = await Promise.all([redis.info(), redis.info("keyspace")]);
        const parse = (section: string, key: string) => section.split("\r\n").find(l => l.startsWith(key))?.split(":")[1]?.trim();

        const usedMem = parseInt(parse(info, "used_memory") || "0");
        const maxMem = parseInt(parse(info, "maxmemory") || "0");
        const hits = parseInt(parse(info, "keyspace_hits") || "0");
        const misses = parseInt(parse(info, "keyspace_misses") || "0");
        const hitRate = hits + misses > 0 ? Math.round(hits / (hits + misses) * 100) : null;

        return {
          connected: true,
          version: parse(info, "redis_version"),
          uptime_seconds: parseInt(parse(info, "uptime_in_seconds") || "0"),
          connected_clients: parseInt(parse(info, "connected_clients") || "0"),
          blocked_clients: parseInt(parse(info, "blocked_clients") || "0"),
          memory: {
            used_mb: Math.round(usedMem / 1024 / 1024),
            max_mb: maxMem > 0 ? Math.round(maxMem / 1024 / 1024) : "unlimited",
            used_percent: maxMem > 0 ? Math.round(usedMem / maxMem * 100) : null,
            peak_mb: Math.round(parseInt(parse(info, "used_memory_peak") || "0") / 1024 / 1024),
          },
          cache: { hits, misses, hit_rate_percent: hitRate },
          keyspace: keyspace.split("\r\n").filter(l => l.startsWith("db")).map(l => {
            const [db, stats] = l.split(":");
            return { db, stats };
          }),
          evicted_keys: parseInt(parse(info, "evicted_keys") || "0"),
          expired_keys: parseInt(parse(info, "expired_keys") || "0"),
          alerts: [
            hitRate !== null && hitRate < 80 ? `Low cache hit rate: ${hitRate}%` : null,
            maxMem > 0 && usedMem / maxMem > 0.9 ? "Redis memory above 90% of limit" : null,
          ].filter(Boolean),
          timestamp: new Date().toISOString(),
        };
      } finally { redis.disconnect(); }
    } catch (e) { return { connected: false, error: (e as Error).message }; }
  },

  check_mongodb_health: async (args: unknown) => {
    const { database_name } = args as { database_name?: string };
    if (!isMongoConfigured()) return notConfigured("mongodb");
    try {
      const client = await getMongoClient();
      try {
        const admin = client.db("admin");
        const [serverStatus, dbList] = await Promise.all([
          admin.command({ serverStatus: 1 }),
          admin.admin().listDatabases(),
        ]);

        const conns = serverStatus.connections as Record<string, number>;
        const mem = serverStatus.mem as Record<string, number>;
        const ops = serverStatus.opcounters as Record<string, number>;

        let collStats: unknown[] = [];
        if (database_name) {
          const db = client.db(database_name);
          const colls = await db.listCollections().toArray();
          collStats = await Promise.all(colls.slice(0, 10).map(async c => {
            try {
              const stats = await db.command({ collStats: c.name });
              return { name: c.name, count: stats.count, size_mb: Math.round(stats.size / 1024 / 1024 * 10) / 10, indexes: stats.nindexes };
            } catch { return { name: c.name, error: "could not get stats" }; }
          }));
        }

        return {
          connected: true,
          version: serverStatus.version,
          uptime_seconds: serverStatus.uptimeMillis ? Math.round(serverStatus.uptimeMillis / 1000) : null,
          connections: { current: conns.current, available: conns.available, totalCreated: conns.totalCreated },
          memory: { resident_mb: mem?.resident, virtual_mb: mem?.virtual },
          operations_per_sec: ops,
          databases: dbList.databases,
          collections: collStats,
          alerts: [
            conns.current > conns.available * 0.8 ? "MongoDB connections near limit" : null,
          ].filter(Boolean),
          timestamp: new Date().toISOString(),
        };
      } finally { await client.close(); }
    } catch (e) { return { connected: false, error: (e as Error).message }; }
  },
};
