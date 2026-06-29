require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { getPool } = require('./connection');

async function migrate() {
  try {
    console.log('Starting database migration...');

    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = await fs.readFile(schemaPath, 'utf-8');

    const statements = schema
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0);

    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      for (const statement of statements) {
        console.log(`Executing: ${statement.substring(0, 50)}...`);
        await connection.query(statement);
      }

      // ─── Shared ALTER statements (idempotent) ───
      const sharedAlters = [
        "ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP NULL DEFAULT NULL"
      ];

      // =============================================
      // APP-SPECIFIC ALTER statements — Add yours here
      // Example: adding share columns to your asset table
      // =============================================
      const appAlters = [
        // "ALTER TABLE items ADD COLUMN shared_by_email VARCHAR(255) DEFAULT NULL",
        // "ALTER TABLE items ADD COLUMN shared_at TIMESTAMP NULL DEFAULT NULL",
      ];

      const allAlters = [...sharedAlters, ...appAlters];

      for (const stmt of allAlters) {
        try {
          await connection.query(stmt);
          console.log(`✓ Applied: ${stmt.substring(0, 60)}...`);
        } catch (e) {
          if (e.code === 'ER_DUP_FIELDNAME') {
            // Column already exists — skip
          } else {
            throw e;
          }
        }
      }

      // Auto-promote admin users from ADMIN_EMAILS env var
      const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
      if (adminEmails.length > 0) {
        const placeholders = adminEmails.map(() => '?').join(',');
        await connection.query(
          `UPDATE users SET is_admin = TRUE WHERE email IN (${placeholders})`,
          adminEmails
        );
        console.log(`✓ Admin users promoted: ${adminEmails.join(', ')}`);
      }

      console.log('✓ Database migration completed successfully');
    } finally {
      connection.release();
    }

    return true;
  } catch (error) {
    console.error('✗ Database migration failed:', error.message);
    throw error;
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { migrate };
