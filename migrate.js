// ─── ONE-TIME DATA MIGRATION: Railway Postgres → Neon Postgres ────────────
//
// Run this ONCE, then switch the start command back to the bot. It:
//   1. Creates the full schema on the new (Neon) database
//   2. Copies every row from every table, old DB → new DB
//   3. Prints a per-table row count so you can confirm nothing was missed
//
// Requires two env vars set in Railway (temporarily):
//   OLD_DATABASE_URL — your existing Railway Postgres connection string
//                       (same value currently in DATABASE_URL)
//   NEW_DATABASE_URL — your new Neon connection string
//
// HOW TO RUN (from Railway's dashboard, no terminal needed):
//   1. Add this file to your repo (via GitHub mobile)
//   2. In Railway → Variables: add OLD_DATABASE_URL (copy your current
//      DATABASE_URL's value) and NEW_DATABASE_URL (your Neon connection
//      string)
//   3. In Railway → Settings → Deploy → Custom Start Command, set it to:
//        node migrate.js
//   4. Trigger a redeploy, watch Deploy Logs until you see
//      "✅ MIGRATION COMPLETE"
//   5. IMPORTANT: change the Start Command back to `npm start` (or just
//      clear it) — otherwise Railway will re-run this migration on every
//      future restart, which would re-copy old data over anything new.

require('dotenv').config();
const { Pool } = require('pg');

const TABLES = [
  'paid_users', 'usage_log', 'known_users', 'paid_chats',
  'seen_announcements', 'bot_settings', 'price_alerts', 'holdings',
  'seen_okx_announcements', 'holder_snapshots', 'dev_watches',
];

async function main() {
  const oldUrl = process.env.OLD_DATABASE_URL;
  const newUrl = process.env.NEW_DATABASE_URL;

  if (!oldUrl || !newUrl) {
    console.error('❌ Set both OLD_DATABASE_URL and NEW_DATABASE_URL in Railway Variables before running this.');
    process.exit(1);
  }

  const oldPool = new Pool({ connectionString: oldUrl, ssl: { rejectUnauthorized: false } });
  const newPool = new Pool({ connectionString: newUrl, ssl: { rejectUnauthorized: false } });

  console.log('🔧 Creating schema on the new database...');
  await createSchema(newPool);
  console.log('✅ Schema ready.\n');

  console.log('📦 Copying data...\n');
  for (const table of TABLES) {
    await copyTable(oldPool, newPool, table);
  }

  console.log('\n🔧 Resetting auto-increment counters...');
  const serialTables = ['price_alerts', 'holdings', 'holder_snapshots', 'dev_watches'];
  for (const table of serialTables) {
    try {
      await newPool.query(`
        SELECT setval(
          pg_get_serial_sequence('${table}', 'id'),
          COALESCE((SELECT MAX(id) FROM ${table}), 1)
        );
      `);
    } catch (err) {
      console.log(`  ⚠️  ${table}: couldn't reset sequence (${err.message})`);
    }
  }

  console.log('\n✅ MIGRATION COMPLETE — remember to change the Start Command back to `npm start` now.');
  await oldPool.end();
  await newPool.end();
  process.exit(0);
}

async function copyTable(oldPool, newPool, table) {
  let rows;
  try {
    const res = await oldPool.query(`SELECT * FROM ${table}`);
    rows = res.rows;
  } catch (err) {
    console.log(`  ⚠️  ${table}: couldn't read from old DB (${err.message}) — skipping`);
    return;
  }

  if (rows.length === 0) {
    console.log(`  ${table}: 0 rows (nothing to copy)`);
    return;
  }

  const columns = Object.keys(rows[0]);
  const colList = columns.map((c) => `"${c}"`).join(', ');
  let copied = 0;

  for (const row of rows) {
    const values = columns.map((c) => row[c]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    try {
      await newPool.query(
        `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        values
      );
      copied++;
    } catch (err) {
      console.log(`  ⚠️  ${table}: failed to copy one row (${err.message})`);
    }
  }

  console.log(`  ✅ ${table}: ${copied}/${rows.length} rows copied`);
}

// Mirrors the EXACT CREATE TABLE / ALTER TABLE statements from index.js's
// initDb() so the new database ends up with an identical schema. Copied
// verbatim rather than reconstructed from memory — a wrong column name
// here would break the row-copy step below with "column does not exist",
// since the copy step inserts using whatever column names the OLD table
// actually has.
async function createSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS paid_users (
      user_id BIGINT PRIMARY KEY,
      expiry BIGINT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'regular'
    );
  `);
  await pool.query(`ALTER TABLE paid_users ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'regular';`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_log (
      user_id BIGINT NOT NULL,
      day TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day, command)
    );
  `);
  await pool.query(`ALTER TABLE usage_log ADD COLUMN IF NOT EXISTS command TEXT NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE usage_log DROP CONSTRAINT IF EXISTS usage_log_pkey;`);
  await pool.query(`ALTER TABLE usage_log ADD CONSTRAINT usage_log_pkey PRIMARY KEY (user_id, day, command);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS known_users (
      user_id BIGINT PRIMARY KEY,
      chat_id BIGINT,
      username TEXT,
      first_seen BIGINT,
      last_seen BIGINT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS paid_chats (
      chat_id BIGINT PRIMARY KEY,
      expiry BIGINT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'regular'
    );
  `);
  await pool.query(`ALTER TABLE paid_chats ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'regular';`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS seen_announcements (
      announcement_id TEXT PRIMARY KEY
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  await pool.query(`
    INSERT INTO bot_settings (key, value) VALUES ('early_access_remaining', '5')
    ON CONFLICT (key) DO NOTHING;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_alerts (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      chat_id BIGINT NOT NULL,
      username TEXT,
      ticker TEXT NOT NULL,
      target_price NUMERIC NOT NULL,
      direction TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      triggered BOOLEAN NOT NULL DEFAULT FALSE,
      recurring BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);
  await pool.query(`ALTER TABLE price_alerts ADD COLUMN IF NOT EXISTS message_id BIGINT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS holdings (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      ticker TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(user_id, ticker)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS seen_okx_announcements (
      announcement_id TEXT PRIMARY KEY
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS holder_snapshots (
      id SERIAL PRIMARY KEY,
      ticker TEXT NOT NULL,
      chain TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      percentage NUMERIC NOT NULL,
      checked_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_holder_wallet ON holder_snapshots (wallet_address);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dev_watches (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      chat_id BIGINT NOT NULL,
      username TEXT,
      ticker TEXT NOT NULL,
      chain TEXT NOT NULL,
      dev_address TEXT NOT NULL,
      last_tx_hash TEXT,
      last_checked_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(user_id, ticker)
    );
  `);
  await pool.query(`ALTER TABLE dev_watches ADD COLUMN IF NOT EXISTS message_id BIGINT;`);
}

main().catch((err) => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
