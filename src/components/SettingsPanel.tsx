import { useEffect, useState, type FormEvent } from 'react';
import { getSettings, saveSettings, type Settings } from '../lib/osControl';

interface SettingsPanelProps {
  onClose: () => void;
  onCheckUpdate: () => void;
  onConfigureToken: () => void;
}

const SENSITIVITY = ['Bassa', 'Medio-bassa', 'Media', 'Alta', 'Molto alta'];

/** Impostazioni (tasto destro sull'icona nella tray → Impostazioni…). */
export default function SettingsPanel({ onClose, onCheckUpdate, onConfigureToken }: SettingsPanelProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getSettings().then(setSettings, (e) => setError(String(e)));
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) return;
    try {
      await saveSettings(settings);
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  const update = (patch: Partial<Settings>) => setSettings((current) => (current ? { ...current, ...patch } : current));

  return (
    <form className="token-panel settings-panel" onSubmit={(event) => void submit(event)}>
      <div className="token-panel-title">Impostazioni HeyJev</div>
      {settings ? (
        <>
          <label className="settings-row">
            <span>Lingua dei comandi</span>
            <select value={settings.language} onChange={(e) => update({ language: e.target.value })}>
              <option value="it">Italiano</option>
              <option value="en">English</option>
              <option value="auto">Automatica</option>
            </select>
          </label>
          <label className="settings-row">
            <span>
              Sensibilità microfono <b>{SENSITIVITY[settings.micSensitivity - 1]}</b>
            </span>
            <input
              type="range"
              min={1}
              max={5}
              step={1}
              value={settings.micSensitivity}
              onChange={(e) => update({ micSensitivity: Number(e.target.value) })}
            />
          </label>
          <label className="settings-row">
            <span>
              Smetti di ascoltare dopo <b>{settings.idleSeconds.toFixed(1)} s</b> di silenzio
            </span>
            <input
              type="range"
              min={1}
              max={6}
              step={0.5}
              value={settings.idleSeconds}
              onChange={(e) => update({ idleSeconds: Number(e.target.value) })}
            />
          </label>
        </>
      ) : null}
      {error ? <p className="settings-error">{error}</p> : null}
      <div className="token-panel-actions">
        <button type="button" className="secondary-button" onClick={onCheckUpdate}>
          Controlla aggiornamenti
        </button>
        <button type="button" className="secondary-button" onClick={onConfigureToken}>
          Token GitHub…
        </button>
        <button type="button" className="secondary-button" onClick={onClose}>
          Chiudi
        </button>
        <button type="submit" disabled={!settings}>
          Salva
        </button>
      </div>
    </form>
  );
}
