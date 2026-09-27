/**
 * One-time migration: Copy reference_presentations and reference_web_slides
 * from production MySQL (PROD_JAWSDB_URL) to staging PostgreSQL (DATABASE_URL).
 *
 * Usage:  node src/db/migrate-references.js
 *
 * Requires PROD_JAWSDB_URL env var pointing to production MySQL.
 * After running, remove PROD_JAWSDB_URL from staging config.
 */

const mysql = require('mysql2/promise');
const { Pool } = require('pg');

async function main() {
  const prodUrl = process.env.PROD_JAWSDB_URL;
  const pgUrl = process.env.DATABASE_URL;

  if (!prodUrl) {
    console.error('PROD_JAWSDB_URL not set — cannot migrate');
    process.exit(1);
  }
  if (!pgUrl) {
    console.error('DATABASE_URL not set — cannot migrate');
    process.exit(1);
  }

  // ── Connect to production MySQL ──
  const urlMatch = prodUrl.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  if (!urlMatch) {
    console.error('Invalid PROD_JAWSDB_URL format');
    process.exit(1);
  }
  const [, user, password, host, port, database] = urlMatch;
  const mysqlConn = await mysql.createConnection({ host, port: parseInt(port), user, password, database });
  console.log('Connected to production MySQL');

  // ── Connect to staging PostgreSQL ──
  const pgPool = new Pool({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  const pgClient = await pgPool.connect();
  console.log('Connected to staging PostgreSQL');

  try {
    await pgClient.query('BEGIN');

    // ── Migrate reference_presentations ──
    const [refs] = await mysqlConn.execute('SELECT * FROM reference_presentations');
    console.log(`Found ${refs.length} reference_presentations in production`);

    for (const ref of refs) {
      // Check if already exists (by name)
      const existing = await pgClient.query(
        'SELECT id FROM reference_presentations WHERE name = $1',
        [ref.name]
      );
      if (existing.rows.length > 0) {
        console.log(`  Skipping "${ref.name}" — already exists (id=${existing.rows[0].id})`);
        continue;
      }

      const annotations = ref.slide_annotations
        ? (typeof ref.slide_annotations === 'string' ? ref.slide_annotations : JSON.stringify(ref.slide_annotations))
        : null;

      const brandData = ref.web_version_brand_data
        ? (typeof ref.web_version_brand_data === 'string' ? ref.web_version_brand_data : JSON.stringify(ref.web_version_brand_data))
        : null;

      const result = await pgClient.query(
        `INSERT INTO reference_presentations
          (name, content, content_length, industry_tag, presentation_type_tag, synopsis,
           slide_count, uploaded_by, google_slides_url, slide_annotations,
           web_version_status, web_version_generated_at, web_version_brand_data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14)
         RETURNING id`,
        [
          ref.name,
          ref.content,
          ref.content_length,
          ref.industry_tag,
          ref.presentation_type_tag,
          ref.synopsis,
          ref.slide_count,
          ref.uploaded_by,
          ref.google_slides_url,
          annotations,
          ref.web_version_status || 'none',
          ref.web_version_generated_at || null,
          brandData,
          ref.created_at,
        ]
      );
      const newId = result.rows[0].id;
      console.log(`  Inserted "${ref.name}" → id=${newId} (was ${ref.id})`);

      // ── Migrate reference_web_slides for this reference ──
      const [slides] = await mysqlConn.execute(
        'SELECT * FROM reference_web_slides WHERE reference_id = ? ORDER BY slide_index',
        [ref.id]
      );
      console.log(`  Found ${slides.length} web slides for reference_id=${ref.id}`);

      for (const slide of slides) {
        await pgClient.query(
          `INSERT INTO reference_web_slides
            (reference_id, slide_index, html_content, css_content,
             background_image_url, background_image_prompt, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            newId,  // Use the new PostgreSQL id
            slide.slide_index,
            slide.html_content,
            slide.css_content,
            slide.background_image_url,
            slide.background_image_prompt,
            slide.created_at,
            slide.updated_at,
          ]
        );
      }
      console.log(`  Inserted ${slides.length} web slides`);
    }

    await pgClient.query('COMMIT');
    console.log('\n✅ Migration complete!');
  } catch (err) {
    await pgClient.query('ROLLBACK');
    console.error('Migration failed, rolled back:', err);
    process.exit(1);
  } finally {
    pgClient.release();
    await pgPool.end();
    await mysqlConn.end();
  }
}

main();
