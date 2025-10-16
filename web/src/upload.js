import { BASE_URL } from './config.js';

const ENDPOINT_CHUNK  = `${BASE_URL}/upload/chunk`;
const ENDPOINT_FINISH = `${BASE_URL}/upload/finish`;

function newUploadId() {
  return (self.crypto?.randomUUID?.() || String(Date.now()) + '-' + Math.random().toString(36).slice(2));
}

/**
 * Uploader with backpressure and optional fixed uploadId.
 * For direct-append backend, keep maxPending=1 (sequential).
 */
export function createChunkUploader({ maxPending = 1, uploadId: fixedId } = {}) {
  let uploadId = null;
  let nextIndex = 0;
  let pending = 0;

  async function start() {
    uploadId = fixedId || newUploadId();
    nextIndex = 0;
    pending = 0;
    return uploadId;
  }

  async function sendChunk(blob, mimeType, index) {
    const form = new FormData();
    form.append('chunk', blob, `part-${index}.bin`);
    form.append('uploadId', uploadId);
    form.append('mimeType', mimeType);
    form.append('index', String(index));
    const res = await fetch(ENDPOINT_CHUNK, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`chunk failed: ${res.status}`);
  }

  async function push(blob, mimeType, { onBackpressurePause, onBackpressureResume } = {}) {
    while (pending >= maxPending) {
      onBackpressurePause?.();
      await new Promise(r => setTimeout(r, 200));
    }
    onBackpressureResume?.();

    const myIndex = nextIndex++;
    pending++;
    try {
      await sendChunk(blob, mimeType, myIndex);
    } finally {
      pending--;
    }
  }

  async function flush() {
    while (pending > 0) {
      await new Promise(r => setTimeout(r, 150));
    }
  }

  async function finalize(durationMs) {
    await flush();

    const form = new FormData();
    form.append('uploadId', uploadId);
    form.append('durationMs', String(durationMs));

    console.log('[finalize] endpoint', ENDPOINT_FINISH, 'uploadId=', uploadId, 'durationMs=', durationMs);

    const res = await fetch(ENDPOINT_FINISH, { method: 'POST', body: form });
    console.log('[finalize] got response?', res && res.status);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`finish failed: ${res.status} ${text}`);
    }
    return res.json(); // { id, url }
  }

  return { start, push, flush, finalize, get uploadId() { return uploadId; } };
}
