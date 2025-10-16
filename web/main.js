// main.js

const BASE_URL = 'http://localhost:3001';

let recorder = null;
let combinedStream = null;
let screenStream = null;
let micStream = null;
let audioCtx = null;
let audioDest = null;

const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const preview  = document.getElementById('preview');
const sysAudioToggle = document.getElementById('sysAudioToggle');

// --- Kodehåndtering ---
const KNOWN_CODES = new Set(['test1', 'test2', 'test3']);
function getUnlockedCode() {
  const c = sessionStorage.getItem('unlockToken');
  return KNOWN_CODES.has(c) ? c : null;
}

function setStatus(text) { statusEl.textContent = text || ''; }

function bestMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return 'video/webm';
}

async function startRecording() {
  try {
    // Enkel sjekk: krever gyldig kode
    const unlockedCode = getUnlockedCode();
    if (!unlockedCode) {
      setStatus('Låst: skriv inn gyldig kode for å starte opptak.');
      return;
    }

    setStatus('Spør etter tillatelser …');
    startBtn.disabled = true;
    stopBtn.disabled = true;

    const wantSystemAudio = !!(sysAudioToggle && sysAudioToggle.checked);

    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: wantSystemAudio
    });

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false
    });

    const vTrack = screenStream.getVideoTracks()[0] || null;
    const sysTrack = screenStream.getAudioTracks()[0] || null;
    const micTrack = micStream.getAudioTracks()[0] || null;

    if (!vTrack) throw new Error('Fant ikke videostrøm fra skjermdeling.');

    let mixedAudioTrack = null;
    if (sysTrack && micTrack) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioDest = audioCtx.createMediaStreamDestination();

      const sysSrc = audioCtx.createMediaStreamSource(new MediaStream([sysTrack]));
      const micSrc = audioCtx.createMediaStreamSource(new MediaStream([micTrack]));

      const sysGain = audioCtx.createGain(); sysGain.gain.value = 1.0;
      const micGain = audioCtx.createGain(); micGain.gain.value = 1.0;

      sysSrc.connect(sysGain).connect(audioDest);
      micSrc.connect(micGain).connect(audioDest);

      mixedAudioTrack = audioDest.stream.getAudioTracks()[0] || null;
    }

    const tracks = [vTrack];
    if (mixedAudioTrack) tracks.push(mixedAudioTrack);
    else if (sysTrack)   tracks.push(sysTrack);
    else if (micTrack)   tracks.push(micTrack);

    combinedStream = new MediaStream(tracks);

    // forhåndsvisning
    if (preview) {
      preview.srcObject = combinedStream;
      preview.muted = true;
      await preview.play().catch(() => {});
    }

    const mimeType = bestMimeType();
    recorder = new RecordRTCPromisesHandler(combinedStream, {
      type: 'video',
      mimeType,
      disableLogs: true,
      bitsPerSecond: 4_000_000
    });

    await recorder.startRecording();
    window.__recStartedAt = Date.now();
    setStatus(`Tar opp … (kode: ${unlockedCode})`);
    stopBtn.disabled = false;

    vTrack.onended = () => { if (!stopBtn.disabled) stopRecording(); };

    const parts = [];
    if (mixedAudioTrack) parts.push('mikrofon + system/tab-lyd');
    else if (sysTrack) parts.push('system/tab-lyd');
    else if (micTrack) parts.push('mikrofon');
    else parts.push('ingen lyd');
    setStatus(`Tar opp video + ${parts.join('')}. (kode: ${unlockedCode})`);
  } catch (err) {
    console.error(err);
    setStatus(`Feil: ${err.message}`);
    cleanup();
  }
}

async function stopRecording() {
  try {
    setStatus('Stopper …');
    stopBtn.disabled = true;

    if (!recorder) return;

    await recorder.stopRecording();
    const blob = await recorder.getBlob();

    // Filnavn med kode-prefiks
    const unlockedCode = getUnlockedCode();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = unlockedCode || 'screen-recording';
    const fileName = `${prefix}-${timestamp}.webm`;

    const form = new FormData();
    form.append('file', blob, fileName);
    form.append('mimeType', blob.type || 'video/webm');
    form.append('durationMs', String(Date.now() - (window.__recStartedAt || Date.now())));
    if (unlockedCode) form.append('code', unlockedCode); // send koden til serveren også

    setStatus('Laster opp …');
    const res = await fetch(`${BASE_URL}/upload`, {
      method: 'POST',
      body: form,
      // alternativt kan du sende kode i header
      // headers: { 'X-Unlock-Code': unlockedCode || '' }
    });

    if (!res.ok) throw new Error(`Upload feilet: ${res.status}`);
    const json = await res.json();
    setStatus(`Opplastet! URL: ${json.url}`);
  } catch (err) {
    console.error(err);
    setStatus(`Feil under stopp: ${err.message}`);
  } finally {
    cleanup();
  }
}

