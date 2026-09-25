const isPostgres = (process.env.DB_TYPE || '').toLowerCase() === 'postgres';

let pool;

/**
 * Convert MySQL ? placeholders to PostgreSQL $1, $2, $3...
 * Also translates MySQL-specific date functions to PostgreSQL equivalents.
 */
function toPostgresParams(sql) {
  let idx = 0;
  let pgSql = sql.replace(/\?/g, () => `$${++idx}`);
  // DATE_SUB(NOW(), INTERVAL ? MINUTE) → NOW() - MAKE_INTERVAL(mins => $N)
  pgSql = pgSql.replace(
    /DATE_SUB\s*\(\s*NOW\(\)\s*,\s*INTERVAL\s+(\$\d+)\s+(MINUTE|HOUR|SECOND)\s*\)/gi,
    (_, param, unit) => {
      const pgUnit = { MINUTE: 'mins', HOUR: 'hours', SECOND: 'secs' }[unit.toUpperCase()];
      return `NOW() - MAKE_INTERVAL(${pgUnit} => ${param})`;
    }
  );
  pgSql = pgSql.replace(
    /DATE_SUB\s*\(\s*NOW\(\)\s*,\s*INTERVAL\s+(\d+)\s+(MINUTE|HOUR|SECOND)\s*\)/gi,
    (_, num, unit) => {
      const pgUnit = { MINUTE: 'minutes', HOUR: 'hours', SECOND: 'seconds' }[unit.toUpperCase()];
      return `NOW() - INTERVAL '${num} ${pgUnit}'`;
    }
  );
  return pgSql;
}

/**
 * Initialize database connection pool.
 * Supports both MySQL (JAWSDB_URL) and PostgreSQL (DATABASE_URL) via DB_TYPE env var.
 */
function initPool() {
  if (pool) return pool;

  if (isPostgres) {
    const { Pool } = require('pg');
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
    });

    console.log('PostgreSQL pool initialized');
    return pool;
  }

  // ─── MySQL (JawsDB) ───
  const mysql = require('mysql2/promise');
  const jawsdbUrl = process.env.JAWSDB_URL;
  if (!jawsdbUrl) {
    throw new Error('JAWSDB_URL environment variable is not set');
  }

  const urlMatch = jawsdbUrl.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  if (!urlMatch) {
    throw new Error('Invalid JAWSDB_URL format');
  }

  const [, user, password, host, port, database] = urlMatch;

  pool = mysql.createPool({
    host,
    port: parseInt(port, 10),
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  });

  console.log(`MySQL pool initialized: ${host}:${port}/${database}`);
  return pool;
}

function getPool() {
  if (!pool) return initPool();
  return pool;
}

/**
 * Execute a query with automatic connection handling.
 * Normalizes the API between MySQL and PostgreSQL.
 */
async function query(sql, params = []) {
  const p = getPool();
  try {
    if (isPostgres) {
      let pgSql = toPostgresParams(sql);
      const isInsert = pgSql.trimStart().toUpperCase().startsWith('INSERT');
      if (isInsert && !pgSql.toUpperCase().includes('RETURNING')) {
        pgSql += ' RETURNING id';
      }
      const result = await p.query(pgSql, params);
      const rows = result.rows;
      rows.affectedRows = result.rowCount;
      rows.changedRows = result.rowCount;
      if (result.rows.length > 0 && result.rows[0].id !== undefined) {
        rows.insertId = result.rows[0].id;
      }
      return rows;
    }
    const [rows] = await p.execute(sql, params);
    return rows;
  } catch (error) {
    console.error('Database query error:', error.message);
    throw error;
  }
}

/**
 * Get a connection from the pool for transactions.
 * For PostgreSQL, returns a wrapper that mimics the mysql2 connection API.
 */
async function getConnection() {
  const p = getPool();

  if (isPostgres) {
    const client = await p.connect();

    return {
      async execute(sql, params = []) {
        let pgSql = toPostgresParams(sql);
        const isInsert = pgSql.trimStart().toUpperCase().startsWith('INSERT');
        if (isInsert && !pgSql.toUpperCase().includes('RETURNING')) {
          pgSql += ' RETURNING id';
        }
        const result = await client.query(pgSql, params);
        const rows = result.rows;
        rows.affectedRows = result.rowCount;
        rows.changedRows = result.rowCount;
        if (result.rows.length > 0 && result.rows[0].id !== undefined) {
          rows.insertId = result.rows[0].id;
        }
        return [rows, result.fields];
      },
      async query(sql, params = []) {
        let pgSql = toPostgresParams(sql);
        const isInsert = pgSql.trimStart().toUpperCase().startsWith('INSERT');
        if (isInsert && !pgSql.toUpperCase().includes('RETURNING')) {
          pgSql += ' RETURNING id';
        }
        const result = await client.query(pgSql, params);
        const rows = result.rows;
        rows.affectedRows = result.rowCount;
        rows.changedRows = result.rowCount;
        if (result.rows.length > 0 && result.rows[0].id !== undefined) {
          rows.insertId = result.rows[0].id;
        }
        return [rows, result.fields];
      },
      async beginTransaction() {
        await client.query('BEGIN');
      },
      async commit() {
        await client.query('COMMIT');
      },
      async rollback() {
        await client.query('ROLLBACK');
      },
      release() {
        client.release();
      },
    };
  }

  // MySQL — return native connection
  return await p.getConnection();
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log(`${isPostgres ? 'PostgreSQL' : 'MySQL'} pool closed`);
  }
}

module.exports = { initPool, getPool, query, getConnection, closePool, isPostgres };
