// iOS (and general file) chunk uploader using the same uploader core.
import { createChunkUploader } from './upload.js';

export function wireFileUploader({
  inputEl,        // <input type="file" id="iosFile">
  buttonEl,       // <button id="iosUploadBtn">
  statusEl,       // <span id="iosStatus">
  progressBarEl,  // <div id="iosBar"> (width will be set)
  chunkSize = 5 * 1024 * 1024 // 5 MB
}) {
  if (!inputEl || !buttonEl) return;

  const setStatus  = (t='') => { if (statusEl) statusEl.textContent = t; };
  const setProgress = f => { if (progressBarEl) progressBarEl.style.width = `${Math.round(f*100)}%`; };

  buttonEl.addEventListener('click', async () => {
    const file = inputEl.files?.[0];
    if (!file) { setStatus('Velg en videofil først.'); return; }

    buttonEl.disabled = true;
    setProgress(0);
    setStatus('Starter opplasting…');

    const up = createChunkUploader({ maxPending: 2 });
    await up.start();

    try {
      let offset = 0;
      while (offset < file.size) {
        // slice without loading into JS memory
        const chunk = file.slice(offset, offset + chunkSize);
        await up.push(chunk, file.type || 'application/octet-stream');
        offset += chunk.size;
        setProgress(offset / file.size);
        setStatus(`Laster opp… ${Math.round(100 * offset / file.size)}%`);
      }

      // duration is optional here; set 0 (server can probe with ffprobe if needed)
      const result = await up.finalize(0); // { id, url }
      setProgress(1);
      setStatus(`Ferdig! ${result.url}`);
    } catch (e) {
      console.error(e);
      setStatus(`Feil: ${e.message}`);
    } finally {
      buttonEl.disabled = false;
    }
  });
}
