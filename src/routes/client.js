const express = require('express');
const archiver = require('archiver');
const { query } = require('../config/db');
const { getSignedDownloadUrl, downloadFileStream } = require('../services/storage');

const router = express.Router();

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
      'SELECT * FROM images WHERE gallery_id = $1 ORDER BY uploaded_at ASC',
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
      'SELECT * FROM images WHERE gallery_id = $1 ORDER BY uploaded_at ASC',
      [gallery.id]
    );

    if (iResult.rows.length === 0) {
      return res.status(404).json({ error: 'No images in this gallery' });
    }

    const safeName = gallery.title.replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'gallery';
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(safeName)}.zip"`,
    });

    const archive = archiver('zip', { store: true }); // store = no compression (images are already compressed)
    archive.pipe(res);

    // Track filenames to avoid duplicates
    const usedNames = {};
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
      archive.append(stream, { name });
    }

    await archive.finalize();
  } catch (err) {
    console.error('Download all error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

module.exports = router;
