// Backend-API for skjermopptaksløsningen.
// Håndterer:
//  - Låsekode -> token-basert tilgang
//  - Enkeltopplasting av videofiler
//  - Chunket opplasting (store opptak i biter)
//  - Navngiving og lagring av filer per “Oppgave/slot” (1–6)
//  - Opprydding av gamle tokens og halvferdige opplastinger

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

// Litt ESM-hjelp for å få "nåværende mappe"
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Konfigurasjon
const PORT       = process.env.PORT || 3001;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

// Hvor lenge et unlock-token er gyldig 2 timer
const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS || 120 * 60 * 1000);

// Maks størrelse per chunk (standard: 8 MB)
const UPLOAD_CHUNK_LIMIT_BYTES = Number(
  process.env.UPLOAD_CHUNK_LIMIT_BYTES || 8 * 1024 * 1024
);

// Maks total størrelse per opplasting (standard: 3 GB)
const PER_UPLOAD_MAX_BYTES = Number(
  process.env.PER_UPLOAD_MAX_BYTES || 3 * 1024 * 1024 * 1024
);

// Hvor lenge en halvferdig opplasting kan ligge før den ryddes vekk 2 timer
const INFLIGHT_TTL_MS = Number(
  process.env.INFLIGHT_TTL_MS || 120 * 60 * 1000
);

// Sørg for at opplastingsmappen finnes
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const app = express();

// Sikkerhets-headere
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));

// JSON-body parsing for unlock-endepunkter.
app.use(express.json());

// Enkle health-checks (brukes av Docker/Compose og manuell testing)
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Hent koder KUN fra miljøvariabler  
const UNLOCK_CODE_1 = process.env.UNLOCK_CODE_1;
const UNLOCK_CODE_2 = process.env.UNLOCK_CODE_2;
const UNLOCK_CODE_3 = process.env.UNLOCK_CODE_3;
const UNLOCK_CODE_4 = process.env.UNLOCK_CODE_4;
const UNLOCK_CODE_5 = process.env.UNLOCK_CODE_5;
const UNLOCK_CODE_6 = process.env.UNLOCK_CODE_6;
const UNLOCK_CODE_7 = process.env.UNLOCK_CODE_7;

// Valider at alle er satt – feiler hardt hvis noe mangler
if (!UNLOCK_CODE_1 || !UNLOCK_CODE_2 || !UNLOCK_CODE_3 || !UNLOCK_CODE_4 || !UNLOCK_CODE_5 || !UNLOCK_CODE_6 || !UNLOCK_CODE_7) {
  console.error('Mangler en eller flere UNLOCK_CODE_X miljøvariabler.');
  process.exit(1); // Stopp serveren, så du ikke kjører med udefinerte koder.
}

// Kun verdier fra env, ingen hardkodede koder
const CODE_TO_USER = new Map([
  [UNLOCK_CODE_1, 'Tester1'],
  [UNLOCK_CODE_2, 'Tester2'],
  [UNLOCK_CODE_3, 'Tester3'],
  [UNLOCK_CODE_4, 'Tester4'],
  [UNLOCK_CODE_5, 'Tester5'],
  [UNLOCK_CODE_6, 'Tester6'],
  [UNLOCK_CODE_7, 'Tester7'],
]);


// Lagrer token i minnet
const activeTokens = new Map();

/**
 * Oppretter et nytt token for en gitt bruker-etikett (f.eks. "Tester1").
 * Token lagres i minnet sammen med tidspunktet det ble utsendt.
 */
function createToken(userLabel) {
  const token = crypto.randomBytes(24).toString('hex');
  activeTokens.set(token, { userLabel, issuedAt: Date.now() });
  return token;
}

// Rydder bort utløpte tokens jevnlig
setInterval(() => {
  const cutoff = Date.now() - TOKEN_TTL_MS;
  for (const [tok, sess] of activeTokens.entries()) {
    if (sess.issuedAt < cutoff) activeTokens.delete(tok);
  }
}, 10 * 60 * 1000); // hver 10. minutt

/**
 * Middleware som krever at klienten sender et gyldig X-unlock-token.
 * Brukes på alle opplastingsendepunkter.
 */
function requireUnlock(req, res, next) {
  const tok = req.headers['x-unlock-token'];
  const sess = tok && activeTokens.get(tok);
  if (!sess) {
    return res.status(403).json({ ok: false, error: 'Locked' });
  }

  // Om en token fortsatt er i bruk, så forlenges den
  sess.issuedAt = Date.now();
  req.userLabel = sess.userLabel;
  req.token = tok;
  next();
}

// Brute force-beskyttelse på /api/unlock (maks 5 forsøk per 15 minutt per IP)
const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * POST /api/unlock
 * Tar imot en kode, sjekker den opp mot CODE_TO_USER og returnerer et token hvis koden stemmer.
 */
app.post('/api/unlock', unlockLimiter, (req, res) => {
  const { code } = req.body || {};
  const userLabel = CODE_TO_USER.get(String(code || '').trim());
  if (!userLabel) {
    return res.status(401).json({ ok: false, error: 'Invalid code' });
  }
  const token = createToken(userLabel);
  res.json({ ok: true, token });
});

