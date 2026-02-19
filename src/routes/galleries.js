const express = require('express');
const crypto = require('crypto');
const { query } = require('../config/db');
const { deleteFile } = require('../services/storage');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/galleries - list all galleries for current photographer
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT g.*, COUNT(i.id)::int AS image_count
       FROM galleries g
       LEFT JOIN images i ON i.gallery_id = g.id
       WHERE g.photographer_id = $1
       GROUP BY g.id
       ORDER BY g.created_at DESC`,
      [req.photographer.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List galleries error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/galleries - create new gallery
router.post('/', async (req, res) => {
  const { title, description, expires_at } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const shareToken = crypto.randomBytes(32).toString('hex');

  try {
    const result = await query(
      `INSERT INTO galleries (photographer_id, title, description, share_token, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.photographer.id, title, description || null, shareToken, expires_at || null]
    );
    res.status(201).json({ ...result.rows[0], image_count: 0 });
  } catch (err) {
    console.error('Create gallery error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/galleries/:id - get gallery with images
router.get('/:id', async (req, res) => {
  try {
    const gResult = await query(
      'SELECT * FROM galleries WHERE id = $1 AND photographer_id = $2',
      [req.params.id, req.photographer.id]
    );
    if (!gResult.rows[0]) {
      return res.status(404).json({ error: 'Gallery not found' });
    }

    const iResult = await query(
      'SELECT * FROM images WHERE gallery_id = $1 ORDER BY uploaded_at DESC',
      [req.params.id]
    );

    res.json({ ...gResult.rows[0], images: iResult.rows });
  } catch (err) {
    console.error('Get gallery error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/galleries/:id - update gallery
router.patch('/:id', async (req, res) => {
  const { title, description, expires_at } = req.body;

  try {
    const result = await query(
      `UPDATE galleries
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           expires_at = $3
       WHERE id = $4 AND photographer_id = $5
       RETURNING *`,
      [title, description, expires_at !== undefined ? expires_at : null, req.params.id, req.photographer.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Gallery not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update gallery error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/galleries/:id
router.delete('/:id', async (req, res) => {
  try {
    const gResult = await query(
      'SELECT * FROM galleries WHERE id = $1 AND photographer_id = $2',
      [req.params.id, req.photographer.id]
    );
    if (!gResult.rows[0]) {
      return res.status(404).json({ error: 'Gallery not found' });
    }

    // Delete all images from storage
    const iResult = await query('SELECT original_key, thumb_key FROM images WHERE gallery_id = $1', [req.params.id]);
    for (const img of iResult.rows) {
      try {
        await deleteFile(img.original_key);
        if (img.thumb_key) await deleteFile(img.thumb_key);
      } catch (storageErr) {
        console.warn('Failed to delete image from storage:', storageErr.message);
      }
    }

    // Delete gallery (cascades to images in DB)
    await query('DELETE FROM galleries WHERE id = $1', [req.params.id]);
    res.json({ message: 'Gallery deleted' });
  } catch (err) {
    console.error('Delete gallery error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
