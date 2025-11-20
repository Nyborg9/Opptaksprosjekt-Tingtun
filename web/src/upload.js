// Upload inneholder funksjoner for å laste opp video i deler ("chunks") til serveren.

import { API_BASE } from './config.js';

// Ferdige URL-er til API-endepunktene for chunk-opplasting og ferdigmelding
const ENDPOINT_CHUNK  = `${API_BASE}/upload/chunk`;
const ENDPOINT_FINISH = `${API_BASE}/upload/finish`;

/**
 * Lager en unik ID for en opplasting.
 * Brukes til å knytte alle chunkene til samme "opptak".
 */
function newUploadId() {
  return self.crypto?.randomUUID?.() 
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Leser token fra sessionStorage.
 * - Hvis den mangler → kaster en feil med code = 'LOCKED',
 *   slik at UI kan vise at økten er låst/utløpt.
 */
function getTokenHeaderOrThrow() {
  const token = sessionStorage.getItem('authToken') 
             || sessionStorage.getItem('unlockToken');

  if (!token) {
    const err = new Error('NO_TOKEN');
    err.code = 'LOCKED';
    throw err;
  }

  // Returnerer ferdig header-objekt til fetch()
  return { 'x-unlock-token': token };
}

/**
 * createChunkUploader
 
 * Returnerer et lite "uploader-objekt" som:
 *  - får en unik uploadId
 *  - tar imot blobs i rekkefølge (0,1,2,...)
 *  - sender hver chunk til /upload/chunk
 *  - til slutt kaller /upload/finish når alt er ferdig
 *
 * maxPending styrer hvor mange chunk-opplastinger som kan være "in flight"
 * samtidig. Her bruker vi typisk 1 for å gjøre det enkelt.
 *
 * slot 1-6 brukes på serveren til å navngi filene
 * (f.eks. Tester1Oppgave2).
 */
export function createChunkUploader({ maxPending = 1, uploadId: fixedId, slot = 1 } = {}) {
  let uploadId = null;
  let nextIndex = 0; // neste chunk-indeks vi kommer til å sende
  let pending   = 0; // hvor mange fetch-kall som pågår akkurat nå

  /**
   * start()
   * - Validerer slot (må være 1, 2 eller 3)
   * - Lager en ny uploadId (eller bruker en gitt uploadId)
   * - Nullstiller intern state
   */
  async function start() {
    if (!Number.isInteger(slot) || slot < 1 || slot > 6) {
    throw new Error('slot må være imellom 1 og 6');
    }
    uploadId = fixedId || newUploadId();
    nextIndex = 0;
    pending = 0;
    return uploadId;
  }

  /**
   * sendChunk()
   * - Sender én chunk til /upload/chunk med FormData
   * - Inkluderer uploadId, mimeType, index og slot
   * - Legger token i x-unlock-token-headeren
   */
  async function sendChunk(blob, mimeType, index) {
    const form = new FormData();
    form.append('chunk',    blob, `part-${index}.bin`);
    form.append('uploadId', uploadId);
    form.append('mimeType', mimeType);
    form.append('index',    String(index));
    form.append('slot',     String(slot));

    const headers = getTokenHeaderOrThrow();

    const res = await fetch(ENDPOINT_CHUNK, {
      method: 'POST',
      headers,
      body: form
    });

    if (res.status === 403) {
      // Server sier at token er ugyldig/utløpt
      throw Object.assign(new Error('Locked'), { code: 'LOCKED' });
    }

    if (!res.ok) {
      // Ikke lekk detaljer om responsbody i feilmelding
      throw new Error(`chunk failed: ${res.status}`);
    }
  }

  /**
   * push()
   * - Kalles for hver chunk som skal sendes.
   * - Sørger for at vi ikke har flere enn maxPending samtidige fetch-kall.
   * - Bruker hooks.onBackpressurePause/Resume for å kunne pause opptak hvis køen blir for stor.
   */
  async function push(blob, mimeType, hooks = {}) {
    while (pending >= maxPending) {
      // For mange chunk-opplastinger samtidig → gi beskjed til opptakeren
      hooks.onBackpressurePause?.();
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Vi har plass igjen → fortsett evt. opptak
    hooks.onBackpressureResume?.();

    const myIndex = nextIndex++;
    pending++;

    try {
      await sendChunk(blob, mimeType, myIndex);
    } finally {
      pending--;
    }
  }

  /**
   * flush()
   * - Venter til alle pågående chunk-opplastinger er ferdige.
   * - Brukes før finalize() for å sikre at alt er sendt.
   */
  async function flush() {
    while (pending > 0) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }

  /**
   * finalize()
   * - Kalles når opptaket er ferdig.
   * - Venter på flush(), og sier deretter fra til serveren via /upload/finish.
   * - Serveren pakker sammen filen, gir den et endelig navn og returnerer URL.
   */
  async function finalize(durationMs) {
    await flush();

    const form = new FormData();
    form.append('uploadId',  uploadId);
    form.append('durationMs', String(durationMs));
    form.append('slot',      String(slot));

    const headers = getTokenHeaderOrThrow();

    const res = await fetch(ENDPOINT_FINISH, {
      method: 'POST',
      headers,
      body: form
    });

    if (res.status === 403) {
      throw Object.assign(new Error('Locked'), { code: 'LOCKED' });
    }

    if (!res.ok) {
      // Igjen: ikke echo hele responsbody, bare status
      throw new Error(`finish failed: ${res.status}`);
    }

    return res.json();
  }

  // Eksponerer et lite objekt som brukes i main.js og file-upload.js
  return {
    start,
    push,
    flush,
    finalize,
    get uploadId() { return uploadId; }
  };
}
