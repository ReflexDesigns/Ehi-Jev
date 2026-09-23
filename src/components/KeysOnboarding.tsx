import { useEffect, useState, type FormEvent } from 'react';
import {
  aiKeyConfigured,
  deepgramKeyConfigured,
  jevKeyConfigured,
  openLink,
  saveAiKey,
  saveDeepgramKey,
  saveJevKey,
} from '../lib/osControl';

interface KeysOnboardingProps {
  /** Finito (o saltato fino in fondo): riepilogo da mostrare nell'isola. */
  onDone: (summary: string) => void;
}

interface KeyStep {
  name: string;
  role: string;
  why: string;
  /** Pagina dove si crea la chiave: deve essere tra quelle ammesse da `open_link` (lib.rs). */
  url: string;
  how: string;
  configured: () => Promise<boolean>;
  save: (key: string) => Promise<void>;
}

// ponytail: niente cifre dei crediti gratuiti nel testo, cambiano nel tempo.
const STEPS: KeyStep[] = [
  {
    name: 'Deepgram',
    role: 'ascolto e voce',
    why: 'Trascrive quello che dici in tempo reale, in italiano, e dà la voce agli avvisi.',
    url: 'https://console.deepgram.com/signup',
    how: 'Crea l’account (credito gratuito all’iscrizione, senza carta) → API Keys → Create a New API Key → copiala e incollala qui.',
    configured: deepgramKeyConfigured,
    save: saveDeepgramKey,
  },
  {
    name: 'Jev',
    role: 'esegue i comandi',
    why: 'Capisce i comandi detti a modo tuo e sceglie l’app giusta in mezzo secondo.',
    url: 'https://console.typesafe.ai',
    how: 'Accedi alla console TypeSafe → API Keys → crea una chiave → copiala e incollala qui.',
    configured: jevKeyConfigured,
    save: saveJevKey,
  },
  {
    name: 'OpenRouter',
    role: 'documenti e siti',
    why: 'Gemini scrive i documenti, DeepSeek crea siti e MVP.',
    url: 'https://openrouter.ai/keys',
    how: 'Accedi → Credits: aggiungi qualche euro (si paga a consumo) → Keys → Create Key → copiala e incollala qui.',
    configured: aiKeyConfigured,
    save: saveAiKey,
  },
];

function summary(ready: boolean[]): string {
  const count = ready.filter(Boolean).length;
  return count === STEPS.length
    ? 'Chiavi a posto: HeyJev è pronta.'
    : `${count}/${STEPS.length} chiavi configurate · le altre da Impostazioni → Chiavi.`;
}

/**
 * Onboarding delle chiavi API, una alla volta: a cosa serve, dove si crea, incolla, verifica.
 * Ogni chiave viene provata sul servizio prima di finire nel Credential Manager di Windows.
 */
export default function KeysOnboarding({ onDone }: KeysOnboardingProps) {
  const [index, setIndex] = useState(0);
  const [ready, setReady] = useState<boolean[]>(STEPS.map(() => false));
  const [key, setKey] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void Promise.all(STEPS.map((step) => step.configured().catch(() => false))).then(setReady);
  }, []);

  const step = STEPS[index];
  const configured = ready[index] && !editing;

  const next = (current = ready) => {
    setKey('');
    setError('');
    setEditing(false);
    if (index + 1 < STEPS.length) setIndex(index + 1);
    else onDone(summary(current));
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!key.trim()) return;
    setBusy(true);
    setError('');
    try {
      await step.save(key.trim());
      const current = ready.map((value, i) => value || i === index);
      setReady(current);
      next(current);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="notch-panel" onSubmit={(event) => void save(event)}>
      <p>
        Chiave {index + 1}/{STEPS.length} · {step.role}
      </p>
      <div className="tutorial-phrase">{step.name}</div>
      <p>{step.why}</p>
      {configured ? (
        <p className="key-ok">✓ Già configurata.</p>
      ) : (
        <>
          <p>{step.how}</p>
          <input
            className="wide"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={`Chiave ${step.name}`}
            aria-label={`Chiave ${step.name}`}
          />
        </>
      )}
      {error ? <p className="settings-error">{error}</p> : null}
      <div className="panel-actions">
        {configured ? (
          <>
            <button type="button" className="pill-button secondary" onClick={() => setEditing(true)}>
              Cambia
            </button>
            <button type="button" className="pill-button" onClick={() => next()}>
              Avanti
            </button>
          </>
        ) : (
          <>
            <button type="button" className="pill-button secondary" onClick={() => void openLink(step.url)}>
              Apri {step.name}
            </button>
            <button type="button" className="pill-button secondary" onClick={() => next()}>
              Salta
            </button>
            <button type="submit" className="pill-button" disabled={busy || !key.trim()}>
              {busy ? 'Verifico…' : 'Verifica e salva'}
            </button>
          </>
        )}
      </div>
    </form>
  );
}
