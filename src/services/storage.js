const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
  forcePathStyle: true, // Required for MinIO
});

const BUCKET = process.env.S3_BUCKET || 'photos';

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === 'NoSuchBucket' || err.name === 'NotFound') {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
      console.log(`Created bucket: ${BUCKET}`);
    } else {
      throw err;
    }
  }
}

async function getSignedUploadUrl(key, mimeType, expiresIn = 300) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: mimeType,
  });
  return getSignedUrl(s3, command, { expiresIn });
}

async function uploadFile(buffer, key, mimeType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }));
  return key;
}

async function getSignedDownloadUrl(key, expiresIn = 3600) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn });
}

async function downloadFileStream(key) {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return response.Body;
}

async function deleteFile(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { ensureBucket, uploadFile, getSignedUploadUrl, getSignedDownloadUrl, downloadFileStream, deleteFile };
