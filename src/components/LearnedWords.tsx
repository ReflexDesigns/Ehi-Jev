import { useEffect, useState, type FormEvent } from 'react';
import { getSettings, recordSample, saveSettings, type Settings } from '../lib/osControl';
import { learn, likeJev, words } from '../lib/voiceProfile';

interface LearnedWordsProps {
  onClose: () => void;
}

const MAX_CORRECTIONS = 64; // come in lib.rs
const MAX_OWN = 50; // come MAX_CUSTOM_PHRASES in lib.rs
const MAX_ALIASES = 8; // come in lib.rs

/**
 * Parole imparate (Impostazioni → Parole imparate): come Whisper sente la «Hey Jev»
 * dell'utente, le parole insegnate e le correzioni di Whisper, ognuna da togliere con ✕.
 * Per insegnarne una la si scrive e la
 * si dice: la prova la fa chi ascolta davvero i comandi. Con Deepgram la parola diventa
 * una sua parola chiave; con Whisper, se sente altro, nasce la correzione.
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
  const forgetPhrase = (text: string) =>
    settings && void store({ ...settings, customPhrases: settings.customPhrases.filter((p) => p !== text) });
  const forgetAlias = (alias: string) =>
    settings && void store({ ...settings, wakeAliases: settings.wakeAliases.filter((a) => a !== alias) });

  /** Un'altra «Hey Jev»: come la sente Whisper diventa un alias della riserva del rilevatore. */
  const teachWake = async () => {
    if (!settings) return;
    setRecording(true);
    setMessage('Di’: «Hey Jev»');
    try {
      const sample = await recordSample(true);
      const alias = words(sample.text).join(' ');
      if (!likeJev(alias)) setMessage(`Whisper ha sentito «${sample.text}»: non sembra «Hey Jev», riprova.`);
      else if (settings.wakeAliases.includes(alias)) setMessage(`«${alias}»: la conosce già ✓`);
      else {
        await store({ ...settings, wakeAliases: [...settings.wakeAliases, alias].slice(-MAX_ALIASES) });
        setMessage(`Imparato: «${alias}» → Hey Jev.`);
      }
    } catch (e) {
      setMessage(String(e));
    } finally {
      setRecording(false);
    }
  };

  const teach = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const expected = phrase.trim();
    if (!expected || !settings) return;
    setRecording(true);
    setMessage(`Di’: «${expected}»`);
    try {
      // Subito tra le parole chiave: la prova di Deepgram la usa già.
      const next = { ...settings, customPhrases: [...new Set([...settings.customPhrases, expected])].slice(-MAX_OWN) };
      await store(next);
      const sample = await recordSample(false);
      const understood = words(sample.text).join(' ').includes(words(expected).join(' '));
      if (settings.recognition === 'deepgram') {
        setMessage(understood ? `Deepgram: «${sample.text}» ✓` : `Deepgram ha sentito «${sample.text}».`);
      } else {
        const learned = learn(expected, sample.text);
        const corrections = new Map(next.corrections);
        for (const [heard, meant] of learned) corrections.set(heard, meant);
        await store({ ...next, corrections: [...corrections].slice(-MAX_CORRECTIONS) });
        setMessage(
          learned.length
            ? `Whisper ha sentito «${sample.text}»: imparato.`
            : understood
              ? `Whisper: «${sample.text}» ✓`
              : `Whisper ha sentito «${sample.text}»: troppo diverso per impararlo, riprova.`,
        );
      }
      setPhrase('');
    } catch (e) {
      setMessage(String(e));
    } finally {
      setRecording(false);
    }
  };

  if (!settings) return <div className="notch-panel">{message ? <p className="settings-error">{message}</p> : null}</div>;

  const deepgram = settings.recognition === 'deepgram';
  return (
    <form className="notch-panel" onSubmit={(event) => void teach(event)}>
      <p>
        {deepgram
          ? 'Ascolta Deepgram: scrivi un nome che sbaglia (un’app, una parola tua), registralo e da ora se lo aspetta.'
          : 'Ascolta Whisper: scrivi la frase, dilla, e se sente altro impara la correzione.'}
      </p>
      <div className="learned-list">
        {settings.wakeAliases.map((alias) => (
          <div className="learned-row" key={`a:${alias}`}>
            <span>
              «{alias}» → <b>Hey Jev</b>
            </span>
            <button type="button" className="icon-button" aria-label={`Dimentica ${alias}`} onClick={() => forgetAlias(alias)}>
              ✕
            </button>
          </div>
        ))}
        {settings.customPhrases.map((text) => (
          <div className="learned-row" key={`p:${text}`}>
            <b>{text}</b>
            <button type="button" className="icon-button" aria-label={`Dimentica ${text}`} onClick={() => forgetPhrase(text)}>
              ✕
            </button>
          </div>
        ))}
        {settings.corrections.map(([heard, meant]) => (
          <div className="learned-row" key={`c:${heard}`}>
            <span>
              «{heard}» → <b>{meant}</b>
              {deepgram ? ' (solo Whisper)' : ''}
            </span>
            <button type="button" className="icon-button" aria-label={`Dimentica ${heard}`} onClick={() => forget(heard)}>
              ✕
            </button>
          </div>
        ))}
        {settings.wakeAliases.length || settings.customPhrases.length || settings.corrections.length ? null : (
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
        <button type="button" className="pill-button secondary" onClick={() => void teachWake()} disabled={recording}>
          + «Hey Jev»
        </button>
        <button type="submit" className="pill-button" disabled={recording || !phrase.trim()}>
          {recording ? 'Parla ora…' : 'Registra'}
        </button>
      </div>
    </form>
  );
}
