import { invoke } from '@tauri-apps/api/core';

/**
 * Wrapper delle commandi Rust esposte da src-tauri.
 * Ogni funzione corrisponde a un #[tauri::command] nel backend.
 */

export interface IntentResult {
  action: string | null;
  confidence: number | null;
  engine: 'jev';
}

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

/**
 * Classifica il transcript con il modello Jev (TypeSafe).
 * Se JEV_API_KEY non è configurata, il comando restituisce errore
 * e il frontend usa il parser regex offline (commandParser.ts).
 */
export function parseIntent(transcript: string): Promise<IntentResult> {
  return invoke<IntentResult>('parse_intent', { transcript });
}

/** Salva un PAT verificato nel Credential Manager, mai nel localStorage. */
export function setUpdateToken(token: string): Promise<void> {
  return invoke<void>('set_update_token', { token });
}

/** Importa GH_TOKEN/GITHUB_TOKEN dall'ambiente senza esporre il valore alla UI. */
export function importUpdateTokenFromEnv(): Promise<void> {
  return invoke<void>('import_update_token_from_env');
}

/** Controlla le release private usando il token salvato localmente. */
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
