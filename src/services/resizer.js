const sharp = require('sharp');

/**
 * Resize an image buffer to a thumbnail.
 * Returns a JPEG buffer.
 */
async function resizeToThumbnail(buffer, width = 600) {
  return sharp(buffer)
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/**
 * Get image dimensions from a buffer.
 */
async function getImageDimensions(buffer) {
  const metadata = await sharp(buffer).metadata();
  return { width: metadata.width, height: metadata.height };
}

module.exports = { resizeToThumbnail, getImageDimensions };
