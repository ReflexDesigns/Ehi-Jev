import { useEffect, useState, type FormEvent } from 'react';
import { aiKeyConfigured, getSettings, saveAiKey, saveSettings, type Settings } from '../lib/osControl';

interface SettingsPanelProps {
  onClose: () => void;
  onCheckUpdate: () => void;
  onConfigureToken: () => void;
}

const SENSITIVITY = ['Bassa', 'Medio-bassa', 'Media', 'Alta', 'Molto alta'];

/** Impostazioni (icona nella tray: clic, oppure tasto destro → Impostazioni…). */
export default function SettingsPanel({ onClose, onCheckUpdate, onConfigureToken }: SettingsPanelProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [aiKey, setAiKey] = useState('');
  const [aiReady, setAiReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getSettings().then(setSettings, (e) => setError(String(e)));
    aiKeyConfigured().then(setAiReady, () => undefined);
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) return;
    setSaving(true);
    try {
      if (aiKey.trim()) await saveAiKey(aiKey);
      await saveSettings(settings);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const update = (patch: Partial<Settings>) => setSettings((current) => (current ? { ...current, ...patch } : current));

  return (
    <form className="notch-panel" onSubmit={(event) => void submit(event)}>
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
              Chiudi dopo <b>{settings.idleSeconds.toFixed(1)} s</b> di silenzio
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
          <label className="settings-row">
            <span>Chiave OpenRouter</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={aiKey}
              onChange={(e) => setAiKey(e.target.value)}
              placeholder={aiReady ? 'Salvata ✓' : 'sk-or-…'}
            />
          </label>
        </>
      ) : null}
      {error ? <p className="settings-error">{error}</p> : null}
      <div className="panel-actions">
        <button type="button" className="pill-button secondary" onClick={onCheckUpdate}>
          Aggiornamenti
        </button>
        <button type="button" className="pill-button secondary" onClick={onConfigureToken}>
          Token GitHub
        </button>
        <button type="button" className="pill-button secondary" onClick={onClose}>
          Chiudi
        </button>
        <button type="submit" className="pill-button" disabled={!settings || saving}>
          {saving ? 'Verifico…' : 'Salva'}
        </button>
      </div>
    </form>
  );
}
