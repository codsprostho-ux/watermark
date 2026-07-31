require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const {
  PORT = 3000,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  GDRIVE_ROOT_FOLDER_ID,
  WATERMARK_LOGO_URL,
  WATERMARK_TEXT = '',
  WATERMARK_OPACITY = '0.35',
  WATERMARK_ROTATION_DEGREES = '-30',
  FIELD_PATIENT_NAME = 'Patient Name',
  FIELD_DOCTOR_NAME = 'Doctor Name',
  FIELD_CASE_TYPE = 'Type of Case',
  FIELD_PHOTO_UPLOAD = 'Upload photo',
  WEBHOOK_SECRET = ''
} = process.env;

const OPACITY = parseFloat(WATERMARK_OPACITY);
const ROTATION = parseFloat(WATERMARK_ROTATION_DEGREES);

// ---------- Google Drive auth ----------
function getDriveClient() {
  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  return google.drive({ version: 'v3', auth });
}

// Finds a folder by name under a given parent, creating it if it doesn't exist.
async function findOrCreateFolder(drive, name, parentId) {
  const safeName = name.replace(/'/g, "\\'");
  const q = `mimeType='application/vnd.google-apps.folder' and name='${safeName}' and '${parentId}' in parents and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id, name)', spaces: 'drive' });
  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id;
  }
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id'
  });
  return created.data.id;
}

async function uploadToDrivePath(buffer, filename, mimeType, { doctorName, patientName }) {
  const drive = getDriveClient();
  const doctorFolderId = await findOrCreateFolder(drive, doctorName || 'Unspecified Doctor', GDRIVE_ROOT_FOLDER_ID);
  const patientFolderId = await findOrCreateFolder(drive, patientName || 'Unspecified Patient', doctorFolderId);

  const monthLabel = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }); // e.g. "July 2026"
  const monthFolderId = await findOrCreateFolder(drive, monthLabel, patientFolderId);

  const { Readable } = require('stream');
  const stream = Readable.from(buffer);

  const file = await drive.files.create({
    requestBody: { name: filename, parents: [monthFolderId] },
    media: { mimeType, body: stream },
    fields: 'id, webViewLink'
  });
  return file.data;
}

// ---------- Watermarking ----------

// Multiplies a PNG's alpha channel by `opacity` (0-1) uniformly.
async function applyOpacity(pngBuffer, opacity) {
  const alpha = Math.max(0, Math.min(1, opacity));
  return sharp(pngBuffer)
    .ensureAlpha()
    .composite([{
      input: Buffer.from([255, 255, 255, Math.round(alpha * 255)]),
      raw: { width: 1, height: 1, channels: 4 },
      tile: true,
      blend: 'dest-in'
    }])
    .png()
    .toBuffer();
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[c]));
}

async function watermarkImage(photoBuffer) {
  const image = sharp(photoBuffer);
  const meta = await image.metadata();
  const { width, height } = meta;

  const layers = [];

  // --- Logo layer (optional) ---
  if (WATERMARK_LOGO_URL) {
    const logoResp = await axios.get(WATERMARK_LOGO_URL, { responseType: 'arraybuffer' });
    const logoWidth = Math.round(width * 0.35);
    let logoBuf = await sharp(logoResp.data).resize({ width: logoWidth }).png().toBuffer();
    logoBuf = await applyOpacity(logoBuf, OPACITY);
    logoBuf = await sharp(logoBuf)
      .rotate(ROTATION, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const logoMeta = await sharp(logoBuf).metadata();
    layers.push({
      input: logoBuf,
      left: Math.round((width - logoMeta.width) / 2),
      top: Math.round((height - logoMeta.height) / 2)
    });
  }

  // --- Text layer ---
  if (WATERMARK_TEXT) {
    const fontSize = Math.max(18, Math.round(width * 0.045));
    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <text x="50%" y="50%"
              font-family="Arial, sans-serif" font-weight="bold"
              font-size="${fontSize}" fill="#FFFFFF" fill-opacity="${OPACITY}"
              text-anchor="middle" dominant-baseline="middle"
              transform="rotate(${ROTATION} ${width / 2} ${height / 2})">
          ${escapeXml(WATERMARK_TEXT)}
        </text>
      </svg>`;
    layers.push({ input: Buffer.from(svg) });
  }

  return sharp(photoBuffer).composite(layers).jpeg({ quality: 90 }).toBuffer();
}

