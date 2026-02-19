const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const result = await query('SELECT * FROM photographers WHERE email = $1', [email.toLowerCase()]);
    const photographer = result.rows[0];
    if (!photographer) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, photographer.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: photographer.id, email: photographer.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      photographer: { id: photographer.id, email: photographer.email, name: photographer.name },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/register (one-time use for account creation)
router.post('/register', async (req, res) => {
  const { email, password, name, registerSecret } = req.body;

  if (registerSecret !== process.env.REGISTER_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, password and name are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await query(
      'INSERT INTO photographers (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email.toLowerCase(), hash, name]
    );

    const photographer = result.rows[0];
    const token = jwt.sign(
      { id: photographer.id, email: photographer.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({ token, photographer });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, email, name, created_at FROM photographers WHERE id = $1',
      [req.photographer.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
