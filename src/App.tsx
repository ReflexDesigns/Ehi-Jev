import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import Notch from './components/Notch';
import SettingsPanel from './components/SettingsPanel';
import { parseCommands } from './lib/commandParser';
import {
  aiCreate,
  checkForUpdate,
  endSession,
  executeAction,
  hideWindow,
  importUpdateTokenFromEnv,
  installPendingUpdate,
  parseIntent,
  setListening,
  setUpdateToken,
  setWakeEnabled,
  showWindow,
  startWakeListener,
  type UpdateSummary,
} from './lib/osControl';
import type { AppState } from './types';

/**
 * HeyJev - Direttore Operativo Vocale del PC.
 *
 * «Hey Jev» apre una sessione: il backend Rust ascolta, taglia ogni frase alla
 * prima pausa e la trascrive con Whisper mentre continua ad ascoltare; la UI
 * esegue i comandi appena arrivano. La sessione finisce dopo qualche secondo di
 * silenzio (Impostazioni) oppure con «grazie» / «ok» / «silenzio».
 * «Crea un documento/sito…» avvia una dettatura: tutto ciò che segue fino alla fine
 * della sessione è la richiesta, eseguita in background da OpenRouter.
 *
 *   idle ──(wake word)──▶ listening ──(silenzio | grazie)──▶ closing ──▶ idle
 */

const WAKE_RETRY_MS = 5000; // riavvio del rilevatore dopo un errore microfono
const LAST_RESULT_MS = 700; // l'ultimo esito resta visibile prima di chiudere
const NOTICE_MS = 4000; // avviso a fine lavoro AI

export default function App() {
  const [state, setState] = useState<AppState>('setup');
  const [status, setStatus] = useState('Avvio del motore vocale…');
  const [showUpdateTokenSetup, setShowUpdateTokenSetup] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [updateTokenBusy, setUpdateTokenBusy] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<UpdateSummary | null>(null);

  const stateRef = useRef<AppState>('idle');
  const levelRef = useRef(0);
  const wakeReadyRef = useRef(false);
  const wakeStartingRef = useRef(false);
  const sessionRef = useRef(false); // sessione di ascolto Rust attiva
  const busyRef = useRef(0); // comandi in esecuzione
  const holdRef = useRef(false); // pannello aperto: non chiudere da soli
  const draftRef = useRef<{ kind: string; text: string } | null>(null); // richiesta AI in dettatura
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const applyState = useCallback((s: AppState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  /** Chiusura: la pillola si restringe e risale, poi click-through. */
  const close = useCallback(async () => {
    holdRef.current = false;
    setShowUpdateTokenSetup(false);
    setShowSettings(false);
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
      const message = `Errore: ${String(error)}`;
      if (message.includes('Token GitHub non configurato')) {
        await hold('setup');
        setShowUpdateTokenSetup(true);
      }
      return message;
    }
  }, [hold]);

  /** Esegue in ordine i comandi di una frase. */
  const runCommands = useCallback(async (transcript: string) => {
    let actions = parseCommands(transcript);
    const draft = draftRef.current;
    if (draft) {
      // Dettatura per l'AI: ogni frase si aggiunge alla richiesta, «grazie» la invia.
      draft.text += ` ${transcript}`;
      setStatus(`✍️ ${draft.text}`);
      if (actions[actions.length - 1] === 'cancel') await endSession();
      return;
    }
    if (!actions.length) {
      try {
        const intent = await parseIntent(transcript);
        if (intent.action) actions = [intent.action];
      } catch {
        // Jev non configurato/irraggiungibile: frase non riconosciuta.
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
        setStatus('Ciao! 👋');
        await endSession(); // Rust risponde con app:session-end
        return;
      }
      if (action === 'check_update') {
        setStatus(await checkUpdates());
        if (holdRef.current) return;
        continue;
      }
      setStatus(await executeAction(action));
    }
  }, [checkUpdates]);

  /** Le frasi arrivano mentre si parla: una coda le esegue una alla volta. */
  const handleTranscript = useCallback((transcript: string) => {
    queueRef.current = queueRef.current.then(async () => {
      if (!sessionRef.current || !transcript) return;
      busyRef.current += 1;
      try {
        await runCommands(transcript);
      } catch (error) {
        setStatus(`Errore: ${String(error)}`);
      } finally {
        busyRef.current -= 1;
      }
    });
  }, [runCommands]);

  const onWakeWord = useCallback(async () => {
    if (stateRef.current !== 'idle') return;
    sessionRef.current = true;
    draftRef.current = null;
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
    } catch (error) {
      wakeReadyRef.current = false;
      applyState('setup');
      setStatus(`Wake word non pronta: ${String(error)}`);
    } finally {
      wakeStartingRef.current = false;
    }
  }, [applyState]);

  const getLevel = useCallback(() => levelRef.current, []);

  const openSettings = useCallback(async () => {
    if (sessionRef.current) return;
    try {
      holdRef.current = true;
      await setWakeEnabled(false);
      await showWindow();
      await setListening(true);
      setUpdateAvailable(null);
      setShowUpdateTokenSetup(false);
      setShowSettings(true);
      applyState('setup');
      setStatus('Impostazioni');
    } catch (error) {
      setStatus(`Impossibile aprire le impostazioni: ${String(error)}`);
    }
  }, [applyState]);

  const checkUpdatesFromSettings = useCallback(async () => {
    setShowSettings(false);
    applyState('processing');
    const result = await checkUpdates();
    setStatus(result);
    if (stateRef.current === 'processing') {
      applyState('done');
      holdRef.current = false;
      window.setTimeout(() => void close(), 1800);
    }
  }, [applyState, checkUpdates, close]);

  const persistUpdateToken = useCallback(async (save: () => Promise<void>) => {
    setUpdateTokenBusy(true);
    try {
      await save();
      setShowUpdateTokenSetup(false);
      setStatus('Token verificato e salvato nel Credential Manager di Windows.');
      if (wakeReadyRef.current) window.setTimeout(() => void close(), 1200);
    } catch (error) {
      setStatus(String(error));
      throw error;
    } finally {
      setUpdateTokenBusy(false);
    }
  }, [close]);

  const saveUpdateToken = useCallback(
    (token: string) => persistUpdateToken(() => setUpdateToken(token)),
    [persistUpdateToken],
  );

  const importTokenFromEnv = useCallback(
    () => persistUpdateToken(() => importUpdateTokenFromEnv()),
    [persistUpdateToken],
  );

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
      listen('app:open-settings', () => void openSettings()),
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
  }, [activateWakeWord, applyState, finishSession, handleTranscript, onWakeWord, openSettings]);

  return (
    <Notch
      state={state}
      status={status}
      getLevel={state === 'listening' ? getLevel : undefined}
      showTokenSetup={showUpdateTokenSetup}
      tokenBusy={updateTokenBusy}
      updateAvailable={updateAvailable}
      onActivate={() => void activateWakeWord()}
      onSaveUpdateToken={saveUpdateToken}
      onImportUpdateToken={importTokenFromEnv}
      onCancelTokenSetup={() => {
        setShowUpdateTokenSetup(false);
        if (wakeReadyRef.current) void close();
      }}
      onInstallUpdate={() => void installUpdate()}
      onDismissUpdate={() => void close()}
    >
      {showSettings ? (
        <SettingsPanel
          onClose={() => void close()}
          onCheckUpdate={() => void checkUpdatesFromSettings()}
          onConfigureToken={() => {
            setShowSettings(false);
            setShowUpdateTokenSetup(true);
          }}
        />
      ) : null}
    </Notch>
  );
}
