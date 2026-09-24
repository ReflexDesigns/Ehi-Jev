import { useEffect, useRef, type ReactNode } from 'react';
import SoundWave from './SoundWave';
import { setHitRect, type UpdateSummary } from '../lib/osControl';
import type { AppState } from '../types';

interface NotchProps {
  state: AppState;
  status: string;
  getLevel?: () => number;
  /** Jev sta parlando: onda e testo della risposta. */
  speaking?: boolean;
  updateAvailable?: UpdateSummary | null;
  /** Callback del pulsante mostrato nello stato "setup" (configura wake word). */
  onActivate?: () => void;
  onInstallUpdate?: () => void;
  onDismissUpdate?: () => void;
  /** Pannello che espande l'isola (Impostazioni, tutorial voce). */
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
  speaking = false,
  updateAvailable = null,
  onActivate,
  onInstallUpdate,
  onDismissUpdate,
  children,
}: NotchProps) {
  const expanded = Boolean(children) || Boolean(updateAvailable);
  const notch = useRef<HTMLDivElement>(null);

  // La finestra trasparente è più grande dell'isola: i click vanno solo all'isola.
  useEffect(() => {
    const island = notch.current;
    if (!island) return;
    const observer = new ResizeObserver(() => {
      const scale = window.devicePixelRatio;
      const width = island.offsetWidth;
      void setHitRect(((window.innerWidth - width) / 2) * scale, 0, width * scale, island.offsetHeight * scale);
    });
    observer.observe(island);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={notch}
      className={`notch notch-${state}${expanded ? ' notch-expanded' : ''}${speaking ? ' notch-speaking' : ''}`}
    >
      <div className="notch-row">
        <div className="notch-status">{status}</div>
        {state === 'setup' && !expanded && onActivate ? (
          <button type="button" className="pill-button" onClick={onActivate}>
            Attiva
          </button>
        ) : (
          <SoundWave state={state} getLevel={getLevel} speaking={speaking} />
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

      {children}
    </div>
  );
}
