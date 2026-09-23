import { useEffect, useRef, useState } from 'react';
import { getSettings, listApps, recordSample, saveSettings } from '../lib/osControl';
import { buildProfile, type TutorialResult } from '../lib/voiceProfile';

interface VoiceTutorialProps {
  /** Tutorial finito: riepilogo da mostrare nell'isola. */
  onDone: (summary: string) => void;
  onSkip: () => void;
}

interface Step {
  text: string;
  wake: boolean;
}

const WAKE_TIMES = 3;
const ITALIAN = ['Apri il terminale', 'Mostra il desktop', 'Crea un documento', 'Apri Esplora file', 'Annulla', 'Grazie'];
const ENGLISH = ['Open the terminal', 'Show desktop', 'Check for updates', 'Thank you'];
const NEXT_MS = 1100; // tempo per leggere cosa ha capito prima della frase successiva

/** Due app installate con nomi brevi: i nomi propri sono quelli che Whisper sbaglia di più. */
function pickApps(names: string[]): string[] {
  const usable = [...new Set(names)].filter(
    (name) =>
      name.split(/\s+/).length <= 2 &&
      !/microsoft|windows|guida|help|setup|installer|impostazioni|settings/i.test(name) &&
      ![...ITALIAN, ...ENGLISH].some((phrase) => phrase.toLowerCase().includes(name.toLowerCase())),
  );
  return usable.sort(() => Math.random() - 0.5).slice(0, 2);
}

/**
 * Tutorial voce (primo avvio, o Impostazioni → Tutorial voce): «Hey Jev» tre volte, poi
 * frasi in italiano e in inglese. HeyJev confronta ciò che sente con ciò che era scritto.
 */
export default function VoiceTutorial({ onDone, onSkip }: VoiceTutorialProps) {
  const [steps, setSteps] = useState<Step[] | null>(null); // null = introduzione
  const [index, setIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [heard, setHeard] = useState('');
  const [error, setError] = useState('');
  const results = useRef<TutorialResult[]>([]);
  // Callback in un ref: un nuovo render dell'App non deve far ripartire la registrazione.
  const done = useRef(onDone);
  done.current = onDone;

  const start = async () => {
    const apps = pickApps(await listApps().catch(() => []));
    const phrases = [...ITALIAN, ...apps.map((app) => `Apri ${app}`), ...ENGLISH];
    setSteps([
      ...Array.from({ length: WAKE_TIMES }, () => ({ text: 'Hey Jev', wake: true })),
      ...phrases.map((text) => ({ text, wake: false })),
    ]);
  };

  useEffect(() => {
    if (!steps) return;
    let cancelled = false;
    if (index >= steps.length) {
      const { profile, wakeHits, wakeTotal } = buildProfile(results.current);
      getSettings()
        .then((settings) => saveSettings({ ...settings, ...profile, voiceTrained: true }))
        .then(() => {
          if (cancelled) return;
          const backup = profile.wakeAliases.length ? ' · attivo anche l’ascolto di riserva' : '';
          done.current(`Fatto! «Hey Jev» riconosciuta ${wakeHits}/${wakeTotal}${backup} · ${profile.corrections.length} correzioni imparate.`);
        })
        .catch((e) => !cancelled && setError(`Salvataggio non riuscito: ${String(e)}`));
      return () => {
        cancelled = true;
      };
    }
    const step = steps[index];
    setHeard('');
    setError('');
    recordSample(step.wake).then(
      (sample) => {
        if (cancelled) return;
        results.current.push({ expected: step.text, wake: step.wake, sample });
        setHeard(sample.text || '…');
        window.setTimeout(() => !cancelled && setIndex((i) => i + 1), NEXT_MS);
      },
      (e) => !cancelled && setError(String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [steps, index, attempt]);

  if (!steps) {
    return (
      <div className="notch-panel">
        <p>
          Insegnami la tua voce: dirai «Hey Jev» tre volte e leggerai qualche frase in italiano e in inglese, con il tuo
          tono normale. Un minuto circa.
        </p>
        <div className="panel-actions">
          <button type="button" className="pill-button secondary" onClick={onSkip}>
            Salta
          </button>
          <button type="button" className="pill-button" onClick={() => void start()}>
            Inizia
          </button>
        </div>
      </div>
    );
  }

  const step = steps[Math.min(index, steps.length - 1)];
  return (
    <div className="notch-panel">
      <p>
        {step.wake ? 'Chiamami come faresti di solito' : 'Leggi ad alta voce'} · {Math.min(index + 1, steps.length)}/
        {steps.length}
      </p>
      <div className="tutorial-phrase">«{step.text}»</div>
      <p className={error ? 'settings-error' : undefined}>
        {error || (index >= steps.length ? 'Salvo il profilo voce…' : heard ? `Ho sentito: «${heard}»` : 'Parla ora…')}
      </p>
      <div className="panel-actions">
        <button type="button" className="pill-button secondary" onClick={onSkip}>
          Esci
        </button>
        {error && index < steps.length ? (
          <>
            <button type="button" className="pill-button secondary" onClick={() => setIndex((i) => i + 1)}>
              Salta frase
            </button>
            <button type="button" className="pill-button" onClick={() => setAttempt((a) => a + 1)}>
              Riprova
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
