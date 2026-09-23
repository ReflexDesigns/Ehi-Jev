import { useState, type FormEvent, type ReactNode } from 'react';
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
  /** Pannello che espande l'isola (Impostazioni). */
  children?: ReactNode;
}

/**
 * "The Notch": isola nera stile Dynamic Island attaccata al bordo alto dello schermo.
 * Apertura, chiusura ed espansione sono solo CSS (classi .notch-<state>, .notch-expanded).
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
  children,
}: NotchProps) {
  const [token, setToken] = useState('');
  const expanded = showTokenSetup || Boolean(children) || Boolean(updateAvailable);

  const submitToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token.trim() || !onSaveUpdateToken) return;
    await onSaveUpdateToken(token);
    setToken('');
  };

  return (
    <div className={`notch notch-${state}${expanded ? ' notch-expanded' : ''}`}>
      <div className="notch-row">
        <div className="notch-status">{status}</div>
        {state === 'setup' && !expanded && onActivate ? (
          <button type="button" className="pill-button" onClick={onActivate}>
            Attiva
          </button>
        ) : (
          <SoundWave state={state} getLevel={getLevel} />
        )}
      </div>

      {updateAvailable ? (
        <div className="panel-actions notch-panel">
          <button type="button" className="pill-button secondary" onClick={onDismissUpdate}>
            Più tardi
          </button>
          <button type="button" className="pill-button" onClick={onInstallUpdate}>
            Installa {updateAvailable.version}
          </button>
        </div>
      ) : null}

      {showTokenSetup ? (
        <form className="notch-panel" onSubmit={(event) => void submitToken(event)}>
          <p>
            Token GitHub fine-grained con <code>Contents: read</code> solo su Ehi-Jev. Verrà verificato e
            salvato nel Credential Manager di Windows, non nel browser né nell’EXE.
          </p>
          <input
            className="wide"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="github_pat_…"
            aria-label="Token GitHub"
          />
          <div className="panel-actions">
            {onImportUpdateToken ? (
              <button type="button" className="pill-button secondary" disabled={tokenBusy} onClick={() => void onImportUpdateToken()}>
                Importa da .env.local
              </button>
            ) : null}
            <button type="button" className="pill-button secondary" disabled={tokenBusy} onClick={onCancelTokenSetup}>
              Annulla
            </button>
            <button type="submit" className="pill-button" disabled={tokenBusy || !token.trim()}>
              {tokenBusy ? 'Verifico…' : 'Salva'}
            </button>
          </div>
        </form>
      ) : null}

      {children}
    </div>
  );
}
