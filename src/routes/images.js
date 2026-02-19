const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const { getSignedUploadUrl, deleteFile, getSignedDownloadUrl } = require('../services/storage');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// POST /api/images/presign/:galleryId
// Returns a presigned PUT URL so the browser can upload directly to MinIO
router.post('/presign/:galleryId', async (req, res) => {
  const { galleryId } = req.params;
  const { filename, mimeType } = req.body;

  if (!filename || !mimeType) {
    return res.status(400).json({ error: 'filename and mimeType are required' });
  }

  try {
    const gResult = await query(
      'SELECT id FROM galleries WHERE id = $1 AND photographer_id = $2',
      [galleryId, req.photographer.id]
    );
    if (!gResult.rows[0]) {
      return res.status(404).json({ error: 'Gallery not found' });
    }

    const ext = path.extname(filename).toLowerCase() || '.jpg';
    const uuid = uuidv4();
    const originalKey = `originals/${galleryId}/${uuid}${ext}`;
    const thumbKey = `thumbs/${galleryId}/${uuid}.jpg`;

    const uploadUrl = await getSignedUploadUrl(originalKey, mimeType, 300);

    res.json({ uploadUrl, originalKey, thumbKey, uuid });
  } catch (err) {
    console.error('Presign error:', err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// POST /api/images/confirm/:galleryId
// Called after the browser has uploaded to MinIO — saves the record to DB
router.post('/confirm/:galleryId', async (req, res) => {
  const { galleryId } = req.params;
  const { originalKey, thumbKey, filename, mimeType, sizeBytes, width, height } = req.body;

  if (!originalKey || !filename) {
    return res.status(400).json({ error: 'originalKey and filename are required' });
  }

  try {
    const gResult = await query(
      'SELECT id FROM galleries WHERE id = $1 AND photographer_id = $2',
      [galleryId, req.photographer.id]
    );
    if (!gResult.rows[0]) {
      return res.status(404).json({ error: 'Gallery not found' });
    }

    const result = await query(
      `INSERT INTO images (gallery_id, filename, original_key, thumb_key, size_bytes, mime_type, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [galleryId, filename, originalKey, thumbKey || null, sizeBytes || null, mimeType || null, width || null, height || null]
    );

    const image = result.rows[0];
    const thumbUrl = thumbKey ? await getSignedDownloadUrl(thumbKey, 3600) : null;

    res.status(201).json({ ...image, thumbUrl });
  } catch (err) {
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Failed to save image record' });
  }
});

// DELETE /api/images/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT i.* FROM images i
       JOIN galleries g ON g.id = i.gallery_id
       WHERE i.id = $1 AND g.photographer_id = $2`,
      [req.params.id, req.photographer.id]
    );
    const image = result.rows[0];
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    try {
      await deleteFile(image.original_key);
      if (image.thumb_key) await deleteFile(image.thumb_key);
    } catch (storageErr) {
      console.warn('Storage deletion warning:', storageErr.message);
    }

    await query('DELETE FROM images WHERE id = $1', [req.params.id]);
    res.json({ message: 'Image deleted' });
  } catch (err) {
    console.error('Delete image error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
