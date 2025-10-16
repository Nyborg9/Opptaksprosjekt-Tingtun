import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- config ---
const PORT = process.env.PORT || 3001;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- DB (SQLite) ---
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'data.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  url TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rec_owner_created ON recordings(owner_id, created_at DESC);
`);

// --- app ---
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

// Demo: single "owner"
function getOwnerId(req) { return 'demo-user'; }

// helpers
const ALLOWED_CODES = new Set(['test1','test2','test3']);

function sanitizeName(name) {
  // keep letters, numbers, dash, underscore, dot; collapse spaces; trim length
  const n = name
    .replace(/[/\\<>:"|?*\u0000-\u001F]/g, '-')   // forbidden on many FS
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
  return n || 'file';
}

function ensureUniqueFilename(dir, base) {
  const { name, ext } = path.parse(base);
  let candidate = base;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${name}-${i}${ext}`;
    i++;
  }
  return candidate;
}

function extFromMime(mime) {
  if (!mime) return '.bin';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('quicktime')) return '.mov';
  return '.bin';
}

// --- Single-file upload (/upload) ---
// Use the client-provided filename (already sent by your main.js) instead of UUID.
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // file.originalname will be like "test1-2025-10-09T12-34-56-789Z.webm"
    const safe = sanitizeName(file.originalname || `upload${extFromMime(file.mimetype)}`);
    const unique = ensureUniqueFilename(UPLOAD_DIR, safe);
    cb(null, unique);
  }
});

const upload = multer({
  storage: diskStorage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

app.post('/upload', upload.single('file'), (req, res) => {
  try {
    const id = uuidv4(); // logical ID for DB; filename is now human-friendly
    const url = `/uploads/${req.file.filename}`;
    const mimeType = req.body.mimeType || req.file.mimetype || 'video/webm';
    const durationMs = Number(req.body.durationMs || 0);
    const ownerId = getOwnerId(req);

    db.prepare(`
      INSERT INTO recordings(id, owner_id, url, mime_type, bytes, duration_ms)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(id, ownerId, url, mimeType, req.file.size, durationMs);

    res.json({ id, url, filename: req.file.filename });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Store failed' });
  }
});

// --- Chunked upload (/upload/chunk + /upload/finish) ---
const memUpload = multer({ storage: multer.memoryStorage() });

const inprogress = new Map();      // uploadId -> fs.WriteStream
const inprogressMeta = new Map();  // uploadId -> { ownerId, startedAt, mimeType, filename }

app.post('/upload/chunk', memUpload.single('chunk'), (req, res) => {
  const { uploadId, mimeType, code } = req.body || {};
  if (!uploadId || !req.file) return res.status(400).json({ error: 'bad request' });

  let meta = inprogressMeta.get(uploadId);
  if (!meta) {
    const ownerId = getOwnerId(req);
    const ext = extFromMime(mimeType);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = ALLOWED_CODES.has((code||'').toLowerCase()) ? code.toLowerCase() : 'screen-recording';
    const desired = sanitizeName(`${prefix}-${ts}${ext}`);
    const filename = ensureUniqueFilename(UPLOAD_DIR, desired);

    meta = { ownerId, startedAt: Date.now(), mimeType: mimeType || 'application/octet-stream', filename };
    inprogressMeta.set(uploadId, meta);
  }

  let handle = inprogress.get(uploadId);
  if (!handle) {
    const filepath = path.join(UPLOAD_DIR, meta.filename);
    handle = fs.createWriteStream(filepath, { flags: 'a' });
    inprogress.set(uploadId, handle);
  }

  handle.write(req.file.buffer);
  res.json({ ok: true, filename: meta.filename });
});

app.post('/upload/finish', (req, res) => {
  const { uploadId, durationMs = 0 } = req.body || {};
  const handle = inprogress.get(uploadId);
  const meta = inprogressMeta.get(uploadId);
  if (!meta) return res.status(404).json({ error: 'unknown uploadId' });

  if (handle) handle.end();
  inprogress.delete(uploadId);

  const filepath = path.join(UPLOAD_DIR, meta.filename);
  const stats = fs.statSync(filepath);
  const url = `/uploads/${meta.filename}`;
  const { ownerId } = meta;
  const id = uploadId; // keep uploadId as DB key for chunked uploads

  db.prepare(`
    INSERT INTO recordings(id, owner_id, url, mime_type, bytes, duration_ms)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET url=excluded.url, mime_type=excluded.mime_type, bytes=excluded.bytes, duration_ms=excluded.duration_ms
  `).run(id, ownerId, url, meta.mimeType, stats.size, Number(durationMs));

  inprogressMeta.delete(uploadId);
  res.json({ id, url, filename: meta.filename });
});

app.listen(PORT, () => console.log(`SQLite-backend kjører på http://localhost:${PORT}`));
