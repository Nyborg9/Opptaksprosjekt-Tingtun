import { createChunkUploader } from './upload.js';
import { startRecorder } from './recorder.js';
import { wireFileUploader } from './file-upload.js';

const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const preview  = document.getElementById('preview');
const sysAudioToggle = document.getElementById('sysAudioToggle');

function setStatus(t=''){ statusEl.textContent = t; }

let rec = null;
let up  = null;

async function start() {
  startBtn.disabled = true; stopBtn.disabled = true;
  try {
    // 1) Uploader
    up = createChunkUploader?.({ maxPending: 2 });
    if (!up || typeof up.start !== 'function') {
      console.error('Uploader missing. createChunkUploader =', createChunkUploader);
      setStatus('Init-feil: uploader mangler (sjekk import/sti).');
      startBtn.disabled = false;
      return;
    }
    await up.start();

    // 2) Recorder
    rec = await startRecorder({
      wantSystemAudio: !!(sysAudioToggle?.checked),
      timesliceMs: 3000,
      previewEl: preview,
      onStatus: setStatus,
      onChunk: async (blob, mimeType) => {
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
    rec?.stop();
    await new Promise(r => setTimeout(r, 50));
    const durationMs = rec?.getDurationMs?.() || 0;
    const result = await up?.finalize(durationMs);
    setStatus(`Opplastet! URL: ${result?.url || '(ukjent)'}`);
  } catch (e) {
    console.error(e);
    setStatus(`Feil under stopp: ${e.message}`);
  } finally {
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

// Wire the manual/iOS uploader
wireFileUploader({
  inputEl: document.getElementById('iosFile'),
  buttonEl: document.getElementById('iosUploadBtn'),
  statusEl: document.getElementById('iosStatus'),
  progressBarEl: document.getElementById('iosBar')
});
