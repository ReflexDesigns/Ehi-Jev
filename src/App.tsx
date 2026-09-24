import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import Notch from './components/Notch';
import SettingsPanel from './components/SettingsPanel';
import KeysOnboarding from './components/KeysOnboarding';
import LearnedWords from './components/LearnedWords';
import VoiceTutorial from './components/VoiceTutorial';
import { parseCommands } from './lib/commandParser';
import {
  aiCreate,
  aiKeyConfigured,
  cancelPower,
  deepgramKeyConfigured,
  checkForUpdate,
  closeApp,
  endSession,
  executeAction,
  getSettings,
  hideWindow,
  installPendingUpdate,
  interpret,
  jevKeyConfigured,
  openApp,
  saveSettings,
  setListening,
  setWakeEnabled,
  showWindow,
  speak,
  typeText,
  pressKeys,
  webSearch,
  startWakeListener,
  type Settings,
  type ToolCall,
  type UpdateSummary,
} from './lib/osControl';
import { applyCorrections, type Correction } from './lib/voiceProfile';
import type { AppState } from './types';

/**
 * HeyJev - Direttore Operativo Vocale del PC.
 *
 * «Hey Jev» apre una sessione: il backend Rust manda il microfono a Deepgram in
 * streaming (o taglia le frasi per Whisper locale) e la UI esegue i comandi appena
 * arrivano. Le frasi che il parser non riconosce le interpreta Jev (TypeSafe, ~0,4 s;
 * Gemini di riserva) e HeyJev le esegue: laconico, la voce Maia parla solo per errori e avvisi. La sessione finisce dopo qualche secondo di
 * silenzio (Impostazioni) oppure con «grazie» / «ok» / «silenzio».
 * «Crea un documento/sito…» avvia una dettatura: tutto ciò che segue fino alla fine
 * della sessione è la richiesta, eseguita in background da OpenRouter.
 *
 *   idle ──(wake word)──▶ listening ──(silenzio | grazie)──▶ closing ──▶ idle
 */

const WAKE_RETRY_MS = 5000; // riavvio del rilevatore dopo un errore microfono
const LAST_RESULT_MS = 700; // l'ultimo esito resta visibile prima di chiudere
const NOTICE_MS = 4000; // avviso a fine lavoro AI

/** «… e premi invio» (come split_enter in lib.rs). */
const ENTER = /(?:premi invio|e invia|dai invio|e invio|e avvio|press enter)[\s.!,;]*$/i;
/** Fermano lo spegnimento del PC in attesa, anche storpiate («a nulla», «nulla» tagliato
 *  dopo la wake word): meglio un PC acceso per sbaglio che uno spento per sbaglio. */
const ABORT = /\b(?:(?:a\s*)?n+ul+[aeio]\w*|cancel\w*|stop|basta|no|ferm[aio]\w*|aspetta)\b/i;

type Panel = 'settings' | 'keys' | 'tutorial' | 'learned';
const PANEL_TITLES: Record<Panel, string> = {
  settings: 'Impostazioni',
  keys: 'Chiavi API',
  tutorial: 'Registra voce',
  learned: 'Parole imparate',
};
/** Strumenti di Jev che corrispondono ad azioni già esistenti. */
const TOOL_ACTIONS: Record<string, string> = {
  open_terminal: 'open_terminal',
  open_claude: 'open_claude',
  open_chatgpt: 'open_gpt',
  show_desktop: 'show_desktop',
  close_window: 'close_current',
};