/**
 * GET /api/whoami
 * Brukes av frontend for å sjekke om et token fortsatt er gyldig.
 */
app.get('/api/whoami', (req, res) => {
  const tok = req.headers['x-unlock-token'];
  const sess = tok && activeTokens.get(tok);
  res.json({
    ok: !!sess,
    tokenSeen: !!tok,
    userLabel: sess?.userLabel || null
  });
});

/**
 * Oversetter mimetype -> trygg filendelse.
 * Forsøker å tvinge alle opplastinger til .webm / .mp4 / .mov.
 */
function safeExt(mime) {
  if (!mime) return '.webm';
  const m = String(mime).toLowerCase();
  if (m.includes('webm'))      return '.webm';
  if (m.includes('mp4'))       return '.mp4';
  if (m.includes('quicktime')) return '.mov';
  return '.webm';
}

/**
 * Genererer tidsstempel til filnavn: YYYYMMDD-HHMMSS
 */
function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '-'); // YYYYMMDD-HHMMSS
}

// Lagre filer direkte til disk med et tilfeldig UUID-basert navn
const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const id = uuidv4();
    const ext = safeExt(file.mimetype);
    cb(null, `${id}${ext}`);
  }
});

// Multer-oppsett for single upload med 3GB-grense og whitelist på video-MIME
const uploadSingle = multer({
  storage: diskStorage,
  limits: { fileSize: 3 * 1024 * 1024 * 1024 }, // 3 GB
  fileFilter: (_req, file, cb) => {
    const ok = ['video/webm', 'video/mp4', 'video/quicktime'].includes(file.mimetype);
    cb(ok ? null : new Error('Unsupported media type'));
  }
});

/**
 * POST /api/upload
 * Vanlig single-file upload.
 * Krever gyldig token (requireUnlock).
 */
app.post('/api/upload', requireUnlock, uploadSingle.single('file'), (req, res) => {
  try {
    const fileName = req.file.filename;
    res.json({
      ok: true,
      id: path.parse(fileName).name,
      fileName,
      path: `/uploads/${fileName}`
    });
  } catch (e) {
    console.error('[single-upload] error', e);
    res.status(500).json({ error: 'store failed' });
  }
});

//Chunking av direkte opptak:

// Multer-oppsett som holder hver chunk i minne (buffer)
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: UPLOAD_CHUNK_LIMIT_BYTES, // maks per chunk
    files: 1
  }
});

// inFlight: uploadId -> pågående opplasting
const inFlight = new Map();

/**
 * POST /api/upload/chunk
 * Tar imot én chunk av en større fil.
 * Sikrer:
 *  - at slot er mellom 1 og 6
 *  - at chunk-rekkefølgen stemmer (index)
 *  - at riktig token eier uploadId
 *  - at vi ikke går over maks totalstørrelse
 */
app.post('/api/upload/chunk', requireUnlock, memUpload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, mimeType } = req.body || {};
    const idx  = Number.isFinite(+req.body?.index) ? Number(req.body.index) : null;
    const slot = Number(req.body?.slot || 0);

    // Grunnleggende validering
    if (!uploadId || !req.file || idx === null || idx < 0) {
      return res.status(400).json({
        error: 'bad request (need uploadId, chunk, numeric index)'
      });
    }

    // Slot må være 1–6 slik frontend/server har avtalt
    if (!Number.isInteger(slot) || slot < 1 || slot > 6) {
      return res.status(400).json({ error: 'slot must be between 1 and 6' });
    }

    // Slå opp eller opprett ny "session" for denne uploadId-en
    let sess = inFlight.get(uploadId);
    if (!sess) {
      const ext = safeExt(mimeType);
      const tmpFilename = `${uploadId}${ext}`;
      const filepath = path.join(UPLOAD_DIR, tmpFilename);
      const stream = fs.createWriteStream(filepath, { flags: 'a' });

      // Egen .owner-fil så vi kan gjenkjenne eier etter en eventuell restart
      const ownerTag = path.join(UPLOAD_DIR, `${uploadId}.owner`);
      try {
        await fsp.writeFile(ownerTag, req.token, { flag: 'wx' });
      } catch {
      }

      sess = {
        stream,
        filepath,
        ext,
        nextIndex: 0,        // neste forventede chunk-indeks
        userLabel: req.userLabel,
        ownerTok: req.token, // hvem eier denne uploadId-en
        slot,
        lastTouched: Date.now(),
        bytes: 0
      };
      inFlight.set(uploadId, sess);
    }

    // Sikre at ny chunk passer til eksisterende session
    if (slot !== sess.slot) {
      return res.status(409).json({ error: 'slot mismatch for this uploadId' });
    }
    if (idx !== sess.nextIndex) {
      return res.status(409).json({
        error: 'out-of-order',
        expected: sess.nextIndex
      });
    }
    if (sess.ownerTok !== req.token) {
      return res.status(403).json({ error: 'not owner of uploadId' });
    }
    if (sess.bytes + req.file.size > PER_UPLOAD_MAX_BYTES) {
      return res.status(413).json({ error: 'upload exceeds max size' });
    }

    // Skriv chunk til filen
    await new Promise((resolve, reject) => {
      sess.stream.write(req.file.buffer, err => (err ? reject(err) : resolve()));
    });

    // Oppdater session-tilstand
    sess.nextIndex += 1;
    sess.bytes += req.file.size;
    sess.lastTouched = Date.now();

    res.json({ ok: true, nextIndex: sess.nextIndex });
  } catch (e) {
    console.error('[chunk] error', e);
    res.status(500).json({ error: 'chunk store failed' });
  }
});

