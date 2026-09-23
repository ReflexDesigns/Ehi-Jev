import SoundWave from './SoundWave';
import type { AudioFrame } from '../lib/micRecorder';
import type { AppState } from '../types';

interface NotchProps {
  state: AppState;
  status: string;
  getFrame?: () => AudioFrame;
  /** Callback del pulsante mostrato nello stato "setup" (configura wake word). */
  onActivate?: () => void;
}

/**
 * "The Notch" - overlay fluttuante frameless in cima allo schermo.
 *
 * Il movimento (discesa dall'orlo / riassorbimento) è gestito via CSS:
 * la classe .notch-<state> controlla la transform translateY.
 */
export default function Notch({ state, status, getFrame, onActivate }: NotchProps) {
  return (
    <div className={`notch notch-${state}`}>
      <div className="notch-inner">
        <div className="notch-icon">
          <img src="/app-icon.svg" alt="HeyJev" draggable={false} />
        </div>
        <div className="notch-body">
          <SoundWave state={state} getFrame={getFrame} />
          <div className="notch-status">{status}</div>
        </div>
        {state === 'setup' && onActivate ? (
          <button type="button" className="activate-button" onClick={onActivate}>
            Attiva
          </button>
        ) : null}
      </div>
    </div>
  );
}
