import { API_BASE } from './config.js';

const ENDPOINT_CHUNK  = `${API_BASE}/upload/chunk`;
const ENDPOINT_FINISH = `${API_BASE}/upload/finish`;

function newUploadId() {
  return self.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getTokenHeaderOrThrow() {
  const tok = sessionStorage.getItem('authToken') || sessionStorage.getItem('unlockToken');
  if (!tok) {
    const err = new Error('NO_TOKEN');
    err.code = 'LOCKED';
    throw err;
  }
  return { 'x-unlock-token': tok };
}

export function createChunkUploader({ maxPending = 1, uploadId: fixedId, slot = 1 } = {}) {
  let uploadId = null, nextIndex = 0, pending = 0;

  async function start() {
    if (![1,2,3].includes(slot)) throw new Error('slot must be 1, 2 or 3');
    uploadId = fixedId || newUploadId();
    nextIndex = 0; pending = 0;
    return uploadId;
  }

  async function sendChunk(blob, mimeType, index) {
    const form = new FormData();
    form.append('chunk', blob, `part-${index}.bin`);
    form.append('uploadId', uploadId);
    form.append('mimeType', mimeType);
    form.append('index', String(index));
    form.append('slot', String(slot));

    const headers = getTokenHeaderOrThrow();
    const res = await fetch(ENDPOINT_CHUNK, { method: 'POST', headers, body: form });
    if (res.status === 403) throw Object.assign(new Error('Locked'), { code: 'LOCKED' });
    if (!res.ok) throw new Error(`chunk failed: ${res.status}`);
  }

  async function push(blob, mimeType, hooks = {}) {
    while (pending >= maxPending) {
      hooks.onBackpressurePause?.();
      await new Promise(r => setTimeout(r, 200));
    }
    hooks.onBackpressureResume?.();
    const myIndex = nextIndex++; pending++;
    try { await sendChunk(blob, mimeType, myIndex); }
    finally { pending--; }
  }

  async function flush() { while (pending > 0) await new Promise(r => setTimeout(r, 150)); }

  async function finalize(durationMs) {
    await flush();
    const form = new FormData();
    form.append('uploadId', uploadId);
    form.append('durationMs', String(durationMs));
    form.append('slot', String(slot));
    const headers = getTokenHeaderOrThrow();
    const res = await fetch(ENDPOINT_FINISH, { method: 'POST', headers, body: form });
    if (res.status === 403) throw Object.assign(new Error('Locked'), { code: 'LOCKED' });
    if (!res.ok) throw new Error(`finish failed: ${res.status}`); // avoid echoing body
    return res.json();
  }

  return { start, push, flush, finalize, get uploadId() { return uploadId; } };
}
