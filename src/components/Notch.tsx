import { useState, type FormEvent } from 'react';
import SoundWave from './SoundWave';
import type { UpdateSummary } from '../lib/osControl';
import type { AppState } from '../types';

interface NotchProps {
  state: AppState;
  status: string;
  getLevel?: () => number;
  showTokenSetup?: boolean;
  tokenBusy?: boolean;
  updateAvailable?: UpdateSummary | null;
  /** Callback del pulsante mostrato nello stato "setup" (configura wake word). */
  onActivate?: () => void;
  onSaveUpdateToken?: (token: string) => Promise<void>;
  onImportUpdateToken?: () => Promise<void>;
  onCancelTokenSetup?: () => void;
  onInstallUpdate?: () => void;
  onDismissUpdate?: () => void;
}

/**
 * "The Notch" - overlay fluttuante frameless in cima allo schermo.
 *
 * Il movimento (discesa dall'orlo / riassorbimento) è gestito via CSS:
 * la classe .notch-<state> controlla la transform translateY.
 */
export default function Notch({
  state,
  status,
  getLevel,
  showTokenSetup = false,
  tokenBusy = false,
  updateAvailable = null,
  onActivate,
  onSaveUpdateToken,
  onImportUpdateToken,
  onCancelTokenSetup,
  onInstallUpdate,
  onDismissUpdate,
}: NotchProps) {
  const [token, setToken] = useState('');

  const submitToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token.trim() || !onSaveUpdateToken) return;
    await onSaveUpdateToken(token);
    setToken('');
  };

  return (
    <>
      <div className={`notch notch-${state}`}>
        <div className="notch-inner">
          <div className="notch-icon">
            <img src="/app-icon.svg" alt="HeyJev" draggable={false} />
          </div>
          <div className="notch-body">
            <SoundWave state={state} getLevel={getLevel} />
            <div className="notch-status">{status}</div>
          </div>
          {state === 'setup' && onActivate ? (
            <button type="button" className="activate-button" onClick={onActivate}>
              Attiva
            </button>
          ) : null}
          {updateAvailable && onInstallUpdate ? (
            <button type="button" className="update-button" onClick={onInstallUpdate}>
              Installa {updateAvailable.version}
            </button>
          ) : null}
          {updateAvailable && onDismissUpdate ? (
            <button type="button" className="update-button secondary-button" onClick={onDismissUpdate}>
              Più tardi
            </button>
          ) : null}
        </div>
      </div>

      {showTokenSetup ? (
        <form className="token-panel" onSubmit={(event) => void submitToken(event)}>
          <div className="token-panel-title">Aggiornamenti privati</div>
          <p>
            Token fine-grained con <code>Contents: read</code> solo su Ehi-Jev. Verrà verificato e
            salvato nel Credential Manager di Windows, non nel browser né nell’EXE.
          </p>
          <label htmlFor="github-update-token">Token GitHub</label>
          <input
            id="github-update-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="github_pat_…"
          />
          <div className="token-panel-actions">
            <button type="submit" disabled={tokenBusy || !token.trim()}>
              {tokenBusy ? 'Verifico…' : 'Salva in Windows'}
            </button>
            {onImportUpdateToken ? (
              <button type="button" className="secondary-button" disabled={tokenBusy} onClick={() => void onImportUpdateToken()}>
                Importa da .env.local
              </button>
            ) : null}
            <button type="button" className="secondary-button" disabled={tokenBusy} onClick={onCancelTokenSetup}>
              Annulla
            </button>
          </div>
        </form>
      ) : null}
    </>
  );
}
