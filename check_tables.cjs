
const db = require('./shared/database/connection');

async function listTables() {
  try {
    console.log('Listing tables in Postgres...');
    const res = await db.getRows(`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
      ORDER BY table_schema, table_name;
    `);
    console.log('Tables:', JSON.stringify(res, null, 2));
    
    // Check specifically for meta.channel_names (schema meta, table channel_names)
    const specific = await db.getRows(`
      SELECT * FROM information_schema.tables 
      WHERE table_schema = 'meta' AND table_name = 'channel_names';
    `);
    console.log('meta.channel_names exists:', specific && specific.length > 0);
    
    // Check specifically for admin.meta_influx_channels
    const admin = await db.getRows(`
      SELECT * FROM information_schema.tables 
      WHERE table_schema = 'admin' AND table_name = 'meta_influx_channels';
    `);
    console.log('admin.meta_influx_channels exists:', admin && admin.length > 0);

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await db.close();
  }
}

listTables();
