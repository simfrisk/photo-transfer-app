const express = require('express');
const { query } = require('../config/db');
const { getSignedDownloadUrl } = require('../services/storage');

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

// GET /api/client/download/:imageId/:shareToken - get signed download URL
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

    const signedUrl = await getSignedDownloadUrl(image.original_key, 3600);
    res.redirect(signedUrl);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
