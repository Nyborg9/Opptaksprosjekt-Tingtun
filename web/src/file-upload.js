import { createChunkUploader } from './upload.js';

export function wireFileUploader({
  inputEl,       // <input type="file"> for å velge videofil
  buttonEl,      // Knapp som starter opplastingen
  statusEl,      // Element hvor vi viser status-tekst
  progressBarEl, // Loadbaren
  chunkSize = 5 * 1024 * 1024, // Hvor stor hver chunk skal være (5 MB)
  getUploadId,   // Funksjon som lager en unik uploadId (per slot)
  slot = 1       // Hvilken slot denne opplastingen tilhører (1–6)
}) {
  // Hvis vi mangler enten input eller knapp, gir funksjonen bare opp
  if (!inputEl || !buttonEl) return;

  // Setter status-tekst under/ved siden av knappen
  const setStatus = (t) => {
    if (statusEl) statusEl.textContent = t || '';
  };

  // Oppdaterer fremdriftsindikatoren (0.0–1.0 → 0–100%)
  const setProgress = (f) => {
    if (progressBarEl) {
      const pct = Math.round((f || 0) * 100);
      progressBarEl.style.width = `${pct}%`;
    }
  };

  // Enkel sjekk for om filen ser ut som en video vi støtter
  function isAllowedVideo(file) {
    if (!file) return false;

    const allowedMimes = ['video/webm', 'video/mp4', 'video/quicktime'];
    if (allowedMimes.includes(file.type)) return true;

    // Fallback: se på filendelse hvis mimetype er rar/ukjent
    const name = file.name.toLowerCase();
    return (
      name.endsWith('.webm') ||
      name.endsWith('.mp4')  ||
      name.endsWith('.mov')
    );
  }

  // Når brukeren klikker på "Last opp"
  buttonEl.addEventListener('click', async () => {
    const file = inputEl.files?.[0];

    // Ingen fil valgt
    if (!file) {
      setStatus('Velg en videofil først.');
      return;
    }

    // Sjekk at brukeren er låst opp (må ha authToken)
    const tok =
      sessionStorage.getItem('authToken') ||
      sessionStorage.getItem('unlockToken');

    if (!tok) {
      setStatus('Sesjonen er låst. Lås opp først.');
      return;
    }

    // Filtype-feil (ikke video / ikke støttet format)
    if (!isAllowedVideo(file)) {
      setStatus('Feil filtype. Kun videofiler (.webm, .mp4, .mov) er tillatt.');
      return;
    }

    // Lås knappen mens vi laster opp, og nullstill fremdrift
    buttonEl.disabled = true;
    setProgress(0);
    setStatus('Starter opplasting…');

    // Lager en uploader for denne sloten (1–6) og denne opplastingen
    const up = createChunkUploader({
      maxPending: 1,          // Kun én chunk om gangen (enkelt og forutsigbart)
      uploadId: getUploadId?.(), // Egen ID per opplasting (f.eks. rec-slot1-...)
      slot
    });

    try {
      // Initier opplastingssesjonen (lager uploadId på serveren sin side)
      await up.start();

      let offset = 0;
      let part   = 0;

      // Del opp filen i biter (chunks) og send én og én
      while (offset < file.size) {
        const chunk = file.slice(offset, offset + chunkSize);

        await up.push(chunk, file.type || 'application/octet-stream');

        offset += chunk.size;
        part++;

        const frac = offset / file.size;
        setProgress(frac);
        setStatus(`Laster opp… ${Math.round(frac * 100)}%`);
      }

      // Edge case: fil uten innhold
      if (part === 0) {
        setStatus('Ingen data ble lastet opp.');
        return;
      }

      // Si ifra til serveren at vi er ferdige, og la den gi filen endelig navn
      const result = await up.finalize(0);
      setProgress(1);
      setStatus('Lastet opp videoen! Videoen er lagret på serveren.');
    } catch (e) {
      // Feilhåndtering, inkl. låst/utløpt sesjon
      setStatus(
        e?.code === 'LOCKED'
          ? 'Sesjonen er låst/utløpt. Lås opp på nytt og prøv igjen.'
          : `Feil under opplasting: ${e.message}`
      );
    } finally {
      // Uansett suksess/feil → reaktiver knappen
      buttonEl.disabled = false;
    }
  });
}
