import { useEffect, useRef, useState } from 'react';
import { deepgramKeyConfigured, getSettings, recordSample, saveSettings } from '../lib/osControl';
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

const WAKE_TIMES = 5; // più campioni = alias più affidabili per il trigger di riserva
const MAX_OWN = 50; // come MAX_CUSTOM_PHRASES in lib.rs
/** Frasi comuni a tutti: le app più usate e i comandi base. */
const COMMON = [
  'Apri Chrome',
  'Chiudi Chrome',
  'Apri Word',
  'Chiudi Word',
  'Apri Excel',
  'Chiudi Excel',
  'Apri Blocco note',
  'Chiudi Blocco note',
  'Mostra il desktop',
  'Chiudi questa finestra',
  'Apri Esplora file',
  'Crea un documento',
  'Annulla',
  'Grazie',
];
const NEXT_MS = 1100; // tempo per leggere cosa ha capito prima della frase successiva

/**
 * Registra voce (primo avvio, o Impostazioni → Registra voce). Con Deepgram basta «Hey Jev»
 * 5 volte: il trigger impara come lo dici. Con Whisper anche frasi comuni e quelle scritte
 * dall'utente: HeyJev confronta ciò che sente con ciò che era scritto e impara le correzioni.
 */
export default function VoiceTutorial({ onDone, onSkip }: VoiceTutorialProps) {
  const [steps, setSteps] = useState<Step[] | null>(null); // null = introduzione
  // 'wake' = solo «Hey Jev» (ascolta Deepgram); 'full' = anche le frasi (ascolta Whisper)
  const [mode, setMode] = useState<'wake' | 'full' | null>(null);
  const [own, setOwn] = useState(''); // frasi dell'utente, una per riga
  const [index, setIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [heard, setHeard] = useState('');
  const [error, setError] = useState('');
  const results = useRef<TutorialResult[]>([]);
  // Callback in un ref: un nuovo render dell'App non deve far ripartire la registrazione.
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    Promise.all([getSettings(), deepgramKeyConfigured()]).then(
      ([settings, deepgram]) => {
        setMode(settings.recognition === 'deepgram' && deepgram ? 'wake' : 'full');
        setOwn(settings.customPhrases.join('\n'));
      },
      () => setMode('full'),
    );
  }, []);

  const start = async () => {
    const wake = Array.from({ length: WAKE_TIMES }, () => ({ text: 'Hey Jev', wake: true }));
    if (mode === 'wake') return setSteps(wake);
    const mine = [...new Set(own.split('\n').map((line) => line.trim()).filter(Boolean))].slice(0, MAX_OWN);
    const settings = await getSettings().catch(() => null);
    if (settings) await saveSettings({ ...settings, customPhrases: mine }).catch(() => undefined);
    const phrases = [...COMMON, ...mine];
    setSteps([...wake, ...phrases.map((text) => ({ text, wake: false }))]);
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
          const learned = profile.corrections ? ` · ${profile.corrections.length} correzioni imparate` : '';
          done.current(`Fatto! «Hey Jev» riconosciuta ${wakeHits}/${wakeTotal}${backup}${learned}.`);
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
        {mode === 'wake' ? (
          <p>
            Prima di iniziare: di’ «Hey Jev» cinque volte, con il tuo tono normale. HeyJev impara come lo dici, così
            ti sente al primo colpo. Venti secondi.
          </p>
        ) : (
          <>
            <p>
              Registra la tua voce per Whisper: dirai «Hey Jev» cinque volte e leggerai i comandi più comuni (apri e
              chiudi Chrome, Word, Excel…). Aggiungi qui le parole o i nomi di app che non capisce, una per riga: te le
              farò ripetere.
            </p>
            <textarea
              className="own-phrases"
              rows={3}
              spellCheck={false}
              value={own}
              onChange={(e) => setOwn(e.target.value)}
              placeholder={'Apri SmileSync\nApri PitStop'}
              aria-label="Frasi da insegnare"
            />
          </>
        )}
        <div className="panel-actions">
          <button type="button" className="pill-button secondary" onClick={onSkip}>
            Salta
          </button>
          <button type="button" className="pill-button" disabled={!mode} onClick={() => void start()}>
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