function cleanup() {
  startBtn.disabled = false;
  stopBtn.disabled = true;

  [screenStream, micStream, combinedStream].forEach(stream => {
    if (stream) stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
  });

  if (preview && preview.srcObject) {
    try { preview.pause(); } catch {}
    preview.srcObject = null;
  }

  if (audioCtx) { try { audioCtx.close(); } catch {} }

  recorder = null;
  screenStream = null;
  micStream = null;
  combinedStream = null;
  audioCtx = null;
  audioDest = null;
}

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);

// MediaRecorder-støtte
(function initUI() {
  const supported = !!(window.MediaRecorder);
  if (!supported) {
    setStatus('MediaRecorder støttes ikke i denne nettleseren.');
    startBtn.disabled = true;
  } else {
    // Hvis låst, kan unlock.js holde UI skjult, men vi lar start være tilgjengelig.
    // startRecording() vil uansett nekte hvis kode mangler.
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
})();

// ---- iOS chunk uploader ----
const iosFileInput = document.getElementById('iosFile');
const iosBtn       = document.getElementById('iosUploadBtn');
const iosStatusEl  = document.getElementById('iosStatus');
const iosBar       = document.getElementById('iosBar');

const ENDPOINT_CHUNK  = `${BASE_URL}/upload/chunk`;
const ENDPOINT_FINISH = `${BASE_URL}/upload/finish`;

const CHUNK_SIZE  = 5 * 1024 * 1024; // 5MB
const MAX_RETRIES = 3;

function iosSetStatus(t){ iosStatusEl.textContent = t || ''; }
function iosSetProgress(f){ iosBar.style.width = `${Math.round(f*100)}%`; }

async function iosSendChunk(blob, uploadId, mimeType) {
  const code = getUnlockedCode() || '';
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('chunk', blob, 'part.bin');
    form.append('uploadId', uploadId);
    form.append('mimeType', mimeType);
    form.append('code', code); // send kode på hver chunk

    const xhr = new XMLHttpRequest();
    xhr.open('POST', ENDPOINT_CHUNK, true);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`chunk failed: ${xhr.status}`));
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(form);
  });
}

async function iosUploadFileInChunks(file) {
  // Krev gyldig kode også for manuell opplasting
  const unlockedCode = getUnlockedCode();
  if (!unlockedCode) {
    iosSetStatus('Låst: skriv inn gyldig kode for å laste opp.');
    throw new Error('locked');
  }

  const uploadId = (self.crypto?.randomUUID?.() || String(Date.now()) + '-' + Math.random().toString(36).slice(2));
  let offset = 0, sent = 0;

  while (offset < file.size) {
    const chunk = file.slice(offset, offset + CHUNK_SIZE);
    let attempt = 0, ok = false;
    while (!ok && attempt < MAX_RETRIES) {
      attempt++;
      try {
        await iosSendChunk(chunk, uploadId, file.type || 'video/quicktime');
        ok = true;
      } catch (e) {
        if (attempt >= MAX_RETRIES) throw e;
        await new Promise(r => setTimeout(r, 600 * attempt));
      }
    }
    offset += chunk.size;
    sent += chunk.size;
    iosSetProgress(sent / file.size);
    iosSetStatus(`Laster opp… ${Math.round(100 * sent / file.size)}% (kode: ${unlockedCode})`);
  }

  const res = await fetch(ENDPOINT_FINISH, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ uploadId, durationMs: 0, code: unlockedCode })
  });
  if (!res.ok) throw new Error('finish failed');

  return res.json(); // { id, url }
}

iosBtn.addEventListener('click', async () => {
  const file = iosFileInput.files?.[0];
  if (!file) { iosSetStatus('Velg en videofil først.'); return; }

  // Krev gyldig kode før opplasting
  if (!getUnlockedCode()) {
    iosSetStatus('Låst: skriv inn gyldig kode for å laste opp.');
    return;
  }

  iosBtn.disabled = true; iosSetProgress(0); iosSetStatus('Starter opplasting…');
  try {
    const result = await iosUploadFileInChunks(file);
    iosSetProgress(1);
    iosSetStatus(`Ferdig! ${result.url}`);
  } catch (e) {
    if (e.message !== 'locked') console.error(e);
    if (e.message !== 'locked') iosSetStatus(`Feil: ${e.message}`);
  } finally {
    iosBtn.disabled = false;
  }
});
