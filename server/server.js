import express from 'express';
import multer from 'multer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import Database from 'better-sqlite3';
import crypto from 'crypto';

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

app.use(cors({
  origin: ['http://localhost:8080'],
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-unlock-token'],
  maxAge: 86400
}));
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

/* ===== SECURE UNLOCK ===== */
const CODE_TO_USER = new Map([
  [(process.env.UNLOCK_CODE_1 || 'test1'), 'User1'],
  [(process.env.UNLOCK_CODE_2 || 'test2'), 'User2'],
  [(process.env.UNLOCK_CODE_3 || 'test3'), 'User3'],
]);

// token -> { userLabel, issuedAt }
const activeTokens = new Map();

function createToken(userLabel) {
  const token = crypto.randomBytes(24).toString('hex');
  activeTokens.set(token, { userLabel, issuedAt: Date.now() });
  return token;
}

function requireUnlock(req, res, next) {
  const headerTok = req.headers['x-unlock-token'];
  const queryTok  = req.query.token;
  const tok = headerTok || queryTok;
  const sess = tok && activeTokens.get(tok);

  // DEBUG LOG — super useful while we fix this
  console.log('[requireUnlock]', req.method, req.path,
              'headerTok?', !!headerTok, 'queryTok?', !!queryTok, 'known?', !!sess);

  if (!sess) return res.status(403).json({ ok: false, error: 'Locked' });
  req.userLabel = sess.userLabel;
  next();
}

app.post('/api/unlock', (req, res) => {
  const { code } = req.body || {};
  const userLabel = CODE_TO_USER.get(String(code || '').trim());
  if (!userLabel) return res.status(401).json({ ok: false, error: 'Invalid code' });
  const token = createToken(userLabel);
  return res.json({ ok: true, token });
});

// Token checker — no auth required so you can test easily
app.get('/api/whoami', (req, res) => {
  const tok = req.headers['x-unlock-token'] || req.query.token;
  const sess = tok && activeTokens.get(tok);
  res.json({ ok: !!sess, tokenSeen: !!tok, userLabel: sess?.userLabel || null });
});

/* ===== UPLOADS ===== */
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

app.post('/upload', requireUnlock, uploadSingle.single('file'), (req, res) => {
  try {
    const id = path.parse(req.file.filename).name;
    const url = `/uploads/${req.file.filename}`;
    const mimeType = req.body.mimeType || req.file.mimetype || 'video/webm';
    const durationMs = Number(req.body.durationMs || 0);

    db.prepare(`
      INSERT INTO recordings(id, owner_id, url, mime_type, bytes, duration_ms)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(id, getOwnerId(req), url, mimeType, req.file.size, durationMs);

    res.json({ id, url });
  } catch (e) {
    console.error('[single-upload] error', e);
    res.status(500).json({ error: 'store failed' });
  }
});

const memUpload = multer({ storage: multer.memoryStorage() });
const inFlight = new Map();

app.post('/upload/chunk', requireUnlock, memUpload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, mimeType } = req.body || {};
    const idx = Number.isFinite(+req.body?.index) ? Number(req.body.index) : null;
    const slot = Number(req.body?.slot || 0);

    if (!uploadId || !req.file || idx === null || idx < 0) {
      return res.status(400).json({ error: 'bad request (need uploadId, chunk, numeric index)' });
    }
    if (![1,2,3].includes(slot)) {
      return res.status(400).json({ error: 'slot must be 1, 2, or 3' });
    }

    let sess = inFlight.get(uploadId);
    if (!sess) {
      const ownerId = getOwnerId(req);
      const ext = safeExt(mimeType);
      const tmpFilename = `${uploadId}${ext}`;
      const filepath = path.join(UPLOAD_DIR, tmpFilename);
      const stream = fs.createWriteStream(filepath, { flags: 'a' });

      sess = {
        stream,
        filepath,
        tmpFilename,
        ownerId,
        mimeType: mimeType || 'video/webm',
        ext,
        bytes: 0,
        nextIndex: 0,
        userLabel: req.userLabel,
        slot
      };
      inFlight.set(uploadId, sess);
      console.log('[chunk:init]', uploadId, 'user=', sess.userLabel, 'slot=', slot);
    }

    if (slot !== sess.slot) return res.status(409).json({ error: 'slot mismatch for this uploadId' });
    if (idx !== sess.nextIndex) return res.status(409).json({ error: 'out-of-order', expected: sess.nextIndex });

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

app.post('/upload/finish', requireUnlock, memUpload.none(), async (req, res) => {
  const uploadId   = req.body?.uploadId;
  const durationMs = Number(req.body?.durationMs || 0);
  const slot       = Number(req.body?.slot || 0);
  if (!uploadId) return res.status(400).json({ error: 'uploadId required' });
  if (![1,2,3].includes(slot)) return res.status(400).json({ error: 'slot must be 1, 2, or 3' });

  const sess = inFlight.get(uploadId);
  const stamp = new Date().toISOString().replace(/[-:]/g,'').replace(/\..+/, '').replace('T','-');
  const userLabel = (sess?.userLabel) || 'User';
  const recName   = `${userLabel}Recording${slot}-${stamp}`;
  const ext       = sess?.ext || '.webm';
  const finalFilename = `${recName}${ext}`;
  const finalPath = path.join(UPLOAD_DIR, finalFilename);
  const finalUrl  = `/uploads/${finalFilename}`;

  try {
    if (!sess) {
      const possible = ['.webm','.mp4','.mov'].map(ext => path.join(UPLOAD_DIR, `${uploadId}${ext}`));
      for (const fp of possible) {
        if (fs.existsSync(fp)) {
          await fsp.rename(fp, finalPath);
          const st = await fsp.stat(finalPath);
          db.prepare(`
            INSERT INTO recordings(id, owner_id, url, mime_type, bytes, duration_ms)
            VALUES(?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE
            SET url=excluded.url, mime_type=excluded.mime_type, bytes=excluded.bytes, duration_ms=excluded.duration_ms
          `).run(uploadId, getOwnerId(req), finalUrl, 'video/webm', st.size, durationMs);
          return res.json({ id: uploadId, url: finalUrl });
        }
      }
      return res.status(404).json({ error: 'unknown uploadId' });
    }

    await new Promise((resolve, reject) => {
      sess.stream.end(err => err ? reject(err) : resolve());
    });

    await fsp.rename(sess.filepath, finalPath);
    const st = await fsp.stat(finalPath);

    db.prepare(`
      INSERT INTO recordings(id, owner_id, url, mime_type, bytes, duration_ms)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE
      SET url=excluded.url, mime_type=excluded.mime_type, bytes=excluded.bytes, duration_ms=excluded.duration_ms
    `).run(uploadId, sess.ownerId, finalUrl, sess.mimeType, st.size, durationMs);

    inFlight.delete(uploadId);
    return res.json({ id: uploadId, url: finalUrl });
  } catch (e) {
    console.error('[finish] finalize error', e);
    return res.status(500).json({ error: 'finalize failed' });
  }
});

app.get('/recordings', requireUnlock, (req, res) => {
  const rows = db.prepare(`
    SELECT id, url, mime_type AS mimeType, bytes, duration_ms AS durationMs, created_at AS createdAt
    FROM recordings
    WHERE owner_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 50
  `).all(getOwnerId(req));
  res.json({ items: rows });
});

app.listen(PORT, () => {
  console.log(`SQLite-backend kjører på http://localhost:${PORT}`);
});
