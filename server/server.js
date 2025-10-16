import express from 'express';
import multer from 'multer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const PORT         = process.env.PORT || 3001;
const ROOT_DIR     = __dirname;
const UPLOAD_DIR   = process.env.UPLOAD_DIR  || path.join(ROOT_DIR, 'uploads'); 
const DATA_DIR     = process.env.DATA_DIR    || path.join(ROOT_DIR, 'data');    
const MAX_FILE_GB  = Number(process.env.MAX_FILE_GB || 2);                     

for (const d of [UPLOAD_DIR, DATA_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}


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


const app = express();
app.use(cors({ origin: true, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());

app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));


app.get('/health', (_req, res) => res.json({ ok: true }));


function getOwnerId(_req) { return 'demo-user'; }


function safeExt(mime) {
  if (!mime) return '.webm';
  const m = String(mime).toLowerCase();
  if (m.includes('webm')) return '.webm';
  if (m.includes('mp4'))  return '.mp4';
  if (m.includes('quicktime')) return '.mov';
  return '.webm';
}

/* =========================
   Single-file upload (optional)
   ========================= */
const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `${id}${ext}`);
  }
});
const uploadSingle = multer({
  storage: diskStorage,
  limits: { fileSize: MAX_FILE_GB * 1024 * 1024 * 1024 }
});

app.post('/upload', uploadSingle.single('file'), (req, res) => {
  try {
    const id = path.parse(req.file.filename).name;
    const url = `/uploads/${req.file.filename}`;
    const mimeType = req.body.mimeType || req.file.mimetype || 'video/webm';
    const durationMs = Number(req.body.durationMs || 0);
    const ownerId = getOwnerId(req);

    db.prepare(`
      INSERT INTO recordings(id, owner_id, url, mime_type, bytes, duration_ms)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(id, ownerId, url, mimeType, req.file.size, durationMs);

    res.json({ id, url });
  } catch (e) {
    console.error('[single-upload] error', e);
    res.status(500).json({ error: 'store failed' });
  }
});

const memUpload = multer({ storage: multer.memoryStorage() });

const inFlight = new Map();

app.post('/upload/chunk', memUpload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, mimeType } = req.body || {};
    const idx = Number.isFinite(+req.body?.index) ? Number(req.body.index) : null;

    if (!uploadId || !req.file || idx === null || idx < 0) {
      return res.status(400).json({ error: 'bad request (need uploadId, chunk, numeric index)' });
    }

    let sess = inFlight.get(uploadId);
    if (!sess) {

      const ownerId = getOwnerId(req);
      const ext = safeExt(mimeType);
      const filename = `${uploadId}${ext}`;
      const filepath = path.join(UPLOAD_DIR, filename);

      const stream = fs.createWriteStream(filepath, { flags: 'a' });

      sess = {
        stream,
        filepath,
        filename,
        ownerId,
        mimeType: mimeType || 'video/webm',
        ext,
        bytes: 0,
        nextIndex: 0
      };
      inFlight.set(uploadId, sess);
      console.log('[chunk:init]', uploadId, '->', filename);
    }


    if (idx !== sess.nextIndex) {

      console.warn('[chunk:order] uploadId=', uploadId, 'got index', idx, 'expected', sess.nextIndex);
      return res.status(409).json({ error: 'out-of-order', expected: sess.nextIndex });
    }


    await new Promise((resolve, reject) => {
      sess.stream.write(req.file.buffer, (err) => err ? reject(err) : resolve());
    });
    sess.bytes += req.file.size;
    sess.nextIndex += 1;

    res.json({ ok: true, nextIndex: sess.nextIndex });
  } catch (e) {
    console.error('[chunk] error', e);
    return res.status(500).json({ error: 'chunk store failed' });
  }
});


app.post('/upload/finish', memUpload.none(), async (req, res) => {
  const uploadId   = req.body?.uploadId;
  const durationMs = Number(req.body?.durationMs || 0);
  if (!uploadId) return res.status(400).json({ error: 'uploadId required' });

  const sess = inFlight.get(uploadId);
  if (!sess) {

    const possible = ['.webm','.mp4','.mov'].map(ext => path.join(UPLOAD_DIR, `${uploadId}${ext}`));
    for (const fp of possible) {
      if (fs.existsSync(fp)) {
        const st = await fsp.stat(fp);
        const url = `/uploads/${path.basename(fp)}`;
        db.prepare(`
          INSERT INTO recordings(id, owner_id, url, mime_type, bytes, duration_ms)
          VALUES(?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE
          SET url=excluded.url, mime_type=excluded.mime_type, bytes=excluded.bytes, duration_ms=excluded.duration_ms
        `).run(uploadId, getOwnerId(req), url, 'video/webm', st.size, durationMs);
        return res.json({ id: uploadId, url });
      }
    }
    return res.status(404).json({ error: 'unknown uploadId' });
  }

  try {
    // Close stream cleanly
    await new Promise((resolve, reject) => {
      sess.stream.end(err => err ? reject(err) : resolve());
    });

    const st = await fsp.stat(sess.filepath);
    const url = `/uploads/${sess.filename}`;
    db.prepare(`
      INSERT INTO recordings(id, owner_id, url, mime_type, bytes, duration_ms)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE
      SET url=excluded.url, mime_type=excluded.mime_type, bytes=excluded.bytes, duration_ms=excluded.duration_ms
    `).run(uploadId, sess.ownerId, url, sess.mimeType, st.size, durationMs);

    inFlight.delete(uploadId);
    return res.json({ id: uploadId, url });
  } catch (e) {
    console.error('[finish] finalize error', e);
    return res.status(500).json({ error: 'finalize failed' });
  }
});


app.get('/recordings', (req, res) => {
  const ownerId = getOwnerId(req);
  const rows = db.prepare(`
    SELECT id, url, mime_type AS mimeType, bytes, duration_ms AS durationMs, created_at AS createdAt
    FROM recordings
    WHERE owner_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 50
  `).all(ownerId);
  res.json({ items: rows });
});

app.listen(PORT, () => {
  console.log(`SQLite-backend kjører på http://localhost:${PORT}`);
});
