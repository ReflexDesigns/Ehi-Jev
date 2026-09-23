import { invoke } from '@tauri-apps/api/core';

/**
 * Wrapper delle commandi Rust esposte da src-tauri.
 * Ogni funzione corrisponde a un #[tauri::command] nel backend.
 */

export interface UpdateSummary {
  version: string;
  notes: string | null;
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

/** Controlla l'ultima release pubblica firmata su GitHub. */
export function checkForUpdate(): Promise<UpdateSummary | null> {
  return invoke<UpdateSummary | null>('check_for_update');
}

/** Scarica e installa l'update firmato dopo la conferma esplicita dell'utente. */
export function installPendingUpdate(): Promise<void> {
  return invoke<void>('install_pending_update');
}

/** Chiude la sessione di ascolto continuo (dopo "grazie", "silenzio"…). */
export function endSession(): Promise<void> {
  return invoke<void>('end_session');
}

export interface Settings {
  /** Lingua per Whisper: 'it' | 'en' | 'auto'. */
  language: string;
  /** 1 = serve voce alta … 5 = sente anche la voce bassa. */
  micSensitivity: number;
  /** Secondi di silenzio prima che HeyJev smetta di ascoltare. */
  idleSeconds: number;
  /** Notifica di Windows quando un documento/progetto AI è pronto. */
  notifications: boolean;
  /** Chi ascolta i comandi: Deepgram in streaming (online, con la chiave) o Whisper sul PC. */
  recognition: 'deepgram' | 'local';
  /** Tutorial voce fatto (al primo avvio parte da solo). */
  voiceTrained: boolean;
  /** Come Whisper sente la «Hey Jev» dell'utente: riconoscimento di riserva. */
  wakeAliases: string[];
  /** Correzioni imparate nel tutorial: [sentito, voluto]. */
  corrections: [string, string][];
}

export function getSettings(): Promise<Settings> {
  return invoke<Settings>('get_settings');
}

export function saveSettings(settings: Settings): Promise<void> {
  return invoke<void>('save_settings', { settings });
}

/** OpenRouter: documento (Gemini Flash → Download) o progetto (DeepSeek Flash → %USERPROFILE%). */
export function aiCreate(kind: string, request: string): Promise<string> {
  return invoke<string>('ai_create', { kind, request });
}

export function aiKeyConfigured(): Promise<boolean> {
  return invoke<boolean>('ai_key_configured');
}

/** Verifica la chiave OpenRouter e la salva nel Credential Manager. */
export function saveAiKey(key: string): Promise<void> {
  return invoke<void>('set_ai_key', { key });
}

export function jevKeyConfigured(): Promise<boolean> {
  return invoke<boolean>('jev_key_configured');
}

/** Verifica la chiave Jev con una frase di prova e la salva nel Credential Manager. */
export function saveJevKey(key: string): Promise<void> {
  return invoke<void>('set_jev_key', { key });
}

export function deepgramKeyConfigured(): Promise<boolean> {
  return invoke<boolean>('deepgram_key_configured');
}

/** Verifica la chiave Deepgram e la salva nel Credential Manager. */
export function saveDeepgramKey(key: string): Promise<void> {
  return invoke<void>('set_deepgram_key', { key });
}

/** Frase che il parser non riconosce: Jev (TypeSafe) sceglie azione e app, con Gemini di
 *  riserva; il risultato arriva come evento app:tool. Ritorna gli strumenti scelti. */
export function interpret(text: string): Promise<string[]> {
  return invoke<string[]>('interpret', { text });
}

/** Legge un testo con la voce Maia (solo se c'è la chiave Deepgram): errori e avvisi. */
export function speak(text: string): Promise<void> {
  return invoke<void>('speak_text', { text });
}

/** Strumento scelto da Gemini (evento app:tool). */
export interface ToolCall {
  name: string;
  args: Record<string, string>;
}

/** Apre un'app del menu Start dal nome detto (anche un po' storpiato da Whisper). */
export function openApp(name: string): Promise<string> {
  return invoke<string>('open_app', { name });
}

/** Nomi delle app del menu Start. */
export function listApps(): Promise<string[]> {
  return invoke<string[]>('list_apps');
}

export interface VoiceSample {
  /** Cosa ha capito Whisper. */
  text: string;
  /** Il rilevatore offline l'ha presa come «Hey Jev». */
  wake: boolean;
  /** Picco della voce rispetto al rumore di fondo. */
  snr: number;
}

/** Tutorial: registra la prossima frase detta (wake = «Hey Jev», senza vocabolario comandi). */
export function recordSample(wake: boolean): Promise<VoiceSample> {
  return invoke<VoiceSample>('record_sample', { wake });
}
