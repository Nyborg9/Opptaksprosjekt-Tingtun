import { BASE_URL } from './config.js';

const ENDPOINT_CHUNK  = `${BASE_URL}/upload/chunk`;
const ENDPOINT_FINISH = `${BASE_URL}/upload/finish`;

function newUploadId() {
  return (self.crypto?.randomUUID?.() || String(Date.now()) + '-' + Math.random().toString(36).slice(2));
}

/**
 * Creates a chunk uploader with backpressure.
 * Usage:
 *   const up = createChunkUploader({ maxPending: 2 });
 *   await up.start();
 *   await up.push(blob, mimeType); // call per chunk
 *   const result = await up.finalize(durationMs); // { id, url }
 */
export function createChunkUploader({ maxPending = 2 } = {}) {
  let uploadId = null;
  let nextIndex = 0;
  let pending = 0;

  async function start() {
    uploadId = newUploadId();
    nextIndex = 0;
    pending = 0;
    return uploadId;
  }

  async function sendChunk(blob, mimeType, index) {
    const form = new FormData();
    form.append('chunk', blob, `part-${index}.bin`);
    form.append('uploadId', uploadId);
    form.append('mimeType', mimeType);
    form.append('index', String(index)); // optional: if server uses it
    const res = await fetch(ENDPOINT_CHUNK, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`chunk failed: ${res.status}`);
  }

  async function push(blob, mimeType, { onBackpressurePause, onBackpressureResume } = {}) {
    // Backpressure: caller (recorder) can pause/resume when we say so.
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
    const res = await fetch(ENDPOINT_FINISH, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ uploadId, durationMs })
    });
    if (!res.ok) throw new Error(`finish failed: ${res.status}`);
    return res.json(); // { id, url }
  }

  return { start, push, flush, finalize, get uploadId() { return uploadId; } };
}