export default function App() {
  const [state, setState] = useState<AppState>('setup');
  const [status, setStatus] = useState('Avvio del motore vocale…');
  const [panel, setPanel] = useState<Panel | null>(null); // pannello aperto nell'isola
  const [updateAvailable, setUpdateAvailable] = useState<UpdateSummary | null>(null);
  const [speaking, setSpeaking] = useState(false); // Jev sta parlando: onda "calda"

  const stateRef = useRef<AppState>('idle');
  const levelRef = useRef(0);
  const wakeReadyRef = useRef(false);
  const wakeStartingRef = useRef(false);
  const sessionRef = useRef(false); // sessione di ascolto Rust attiva
  const busyRef = useRef(0); // comandi in esecuzione
  const holdRef = useRef(false); // pannello aperto: non chiudere da soli
  const draftRef = useRef<{ kind: string; text: string } | null>(null); // richiesta AI in dettatura
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const toolsRef = useRef<Promise<void>>(Promise.resolve()); // strumenti scelti da Jev
  const correctionsRef = useRef<Correction[]>([]); // imparate nel tutorial voce
  const typedRef = useRef(false); // nella sessione si è già scritto (senza Invio): serve lo spazio

  /** Le correzioni del tutorial sono errori tipici di Whisper: con Deepgram non servono
   *  (e "fa il" → "file" rovinerebbe "che tempo fa il weekend"). */
  const loadCorrections = (settings: Settings | null) => {
    correctionsRef.current = settings?.recognition === 'local' ? settings.corrections : [];
  };

  const applyState = useCallback((s: AppState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  /** Chiusura: la pillola si restringe e risale, poi click-through. */
  const close = useCallback(async () => {
    holdRef.current = false;
    setPanel(null);
    setUpdateAvailable(null);
    applyState('closing');
    setStatus('');
    window.setTimeout(async () => {
      if (stateRef.current !== 'closing') return;
      try {
        await setListening(false);
        await setWakeEnabled(true);
        await hideWindow();
        applyState('idle');
      } catch (error) {
        wakeReadyRef.current = false;
        applyState('setup');
        setStatus(`Riattivazione wake word non riuscita: ${String(error)}`);
      }
    }, 420);
  }, [applyState]);

  /** Esito di un lavoro AI in background: nella sessione aperta, altrimenti avviso di qualche secondo. */
  const notify = useCallback((message: string) => {
    setStatus(message);
    void speak(message.split(':')[0]); // "Documento salvato in Download", senza il nome file
    if (sessionRef.current || holdRef.current || stateRef.current === 'setup') return;
    applyState('done');
    window.setTimeout(() => {
      if (stateRef.current === 'done' && !sessionRef.current && !holdRef.current) void close();
    }, NOTICE_MS);
  }, [applyState, close]);

  const submitDraft = useCallback(() => {
    const draft = draftRef.current;
    draftRef.current = null;
    if (!draft) return;
    setStatus(draft.kind === 'create_document' ? 'Gemini scrive il documento…' : 'DeepSeek prepara il progetto…');
    aiCreate(draft.kind, draft.text).then(notify, (error) => notify(`Errore AI: ${String(error)}`));
  }, [notify]);

  /** Fine sessione (silenzio o «grazie»): dopo le frasi in coda invia la dettatura e chiude. */
  const finishSession = useCallback(() => {
    queueRef.current = queueRef.current.then(() => {
      sessionRef.current = false;
      submitDraft();
      if (holdRef.current) return;
      window.setTimeout(() => {
        // Non chiudere un avviso AI o una nuova sessione nati nel frattempo.
        if (stateRef.current === 'listening' && !sessionRef.current) void close();
      }, LAST_RESULT_MS);
    });
  }, [close, submitDraft]);

  /** Pannelli che richiedono l'utente: ferma la sessione e tiene aperto il notch. */
  const hold = useCallback(async (next: AppState) => {
    holdRef.current = true;
    if (sessionRef.current) await endSession();
    sessionRef.current = false;
    applyState(next);
  }, [applyState]);

  const checkUpdates = useCallback(async () => {
    setStatus('Controllo aggiornamenti…');
    try {
      const available = await checkForUpdate();
      if (!available) return 'HeyJev è aggiornata.';
      await hold('done');
      setUpdateAvailable(available);
      return `È disponibile HeyJev ${available.version}. Conferma con il pulsante per installarla.`;
    } catch (error) {
      return `Errore: ${String(error)}`;
    }
  }, [hold]);

  /** Esito a schermo. Laconico: a voce (`say`) solo errori e avvisi (l'app che si apre è già la risposta). */
  const report = useCallback((message: string) => setStatus(message), []);
  const say = useCallback((message: string) => {
    setStatus(message);
    void speak(message);
  }, []);

  /** Esegue in ordine i comandi di una frase. */
  const runCommands = useCallback(async (heard: string) => {
    const transcript = applyCorrections(heard, correctionsRef.current);
    // Prima di tutto, e senza chiudere: se Jev la prendesse per un saluto il PC si spegnerebbe.
    if (ABORT.test(transcript) && (await cancelPower())) {
      say('Annullato.');
      return;
    }
    let actions = parseCommands(transcript);
    const draft = draftRef.current;
    if (draft && /^\W*annulla\b/i.test(transcript)) {
      // «Annulla» durante una dettatura la butta, non la manda all'AI.
      draftRef.current = null;
      say('Annullato.');
      await endSession();
      return;
    }
    if (draft) {
      // Dettatura per l'AI: ogni frase si aggiunge alla richiesta, «grazie» la invia.
      draft.text += ` ${transcript}`;
      setStatus(`✍️ ${draft.text}`);
      if (actions[actions.length - 1] === 'cancel') await endSession();
      return;
    }
    if (!actions.length || actions[0] === 'interpret') {
      // Il parser non la riconosce, o ne avanza un pezzo: Jev sceglie, Gemini se servono più
      // azioni, testo o tasti (app:tool → runTool).
      try {
        setStatus(transcript);
        await interpret(transcript);
        return;
      } catch {
        // Né Jev né Gemini configurati o raggiungibili: restano i comandi riconosciuti.
        actions = actions.filter((action) => action !== 'interpret');
      }
    }
    if (!actions.length) {
      setStatus(`Non riconosciuto: "${transcript}"`);
      return;
    }
    for (const action of actions) {
      if (action === 'create_document' || action === 'create_project') {
        draftRef.current = { kind: action, text: transcript };
        setStatus(`✍️ ${transcript}`);
        if (actions[actions.length - 1] === 'cancel') await endSession();
        return;
      }
      if (action === 'cancel') {
        // «Spegni il PC, annulla» nella stessa frase; «spegni il PC, grazie» no.
        if (ABORT.test(transcript) && (await cancelPower())) say('Annullato.');
        else setStatus('Ciao! 👋');
        await endSession(); // Rust risponde con app:session-end
        return;
      }
      if (action === 'shutdown' || action === 'restart') {
        // A voce solo «Spengo il PC tra 15 secondi»: se Maia dicesse «annulla», il filtro
        // dell'eco scarterebbe l'«annulla» dell'utente. Come fermarlo resta scritto.
        const notice = await executeAction(action);
        setStatus(notice);
        void speak(notice.split(':')[0]);
        continue;
      }
      if (action.startsWith('open_app:')) {
        report(await openApp(action.slice('open_app:'.length)));
        continue;
      }
      if (action.startsWith('close_app:')) {
        report(await closeApp(action.slice('close_app:'.length)));
        continue;
      }
      if (action.startsWith('search:')) {
        report(await webSearch(action.slice('search:'.length)));
        continue;
      }
      if (action.startsWith('type_text:')) {
        // «Scrivi …» di seguito: i pezzi si separano con uno spazio, tranne dopo un Invio.
        const text = action.slice('type_text:'.length);
        report(await typeText(typedRef.current ? ` ${text}` : text));
        typedRef.current = !ENTER.test(text);
        continue;
      }
      if (action.startsWith('press_keys:')) {
        report(await pressKeys(action.slice('press_keys:'.length)));
        typedRef.current = false;
        continue;
      }
      if (action === 'check_update') {
        report(await checkUpdates());
        if (holdRef.current) return;
        continue;
      }
      report(await executeAction(action));
    }
  }, [checkUpdates, report, say]);

  /** Strumento scelto da Jev: si esegue subito, fuori dalla coda delle frasi. */
  const runTool = useCallback(async ({ name, args }: ToolCall) => {
    try {
      if (name in TOOL_ACTIONS) report(await executeAction(TOOL_ACTIONS[name]));
      else if (name === 'open_app') report(await openApp(args.name ?? ''));
      else if (name === 'close_app') report(await closeApp(args.name ?? ''));
      else if (name === 'web_search') report(await webSearch(args.query ?? ''));
      else if (name === 'type_text') report(await typeText(args.text ?? ''));
      else if (name === 'press_keys') report(await pressKeys(args.keys ?? ''));
      else if (name === 'check_updates') report(await checkUpdates());
      else if (name === 'create_document' || name === 'create_website') {
        const kind = name === 'create_document' ? 'create_document' : 'create_project';
        report(kind === 'create_document' ? 'Gemini scrive il documento…' : 'DeepSeek prepara il progetto…');
        aiCreate(kind, args.request ?? '').then(notify, (error) => notify(`Errore AI: ${String(error)}`));
      } else if (name === 'end_conversation') {
        setStatus('Ciao! 👋');
        await endSession();
      } else if (name === 'not_a_command') report('Non è un comando.');
    } catch (error) {
      say(String(error));
    }
  }, [checkUpdates, say, notify, report]);

  /** Le frasi arrivano mentre si parla: una coda le esegue una alla volta. */
  const handleTranscript = useCallback((transcript: string) => {
    queueRef.current = queueRef.current.then(async () => {
      if (!sessionRef.current || !transcript) return;
      busyRef.current += 1;
      try {
        await runCommands(transcript);
      } catch (error) {
        say(String(error)); // es. "Non trovo l'app «X»."
      } finally {
        busyRef.current -= 1;
      }
    });
  }, [say, runCommands]);

  const onWakeWord = useCallback(async () => {
    if (stateRef.current !== 'idle') return;
    sessionRef.current = true;
    draftRef.current = null;
    typedRef.current = false;
    levelRef.current = 0;
    applyState('listening');
    setStatus('Ti ascolto…');
    try {
      await showWindow();
      await setListening(true);
    } catch (error) {
      setStatus(`Impossibile mostrare HeyJev: ${String(error)}`);
    }
  }, [applyState]);

  const activateWakeWord = useCallback(async () => {
    if (wakeReadyRef.current || wakeStartingRef.current) return;
    wakeStartingRef.current = true;
    setStatus('Avvio del rilevatore offline…');
    try {
      wakeReadyRef.current = true;
      await startWakeListener();
      applyState('idle');
      setStatus('Ascolto offline attivo · di’ «Hey Jev».');
      void hideWindow().catch(() => undefined);
      const settings = await getSettings().catch(() => null);
      loadCorrections(settings);
      if (settings) void firstRunRef.current(settings);
    } catch (error) {
      wakeReadyRef.current = false;
      applyState('setup');
      setStatus(`Wake word non pronta: ${String(error)}`);
    } finally {
      wakeStartingRef.current = false;
    }
  }, [applyState]);

  const getLevel = useCallback(() => levelRef.current, []);

  /** Pannello nell'isola: ferma la wake word e tiene aperto finché l'utente non chiude.
   *  Il tutorial usa lo stato "listening" per l'onda che segue il microfono. */
  const openPanel = useCallback(async (next: Panel) => {
    if (sessionRef.current) return;
    try {
      holdRef.current = true;
      await setWakeEnabled(false);
      await showWindow();
      await setListening(true);
      setUpdateAvailable(null);
      setPanel(next);
      // Dove si registra la voce l'onda segue il microfono.
      applyState(next === 'tutorial' || next === 'learned' ? 'listening' : 'setup');
      setStatus(PANEL_TITLES[next]);
    } catch (error) {
      setStatus(`Impossibile aprire ${PANEL_TITLES[next]}: ${String(error)}`);
    }
  }, [applyState]);

  /** Primo avvio: chiavi API (se ne manca qualcuna), poi tutorial voce. */
  const firstRun = useCallback(async (settings: Settings) => {
    if (!settings.keysOnboarded) {
      const keys = await Promise.all([deepgramKeyConfigured(), jevKeyConfigured(), aiKeyConfigured()]).catch(() => []);
      if (keys.length && keys.every(Boolean)) await saveSettings({ ...settings, keysOnboarded: true }).catch(() => undefined);
      else return openPanel('keys');
    }
    if (!settings.voiceTrained) await openPanel('tutorial');
  }, [openPanel]);
  const firstRunRef = useRef(firstRun);
  firstRunRef.current = firstRun;

  /** Chiavi fatte (o saltate): non si ripropongono; al primo avvio segue il tutorial voce. */
  const finishKeys = useCallback(async (summary: string) => {
    const settings = await getSettings().catch(() => null);
    if (settings && !settings.keysOnboarded) await saveSettings({ ...settings, keysOnboarded: true }).catch(() => undefined);
    if (settings && !settings.voiceTrained) {
      setStatus(summary);
      await openPanel('tutorial');
      return;
    }
    setPanel(null);
    holdRef.current = false;
    applyState('done');
    setStatus(summary);
    window.setTimeout(() => {
      if (stateRef.current === 'done') void close();
    }, NOTICE_MS);
  }, [applyState, close, openPanel]);

  const finishTutorial = useCallback(async (summary: string) => {
    setPanel(null);
    loadCorrections(await getSettings().catch(() => null));
    holdRef.current = false;
    applyState('done');
    setStatus(summary);
    window.setTimeout(() => {
      if (stateRef.current === 'done') void close();
    }, NOTICE_MS);
  }, [applyState, close]);

  /** Saltato: non si ripropone a ogni avvio (resta in Impostazioni → Tutorial voce). */
  const skipTutorial = useCallback(async () => {
    const settings = await getSettings().catch(() => null);
    if (settings && !settings.voiceTrained) await saveSettings({ ...settings, voiceTrained: true }).catch(() => undefined);
    void close();
  }, [close]);

  const checkUpdatesFromSettings = useCallback(async () => {
    setPanel(null);
    applyState('processing');
    const result = await checkUpdates();
    setStatus(result);
    if (stateRef.current === 'processing') {
      applyState('done');
      holdRef.current = false;
      window.setTimeout(() => void close(), 1800);
    }
  }, [applyState, checkUpdates, close]);

  const installUpdate = useCallback(async () => {
    setUpdateAvailable(null);
    applyState('processing');
    setStatus('Download e verifica firma…');
    try {
      await installPendingUpdate();
      setStatus('Aggiornamento installato.');
    } catch (error) {
      setStatus(`Aggiornamento non riuscito: ${String(error)}`);
      applyState('done');
      window.setTimeout(() => void close(), 4000);
    }
  }, [applyState, close]);

  // Eventi del backend nativo e della system tray.
  useEffect(() => {
    let disposed = false;
    let unlisteners: UnlistenFn[] = [];
    void Promise.all([
      listen('app:wake-word', () => void onWakeWord()),
      listen<number>('app:level', (event) => {
        levelRef.current = event.payload;
      }),
      listen('app:segment', () => {
        if (sessionRef.current && busyRef.current === 0 && !draftRef.current) setStatus('Trascrizione…');
      }),
      listen<string>('app:transcript', (event) => handleTranscript(event.payload.trim())),
      // Deepgram: la frase mentre la stai dicendo.
      listen<string>('app:interim', (event) => {
        if (!sessionRef.current) return;
        const draft = draftRef.current;
        setStatus(draft ? `✍️ ${draft.text} ${event.payload}` : event.payload);
      }),
      // In ordine: «apri X e scrivi Y» scrive nella finestra di X.
      listen<ToolCall>('app:tool', (event) => {
        toolsRef.current = toolsRef.current.then(() => runTool(event.payload));
      }),
      listen<boolean>('app:speaking', (event) => setSpeaking(event.payload)),
      listen('app:barge-in', () => {
        if (sessionRef.current) setStatus('Ti ascolto…');
      }),
      listen<string>('app:transcript-error', (event) => {
        if (sessionRef.current) setStatus(`Errore trascrizione: ${event.payload}`);
      }),
      listen('app:session-end', () => finishSession()),
      listen<string>('app:wake-error', (event) => {
        wakeReadyRef.current = false;
        sessionRef.current = false;
        void showWindow();
        applyState('setup');
        setStatus(`Rilevatore wake word fermato: ${event.payload} Riprovo…`);
        // Microfono cambiato/ricollegato: il nuovo avvio usa il device predefinito attuale.
        window.setTimeout(() => void activateWakeWord(), WAKE_RETRY_MS);
      }),
      listen('app:open-settings', () => void openPanel('settings')),
    ]).then((listeners) => {
      if (disposed) listeners.forEach((unlisten) => unlisten());
      else unlisteners = listeners;
      if (!disposed) void activateWakeWord();
    });
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
      void setWakeEnabled(false);
    };
  }, [activateWakeWord, applyState, finishSession, handleTranscript, onWakeWord, openPanel, runTool]);

  return (
    <Notch
      state={state}
      status={status}
      getLevel={state === 'listening' ? getLevel : undefined}
      speaking={speaking}
      updateAvailable={updateAvailable}
      onActivate={() => void activateWakeWord()}
      onInstallUpdate={() => void installUpdate()}
      onDismissUpdate={() => void close()}
    >
      {panel === 'settings' ? (
        <SettingsPanel
          onClose={() => {
            void getSettings().then(loadCorrections, () => undefined); // "chi ascolta" può essere cambiato
            void close();
          }}
          onCheckUpdate={() => void checkUpdatesFromSettings()}
          onTutorial={() => void openPanel('tutorial')}
          onKeys={() => void openPanel('keys')}
          onLearned={() => void openPanel('learned')}
          onWhisperChosen={() => {
            void getSettings().then(loadCorrections, () => undefined);
            void openPanel('tutorial');
          }}
        />
      ) : null}
      {panel === 'keys' ? <KeysOnboarding onDone={(summary) => void finishKeys(summary)} /> : null}
      {panel === 'learned' ? (
        <LearnedWords
          onClose={() => {
            void getSettings().then(loadCorrections, () => undefined);
            void close();
          }}
        />
      ) : null}
      {panel === 'tutorial' ? (
        <VoiceTutorial onDone={(summary) => void finishTutorial(summary)} onSkip={() => void skipTutorial()} />
      ) : null}
    </Notch>
  );
}
