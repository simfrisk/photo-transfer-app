require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initSchema } = require('./src/config/db');
const { ensureBucket } = require('./src/services/storage');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/galleries', require('./src/routes/galleries'));
// Images upload route — disable body parser so we can stream the raw body
app.use('/api/images', (req, res, next) => {
  if (req.path.startsWith('/upload/')) return next();
  express.json()(req, res, next);
});
app.use('/api/images', require('./src/routes/images'));
app.use('/api/client', require('./src/routes/client'));

// Frontend page routes
app.get('/', (req, res) => res.redirect('/login.html'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/upload/:galleryId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'upload.html')));
app.get('/gallery/:shareToken', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gallery.html')));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

async function start() {
  try {
    await initSchema();
    console.log('Database schema initialized');
    await ensureBucket();
    console.log('Storage bucket ready');
    app.listen(PORT, () => {
      console.log(`Photo Transfer App running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