// ---------- Helpers to parse Jotform's payload ----------

// Jotform sends a "pretty" field like:
// "Patient Name:John Doe, Doctor Name:Dr. Smith, Upload photo:https://www.jotform.com/uploads/.../photo.jpg"
// Fields are comma-separated, so we split on ", " but only right before what looks like
// the start of the next "Label:" pair, so values that themselves contain commas survive intact.
function parsePretty(pretty) {
  const result = {};
  if (!pretty) return result;
  const parts = pretty.split(/,\s+(?=[^,:]+:)/);
  parts.forEach((pair) => {
    const idx = pair.indexOf(':');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    result[key] = value;
  });
  return result;
}

async function downloadFile(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(resp.data);
}

// ---------- Webhook route ----------

app.post('/webhook', upload.any(), async (req, res) => {
  console.log('--- Incoming webhook hit ---');
  console.log('Query params:', req.query);
  console.log('Body keys:', Object.keys(req.body || {}));
  console.log('Files received:', (req.files || []).map((f) => f.originalname));
  try {
    if (WEBHOOK_SECRET && req.query.secret !== WEBHOOK_SECRET) {
      console.warn('Secret mismatch. Expected vs received differ.');
      return res.status(401).send('Invalid secret');
    }

    const fields = parsePretty(req.body.pretty);
    console.log('Raw pretty string:', req.body.pretty);
    console.log('Parsed fields:', fields);
    const patientName = fields[FIELD_PATIENT_NAME] || 'Unknown Patient';
    const doctorName = fields[FIELD_DOCTOR_NAME] || 'Unspecified Doctor';
    const caseType = fields[FIELD_CASE_TYPE] || 'Unspecified Case Type';

    // Collect photo(s): prefer actual uploaded file(s) captured by multer,
    // fall back to downloading from the URL Jotform put in `pretty`.
    let photoBuffers = [];
    if (req.files && req.files.length > 0) {
      photoBuffers = req.files.map((f) => ({ buffer: f.buffer, name: f.originalname }));
    } else if (fields[FIELD_PHOTO_UPLOAD]) {
      const urls = fields[FIELD_PHOTO_UPLOAD].split(',').map((u) => u.trim()).filter(Boolean);
      for (const url of urls) {
        if (!/^https?:\/\//i.test(url)) {
          console.warn('Skipping non-URL value in photo field:', url);
          continue;
        }
        try {
          const buffer = await downloadFile(url);
          photoBuffers.push({ buffer, name: url.split('/').pop() });
        } catch (downloadErr) {
          console.error('Failed to download photo from URL:', url, downloadErr.message);
        }
      }
    }

    if (photoBuffers.length === 0) {
      console.warn('No photo found in submission', req.body.submissionID);
      return res.status(200).send('No photo to process');
    }

    const results = [];
    for (const photo of photoBuffers) {
      const watermarked = await watermarkImage(photo.buffer);
      const safePatient = patientName.replace(/[^a-z0-9]+/gi, '_');
      const safeCaseType = (caseType || 'case').replace(/[^a-z0-9]+/gi, '_');
      const filename = `${safePatient}_${safeCaseType}_${Date.now()}.jpg`;
      const uploaded = await uploadToDrivePath(watermarked, filename, 'image/jpeg', { doctorName, patientName });
      results.push(uploaded);
    }

    console.log(`Processed ${results.length} photo(s) for ${patientName} (${doctorName}, ${caseType})`);
    res.status(200).json({ ok: true, uploaded: results });
  } catch (err) {
    console.error('Webhook processing failed:', err);
    res.status(500).send('Processing error');
  }
});

app.get('/', (req, res) => res.send('Jotform watermark server is running.'));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
