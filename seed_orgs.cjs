const { Pool } = require('pg');
require('dotenv').config();

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  await pool.query(`
    INSERT INTO organizations (id, name, slug) VALUES 
    ('org_1', 'Default Org', 'default-org-1'),
    ('default', 'Default Workspace', 'default-workspace')
    ON CONFLICT DO NOTHING;
  `);
  console.log('Seeded organizations!');
  await pool.end();
}
run().catch(console.error);
