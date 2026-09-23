import { invoke } from '@tauri-apps/api/core';

/**
 * Wrapper delle commandi Rust esposte da src-tauri.
 * Ogni funzione corrisponde a un #[tauri::command] nel backend.
 */

export interface IntentResult {
  action: string | null;
  confidence: number | null;
  engine: 'jev' | 'regex';
}

/** Avvia il motore locale sherpa-onnx dal backend Rust. */
export function startWakeListener(): Promise<void> {
  return invoke<void>('start_wake_listener');
}

/** Sospende o riattiva la decodifica mentre Jev acquisisce il comando. */
export function setWakeEnabled(active: boolean): Promise<void> {
  return invoke<void>('set_wake_enabled', { active });
}

/** Mostra la finestra overlay "The Notch". */
export function showWindow(): Promise<void> {
  return invoke<void>('show_window');
}

/** Nasconde la finestra overlay. */
export function hideWindow(): Promise<void> {
  return invoke<void>('hide_window');
}

/**
 * Comunica al backend se siamo in stato di ascolto attivo:
 * evita che la wake word si ri-inneschi durante un comando.
 */
export function setListening(active: boolean): Promise<void> {
  return invoke<void>('set_listening', { active });
}

/** Esegue un'azione di automazione Windows (es. open_terminal). */
export function executeAction(action: string): Promise<string> {
  return invoke<string>('execute_action', { action });
}

/** Invia l'audio WAV al backend che lo trascrive con Whisper.cpp. */
export function transcribeAudio(wav: ArrayBuffer): Promise<string> {
  return invoke<string>('transcribe_audio', {
    audio: Array.from(new Uint8Array(wav)),
  });
}

/**
 * Classifica il transcript con il modello Jev (TypeSafe).
 * Se JEV_API_KEY non è configurata, il comando restituisce errore
 * e il frontend usa il parser regex offline (commandParser.ts).
 */
export function parseIntent(transcript: string): Promise<IntentResult> {
  return invoke<IntentResult>('parse_intent', { transcript });
}
