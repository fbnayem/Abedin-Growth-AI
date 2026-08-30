const fs = require('fs');
const { Client } = require('pg');

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  const sql = fs.readFileSync('drizzle/0001_curvy_toad_men.sql', 'utf8');
  await client.query(sql);
  console.log("Migration 1 executed successfully!");
  await client.end();
}
run().catch(e => { console.error(e); process.exit(1); });
