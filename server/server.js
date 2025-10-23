import express from 'express';
import multer from 'multer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT       = process.env.PORT || 3001;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

setInterval(() => {
  const now = Date.now();
  for (const [tok, sess] of activeTokens.entries()) {
    if (now - sess.issuedAt > 30 * 60 * 1000) activeTokens.delete(tok);
  }
}, 10 * 60 * 1000);

function requireUnlock(req, res, next) {
  const headerTok = req.headers['x-unlock-token'];
  const queryTok  = req.query.token;
  const tok = headerTok || queryTok;
  const sess = tok && activeTokens.get(tok);
  if (!sess) return res.status(403).json({ ok: false, error: 'Locked' });
  req.userLabel = sess.userLabel;
  next();
}

app.post('/api/unlock', (req, res) => {
  const { code } = req.body || {};
  const userLabel = CODE_TO_USER.get(String(code || '').trim());
  if (!userLabel) return res.status(401).json({ ok: false, error: 'Invalid code' });
  const token = createToken(userLabel);
  res.json({ ok: true, token });
});

app.get('/api/whoami', (req, res) => {
  const tok = req.headers['x-unlock-token'] || req.query.token;
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

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `${id}${ext}`);
  }
});
const uploadSingle = multer({ storage: diskStorage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
app.post('/upload', requireUnlock, uploadSingle.single('file'), (req, res) => {
  try {
    const url = `/uploads/${req.file.filename}`;
    res.json({ id: path.parse(req.file.filename).name, url });
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
      sess = { stream, filepath, ext, nextIndex: 0, userLabel: req.userLabel, slot };
      inFlight.set(uploadId, sess);
    }
    if (slot !== sess.slot) return res.status(409).json({ error: 'slot mismatch for this uploadId' });
    if (idx !== sess.nextIndex) return res.status(409).json({ error: 'out-of-order', expected: sess.nextIndex });

    await new Promise((resolve, reject) => {
      sess.stream.write(req.file.buffer, err => (err ? reject(err) : resolve()));
    });
    sess.nextIndex += 1;
    res.json({ ok: true, nextIndex: sess.nextIndex });
  } catch (e) {
    console.error('[chunk] error', e);
    res.status(500).json({ error: 'chunk store failed' });
  }
});

app.post('/upload/finish', requireUnlock, memUpload.none(), async (req, res) => {
  try {
    const uploadId   = req.body?.uploadId;
    const slot       = Number(req.body?.slot || 0);
    if (!uploadId) return res.status(400).json({ error: 'uploadId required' });
    if (![1,2,3].includes(slot)) return res.status(400).json({ error: 'slot must be 1, 2, or 3' });

    const sess = inFlight.get(uploadId);
    if (!sess) {
      for (const ext of ['.webm','.mp4','.mov']) {
        const fp = path.join(UPLOAD_DIR, `${uploadId}${ext}`);
        if (fs.existsSync(fp)) {
          const finalName = `${(req.userLabel||'User')}Recording${slot}-${timestamp()}${ext}`;
          const finalPath = path.join(UPLOAD_DIR, finalName);
          await fsp.rename(fp, finalPath);
          return res.json({ id: uploadId, url: `/uploads/${finalName}` });
        }
      }
      return res.status(404).json({ error: 'unknown uploadId' });
    }

    await new Promise((resolve, reject) => sess.stream.end(err => (err ? reject(err) : resolve())));
    const finalName = `${sess.userLabel || 'User'}Recording${slot}-${timestamp()}${sess.ext}`;
    const finalPath = path.join(UPLOAD_DIR, finalName);
    await fsp.rename(sess.filepath, finalPath);
    inFlight.delete(uploadId);

    res.json({ id: uploadId, url: `/uploads/${finalName}` });
  } catch (e) {
    console.error('[finish] finalize error', e);
    res.status(500).json({ error: 'finalize failed' });
  }
});
app.get('/recordings', requireUnlock, async (_req, res) => {
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
