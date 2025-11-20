import { createChunkUploader } from './upload.js';
import { startRecorder } from './recorder.js';
import { wireFileUploader } from './file-upload.js';

// Pekere til sentrale elementer
const stopBtn        = document.getElementById('stopBtn');
const statusEl       = document.getElementById('status');
const preview        = document.getElementById('preview');
const sysAudioToggle = document.getElementById('sysAudioToggle');

// Enkel helper for å vise statusmeldinger til brukeren
function setStatus(t = '') {
  if (statusEl) statusEl.textContent = t;
}

// Tilstand for aktivt opptak
let rec = null;               // objektet fra startRecorder
let up  = null;               // chunk-uploaderen mot serveren
let recordingActive = false;  // om vi for øyeblikket tar opp

// Slår av/på alle “Start opptak” knappene
function setStartButtonsDisabled(disabled) {
  document.querySelectorAll('[data-slot]').forEach(btn => {
    btn.disabled = disabled;
  });
}

/**
 * Starter et skjermopptak for gitt slot (1–6).
 * Slot-nummeret avgjør hvilket “Opptak X” filen havner som på serveren.
 */
async function start(slot) {
  // Deaktiver start-knapper mens vi setter opp
  setStartButtonsDisabled(true);
  if (stopBtn) stopBtn.disabled = true;

  try {
    // Sjekk om brukeren har låst opp (token i sessionStorage)
    const token =
      sessionStorage.getItem('authToken') ||
      sessionStorage.getItem('unlockToken');

    if (!token) {
      setStatus('Opptak er låst. Skriv inn kode for å låse opp.');
      setStartButtonsDisabled(false);
      return;
    }

    // Lag uploader for denne sloten (1–6). maxPending=1 for enkel køhåndtering
    up = createChunkUploader({ maxPending: 1, slot });
    await up.start();

    recordingActive = true;

    // Start skjerm + lyd-opptak
    rec = await startRecorder({
      wantSystemAudio: !!(sysAudioToggle?.checked), // ta opp systemlyd hvis avkrysset
      timesliceMs: 3000,                            // ny chunk ca. hver 3. sekund
      previewEl: preview,                           // <video> der brukeren ser opptaket
      onStatus: setStatus,                          // vis statusmeldinger
      onChunk: async (blob, mimeType) => {          // får hver chunk fra opptakeren
        if (!recordingActive) return;
        try {
          await up.push(blob, mimeType, {
            // Hvis opplasting henger, kan vi pause opptaker midlertidig
            onBackpressurePause: () => rec?.pause?.(),
            onBackpressureResume: () => rec?.resume?.()
          });
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

    // Nå kan brukeren stoppe opptaket
    if (stopBtn) stopBtn.disabled = false;
  } catch (e) {
    console.error(e);
    setStatus(`Feil ved start av opptak: ${e.message}`);
    cleanup();
  }
}

//Stopp-knappen: avslutter opptaket og fullfører opplasting til server.

async function stop() {
  if (stopBtn) stopBtn.disabled = true;
  recordingActive = false;

  try {
    // Be opptakeren sende siste rest av data
    rec?.flush?.();
    rec?.stop?.();

    // Liten pause for å være sikre på at siste chunk er ferdig
    await new Promise(r => setTimeout(r, 150));

    const durationMs = rec?.getDurationMs?.() || 0;
    const result = await up?.finalize(durationMs);
    console.log('Finalize result:', result);

    setStatus('Videoen ble opplastet! Filen er lagret på serveren.');
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

/**
 * Rydder opp etter et opptak:
 *  - stopper eventuelle streams
 *  - nullstiller variabler
 *  - reaktiverer start-knapper
 */
function cleanup() {
  try { rec?.cleanup?.(); } catch {}
  rec = null;
  up  = null;
  recordingActive = false;
  setStartButtonsDisabled(false);
  if (stopBtn) stopBtn.disabled = true;
}

// Koble stopp-knappen til stop()-funksjonen
stopBtn?.addEventListener('click', stop);

/**
 * Init-funksjon som kjører én gang når skriptet lastes:
 *  - sjekker om MediaRecorder støttes
 *  - kobler “Start opptak" knappene til start (slot)
 */
(function initUI() {
  const supported = !!window.MediaRecorder;
  if (!supported) {
    setStatus('MediaRecorder støttes ikke i denne nettleseren.');
    setStartButtonsDisabled(true);
  } else {
    setStartButtonsDisabled(false);
    if (stopBtn) stopBtn.disabled = true;
  }

  // Knytt alle knapper med data-slot til riktig slot-nummer
  document.querySelectorAll('[data-slot]').forEach(btn => {
    const slot = Number(btn.dataset.slot || '1');
    btn.addEventListener('click', () => start(slot));
  });
})();

/**
 * Konfigurer filopplasting for hvert “Opptak”.
 * Hver wireFileUploader kobler sammen:
 *  - én <input type="file">
 *  - én “Last opp som Opptak” knapp
 *  - én statuslinje og én progress-bar
 *  - og en slot (1–6) som matcher server-navngivingen
 */

// Slot 1
wireFileUploader({
  inputEl: document.getElementById('fileUpload1'),
  buttonEl: document.getElementById('fileUploadBtn1'),
  statusEl: document.getElementById('fileUploadStatus1'),
  progressBarEl: document.getElementById('fileUploadBar1'),
  getUploadId: () => `rec-slot1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  slot: 1
});

// Slot 2
wireFileUploader({
  inputEl: document.getElementById('fileUpload2'),
  buttonEl: document.getElementById('fileUploadBtn2'),
  statusEl: document.getElementById('fileUploadStatus2'),
  progressBarEl: document.getElementById('fileUploadBar2'),
  getUploadId: () => `rec-slot2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  slot: 2
});

// Slot 3
wireFileUploader({
  inputEl: document.getElementById('fileUpload3'),
  buttonEl: document.getElementById('fileUploadBtn3'),
  statusEl: document.getElementById('fileUploadStatus3'),
  progressBarEl: document.getElementById('fileUploadBar3'),
  getUploadId: () => `rec-slot3-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  slot: 3
});

// Slot 4
wireFileUploader({
  inputEl: document.getElementById('fileUpload4'),
  buttonEl: document.getElementById('fileUploadBtn4'),
  statusEl: document.getElementById('fileUploadStatus4'),
  progressBarEl: document.getElementById('fileUploadBar4'),
  getUploadId: () => `rec-slot4-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  slot: 4
});

// Slot 5
wireFileUploader({
  inputEl: document.getElementById('fileUpload5'),
  buttonEl: document.getElementById('fileUploadBtn5'),
  statusEl: document.getElementById('fileUploadStatus5'),
  progressBarEl: document.getElementById('fileUploadBar5'),
  getUploadId: () => `rec-slot5-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  slot: 5
});

// Slot 6
wireFileUploader({
  inputEl: document.getElementById('fileUpload6'),
  buttonEl: document.getElementById('fileUploadBtn6'),
  statusEl: document.getElementById('fileUploadStatus6'),
  progressBarEl: document.getElementById('fileUploadBar6'),
  getUploadId: () => `rec-slot6-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  slot: 6
});
