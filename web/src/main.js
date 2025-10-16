import { createChunkUploader } from './upload.js';
import { startRecorder } from './recorder.js';
import { wireFileUploader } from './file-upload.js';

const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const preview  = document.getElementById('preview');
const sysAudioToggle = document.getElementById('sysAudioToggle');

function setStatus(t=''){ statusEl.textContent = t; }

// keep filenames/IDs safe
function sanitizeCode(code) {
  return String(code || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 60);
}

let rec = null;
let up  = null;
let chunkCount = 0;

async function start() {
  startBtn.disabled = true; stopBtn.disabled = true;
  try {
    // require an unlock code (stored by unlock.js)
    const codeRaw = sessionStorage.getItem('unlockToken');
    const code = sanitizeCode(codeRaw);
    if (!code) {
      setStatus('Opptak er låst. Skriv inn kode for å låse opp.');
      startBtn.disabled = false;
      return;
    }

    // stable, readable uploadId => becomes filename stem on server
    const suffix = Math.random().toString(36).slice(2, 6);
    const uploadId = `${code}-${Date.now()}-${suffix}`;

    // 1) Uploader (sequential to preserve order for direct-append backend)
    up = createChunkUploader?.({ maxPending: 1, uploadId });
    if (!up || typeof up.start !== 'function') {
      console.error('Uploader missing. createChunkUploader =', createChunkUploader);
      setStatus('Init-feil: uploader mangler (sjekk import/sti).');
      startBtn.disabled = false;
      return;
    }
    await up.start();

    // 2) Recorder
    chunkCount = 0;
    rec = await startRecorder({
      wantSystemAudio: !!(sysAudioToggle?.checked),
      timesliceMs: 3000,
      previewEl: preview,
      onStatus: setStatus,
      onChunk: async (blob, mimeType) => {
        const idx = chunkCount++;
        await up.push(blob, mimeType, {
          onBackpressurePause: () => rec.pause(),
          onBackpressureResume: () => rec.resume()
        });
      }
    });

    stopBtn.disabled = false;
  } catch (e) {
    console.error(e);
    setStatus(`Feil: ${e.message}`);
    cleanup();
  }
}

async function stop() {
  stopBtn.disabled = true;
  try {
    rec?.flush?.();           // force last partial chunk
    rec?.stop();
    await new Promise(r => setTimeout(r, 150)); // let ondataavailable fire
    const durationMs = rec?.getDurationMs?.() || 0;
    const result = await up?.finalize(durationMs);
    setStatus(`Opplastet! URL: ${result?.url || '(ukjent)'}`);
  } catch (e) {
    console.error(e);
    setStatus(`Feil under stopp: ${e.message}`);
  } finally {
    chunkCount = 0;
    cleanup();
  }
}

function cleanup() {
  try { rec?.cleanup?.(); } catch {}
  rec = null; up = null;
  startBtn.disabled = false;
  stopBtn.disabled  = true;
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);

(function initUI(){
  const supported = !!window.MediaRecorder;
  if (!supported) {
    setStatus('MediaRecorder støttes ikke i denne nettleseren.');
    startBtn.disabled = true;
  } else {
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
})();

// Wire the manual/iOS uploader — also name files using the unlock code if present
wireFileUploader({
  inputEl: document.getElementById('iosFile'),
  buttonEl: document.getElementById('iosUploadBtn'),
  statusEl: document.getElementById('iosStatus'),
  progressBarEl: document.getElementById('iosBar'),
  getUploadId: () => {
    const code = sanitizeCode(sessionStorage.getItem('unlockToken'));
    if (!code) return undefined; // fall back to random id
    const suffix = Math.random().toString(36).slice(2, 6);
    return `${code}-${Date.now()}-${suffix}`;
  }
});
