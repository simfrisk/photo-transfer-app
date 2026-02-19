const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'phototransfer',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS photographers (
      id         SERIAL PRIMARY KEY,
      email      VARCHAR(255) UNIQUE NOT NULL,
      password   VARCHAR(255) NOT NULL,
      name       VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS galleries (
      id               SERIAL PRIMARY KEY,
      photographer_id  INTEGER REFERENCES photographers(id) ON DELETE CASCADE,
      title            VARCHAR(255) NOT NULL,
      description      TEXT,
      share_token      VARCHAR(64) UNIQUE NOT NULL,
      expires_at       TIMESTAMP,
      created_at       TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_galleries_share_token ON galleries(share_token)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_galleries_photographer ON galleries(photographer_id)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS images (
      id           SERIAL PRIMARY KEY,
      gallery_id   INTEGER REFERENCES galleries(id) ON DELETE CASCADE,
      filename     VARCHAR(500) NOT NULL,
      original_key VARCHAR(500) NOT NULL,
      thumb_key    VARCHAR(500),
      size_bytes   BIGINT,
      mime_type    VARCHAR(100),
      width        INTEGER,
      height       INTEGER,
      uploaded_at  TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_images_gallery ON images(gallery_id)
  `);
}

module.exports = { query, initSchema };
