import { createChunkUploader } from './upload.js';
import { startRecorder } from './recorder.js';
import { wireFileUploader } from './file-upload.js';

const stopBtn  = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const preview  = document.getElementById('preview');
const sysAudioToggle = document.getElementById('sysAudioToggle');

function setStatus(t = '') { statusEl.textContent = t; }

let rec = null;
let up  = null;
let chunkCount = 0;
let recordingActive = false;

function setStartButtonsDisabled(disabled) {
  document.querySelectorAll('[data-slot]').forEach(btn => (btn.disabled = disabled));
}

async function start(slot) {
  setStartButtonsDisabled(true);
  stopBtn.disabled = true;

  try {
    const token = sessionStorage.getItem('authToken'); // << new key
    if (!token) {
      setStatus('Opptak er låst. Skriv inn kode for å låse opp.');
      setStartButtonsDisabled(false);
      return;
    }

    up = createChunkUploader({ maxPending: 1, slot });
    await up.start();

    chunkCount = 0;
    recordingActive = true;

    rec = await startRecorder({
      wantSystemAudio: !!(sysAudioToggle?.checked),
      timesliceMs: 3000,
      previewEl: preview,
      onStatus: setStatus,
      onChunk: async (blob, mimeType) => {
        if (!recordingActive) return;
        try {
          await up.push(blob, mimeType, {
            onBackpressurePause: () => rec?.pause?.(),
            onBackpressureResume: () => rec?.resume?.()
          });
          chunkCount++;
        } catch (e) {
          console.error('Upload chunk error:', e);
          if (e?.code === 'LOCKED') {
            setStatus('Sesjonen er låst/utløpt (403). Lås opp på nytt og start opptak.');
          } else {
            setStatus(`Feil ved opplasting: ${e.message}`);
          }
          recordingActive = false;
          try { rec?.stop?.(); } catch {}
          cleanup();
        }
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
  recordingActive = false;
  try {
    rec?.flush?.();
    rec?.stop?.();
    await new Promise(r => setTimeout(r, 150));
    const durationMs = rec?.getDurationMs?.() || 0;
    const result = await up?.finalize(durationMs);
    setStatus(`Opplastet! URL: ${result?.url || '(ukjent)'}`);
  } catch (e) {
    console.error(e);
    if (e?.code === 'LOCKED') {
      setStatus('Sesjonen er låst/utløpt (403). Lås opp på nytt og start opptak.');
    } else {
      setStatus(`Feil under stopp: ${e.message}`);
    }
  } finally {
    cleanup();
  }
}

function cleanup() {
  try { rec?.cleanup?.(); } catch {}
  rec = null;
  up  = null;
  chunkCount = 0;
  recordingActive = false;
  setStartButtonsDisabled(false);
  stopBtn.disabled = true;
}

stopBtn.addEventListener('click', stop);

(function initUI() {
  const supported = !!window.MediaRecorder;
  if (!supported) {
    setStatus('MediaRecorder støttes ikke i denne nettleseren.');
    setStartButtonsDisabled(true);
  } else {
    setStartButtonsDisabled(false);
    stopBtn.disabled = true;
  }

  document.querySelectorAll('[data-slot]').forEach(btn => {
    const slot = Number(btn.dataset.slot || '1');
    btn.addEventListener('click', () => start(slot));
  });
})();

// Manual/iOS uploader
wireFileUploader({
  inputEl: document.getElementById('iosFile'),
  buttonEl: document.getElementById('iosUploadBtn'),
  statusEl: document.getElementById('iosStatus'),
  progressBarEl: document.getElementById('iosBar'),
  getUploadId: () => `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  slot: 1
});
