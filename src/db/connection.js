const mysql = require('mysql2/promise');

let pool;

/**
 * Initialize MySQL connection pool from JAWSDB_URL
 */
function initPool() {
  if (pool) return pool;

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

async function query(sql, params = []) {
  const pool = getPool();
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (error) {
    console.error('Database query error:', error.message);
    throw error;
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('MySQL pool closed');
  }
}

module.exports = { initPool, getPool, query, closePool };
