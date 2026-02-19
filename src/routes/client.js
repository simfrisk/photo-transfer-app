const express = require('express');
const { query } = require('../config/db');
const { getSignedDownloadUrl, downloadFileStream } = require('../services/storage');

const router = express.Router();

// ── Minimal ZIP writer (no external dependencies) ──────────────────────
// Builds a valid ZIP file (store/no-compression) by writing local file
// headers, data, and then the central directory + end record.
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZipBuffer(files) {
  // files: [{ name: string, data: Buffer }]
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;
  const parts = [];

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const size = file.data.length;

    // Local file header (30 + nameLen)
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);  // signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // compression: store
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0, 12);           // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);        // compressed
    local.writeUInt32LE(size, 22);        // uncompressed
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length
    nameBytes.copy(local, 30);

    // Central directory header (46 + nameLen)
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0, 8);          // flags
    central.writeUInt16LE(0, 10);         // compression
    central.writeUInt16LE(0, 12);         // mod time
    central.writeUInt16LE(0, 14);         // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);         // extra field length
    central.writeUInt16LE(0, 32);         // comment length
    central.writeUInt16LE(0, 34);         // disk number start
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE(0, 38);         // external attrs
    central.writeUInt32LE(offset, 42);    // relative offset
    nameBytes.copy(central, 46);

    parts.push(local, file.data);
    centralHeaders.push(central);
    offset += local.length + file.data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const ch of centralHeaders) {
    parts.push(ch);
    centralSize += ch.length;
  }

  // End of central directory
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);               // disk number
  end.writeUInt16LE(0, 6);               // disk with central dir
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);              // comment length
  parts.push(end);

  return Buffer.concat(parts);
}
// ────────────────────────────────────────────────────────────────────────

// GET /api/client/gallery/:shareToken - public gallery view
router.get('/gallery/:shareToken', async (req, res) => {
  try {
    const gResult = await query(
      `SELECT g.*, p.name AS photographer_name
       FROM galleries g
       JOIN photographers p ON p.id = g.photographer_id
       WHERE g.share_token = $1`,
      [req.params.shareToken]
    );

    const gallery = gResult.rows[0];
    if (!gallery) {
      return res.status(404).json({ error: 'Gallery not found' });
    }

    // Check expiry
    if (gallery.expires_at && new Date(gallery.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This gallery link has expired' });
    }

    // Fetch images with signed thumbnail URLs
    const iResult = await query(
      'SELECT * FROM images WHERE gallery_id = $1 ORDER BY sort_order ASC, uploaded_at ASC',
      [gallery.id]
    );

    const images = await Promise.all(
      iResult.rows.map(async (img) => {
        const thumbUrl = img.thumb_key
          ? await getSignedDownloadUrl(img.thumb_key, 3600)
          : await getSignedDownloadUrl(img.original_key, 3600);
        return {
          id: img.id,
          filename: img.filename,
          width: img.width,
          height: img.height,
          size_bytes: img.size_bytes,
          uploaded_at: img.uploaded_at,
          thumbUrl,
        };
      })
    );

    res.json({
      id: gallery.id,
      title: gallery.title,
      description: gallery.description,
      photographer_name: gallery.photographer_name,
      created_at: gallery.created_at,
      expires_at: gallery.expires_at,
      image_count: images.length,
      images,
    });
  } catch (err) {
    console.error('Client gallery error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/client/download/:imageId/:shareToken - download image as attachment
router.get('/download/:imageId/:shareToken', async (req, res) => {
  try {
    const result = await query(
      `SELECT i.* FROM images i
       JOIN galleries g ON g.id = i.gallery_id
       WHERE i.id = $1 AND g.share_token = $2`,
      [req.params.imageId, req.params.shareToken]
    );

    const image = result.rows[0];
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    // Check gallery expiry
    const gResult = await query('SELECT expires_at FROM galleries WHERE id = $1', [image.gallery_id]);
    const gallery = gResult.rows[0];
    if (gallery?.expires_at && new Date(gallery.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This gallery link has expired' });
    }

    // Stream the file from storage and set Content-Disposition to force download
    const stream = await downloadFileStream(image.original_key);
    const safeFilename = encodeURIComponent(image.filename).replace(/%20/g, '+');
    res.set({
      'Content-Type': image.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safeFilename}"`,
    });
    if (image.size_bytes) {
      res.set('Content-Length', String(image.size_bytes));
    }
    stream.pipe(res);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/client/download-all/:shareToken - download all images as a zip
router.get('/download-all/:shareToken', async (req, res) => {
  try {
    const gResult = await query(
      `SELECT g.*, p.name AS photographer_name
       FROM galleries g
       JOIN photographers p ON p.id = g.photographer_id
       WHERE g.share_token = $1`,
      [req.params.shareToken]
    );

    const gallery = gResult.rows[0];
    if (!gallery) {
      return res.status(404).json({ error: 'Gallery not found' });
    }

    if (gallery.expires_at && new Date(gallery.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This gallery link has expired' });
    }

    const iResult = await query(
      'SELECT * FROM images WHERE gallery_id = $1 ORDER BY sort_order ASC, uploaded_at ASC',
      [gallery.id]
    );

    if (iResult.rows.length === 0) {
      return res.status(404).json({ error: 'No images in this gallery' });
    }

    // Download all files into memory and build zip
    const usedNames = {};
    const files = [];
    for (const img of iResult.rows) {
      let name = img.filename || 'image.jpg';
      if (usedNames[name]) {
        const ext = name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.')) : '';
        const base = name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name;
        usedNames[name]++;
        name = `${base}_${usedNames[name]}${ext}`;
      } else {
        usedNames[name] = 1;
      }

      const stream = await downloadFileStream(img.original_key);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      files.push({ name, data: Buffer.concat(chunks) });
    }

    const zipBuffer = buildZipBuffer(files);
    const safeName = gallery.title.replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'gallery';
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(safeName)}.zip"`,
      'Content-Length': String(zipBuffer.length),
    });
    res.send(zipBuffer);
  } catch (err) {
    console.error('Download all error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

module.exports = router;
