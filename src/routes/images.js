const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const { uploadFile, deleteFile, getSignedDownloadUrl } = require('../services/storage');
const { resizeToThumbnail, getImageDimensions } = require('../services/resizer');
const authMiddleware = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();
router.use(authMiddleware);

// POST /api/images/upload/:galleryId
router.post('/upload/:galleryId', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  const { galleryId } = req.params;

  try {
    // Verify gallery ownership
    const gResult = await query(
      'SELECT id FROM galleries WHERE id = $1 AND photographer_id = $2',
      [galleryId, req.photographer.id]
    );
    if (!gResult.rows[0]) {
      return res.status(404).json({ error: 'Gallery not found' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    const uuid = uuidv4();
    const originalKey = `originals/${galleryId}/${uuid}${ext}`;
    const thumbKey = `thumbs/${galleryId}/${uuid}.jpg`;

    // Get original dimensions
    const { width, height } = await getImageDimensions(req.file.buffer);

    // Upload original to S3
    await uploadFile(req.file.buffer, originalKey, req.file.mimetype);

    // Generate and upload thumbnail
    const thumbBuffer = await resizeToThumbnail(req.file.buffer, 800);
    await uploadFile(thumbBuffer, thumbKey, 'image/jpeg');

    // Save to database
    const result = await query(
      `INSERT INTO images (gallery_id, filename, original_key, thumb_key, size_bytes, mime_type, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        galleryId,
        req.file.originalname,
        originalKey,
        thumbKey,
        req.file.size,
        req.file.mimetype,
        width,
        height,
      ]
    );

    const image = result.rows[0];
    // Return with a short-lived thumb URL
    const thumbUrl = await getSignedDownloadUrl(thumbKey, 3600);

    res.status(201).json({ ...image, thumbUrl });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// DELETE /api/images/:id
router.delete('/:id', async (req, res) => {
  try {
    // Verify ownership via gallery
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

    // Delete from storage
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
