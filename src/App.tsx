import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import Notch from './components/Notch';
import { parseCommand } from './lib/commandParser';
import {
  checkForUpdate,
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
 * Macchina a stati:
 *   idle ──(wake word)──▶ listening ──(pausa/timeout)──▶ processing
 *   processing ──▶ done ──(1.8s)──▶ closing ──▶ idle
 *
 * Il backend Rust ascolta il microfono (sherpa-onnx), registra il comando dopo
 * la wake word, lo trascrive con Whisper.cpp e manda eventi Tauri alla UI.
 */

const WAKE_RETRY_MS = 5000; // riavvio del rilevatore dopo un errore microfono

export default function App() {
  const [state, setState] = useState<AppState>('setup');
  const [status, setStatus] = useState('Avvio del motore vocale…');
  const [showUpdateTokenSetup, setShowUpdateTokenSetup] = useState(false);
  const [updateTokenBusy, setUpdateTokenBusy] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<UpdateSummary | null>(null);

  const stateRef = useRef<AppState>('idle');
  const levelRef = useRef(0);
  const wakeReadyRef = useRef(false);
  const wakeStartingRef = useRef(false);

  const applyState = useCallback((s: AppState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  /** Chiusura: animazione di riassorbimento verso l'alto, poi click-through. */
  const close = useCallback(async () => {
    setShowUpdateTokenSetup(false);
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

  /** Wake word: il notch scende e mostra l'onda mentre Rust registra il comando. */
  const onWakeWord = useCallback(async () => {
    if (stateRef.current !== 'idle') return;
    levelRef.current = 0;
    applyState('listening');
    setStatus('In ascolto…');
    try {
      await showWindow();
      await setListening(true);
    } catch (error) {
      setStatus(`Impossibile mostrare HeyJev: ${String(error)}`);
    }
  }, [applyState]);

  /**
   * Trascrizione pronta -> pipeline:
   *  1. Intent parsing con Jev/TypeSafe (Rust) -> fallback regex (TS)
   *  2. Esecuzione azione Windows (Rust)
   */
  const handleTranscript = useCallback(
    async (transcript: string, sttError = '') => {
      if (stateRef.current !== 'listening' && stateRef.current !== 'processing') return;
      applyState('processing');

      let result: string;
      let action: string | null = null;
      let available: UpdateSummary | null = null;
      let keepOpen = false;
      try {
        if (transcript) {
          setStatus(transcript);
          try {
            const intent = await parseIntent(transcript);
            if (intent.action) action = intent.action;
          } catch {
            // Jev non configurato/irraggiungibile -> fallback regex offline.
          }
          if (!action) action = parseCommand(transcript)?.action ?? null;
        }

        if (action === 'check_update') {
          setStatus('Controllo release firmate…');
          available = await checkForUpdate();
          if (available) {
            keepOpen = true;
            result = `È disponibile HeyJev ${available.version}. Conferma con il pulsante per installarla.`;
          } else {
            result = 'HeyJev è aggiornata.';
          }
        } else if (action === 'cancel') {
          result = 'Ciao! 👋';
        } else if (action) {
          setStatus('Esecuzione…');
          result = await executeAction(action);
        } else if (transcript) {
          result = `Non riconosciuto: "${transcript}"`;
        } else if (sttError) {
          result = `Errore trascrizione: ${sttError}`;
        } else {
          result = 'Non ho sentito nulla, riprova.';
        }
      } catch (e) {
        result = `Errore: ${String(e)}`;
        if (action === 'check_update' && result.includes('Token GitHub non configurato')) {
          keepOpen = true;
          setShowUpdateTokenSetup(true);
        }
      }

      setUpdateAvailable(available);
      setStatus(result);
      applyState('done');
      if (!keepOpen) window.setTimeout(() => void close(), 1800);
    },
    [applyState, close],
  );

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

  const openUpdateTokenSetup = useCallback(async () => {
    try {
      await setWakeEnabled(false);
      await showWindow();
      await setListening(true);
      setUpdateAvailable(null);
      setShowUpdateTokenSetup(true);
      applyState('setup');
      setStatus('Il token sarà verificato e salvato nel Credential Manager di Windows.');
    } catch (error) {
      setStatus(`Impossibile aprire la configurazione aggiornamenti: ${String(error)}`);
    }
  }, [applyState]);

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
    }
  }, [applyState]);

  // Eventi del backend nativo, più mostra finestra dalla system tray.
  useEffect(() => {
    let disposed = false;
    let unlisteners: UnlistenFn[] = [];
    void Promise.all([
      listen('app:show', () => {
        if (stateRef.current === 'listening' || stateRef.current === 'processing') return;
        void showWindow();
        if (wakeReadyRef.current) {
          applyState('done');
          setStatus('Wake word attiva. Sono pronta quando dici «Hey Jev».');
          window.setTimeout(() => void close(), 1800);
        } else {
          applyState('setup');
          setStatus('Rilevatore non attivo: premi Attiva.');
        }
      }),
      listen('app:wake-word', () => void onWakeWord()),
      listen<number>('app:level', (event) => {
        levelRef.current = event.payload;
      }),
      listen('app:listening-done', () => {
        if (stateRef.current !== 'listening') return;
        applyState('processing');
        setStatus('Trascrizione…');
      }),
      listen<string>('app:transcript', (event) => void handleTranscript(event.payload.trim())),
      listen<string>('app:transcript-error', (event) => void handleTranscript('', event.payload)),
      listen<string>('app:wake-error', (event) => {
        wakeReadyRef.current = false;
        void showWindow();
        applyState('setup');
        setStatus(`Rilevatore wake word fermato: ${event.payload} Riprovo…`);
        // Microfono cambiato/ricollegato: il nuovo avvio usa il device predefinito attuale.
        window.setTimeout(() => void activateWakeWord(), WAKE_RETRY_MS);
      }),
      listen('app:configure-update-token', () => void openUpdateTokenSetup()),
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
  }, [activateWakeWord, applyState, close, handleTranscript, onWakeWord, openUpdateTokenSetup]);

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
    />
  );
}
