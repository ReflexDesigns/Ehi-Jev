import { useEffect, useState, type FormEvent } from 'react';
import { getSettings, recordSample, saveSettings, type Settings } from '../lib/osControl';
import { learn } from '../lib/voiceProfile';

interface LearnedWordsProps {
  onClose: () => void;
}

const MAX_CORRECTIONS = 64; // come in lib.rs
const MAX_OWN = 50; // come MAX_CUSTOM_PHRASES in lib.rs

/**
 * Parole imparate (Impostazioni → Parole imparate): cosa ha imparato Whisper dalla voce
 * dell'utente, con la possibilità di toglierne una o di insegnarne una nuova al volo:
 * la si scrive, la si dice, e se Whisper sente altro nasce la correzione.
 */
export default function LearnedWords({ onClose }: LearnedWordsProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [phrase, setPhrase] = useState('');
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    getSettings().then(setSettings, (e) => setMessage(String(e)));
  }, []);

  const store = async (next: Settings) => {
    await saveSettings(next);
    setSettings(next);
  };

  const forget = (heard: string) =>
    settings && void store({ ...settings, corrections: settings.corrections.filter(([h]) => h !== heard) });

  const teach = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const expected = phrase.trim();
    if (!expected || !settings) return;
    setRecording(true);
    setMessage(`Di’: «${expected}»`);
    try {
      const sample = await recordSample(false);
      const learned = learn(expected, sample.text);
      const corrections = new Map(settings.corrections);
      for (const [heard, meant] of learned) corrections.set(heard, meant);
      await store({
        ...settings,
        corrections: [...corrections].slice(-MAX_CORRECTIONS),
        customPhrases: [...new Set([...settings.customPhrases, expected])].slice(-MAX_OWN),
      });
      setMessage(learned.length ? `Ho sentito «${sample.text}»: imparato.` : `Ho sentito «${sample.text}»: la capisco già ✓`);
      setPhrase('');
    } catch (e) {
      setMessage(String(e));
    } finally {
      setRecording(false);
    }
  };

  if (!settings) return <div className="notch-panel">{message ? <p className="settings-error">{message}</p> : null}</div>;

  return (
    <form className="notch-panel" onSubmit={(event) => void teach(event)}>
      {settings.recognition === 'deepgram' ? (
        <p>Con Deepgram queste correzioni non servono: valgono quando ascolta Whisper.</p>
      ) : null}
      <p>Come ti chiama: {settings.wakeAliases.length ? settings.wakeAliases.map((a) => `«${a}»`).join(', ') : '«Hey Jev» (riconosciuto al primo colpo)'}</p>
      <div className="learned-list">
        {settings.corrections.length ? (
          settings.corrections.map(([heard, meant]) => (
            <div className="learned-row" key={heard}>
              <span>
                «{heard}» → <b>{meant}</b>
              </span>
              <button type="button" className="icon-button" aria-label={`Dimentica ${heard}`} onClick={() => forget(heard)}>
                ✕
              </button>
            </div>
          ))
        ) : (
          <p>Nessuna parola imparata finora.</p>
        )}
      </div>
      <input
        className="wide"
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
        placeholder="Parola o frase da insegnare, es. Apri SmileSync"
        aria-label="Parola o frase da insegnare"
        disabled={recording}
      />
      {message ? <p className="learned-message">{message}</p> : null}
      <div className="panel-actions">
        <button type="button" className="pill-button secondary" onClick={onClose}>
          Chiudi
        </button>
        <button type="submit" className="pill-button" disabled={recording || !phrase.trim()}>
          {recording ? 'Parla ora…' : 'Registra'}
        </button>
      </div>
    </form>
  );
}
