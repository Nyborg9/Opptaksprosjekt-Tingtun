import { API_BASE } from './src/config.js';

// Henter alle HTML-elementene vi trenger for lås/låsopp-grensesnittet
const unlockCard = document.getElementById('unlockCard');
const unlockForm = document.getElementById('unlockForm');
const unlockCode = document.getElementById('unlockCode');
const unlockBtn  = document.getElementById('unlockBtn');
const unlockMsg  = document.getElementById('unlockMsg');
const recWrap    = document.getElementById('recWrap');

/**
 * Endrer brukergrensesnittet mellom låst og ulåst tilstand.
 * - Når locked: skjul hele opptakssiden, vis kodefelt, stopp eventuelle kamera-strømmer.
 * - Når unlocked: vis alt, gi tilgang til opptaksknapper.
 */
function setLockedState(locked) {
  if (locked) {
    // Skjul selve opptakssiden
    recWrap.classList.add('hidden');
    recWrap.setAttribute('aria-hidden', 'true');

    // Vis kortet hvor man skriver inn kode
    unlockCard.classList.remove('hidden');
    unlockMsg.textContent = 'Opptak er låst. Skriv inn kode for å låse opp.';
    unlockMsg.className = 'statusline';

    // Fjern token når vi låser
    sessionStorage.removeItem('authToken');

    // Vis/Skjul riktige knapper
    unlockBtn.classList.remove('hidden');

    // Nullstill feltet og sett fokus
    unlockCode.value = '';
    unlockCode.focus();

    // Deaktiver alle opptaksknapper
    document.querySelectorAll('[data-slot]').forEach(b => b.disabled = true);

    // Deaktiver stopp-knappen
    const stopBtn = document.getElementById('stopBtn');
    if (stopBtn) stopBtn.disabled = true;

    // Stopp eventuell aktiv videostrøm (ryddig opprydding)
    const preview = document.getElementById('preview');
    if (preview && preview.srcObject) {
      try { preview.pause(); } catch {}
      try { preview.srcObject.getTracks().forEach(t => t.stop()); } catch {}
      preview.srcObject = null;
    }

  } else {
    // Ulåst: vis hele opptakssiden
    unlockCard.classList.add('hidden');
    recWrap.classList.remove('hidden');
    recWrap.removeAttribute('aria-hidden');

    unlockMsg.textContent = 'Låst opp for denne fanen/økten.';
    unlockMsg.className = 'statusline ok';

    // Riktig knappesett
    unlockBtn.classList.add('hidden');

    // Aktiver opptaksknapper igjen
    document.querySelectorAll('[data-slot]').forEach(b => b.disabled = false);
  }
}

/**
 * Forsøker å automatisk låse opp hvis vi allerede har en gyldig token
 * lagret i sessionStorage.
 */
async function tryAutoUnlock() {
  const tok = sessionStorage.getItem('authToken');
  if (!tok) return setLockedState(true);

    try {
      // Spør serveren om token fortsatt er gyldig
      const response = await fetch(`${API_BASE}/whoami`, {
        headers: { 'x-unlock-token': tok }
      });

      const result = await response.json().catch(() => ({}));

      // Hvis token er OK → ulåst, ellers låst
      setLockedState(!(result && result.ok));
    } catch {
      // Nettverksfeil = fallback til låst
      setLockedState(true);
    }
  }

/**
 * Kjøres når bruker prøver å låse opp manuelt.
 */
unlockForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const code = (unlockCode.value || '').trim();
  if (!code) return;

  unlockBtn.disabled = true;
  unlockMsg.textContent = 'Verifiserer...';
  unlockMsg.className = 'statusline';

  try {
    // Forsøk å låse opp via API-et
    const res = await fetch(`${API_BASE}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });

    const data = await res.json().catch(() => ({}));

    // Gyldig kode -> lagre token og åpne UI
    if (res.ok && data.ok && data.token) {
      sessionStorage.setItem('authToken', data.token);
      setLockedState(false);
    } else {
      // Ugyldig kode
      unlockMsg.textContent = 'Feil kode.';
      unlockMsg.className = 'statusline err';
      setLockedState(true);
    }

  } catch (err) {
    // Serverfeil (nettverk, proxy, crash etc.)
    console.error('Unlock error:', err);
    unlockMsg.textContent = 'Serverfeil.';
    unlockMsg.className = 'statusline err';
  } finally {
    unlockBtn.disabled = false;
  }
});

// Først når siden lastes: sjekk om vi allerede er ulåst
tryAutoUnlock();
