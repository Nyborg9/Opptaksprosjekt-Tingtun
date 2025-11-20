// Velger beste videoformat som nettleseren støtter for opptak
function bestMimeType() {
  // Vi prøver disse i rekkefølge
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];

  // Returner første format som MediaRecorder sier at den støtter
  for (const t of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
  }

  // Fallback hvis ingen av de over eksplisitt støttes
  return 'video/webm';
}

/**
 * Starter et skjermopptak med lyd.
 * Parametere:
 *  - wantSystemAudio: om vi skal prøve å ta opp systemlyd (tab/PC-lyd)
 *  - timesliceMs: hvor ofte vi får en ny "chunk" (millisekunder)
 *  - previewEl: <video>-element for forhåndsvisning (kan være null)
 *  - onChunk: callback som får hver data-del (blob, mimeType)
 *  - onStatus: callback for statusmeldinger til brukeren
 */
export async function startRecorder({
  wantSystemAudio = false,
  timesliceMs = 3000,
  previewEl = null,
  onChunk,
  onStatus
}) {
  // Gi brukeren beskjed om at vi spør om rettigheter
  onStatus?.('Spør etter tillatelser …');

  // Be brukeren velge skjerm/app/fane å dele (video, og ev. systemlyd)
  const screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: wantSystemAudio
  });

  // Be om mikrofon-lyd samtidig (egen stream)
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: false
  });

  // Plukk ut konkrete spor (tracks) fra streamene
  const vTrack   = screenStream.getVideoTracks()[0];
  const sysTrack = screenStream.getAudioTracks()[0] || null;
  const micTrack = micStream.getAudioTracks()[0] || null;

  if (!vTrack) {
    // Hvis vi ikke har videostrøm, kan vi ikke fortsette
    throw new Error('Fant ikke videostrøm fra skjermdeling.');
  }

  // Variabler for lydmiksing
  let audioCtx = null, audioDest = null, mixedAudioTrack = null;

  // Hvis vi både har systemlyd og mikrofon, miks dem sammen til ett lydspor
  if (sysTrack && micTrack) {
    // Opprett AudioContext (vanlig eller webkit-variant)
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioDest = audioCtx.createMediaStreamDestination();

    // Lag lydkilder fra sporene
    const sysSrc = audioCtx.createMediaStreamSource(new MediaStream([sysTrack]));
    const micSrc = audioCtx.createMediaStreamSource(new MediaStream([micTrack]));

    // Separate gain-kontroller (volum) for systemlyd og mikrofon
    const sysGain = audioCtx.createGain(); sysGain.gain.value = 1.0;
    const micGain = audioCtx.createGain(); micGain.gain.value = 1.0;

    // Koble begge lydkildene inn til samme "destination"
    sysSrc.connect(sysGain).connect(audioDest);
    micSrc.connect(micGain).connect(audioDest);

    // Hent det ferdig miksede lydsporet
    mixedAudioTrack = audioDest.stream.getAudioTracks()[0] || null;
  }

  // Bygg en kombinert MediaStream med video + lydspor
  const tracks = [vTrack];
  if (mixedAudioTrack) tracks.push(mixedAudioTrack);
  else if (sysTrack)   tracks.push(sysTrack);
  else if (micTrack)   tracks.push(micTrack);

  const combinedStream = new MediaStream(tracks);

  // Sett forhåndsvisning hvis vi har fått inn et <video>-element
  if (previewEl) {
    previewEl.srcObject = combinedStream;
    previewEl.muted = true;        // spill uten lyd
    previewEl.defaultMuted = true;
    previewEl.volume = 0;
    try { await previewEl.play(); } catch {}
  }

  // Velg beste mime-type og opprett selve MediaRecorder
  const mimeType = bestMimeType();
  const recorder = new MediaRecorder(combinedStream, {
    mimeType,
    bitsPerSecond: 1_700_000  // 1.7 Mbit/s
  });

  const startedAt = Date.now();

  // Hver gang recorder har data klar, sender vi den til onChunk
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) onChunk?.(e.data, mimeType);
  };
  
  // Oppdater status når opptak starter
  recorder.onstart = () => onStatus?.('Tar opp …');

  // Melder fra om feil i opptakeren
  recorder.onerror = (e) =>
    onStatus?.(`Feil i opptaker: ${e.error?.message || e.message || e.name}`);

  // Pause opptak (brukes ved backpressure fra opplasting)
  function pause()  {
    try {
      if (recorder.state === 'recording') recorder.pause();
    } catch {}
  }

  // Fortsett opptak etter pause
  function resume() {
    try {
      if (recorder.state === 'paused') recorder.resume();
    } catch {}
  }
  
  // Be om en ekstra chunk med en gang opptaket stoppes
  function flush() {
    try { recorder.requestData?.(); } catch {}
  }

  // Stopp opptaket hvis det fortsatt er aktivt
  function stop() {
    if (recorder.state !== 'inactive') recorder.stop();
  }

  // Rydd opp ressurser: stopp alle spor, stopp forhåndsvisning, lukk AudioContext
  function cleanup() {
    [screenStream, micStream, combinedStream].forEach(s => {
      if (s) s.getTracks().forEach(t => {
        try { t.stop(); } catch {}
      });
    });

    if (previewEl) {
      try { previewEl.pause(); } catch {}
      previewEl.srcObject = null;
    }

    if (audioCtx) {
      try { audioCtx.close(); } catch {}
    }
  }

  // Hvis brukeren avslutter skjermdeling (stopper delingen), stopp opptak
  vTrack.onended = () => stop();

  // Start Recorder med valgt intervall
  recorder.start(timesliceMs);

  // Returner et lite "API" til resten av koden
  return {
    stop,
    cleanup,
    pause,
    resume,
    flush,
    requestData: () => { try { recorder.requestData?.(); } catch {} },
    getDurationMs: () => Date.now() - startedAt
  };
}
