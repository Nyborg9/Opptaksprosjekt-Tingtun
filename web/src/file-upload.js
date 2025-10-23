import { createChunkUploader } from './upload.js';

export function wireFileUploader({
  inputEl,
  buttonEl,
  statusEl,
  progressBarEl,
  chunkSize = 5 * 1024 * 1024,
  getUploadId,
  slot = 1
}) {
  if (!inputEl || !buttonEl) return;

  const setStatus = t => { if (statusEl) statusEl.textContent = t || ''; };
  const setProgress = f => { if (progressBarEl) progressBarEl.style.width = `${Math.round((f || 0) * 100)}%`; };

  buttonEl.addEventListener('click', async () => {
    const file = inputEl.files?.[0];
    if (!file) { setStatus('Velg en videofil først.'); return; }

    const token = sessionStorage.getItem('authToken') || sessionStorage.getItem('unlockToken');
    console.log('[file-upload] token present?', !!token, 'len=', token?.length);

    buttonEl.disabled = true;
    setProgress(0);
    setStatus('Starter opplasting…');

    const up = createChunkUploader({
      maxPending: 1,
      uploadId: getUploadId?.(),
      slot
    });

    try {
      await up.start();

      let offset = 0;
      while (offset < file.size) {
        const chunk = file.slice(offset, offset + chunkSize);
        await up.push(chunk, file.type || 'application/octet-stream');
        offset += chunk.size;
        setProgress(offset / file.size);
        setStatus(`Laster opp… ${Math.round(100 * offset / file.size)}%`);
      }

      const result = await up.finalize(0);
      setProgress(1);
      setStatus(`Ferdig! ${result?.url || '(ukjent)'}`);
    } catch (e) {
      console.error('[file-upload] error:', e);
      if (e?.code === 'LOCKED') {
        setStatus('Sesjonen er låst/utløpt. Lås opp på nytt og prøv igjen.');
      } else {
        setStatus(`Feil: ${e.message}`);
      }
    } finally {
      buttonEl.disabled = false;
    }
  });
}
