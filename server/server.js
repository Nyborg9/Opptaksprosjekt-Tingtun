// server.js
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT       = process.env.PORT || 3001;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS || 30 * 60 * 1000); // 30m
const UPLOAD_CHUNK_LIMIT_BYTES = Number(process.env.UPLOAD_CHUNK_LIMIT_BYTES || 8 * 1024 * 1024); // 8MB
const PER_UPLOAD_MAX_BYTES = Number(process.env.PER_UPLOAD_MAX_BYTES || 3 * 1024 * 1024 * 1024); // 3GB
const INFLIGHT_TTL_MS = Number(process.env.INFLIGHT_TTL_MS || 30 * 60 * 1000); // 30m

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();

// Security headers
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));

app.use(express.json());

// Serve uploads safely (discourage inline execution)
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const basename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${basename}"`);
  }
}));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const CODE_TO_USER = new Map([
  [(process.env.UNLOCK_CODE_1 || 'test1'), 'User1'],
  [(process.env.UNLOCK_CODE_2 || 'test2'), 'User2'],
  [(process.env.UNLOCK_CODE_3 || 'test3'), 'User3'],
]);

const activeTokens = new Map(); // token -> { userLabel, issuedAt }
function createToken(userLabel) {
  const token = crypto.randomBytes(24).toString('hex');
  activeTokens.set(token, { userLabel, issuedAt: Date.now() });
  return token;
}

// Slide/expire tokens
setInterval(() => {
  const cutoff = Date.now() - TOKEN_TTL_MS;
  for (const [tok, sess] of activeTokens.entries()) {
    if (sess.issuedAt < cutoff) activeTokens.delete(tok);
  }
}, 10 * 60 * 1000);

function requireUnlock(req, res, next) {
  const tok = req.headers['x-unlock-token'];
  const sess = tok && activeTokens.get(tok);
  if (!sess) return res.status(403).json({ ok: false, error: 'Locked' });
  // sliding expiration
  sess.issuedAt = Date.now();
  req.userLabel = sess.userLabel;
  req.token = tok;
  next();
}

// Brute-force protection on unlock
const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false
});

app.post('/api/unlock', unlockLimiter, (req, res) => {
  const { code } = req.body || {};
  const userLabel = CODE_TO_USER.get(String(code || '').trim());
  if (!userLabel) return res.status(401).json({ ok: false, error: 'Invalid code' });
  const token = createToken(userLabel);
  res.json({ ok: true, token });
});

app.get('/api/whoami', (req, res) => {
  const tok = req.headers['x-unlock-token'];
  const sess = tok && activeTokens.get(tok);
  res.json({ ok: !!sess, tokenSeen: !!tok, userLabel: sess?.userLabel || null });
});

function safeExt(mime) {
  if (!mime) return '.webm';
  const m = String(mime).toLowerCase();
  if (m.includes('webm')) return '.webm';
  if (m.includes('mp4'))  return '.mp4';
  if (m.includes('quicktime')) return '.mov';
  return '.webm';
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g,'').replace(/\..+/, '').replace('T','-'); // YYYYMMDD-HHMMSS
}

// Single-file upload (whitelist MIME, force safe ext)
const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const id = uuidv4();
    const ext = safeExt(file.mimetype);
    cb(null, `${id}${ext}`);
  }
});
const uploadSingle = multer({
  storage: diskStorage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['video/webm', 'video/mp4', 'video/quicktime'].includes(file.mimetype);
    cb(ok ? null : new Error('Unsupported media type'));
  }
});
app.post('/api/upload', requireUnlock, uploadSingle.single('file'), (req, res) => {
  try {
    const url = `/uploads/${req.file.filename}`;
    res.json({ id: path.parse(req.file.filename).name, url });
  } catch (e) {
    console.error('[single-upload] error', e);
    res.status(500).json({ error: 'store failed' });
  }
});

// Chunked upload (owner binding + limits)
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: UPLOAD_CHUNK_LIMIT_BYTES,
    files: 1
  }
});

// uploadId -> session state
const inFlight = new Map();

