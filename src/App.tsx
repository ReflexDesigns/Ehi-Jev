import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import Notch from './components/Notch';
import { MicRecorder, type AudioFrame } from './lib/micRecorder';
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
  transcribeAudio,
  type UpdateSummary,
} from './lib/osControl';
import type { AppState } from './types';

/**
 * HeyJev - Direttore Operativo Vocale del PC.
 *
 * Macchina a stati:
 *   idle ──(wake word)──▶ listening ──(silenzio/timeout)──▶ processing
 *   processing ──▶ done ──(1.8s)──▶ closing ──▶ idle
 *
 * sherpa-onnx ascolta dal backend Rust e segnala la wake word via evento Tauri.
 */

const SILENCE_THRESHOLD = 0.04; // RMS sotto cui consideriamo silenzio
const SILENCE_TIMEOUT_MS = 850; // silenzio continuo -> fine comando
const MAX_RECORD_MS = 5000; // tetto massimo di registrazione
export default function App() {
  const [state, setState] = useState<AppState>('setup');
  const [status, setStatus] = useState('Avvio del motore vocale…');
  const [showUpdateTokenSetup, setShowUpdateTokenSetup] = useState(false);
  const [updateTokenBusy, setUpdateTokenBusy] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<UpdateSummary | null>(null);

  const stateRef = useRef<AppState>('idle');
  const recorderRef = useRef<MicRecorder | null>(null);
  const rafRef = useRef(0);
  const silenceStartRef = useRef<number | null>(null);
  const maxTimerRef = useRef<number | null>(null);
  const wakeReadyRef = useRef(false);
  const wakeFiredRef = useRef(false);
  const wakeStartingRef = useRef(false);

  const applyState = useCallback((s: AppState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  /** Cancella rAF loop e timer pendenti. */
  const clearTimers = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    if (maxTimerRef.current !== null) window.clearTimeout(maxTimerRef.current);
    maxTimerRef.current = null;
    silenceStartRef.current = null;
  }, []);

  /** Chiusura: animazione di riassorbimento verso l'alto, poi hide. */
  const close = useCallback(async () => {
    setShowUpdateTokenSetup(false);
    setUpdateAvailable(null);
    applyState('closing');
    setStatus('');
    window.setTimeout(async () => {
      if (stateRef.current !== 'closing') return;
      clearTimers();
      recorderRef.current = null;
      try {
        await setListening(false);
        await setWakeEnabled(true);
        await hideWindow();
        wakeFiredRef.current = false;
        applyState('idle');
      } catch (error) {
        wakeReadyRef.current = false;
        wakeFiredRef.current = false;
        applyState('setup');
        setStatus(`Riattivazione wake word non riuscita: ${String(error)}`);
      }
    }, 420);
  }, [applyState, clearTimers]);

  /**
   * Fine ascolto -> pipeline:
   *  1. STT con Whisper.cpp (Rust)
   *  2. Intent parsing con Jev/TypeSafe (Rust) -> fallback regex (TS)
   *  3. Esecuzione azione Windows (Rust)
   */
  const finishListening = useCallback(async () => {
    if (stateRef.current !== 'listening') return;
    const wav = recorderRef.current?.stopAndGetWav() ?? null;
    clearTimers();
    applyState('processing');

    let result: string;
    let action: string | null = null;
    let available: UpdateSummary | null = null;
    let keepOpen = false;
    try {
      // --- 1. STT ---
      let transcript = '';
      if (wav && wav.byteLength > 44) {
        setStatus('Trascrizione…');
        try {
          transcript = (await transcribeAudio(wav)).trim();
        } catch {
          // se la STT fallisce, proseguiamo senza transcript
        }
      }

      // --- 2. Intent ---
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

      // --- 3. Esecuzione ---
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
  }, [applyState, clearTimers, close]);

  /** Stato di ascolto attivo: mostra il notch e registra dal microfono. */
  const startListening = useCallback(async () => {
    if (stateRef.current !== 'idle') return;
    await setWakeEnabled(false);
    await showWindow();
    await setListening(true);
    applyState('listening');
    setStatus('In ascolto…');

    const rec = new MicRecorder();
    recorderRef.current = rec;
    try {
      await rec.start();
    } catch (e) {
      setStatus(`Microfono non disponibile: ${String(e)}`);
      applyState('done');
      window.setTimeout(() => void close(), 2000);
      return;
    }

    silenceStartRef.current = null;
    maxTimerRef.current = window.setTimeout(() => void finishListening(), MAX_RECORD_MS);

    // Loop di rilevamento silenzio (legge anche i livelli per l'onda).
    const loop = () => {
      if (stateRef.current !== 'listening') return;
      const level = rec.getLevel();
      if (level < SILENCE_THRESHOLD) {
        if (silenceStartRef.current === null) {
          silenceStartRef.current = performance.now();
        } else if (performance.now() - silenceStartRef.current > SILENCE_TIMEOUT_MS) {
          void finishListening();
          return;
        }
      } else {
        silenceStartRef.current = null;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [applyState, close, finishListening]);

  const onWakeWord = useCallback(async () => {
    if (stateRef.current !== 'idle' || wakeFiredRef.current) return;
    wakeFiredRef.current = true;
    try {
      await setWakeEnabled(false);
      await startListening();
    } catch (error) {
      await showWindow();
      applyState('done');
      setStatus(`Wake word rilevata, ma non riesco ad aprire il microfono: ${String(error)}`);
      window.setTimeout(() => void close(), 1800);
    }
  }, [applyState, close, showWindow, startListening]);

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
      setStatus(`Wake word non pronta: ${String(error)}. Esegui scripts\\setup-kws.ps1 e riprova.`);
    } finally {
      wakeStartingRef.current = false;
    }
  }, [applyState, hideWindow]);

  /** Frame audio per la visualizzazione dell'onda (letto dal canvas). */
  const getFrame = useCallback((): AudioFrame => {
    const rec = recorderRef.current;
    return {
      level: rec?.getLevel() ?? 0,
      freq: rec?.getFrequencyData() ?? new Uint8Array(0),
    };
  }, []);

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

  // Eventi del rilevatore nativo, più mostra finestra dalla system tray.
  useEffect(() => {
    let disposed = false;
    let unlisteners: UnlistenFn[] = [];
    void Promise.all([
      listen('app:show', () => {
        void showWindow();
        if (wakeReadyRef.current) {
          applyState('done');
          setStatus('Wake word attiva. Sono pronta quando dici «Hey Jev».');
          window.setTimeout(() => void close(), 1800);
        } else {
          applyState('setup');
          setStatus('Esegui scripts\\setup-kws.ps1 e poi premi Attiva.');
        }
      }),
      listen('app:wake-word', () => void onWakeWord()),
      listen<string>('app:wake-error', (event) => {
        wakeReadyRef.current = false;
        void showWindow();
        applyState('setup');
        setStatus(`Rilevatore wake word fermato: ${event.payload}`);
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
      clearTimers();
      void setWakeEnabled(false);
      recorderRef.current?.stopAndGetWav();
    };
  }, [activateWakeWord, applyState, clearTimers, close, onWakeWord, openUpdateTokenSetup]);

  return (
    <Notch
      state={state}
      status={status}
      getFrame={state === 'listening' ? getFrame : undefined}
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
    />
  );
}
