import { useEffect, useState, type FormEvent } from 'react';
import {
  aiKeyConfigured,
  deepgramKeyConfigured,
  getSettings,
  jevKeyConfigured,
  saveAiKey,
  saveDeepgramKey,
  saveJevKey,
  saveSettings,
  type Settings,
} from '../lib/osControl';

interface SettingsPanelProps {
  onClose: () => void;
  onCheckUpdate: () => void;
  onTutorial: () => void;
  onKeys: () => void;
  onLearned: () => void;
  /** Salvato passando da Deepgram a Whisper: serve la registrazione completa. */
  onWhisperChosen: () => void;
}

const SENSITIVITY = ['Bassa', 'Medio-bassa', 'Media', 'Alta', 'Molto alta'];

/** Impostazioni (icona nella tray: clic, oppure tasto destro → Impostazioni…). */
export default function SettingsPanel({
  onClose,
  onCheckUpdate,
  onTutorial,
  onKeys,
  onLearned,
  onWhisperChosen,
}: SettingsPanelProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [initialRecognition, setInitialRecognition] = useState('');
  const [aiKey, setAiKey] = useState('');
  const [jevKey, setJevKey] = useState('');
  const [deepgramKey, setDeepgramKey] = useState('');
  const [deepgramReady, setDeepgramReady] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const [jevReady, setJevReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getSettings().then(
      (loaded) => {
        setSettings(loaded);
        setInitialRecognition(loaded.recognition);
      },
      (e) => setError(String(e)),
    );
    aiKeyConfigured().then(setAiReady, () => undefined);
    jevKeyConfigured().then(setJevReady, () => undefined);
    deepgramKeyConfigured().then(setDeepgramReady, () => undefined);
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) return;
    setSaving(true);
    try {
      if (aiKey.trim()) await saveAiKey(aiKey);
      if (jevKey.trim()) await saveJevKey(jevKey);
      if (deepgramKey.trim()) await saveDeepgramKey(deepgramKey);
      await saveSettings(settings);
      if (settings.recognition === 'local' && initialRecognition !== 'local') onWhisperChosen();
      else onClose();
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
            <span>Chi ascolta i comandi</span>
            <select
              value={settings.recognition}
              onChange={(e) => update({ recognition: e.target.value as Settings['recognition'] })}
            >
              <option value="deepgram">Deepgram (online)</option>
              <option value="local">Whisper (offline)</option>
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
            <span>Notifica quando un documento o sito è pronto</span>
            <input
              type="checkbox"
              checked={settings.notifications}
              onChange={(e) => update({ notifications: e.target.checked })}
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
          <label className="settings-row">
            <span>Chiave Deepgram (ascolto e voce)</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={deepgramKey}
              onChange={(e) => setDeepgramKey(e.target.value)}
              placeholder={deepgramReady ? 'Salvata ✓' : 'chiave API'}
            />
          </label>
          <label className="settings-row">
            <span>Chiave Jev (esegue i comandi)</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={jevKey}
              onChange={(e) => setJevKey(e.target.value)}
              placeholder={jevReady ? 'Salvata ✓' : 'chiave TypeSafe'}
            />
          </label>
        </>
      ) : null}
      {error ? <p className="settings-error">{error}</p> : null}
      <div className="panel-actions">
        <button type="button" className="pill-button secondary" onClick={onCheckUpdate}>
          Aggiornamenti
        </button>
        <button type="button" className="pill-button secondary" onClick={onKeys}>
          Chiavi
        </button>
        <button type="button" className="pill-button secondary" onClick={onTutorial}>
          Registra voce
        </button>
        <button type="button" className="pill-button secondary" onClick={onLearned}>
          Parole imparate
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
