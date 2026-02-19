const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const { getSignedUploadUrl, deleteFile, getSignedDownloadUrl, uploadFile } = require('../services/storage');
const { resizeToThumbnail, getImageDimensions } = require('../services/resizer');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// POST /api/images/upload/:galleryId
// Streams the raw body directly to MinIO — no multer buffering, no body size limit
router.post('/upload/:galleryId', async (req, res) => {
  const { galleryId } = req.params;
  const filename = req.headers['x-filename'] ? decodeURIComponent(req.headers['x-filename']) : 'image.jpg';
  const mimeType = req.headers['content-type'] || 'image/jpeg';
  const sizeBytes = parseInt(req.headers['content-length'] || '0', 10);

  console.log(`[Upload] POST /upload/${galleryId} - file: ${filename}, type: ${mimeType}, size: ${sizeBytes}`);

  if (!mimeType.startsWith('image/')) {
    console.log('[Upload] Rejected: not an image type:', mimeType);
    return res.status(400).json({ error: 'Only image files are allowed' });
  }

  try {
    console.log('[Upload] Checking gallery ownership...');
    const gResult = await query(
      'SELECT id FROM galleries WHERE id = $1 AND photographer_id = $2',
      [galleryId, req.photographer.id]
    );
    if (!gResult.rows[0]) {
      console.log('[Upload] Gallery not found for photographer:', req.photographer.id);
      return res.status(404).json({ error: 'Gallery not found' });
    }
    console.log('[Upload] Gallery found, proceeding with upload');

    const ext = path.extname(filename).toLowerCase() || '.jpg';
    const uuid = uuidv4();
    const originalKey = `originals/${galleryId}/${uuid}${ext}`;
    const thumbKey = `thumbs/${galleryId}/${uuid}.jpg`;

    // Collect the stream into a buffer so we can also make a thumbnail
    console.log('[Upload] Reading request body stream...');
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    console.log('[Upload] Body received, buffer size:', buffer.length);

    if (buffer.length === 0) {
      console.error('[Upload] ERROR: Received empty body!');
      return res.status(400).json({ error: 'Empty file received' });
    }

    // Upload original to MinIO
    console.log('[Upload] Uploading original to storage, key:', originalKey);
    await uploadFile(buffer, originalKey, mimeType);
    console.log('[Upload] Original uploaded successfully');

    // Generate thumbnail and upload
    let width = null, height = null;
    let thumbUploaded = false;
    try {
      console.log('[Upload] Generating thumbnail...');
      const dims = await getImageDimensions(buffer);
      width = dims.width;
      height = dims.height;
      console.log('[Upload] Image dimensions:', width, 'x', height);
      const thumbBuffer = await resizeToThumbnail(buffer, 800);
      await uploadFile(thumbBuffer, thumbKey, 'image/jpeg');
      thumbUploaded = true;
      console.log('[Upload] Thumbnail uploaded successfully');
    } catch (thumbErr) {
      console.warn('[Upload] Thumbnail generation warning:', thumbErr.message);
    }

    // Save to database
    console.log('[Upload] Saving to database...');
    const result = await query(
      `INSERT INTO images (gallery_id, filename, original_key, thumb_key, size_bytes, mime_type, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [galleryId, filename, originalKey, thumbUploaded ? thumbKey : null, sizeBytes || buffer.length, mimeType, width, height]
    );

    const image = result.rows[0];
    console.log('[Upload] Image saved to DB, id:', image.id);
    const thumbUrl = thumbUploaded ? await getSignedDownloadUrl(thumbKey, 3600) : null;

    console.log('[Upload] Upload complete, returning response');
    res.status(201).json({ ...image, thumbUrl });
  } catch (err) {
    console.error('[Upload] Upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
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