/**
 * POST /api/upload/finish
 * Kalles når frontend er ferdig med alle chunkene og vil "lukke" opptaket.
 * Gir filen et endelig navn basert på bruker-etikett, slot og timestamp.
 */
app.post('/api/upload/finish', requireUnlock, memUpload.none(), async (req, res) => {
  try {
    const uploadId = req.body?.uploadId;
    const slot     = Number(req.body?.slot || 0);

    if (!uploadId) {
      return res.status(400).json({ error: 'uploadId required' });
    }
    if (!Number.isInteger(slot) || slot < 1 || slot > 6) {
      return res.status(400).json({ error: 'slot must be between 1 and 6' });
    }

    const sess = inFlight.get(uploadId);

    // Hvis vi ikke finner session i minnet (f.eks. etter server-restart),
    // forsøker vi "fallback" via .owner-fil og eksisterende fil på disk.
    if (!sess) {
      const ownerTag = path.join(UPLOAD_DIR, `${uploadId}.owner`);
      if (!fs.existsSync(ownerTag)) {
        return res.status(404).json({ error: 'unknown uploadId' });
      }

      const ownerTok = (await fsp.readFile(ownerTag, 'utf8')).trim();
      if (ownerTok !== req.token) {
        return res.status(403).json({ error: 'not owner of uploadId' });
      }

      // Let etter en fil med passende endelse
      for (const ext of ['.webm', '.mp4', '.mov']) {
        const fp = path.join(UPLOAD_DIR, `${uploadId}${ext}`);
        if (fs.existsSync(fp)) {
          const finalName =
            `${(req.userLabel || 'User')}Oppgave${slot}-${timestamp()}${ext}`;
          const finalPath = path.join(UPLOAD_DIR, finalName);

          await fsp.rename(fp, finalPath);
          await fsp.unlink(ownerTag).catch(() => {});

          return res.json({
            id: uploadId,
            fileName: finalName,
            path: `/uploads/${finalName}`
          });
        }
      }
      return res.status(404).json({ error: 'unknown uploadId' });
    }

    // Normal vei (session finnes i minnet]
    if (sess.ownerTok !== req.token) {
      return res.status(403).json({ error: 'not owner of uploadId' });
    }

    await new Promise((resolve, reject) =>
      sess.stream.end(err => (err ? reject(err) : resolve()))
    );

    // Gi filen endelig navn
    const finalName =
      `${sess.userLabel || 'User'}Oppgave${slot}-${timestamp()}${sess.ext}`;
    const finalPath = path.join(UPLOAD_DIR, finalName);

    await fsp.rename(sess.filepath, finalPath);
    inFlight.delete(uploadId);
    await fsp.unlink(path.join(UPLOAD_DIR, `${uploadId}.owner`)).catch(() => {});

    res.json({ id: uploadId, url: `/uploads/${finalName}` });
  } catch (e) {
    console.error('[finish] finalize error', e);
    res.status(500).json({ error: 'finalize failed' });
  }
});

/**
 * Periodisk opprydding:
 *  - Fjerner gamle inFlight-opplastinger som har stått stille for lenge
 *  - Fjerner .owner-filer som er gamle
 */
setInterval(async () => {
  const now = Date.now();

  // Rydd bort gamle inFlight-sessions
  for (const [id, s] of inFlight) {
    if (now - (s.lastTouched || 0) > INFLIGHT_TTL_MS) {
      try { s.stream.end(); } catch {}
      try { await fsp.unlink(s.filepath).catch(() => {}); } catch {}
      inFlight.delete(id);
      await fsp.unlink(path.join(UPLOAD_DIR, `${id}.owner`)).catch(() => {});
      console.warn('[sweeper] removed stale upload', id);
    }
  }

  // Rydd bort gamle .owner-filer som ikke har tilhørende inFlight
  for (const name of await fsp.readdir(UPLOAD_DIR)) {
    if (!name.endsWith('.owner')) continue;
    const fp = path.join(UPLOAD_DIR, name);
    const st = await fsp.stat(fp);
    if (now - st.mtimeMs > INFLIGHT_TTL_MS) {
      await fsp.unlink(fp).catch(() => {});
    }
  }
}, 5 * 60 * 1000); // hver 5. minutt

// Start serveren
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