app.post('/api/upload/chunk', requireUnlock, memUpload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, mimeType } = req.body || {};
    const idx  = Number.isFinite(+req.body?.index) ? Number(req.body.index) : null;
    const slot = Number(req.body?.slot || 0);
    if (!uploadId || !req.file || idx === null || idx < 0) {
      return res.status(400).json({ error: 'bad request (need uploadId, chunk, numeric index)' });
    }
    if (![1,2,3].includes(slot)) return res.status(400).json({ error: 'slot must be 1, 2, or 3' });

    let sess = inFlight.get(uploadId);
    if (!sess) {
      const ext = safeExt(mimeType);
      const tmpFilename = `${uploadId}${ext}`;
      const filepath = path.join(UPLOAD_DIR, tmpFilename);
      const stream = fs.createWriteStream(filepath, { flags: 'a' });

      // Create owner sidecar for crash/restart survival
      const ownerTag = path.join(UPLOAD_DIR, `${uploadId}.owner`);
      try { await fsp.writeFile(ownerTag, req.token, { flag: 'wx' }); } catch { /* exists ok */ }

      sess = {
        stream, filepath, ext,
        nextIndex: 0,
        userLabel: req.userLabel,
        ownerTok: req.token,
        slot,
        lastTouched: Date.now(),
        bytes: 0
      };
      inFlight.set(uploadId, sess);
    }

    if (slot !== sess.slot) return res.status(409).json({ error: 'slot mismatch for this uploadId' });
    if (idx !== sess.nextIndex) return res.status(409).json({ error: 'out-of-order', expected: sess.nextIndex });
    if (sess.ownerTok !== req.token) return res.status(403).json({ error: 'not owner of uploadId' });
    if (sess.bytes + req.file.size > PER_UPLOAD_MAX_BYTES) {
      return res.status(413).json({ error: 'upload exceeds max size' });
    }

    await new Promise((resolve, reject) => {
      sess.stream.write(req.file.buffer, err => (err ? reject(err) : resolve()));
    });
    sess.nextIndex += 1;
    sess.bytes += req.file.size;
    sess.lastTouched = Date.now();
    res.json({ ok: true, nextIndex: sess.nextIndex });
  } catch (e) {
    console.error('[chunk] error', e);
    res.status(500).json({ error: 'chunk store failed' });
  }
});

app.post('/api/upload/finish', requireUnlock, memUpload.none(), async (req, res) => {
  try {
    const uploadId   = req.body?.uploadId;
    const slot       = Number(req.body?.slot || 0);
    if (!uploadId) return res.status(400).json({ error: 'uploadId required' });
    if (![1,2,3].includes(slot)) return res.status(400).json({ error: 'slot must be 1, 2, or 3' });

    const sess = inFlight.get(uploadId);
    if (!sess) {
      // Fallback path after restart: verify owner via .owner file
      const ownerTag = path.join(UPLOAD_DIR, `${uploadId}.owner`);
      if (!fs.existsSync(ownerTag)) return res.status(404).json({ error: 'unknown uploadId' });
      const ownerTok = (await fsp.readFile(ownerTag, 'utf8')).trim();
      if (ownerTok !== req.token) return res.status(403).json({ error: 'not owner of uploadId' });

      for (const ext of ['.webm','.mp4','.mov']) {
        const fp = path.join(UPLOAD_DIR, `${uploadId}${ext}`);
        if (fs.existsSync(fp)) {
          const finalName = `${(req.userLabel||'User')}Recording${slot}-${timestamp()}${ext}`;
          const finalPath = path.join(UPLOAD_DIR, finalName);
          await fsp.rename(fp, finalPath);
          await fsp.unlink(ownerTag).catch(()=>{});
          return res.json({ id: uploadId, url: `/uploads/${finalName}` });
        }
      }
      return res.status(404).json({ error: 'unknown uploadId' });
    }

    if (sess.ownerTok !== req.token) return res.status(403).json({ error: 'not owner of uploadId' });
    await new Promise((resolve, reject) => sess.stream.end(err => (err ? reject(err) : resolve())));
    const finalName = `${sess.userLabel || 'User'}Recording${slot}-${timestamp()}${sess.ext}`;
    const finalPath = path.join(UPLOAD_DIR, finalName);
    await fsp.rename(sess.filepath, finalPath);
    inFlight.delete(uploadId);
    await fsp.unlink(path.join(UPLOAD_DIR, `${uploadId}.owner`)).catch(()=>{});

    res.json({ id: uploadId, url: `/uploads/${finalName}` });
  } catch (e) {
    console.error('[finish] finalize error', e);
    res.status(500).json({ error: 'finalize failed' });
  }
});

app.get('/api/recordings', requireUnlock, async (_req, res) => {
  try {
    const files = await fsp.readdir(UPLOAD_DIR);
    const items = await Promise.all(files.map(async name => {
      const fp = path.join(UPLOAD_DIR, name);
      const st = await fsp.stat(fp);
      return { name, url: `/uploads/${name}`, bytes: st.size, mtime: st.mtimeMs };
    }));
    items.sort((a,b) => b.mtime - a.mtime);
    res.json({ items });
  } catch (e) {
    console.error('[recordings] list error', e);
    res.status(500).json({ error: 'list failed' });
  }
});

setInterval(async () => {
  const now = Date.now();
  for (const [id, s] of inFlight) {
    if (now - (s.lastTouched || 0) > INFLIGHT_TTL_MS) {
      try { s.stream.end(); } catch {}
      try { await fsp.unlink(s.filepath).catch(()=>{}); } catch {}
      inFlight.delete(id);
      await fsp.unlink(path.join(UPLOAD_DIR, `${id}.owner`)).catch(()=>{});
      console.warn('[sweeper] removed stale upload', id);
    }
  }
  for (const name of await fsp.readdir(UPLOAD_DIR)) {
    if (!name.endsWith('.owner')) continue;
    const fp = path.join(UPLOAD_DIR, name);
    const st = await fsp.stat(fp);
    if (now - st.mtimeMs > INFLIGHT_TTL_MS) {
      await fsp.unlink(fp).catch(()=>{});
    }
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
