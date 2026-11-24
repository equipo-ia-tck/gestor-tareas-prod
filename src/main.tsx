import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { AuthGate } from './app/AuthGate';
import { isConsentPage, OAuthConsent } from './app/OAuthConsent';
import { initSync } from './data/sync';
import { captureInstallPrompt } from './app/install';
import { requestPersistentStorage } from './data/backup';
import { autosave, repo } from './data/services';
import { registerSW } from 'virtual:pwa-register';
import './index.css';

captureInstallPrompt();
void requestPersistentStorage();
void autosave.init();
initSync(repo.db);
// Algunas páginas sin HTTPS (p. ej. abrir el servidor desde otro equipo de la red) no tienen randomUUID.
if (!crypto.randomUUID) {
  crypto.randomUUID = () => '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)) as ReturnType<Crypto['randomUUID']>;
}
// Service worker para funcionar sin conexión (solo en producción; en desarrollo no se registra).
registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      {isConsentPage() ? <OAuthConsent /> : <App />}
    </AuthGate>
  </StrictMode>,
);
