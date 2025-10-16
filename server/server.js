// server/server.js
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import Database from 'better-sqlite3';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================
   Config
   ========================= */
const PORT         = process.env.PORT || 3001;
const ROOT_DIR     = __dirname;
const UPLOAD_DIR   = process.env.UPLOAD_DIR  || path.join(ROOT_DIR, 'uploads');   // final files
const STAGING_DIR  = process.env.STAGING_DIR || path.join(ROOT_DIR, 'staging');   // per-session parts
const DATA_DIR     = process.env.DATA_DIR    || path.join(ROOT_DIR, 'data');      // SQLite
const MAX_FILE_GB  = Number(process.env.MAX_FILE_GB || 2);                        // single upload route cap
const STAGING_TTLH = Number(process.env.STAGING_TTL_HOURS || 24);                 // GC old sessions

for (const d of [UPLOAD_DIR, STAGING_DIR, DATA_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/* =========================
   Database (SQLite)
   ========================= */
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

/* =========================
   App + Middleware
   ========================= */
const app = express();

// CORS for local dev (8080 -> 3001). In prod, use a reverse proxy for same-origin.
app.use(cors({ origin: true, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());

app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR)); // dev convenience

// Simple health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Placeholder owner (replace with real auth later)
function getOwnerId(_req) { return 'demo-user'; }

/* =========================
   Helpers
   ========================= */
function safeExt(mime) {
  if (!mime) return '.webm';
  const m = mime.toLowerCase();
  if (m.includes('webm')) return '.webm';
  if (m.includes('mp4')) return '.mp4';
  if (m.includes('quicktime')) return '.mov';
  return '.webm';
}

function runFfmpeg(args, { showLogs = true } = {}) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', args);
    if (showLogs) {
      ff.stderr.on('data', (d) => process.stderr.write(d));
    }
    ff.on('close', (code) => resolve(code));
  });
}

/* =========================
   Single-file upload (unchanged)
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

/* =========================
   Chunked upload (parts + ffmpeg concat)
   ========================= */
const memUpload = multer({ storage: multer.memoryStorage() }); // for chunk (file)
const formOnly  = multer();                                    // for finish (fields only)

const sessions = new Map(); // uploadId -> { ownerId, mimeType, startedAt, ext }

/** POST /upload/chunk
 *  FormData: chunk (file), uploadId, mimeType, index (optional)
 */
app.post('/upload/chunk', memUpload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, mimeType } = req.body || {};
    if (!uploadId || !req.file) return res.status(400).json({ error: 'bad request' });

    let meta = sessions.get(uploadId);
    if (!meta) {
      const ownerId = getOwnerId(req);
      meta = {
        ownerId,
        mimeType: mimeType || 'video/webm',
        startedAt: Date.now(),
        ext: safeExt(mimeType)
      };
      sessions.set(uploadId, meta);
    }

    const sessDir = path.join(STAGING_DIR, uploadId);
    await fsp.mkdir(sessDir, { recursive: true });

    const idx = Number.isFinite(+req.body?.index) ? Number(req.body.index) : null;
    const partName = (idx !== null && idx >= 0)
      ? `${idx}.webm.part`
      : `${Date.now()}-${Math.random().toString(36).slice(2)}.webm.part`;
    const partPath = path.join(sessDir, partName);

    await fsp.writeFile(partPath, req.file.buffer);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[chunk] store failed', e);
    return res.status(500).json({ error: 'chunk store failed' });
  }
});

/** POST /upload/finish
 *  FormData: uploadId, durationMs
 */
app.post('/upload/finish', formOnly.none(), async (req, res) => {
  const uploadId   = req.body?.uploadId;
  const durationMs = Number(req.body?.durationMs || 0);
  if (!uploadId) return res.status(400).json({ error: 'uploadId required' });

  const meta = sessions.get(uploadId) || { ownerId: getOwnerId(req), mimeType: 'video/webm', ext: '.webm' };
  const sessDir = path.join(STAGING_DIR, uploadId);

  try {
    const entries = await fsp.readdir(sessDir).catch(() => []);
    const parts = entries
      .filter(n => n.endsWith('.part'))
      .map(n => {
        const m = n.match(/^(\d+)\.webm\.part$/);
        return { n, order: m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER, mtime: 0 };
      });

    if (!parts.length) {
      console.error('[finish] no parts for', uploadId, 'dir=', sessDir);
      return res.status(400).json({ error: 'no parts' });
    }

    // Sort by provided index, else by mtime
    if (parts.every(p => p.order === Number.MAX_SAFE_INTEGER)) {
      const stats = await Promise.all(parts.map(p => fsp.stat(path.join(sessDir, p.n))));
      parts.forEach((p, i) => (p.mtime = stats[i].mtimeMs));
      parts.sort((a, b) => a.mtime - b.mtime);
    } else {
      parts.sort((a, b) => a.order - b.order);
    }

    // Build concat list.txt
    const listPath = path.join(sessDir, 'list.txt');
    const lines = parts.map(p => {
      const abs = path.join(sessDir, p.n).replace(/'/g, "'\\''");
      return `file '${abs}'`;
    }).join('\n');
    await fsp.writeFile(listPath, lines);

    // Final output
    const finalName = `${uploadId}${meta.ext}`;
    const finalPath = path.join(UPLOAD_DIR, finalName);

    // ffmpeg concat (stream copy)
    const args = ['-f','concat','-safe','0','-i', listPath, '-c','copy', finalPath];
    console.log('[finish] ffmpeg', args.join(' '));
    const code = await runFfmpeg(args);
    if (code !== 0) {
      console.error('[finish] ffmpeg exit code', code);
      return res.status(500).json({ error: 'ffmpeg concat failed' });
    }

    // Persist DB row
    const stats = await fsp.stat(finalPath);
    const url = `/uploads/${finalName}`;
    const id = uploadId;
    const ownerId = meta.ownerId;

    db.prepare(`
      INSERT INTO recordings(id, owner_id, url, mime_type, bytes, duration_ms)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE
      SET url=excluded.url, mime_type=excluded.mime_type, bytes=excluded.bytes, duration_ms=excluded.duration_ms
    `).run(id, ownerId, url, meta.mimeType, stats.size, durationMs);

    // Cleanup staging
    try { await fsp.rm(sessDir, { recursive: true, force: true }); } catch {}
    sessions.delete(uploadId);

    return res.json({ id, url });
  } catch (e) {
    console.error('[finish] finalize error', e);
    return res.status(500).json({ error: 'finalize failed' });
  }
});

/* =========================
   (Optional) list recent recordings (dev helper)
   ========================= */
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

/* =========================
   GC for stale staging sessions
   ========================= */
async function gcStaging() {
  try {
    const now = Date.now();
    const cutoff = now - STAGING_TTLH * 60 * 60 * 1000;
    const dirs = await fsp.readdir(STAGING_DIR).catch(() => []);
    for (const d of dirs) {
      const full = path.join(STAGING_DIR, d);
      try {
        const st = await fsp.stat(full);
        if (st.isDirectory() && st.mtimeMs < cutoff) {
          console.log('[gc] removing stale', full);
          await fsp.rm(full, { recursive: true, force: true });
          sessions.delete(d);
        }
      } catch {}
    }
  } catch (e) {
    console.error('[gc] error', e);
  }
}
setInterval(gcStaging, 60 * 60 * 1000).unref(); // hourly
gcStaging(); // run once on boot

/* =========================
   Start
   ========================= */
app.listen(PORT, () => {
  console.log(`SQLite-backend kjører på http://localhost:${PORT}`);
});
