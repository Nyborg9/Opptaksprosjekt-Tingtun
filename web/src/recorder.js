function bestMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  for (const t of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
  }
  return 'video/webm';
}

/**
 * Starts recording and emits small chunks via onChunk(blob, mimeType).
 * Returns { stop, cleanup }.
 */
export async function startRecorder({
  wantSystemAudio = false,
  timesliceMs = 3000,
  previewEl = null,
  onChunk,
  onStatus
}) {
  onStatus?.('Spør etter tillatelser …');

  const screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: wantSystemAudio
  });
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: false
  });

  const vTrack = screenStream.getVideoTracks()[0];
  const sysTrack = screenStream.getAudioTracks()[0] || null;
  const micTrack = micStream.getAudioTracks()[0] || null;
  if (!vTrack) throw new Error('Fant ikke videostrøm fra skjermdeling.');

  // Mix mic + system if both present
  let audioCtx = null, audioDest = null, mixedAudioTrack = null;
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
  const combinedStream = new MediaStream(tracks);

  if (previewEl) {
    previewEl.srcObject = combinedStream;
    previewEl.muted = true;
    previewEl.defaultMuted = true;
    previewEl.volume = 0;
    try { await previewEl.play(); } catch {}
  }

  const mimeType = bestMimeType();
  const recorder = new MediaRecorder(combinedStream, {
    mimeType,
    bitsPerSecond: 1_700_000
  });

  const startedAt = Date.now();
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) onChunk?.(e.data, mimeType);
  };
  
  recorder.onstart = () => onStatus?.('Tar opp …');
  recorder.onerror = (e) => onStatus?.(`Feil i opptaker: ${e.error?.message || e.message || e.name}`);

  // Let caller control backpressure by pausing/resuming these:
  function pause()  { try { if (recorder.state === 'recording') recorder.pause(); } catch {} }
  function resume() { try { if (recorder.state === 'paused')   recorder.resume(); } catch {} }
  
  function flush() {
    try { recorder.requestData?.(); } catch {}
  }

  function stop() {
    if (recorder.state !== 'inactive') recorder.stop();
  }

  function cleanup() {
    [screenStream, micStream, combinedStream].forEach(s => {
      if (s) s.getTracks().forEach(t => { try { t.stop(); } catch {} });
    });
    if (previewEl) { try { previewEl.pause(); } catch {}; previewEl.srcObject = null; }
    if (audioCtx)  { try { audioCtx.close(); } catch {} }
  }

  // Auto-stop when the user stops sharing
  vTrack.onended = () => stop();

  recorder.start(timesliceMs);
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
