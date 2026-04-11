// Helper script to run SQL against Supabase
// Usage: node scripts/db.js "SELECT * FROM table"
const { Client } = require('pg');
const sql = process.argv[2];
if (!sql) { console.error('Usage: node scripts/db.js "SQL"'); process.exit(1); }
const c = new Client({
  connectionString: 'postgresql://postgres:S3MF5WiGSeErz3TQ@db.neksyvneljgxvpchwgch.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});
c.connect()
  .then(() => c.query(sql))
  .then(r => {
    if (r.rows) console.log(JSON.stringify(r.rows, null, 2));
    else console.log('OK -', r.command, r.rowCount, 'rows');
    c.end();
  })
  .catch(e => { console.error('ERROR:', e.message); c.end(); process.exit(1); });
