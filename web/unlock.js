// unlock.js — uses server-issued tokens only & new key "authToken"
import { API_BASE } from './src/config.js';

// Kill any stale demo key from old code
try { sessionStorage.removeItem('unlockToken'); } catch {}

const unlockCard = document.getElementById('unlockCard');
const unlockForm = document.getElementById('unlockForm');
const unlockCode = document.getElementById('unlockCode');
const unlockBtn  = document.getElementById('unlockBtn');
const lockBtn    = document.getElementById('lockBtn');
const unlockMsg  = document.getElementById('unlockMsg');
const recWrap    = document.getElementById('recWrap');

function setLockedState(locked) {
  if (locked) {
    recWrap.classList.add('hidden');
    recWrap.setAttribute('aria-hidden', 'true');
    unlockCard.classList.remove('hidden');
    unlockMsg.textContent = 'Opptak er låst. Skriv inn kode for å låse opp.';
    unlockMsg.className = 'statusline';
    sessionStorage.removeItem('authToken');
    lockBtn.classList.add('hidden');
    unlockBtn.classList.remove('hidden');
    unlockCode.value = '';
    unlockCode.focus();
    document.querySelectorAll('[data-slot]').forEach(b => b.disabled = true);
    const stopBtn = document.getElementById('stopBtn');
    if (stopBtn) stopBtn.disabled = true;
    const preview = document.getElementById('preview');
    if (preview && preview.srcObject) {
      try { preview.pause(); } catch {}
      try { preview.srcObject.getTracks().forEach(t => t.stop()); } catch {}
      preview.srcObject = null;
    }
  } else {
    unlockCard.classList.add('hidden');
    recWrap.classList.remove('hidden');
    recWrap.removeAttribute('aria-hidden');
    unlockMsg.textContent = 'Låst opp for denne fanen/økten.';
    unlockMsg.className = 'statusline ok';
    lockBtn.classList.remove('hidden');
    unlockBtn.classList.add('hidden');
    document.querySelectorAll('[data-slot]').forEach(b => b.disabled = false);
  }
}

async function tryAutoUnlock() {
  const tok = sessionStorage.getItem('authToken');
  if (!tok) return setLockedState(true);
  try {
    const r = await fetch(`${API_BASE}/api/whoami?token=${encodeURIComponent(tok)}`);
    const j = await r.json().catch(()=> ({}));
    setLockedState(!(j && j.ok));
  } catch { setLockedState(true); }
}

unlockForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = (unlockCode.value || '').trim();
  if (!code) return;
  unlockBtn.disabled = true;
  unlockMsg.textContent = 'Verifiserer...';
  unlockMsg.className = 'statusline';

  try {
    const res = await fetch(`${API_BASE}/api/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    if (res.ok && data.ok && data.token) {
      sessionStorage.setItem('authToken', data.token); // << store server token here
      setLockedState(false);
    } else {
      unlockMsg.textContent = 'Feil kode.';
      unlockMsg.className = 'statusline err';
      setLockedState(true);
    }
  } catch (err) {
    console.error('Unlock error:', err);
    unlockMsg.textContent = 'Serverfeil.';
    unlockMsg.className = 'statusline err';
  } finally {
    unlockBtn.disabled = false;
  }
});

lockBtn.addEventListener('click', () => setLockedState(true));
tryAutoUnlock();
