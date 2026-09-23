use std::{
    env,
    fs::{self, File},
    mem::size_of,
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Command, Stdio},
    ptr,
    sync::{
        atomic::{AtomicIsize, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, State, WindowEvent,
};
use tauri_plugin_updater::{Update, UpdaterExt};
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_ALREADY_EXISTS, HWND},
    System::Threading::CreateMutexW,
    UI::{
        Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_D, VK_LWIN,
        },
        Shell::ShellExecuteW,
        WindowsAndMessaging::{
            GetClassNameW, GetForegroundWindow, PostMessageW, SC_CLOSE, SW_SHOWNORMAL,
            WM_SYSCOMMAND,
        },
    },
};

mod ai;
mod apps;
mod chat;
mod deepgram;
mod speaker;
mod wake;
use wake::WakeController;

#[derive(Default)]
struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
struct UpdateSummary {
    version: String,
    notes: Option<String>,
}

/// Servizio delle chiavi API nel Credential Manager di Windows.
const SECRET_SERVICE: &str = "com.heyjev.app";
const JEV_KEY_ACCOUNT: &str = "jev-api-key";

pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const WHISPER_TIMEOUT: Duration = Duration::from_secs(20);
// Vocabolario dei comandi: guida Whisper tiny verso le frasi attese (IT + EN).
// Solo italiano: il prompt misto IT/EN faceva sbagliare "Apri Claude"; l'inglese resta ok (misurato).
pub(crate) const WHISPER_PROMPT: &str = "Apri terminale. Apri Claude. Apri ChatGPT. Mostra desktop. Chiudi questo. Controlla aggiornamenti. Crea un documento. Crea un sito. Grazie. Silenzio.";
/// Wake word via Whisper (tutorial e riserva). Senza prompt Whisper tiny la storpia a caso
/// ("Ingeto", "Hai taggiare"); con questo esce stabile: 11/12 campioni, falsi positivi 1/24
/// e solo su "Hey Jeff" (misurato su TTS).
pub(crate) const WAKE_PROMPT: &str = "Hey Jev.";

/// Impostazioni utente, in `%APPDATA%\com.heyjev.app\settings.json`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Settings {
    /// Lingua per Whisper: "it", "en" o "auto".
    language: String,
    /// 1 = serve voce alta ... 5 = sente anche la voce bassa.
    mic_sensitivity: u8,
    /// Secondi di silenzio dopo i quali la sessione si chiude.
    pub(crate) idle_seconds: f32,
    /// Notifica di Windows quando un documento o progetto AI è pronto.
    pub(crate) notifications: bool,
    /// Chi ascolta i comandi: "deepgram" (streaming online, se c'è la chiave) o "local" (Whisper).
    pub(crate) recognition: String,
    /// Tutorial voce fatto: al primo avvio parte da solo.
    voice_trained: bool,
    /// Come Whisper sente la tua «Hey Jev» (dal tutorial). Vuoto = basta il KWS.
    pub(crate) wake_aliases: Vec<String>,
    /// Correzioni imparate nel tutorial: [sentito, voluto].
    corrections: Vec<(String, String)>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: "it".into(),
            mic_sensitivity: 4,
            idle_seconds: 2.5,
            notifications: true,
            recognition: "deepgram".into(),
            voice_trained: false,
            wake_aliases: Vec::new(),
            corrections: Vec::new(),
        }
    }
}

impl Settings {
    /// Parlato = RMS sopra questo multiplo del rumore tipico (mediana).
    pub(crate) fn vad_ratio(&self) -> f32 {
        [5.0, 4.0, 3.0, 2.4, 1.8][usize::from(self.mic_sensitivity.clamp(1, 5)) - 1]
    }
}

#[derive(Default)]
struct SettingsState(Mutex<Settings>);

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("settings.json"))
}

pub(crate) fn current_settings(app: &AppHandle) -> Settings {
    app.state::<SettingsState>()
        .0
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    current_settings(&app)
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
    settings: Settings,
) -> Result<(), String> {
    if !matches!(settings.language.as_str(), "it" | "en" | "auto")
        || !matches!(settings.recognition.as_str(), "deepgram" | "local")
        || !(1..=5).contains(&settings.mic_sensitivity)
        || !(1.0..=10.0).contains(&settings.idle_seconds)
        || settings.wake_aliases.len() > 8
        || settings.corrections.len() > 64
        || settings
            .wake_aliases
            .iter()
            .chain(settings.corrections.iter().flat_map(|(heard, meant)| [heard, meant]))
            .any(|text| text.len() > 120)
    {
        return Err("Impostazioni non valide.".into());
    }
    let path = settings_file(&app).ok_or("Cartella impostazioni non disponibile.")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(&path, json).map_err(|error| format!("Salvataggio impostazioni fallito: {error}"))?;
    *state
        .0
        .lock()
        .map_err(|_| "Impostazioni non disponibili.")? = settings;
    Ok(())
}

/// Finestra in primo piano al momento della wake word: bersaglio di `close_current`.
static TARGET_WINDOW: AtomicIsize = AtomicIsize::new(0);

pub(crate) fn remember_foreground_window() {
    TARGET_WINDOW.store(unsafe { GetForegroundWindow() } as isize, Ordering::Release);
}

/// Carica `%APPDATA%\com.heyjev.app\.env.local`; quello del repo solo in debug.
/// Mai dalla cwd: un `.env.local` piantato lì potrebbe puntare a EXE arbitrari.
fn load_environment(app: &tauri::AppHandle) {
    let mut candidates = Vec::new();
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.env.local"));
    }
    if let Ok(path) = app.path().app_config_dir() {
        candidates.push(path.join(".env.local"));
    }
    for path in candidates {
        if path.is_file() {
            let _ = dotenvy::from_path(path);
            break;
        }
    }
}

/// Chiave API: Credential Manager (Impostazioni), altrimenti variabili d'ambiente (.env.local).
pub(crate) fn secret(account: &str, env_names: &[&str]) -> Option<String> {
    keyring::Entry::new(SECRET_SERVICE, account)
        .and_then(|entry| entry.get_password())
        .ok()
        .into_iter()
        .chain(env_names.iter().filter_map(|name| env::var(name).ok()))
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty() && !value.starts_with("your_"))
}

pub(crate) fn store_secret(account: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(SECRET_SERVICE, account)
        .and_then(|entry| entry.set_password(value))
        .map_err(|_| "Windows non ha salvato la chiave nel Credential Manager.".into())
}

pub(crate) fn check_key_shape(key: &str) -> Result<(), String> {
    if key.len() < 16 || key.len() > 512 || key.chars().any(char::is_whitespace) {
        return Err("Chiave non valida: controlla il valore e riprova.".into());
    }
    Ok(())
}

pub(crate) fn jev_key() -> Option<String> {
    secret(JEV_KEY_ACCOUNT, &["JEV_API_KEY", "TYPESAFE_API_KEY"])
}

/// Parole minuscole senza accenti né punteggiatura: confronti tolleranti con Whisper.
/// Via i tag di Whisper per i suoni ("[Musica]", "(risate)"): non sono parole dette.
pub(crate) fn words(text: &str) -> Vec<String> {
    let mut tag = 0_i32;
    text.to_lowercase()
        .chars()
        .map(|c| match c {
            '[' | '(' => {
                tag += 1;
                ' '
            }
            ']' | ')' => {
                tag = (tag - 1).max(0);
                ' '
            }
            _ if tag > 0 => ' ',
            'à' | 'á' | 'â' | 'ä' => 'a',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ò' | 'ó' | 'ô' | 'ö' => 'o',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect::<String>()
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

#[tauri::command]
fn show_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Finestra HeyJev non disponibile.".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window
        .set_ignore_cursor_events(false)
        .map_err(|error| error.to_string())
}

// La finestra resta caricata: il listener nativo vive nel backend Rust.
#[tauri::command]
fn hide_window(app: AppHandle) -> Result<(), String> {
    set_clickthrough(&app, true)
}

#[tauri::command]
fn set_listening(app: AppHandle, active: bool) -> Result<(), String> {
    set_clickthrough(&app, !active)
}

fn set_clickthrough(app: &AppHandle, ignore: bool) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Finestra HeyJev non disponibile.".to_string())?
        .set_ignore_cursor_events(ignore)
        .map_err(|error| error.to_string())
}

/// PCM float mono -> WAV 16 bit (Whisper ricampiona da solo a 16 kHz).
fn wav_bytes(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = samples.len() as u32 * 2;
    let mut wav = [
        b"RIFF".as_slice(),
        &(36 + data_len).to_le_bytes(),
        b"WAVEfmt ",
        &16u32.to_le_bytes(),
        &1u16.to_le_bytes(), // PCM
        &1u16.to_le_bytes(), // mono
        &sample_rate.to_le_bytes(),
        &(sample_rate * 2).to_le_bytes(),
        &2u16.to_le_bytes(),
        &16u16.to_le_bytes(),
        b"data",
        &data_len.to_le_bytes(),
    ]
    .concat();
    for sample in samples {
        wav.extend_from_slice(&((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes());
    }
    wav
}

/// `prompt`: frasi attese, guidano Whisper tiny (comandi o wake word).
pub(crate) fn transcribe(
    app: &AppHandle,
    samples: &[f32],
    sample_rate: u32,
    prompt: &str,
) -> Result<String, String> {
    let model = resource_path(app, "WHISPER_MODEL_PATH", "models/whisper/ggml-tiny.bin")?;
    let binary = resource_path(app, "WHISPER_CPP_BIN", "models/whisper/bin/whisper-cli.exe")?;
    // Whisper tiny con "auto" scambia comandi italiani brevi per altre lingue.
    let language = current_settings(app).language;
    let threads = thread::available_parallelism()
        .map(|cores| cores.get().clamp(2, 6))
        .unwrap_or(4)
        .to_string();
    let temporary = tempfile::tempdir().map_err(|error| error.to_string())?;
    let input = temporary.path().join("command.wav");
    let output = temporary.path().join("transcript");
    let log = temporary.path().join("whisper.log");
    fs::write(&input, wav_bytes(samples, sample_rate)).map_err(|error| error.to_string())?;
    let log_file = File::create(&log).map_err(|error| error.to_string())?;

    let mut child = Command::new(&binary)
        .arg("-m")
        .arg(&model)
        .arg("-f")
        .arg(&input)
        .args(["-l", language.as_str(), "--prompt", prompt])
        // Greedy (-bs 1 -bo 1) e più thread: ~0,6 s a frase invece di ~1,1 s (misurato).
        .args([
            "-t",
            threads.as_str(),
            "-bs",
            "1",
            "-bo",
            "1",
            "-nt",
            "-otxt",
            "-of",
        ])
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log_file)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("Avvio Whisper.cpp fallito ({}): {error}", binary.display()))?;
    let deadline = Instant::now() + WHISPER_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Whisper.cpp non ha risposto entro 20 secondi.".into());
        }
        thread::sleep(Duration::from_millis(50));
    };
    if !status.success() {
        let log = fs::read_to_string(&log).unwrap_or_default();
        let detail = log.lines().rev().find(|line| !line.trim().is_empty());
        return Err(format!(
            "Whisper.cpp ha restituito un errore ({status}): {}",
            detail.unwrap_or("nessun dettaglio")
        ));
    }
    fs::read_to_string(output.with_extension("txt"))
        .map(|text| text.trim().to_string())
        .map_err(|error| format!("Whisper non ha prodotto la trascrizione: {error}"))
}

/// Risolve un path (default o override da env) sulla cartella risorse:
/// `target\<profilo>\` in sviluppo, cartella d'installazione nell'app installata.
pub(crate) fn resource_path(
    app: &AppHandle,
    env_name: &str,
    default: &str,
) -> Result<PathBuf, String> {
    let path = PathBuf::from(env::var(env_name).unwrap_or_else(|_| default.into()));
    let path = if path.is_absolute() {
        path
    } else {
        app.path()
            .resource_dir()
            .map_err(|error| format!("Cartella risorse HeyJev non accessibile: {error}"))?
            .join(path)
    };
    if path.exists() {
        Ok(path)
    } else {
        Err(format!(
            "File HeyJev mancante: {}. Reinstalla HeyJev (in sviluppo: npm run setup:models).",
            path.display()
        ))
    }
}

/// Una richiesta a Jev (TypeSafe SystemOne): `state` è la frase detta, `questions` le
/// domande a scelta. Ritorna `answers`, una risposta per domanda.
pub(crate) async fn jev_ask(key: &str, state: &str, questions: Value) -> Result<Value, String> {
    let base = env::var("JEV_API_BASE_URL").unwrap_or_else(|_| "https://api.typesafe.ai/v1".into());
    if !base.starts_with("https://") {
        return Err("JEV_API_BASE_URL deve usare https://.".into());
    }
    let model = env::var("JEV_MODEL")
        .or_else(|_| env::var("TYPESAFE_MODEL"))
        .unwrap_or_else(|_| "jev-latest".into());
    let response = reqwest::Client::builder()
        // Un comando non può aspettare: oltre 5 s si passa alla riserva (Gemini).
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?
        .post(format!("{}/systemone", base.trim_end_matches('/')))
        .bearer_auth(key)
        .json(&json!({ "model": model, "state": state, "questions": questions }))
        .send()
        .await
        .map_err(|error| format!("Connessione Jev fallita: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Jev ha restituito HTTP {}.", response.status()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Risposta Jev non valida: {error}"))?;
    Ok(body["answers"].clone())
}

#[tauri::command]
fn jev_key_configured() -> bool {
    jev_key().is_some()
}

/// Verifica la chiave con una frase di prova, poi la salva nel Credential Manager.
#[tauri::command]
async fn set_jev_key(key: String) -> Result<(), String> {
    let key = key.trim();
    check_key_shape(key)?;
    let probe = json!({ "check": { "type": "choice", "instructions": "Che cosa chiede?", "criteria": { "apri": null, "altro": null } } });
    jev_ask(key, "apri il terminale", probe).await?;
    store_secret(JEV_KEY_ACCOUNT, key)
}

/// Repo pubblico: l'updater legge `latest.json` dell'ultima release (endpoint in tauri.conf.json).
#[tauri::command]
async fn check_for_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateSummary>, String> {
    let update = app
        .updater()
        .map_err(|error| format!("Configurazione updater non valida: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Controllo release fallito: {error}"))?;

    let Some(update) = update else {
        *pending
            .0
            .lock()
            .map_err(|_| "Stato updater non disponibile.".to_string())? = None;
        return Ok(None);
    };

    let summary = UpdateSummary {
        version: update.version.clone(),
        notes: update.body.clone(),
    };
    *pending
        .0
        .lock()
        .map_err(|_| "Stato updater non disponibile.".to_string())? = Some(update);
    Ok(Some(summary))
}

#[tauri::command]
async fn install_pending_update(pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|_| "Stato updater non disponibile.".to_string())?
        .take()
        .ok_or_else(|| "Nessun aggiornamento in attesa. Controlla di nuovo.".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| {
            format!("Download o installazione dell'aggiornamento non riusciti: {error}")
        })
}

#[tauri::command]
fn execute_action(app: AppHandle, action: String) -> Result<String, String> {
    match action.as_str() {
        "open_terminal" => Command::new("wt.exe")
            .spawn()
            .or_else(|_| Command::new("cmd.exe").spawn())
            .map(|_| "Terminale aperto.".to_string())
            .map_err(|error| format!("Impossibile aprire il terminale: {error}")),
        "open_claude" => open_url("https://claude.ai").map(|_| "Claude aperto.".to_string()),
        "open_gpt" => open_url("https://chatgpt.com").map(|_| "ChatGPT aperto.".to_string()),
        "show_desktop" => send_chord(VK_LWIN, VK_D).map(|_| "Desktop mostrato.".to_string()),
        "close_current" => close_target_window(&app).map(|_| "Finestra chiusa.".to_string()),
        _ => Err("Comando non consentito.".into()),
    }
}

/// Equivale ad Alt+F4 sulla finestra attiva al momento della wake word, mai su HeyJev
/// né sul desktop/taskbar (lì Alt+F4 aprirebbe "Arresta Windows").
fn close_target_window(app: &AppHandle) -> Result<(), String> {
    let hwnd = TARGET_WINDOW.swap(0, Ordering::AcqRel) as HWND;
    let own = app
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|own| own.0 as isize);
    let mut class = [0u16; 64];
    let length = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
    let class = String::from_utf16_lossy(&class[..length.max(0) as usize]);
    if hwnd.is_null()
        || own == Some(hwnd as isize)
        || matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd")
    {
        return Err("Nessuna finestra da chiudere.".into());
    }
    if unsafe { PostMessageW(hwnd, WM_SYSCOMMAND, SC_CLOSE as usize, 0) } == 0 {
        return Err("Windows non ha accettato la chiusura della finestra.".into());
    }
    Ok(())
}

/// Seconda istanza = doppio microfono e azioni doppie: esce subito.
fn already_running() -> bool {
    let name: Vec<u16> = "Local\\com.heyjev.app\0".encode_utf16().collect();
    // ponytail: handle mai chiuso di proposito, Windows lo rilascia all'uscita del processo.
    unsafe {
        CreateMutexW(ptr::null(), 0, name.as_ptr());
        GetLastError() == ERROR_ALREADY_EXISTS
    }
}

fn open_url(url: &str) -> Result<(), String> {
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            0 as _,
            operation.as_ptr(),
            target.as_ptr(),
            ptr::null(),
            ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        Err(format!("Windows non ha aperto {url}."))
    } else {
        Ok(())
    }
}

fn send_chord(modifier: u16, key: u16) -> Result<(), String> {
    let inputs = [
        keyboard_input(modifier, 0),
        keyboard_input(key, 0),
        keyboard_input(key, KEYEVENTF_KEYUP),
        keyboard_input(modifier, KEYEVENTF_KEYUP),
    ];
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    };
    if sent == inputs.len() as u32 {
        Ok(())
    } else {
        Err("Windows non ha accettato la scorciatoia.".into())
    }
}

fn keyboard_input(key: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

pub fn run() {
    if already_running() {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        // Alt+F4 sull'overlay non deve chiudere HeyJev: si esce solo dalla tray.
        .on_window_event(|_, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
            }
        })
        .manage(WakeController::default())
        .manage(PendingUpdate::default())
        .manage(SettingsState::default())
        .setup(|app| {
            load_environment(app.handle());
            apps::preload();
            speaker::init(app.handle());
            let saved = settings_file(app.handle())
                .and_then(|path| fs::read_to_string(path).ok())
                .and_then(|json| serde_json::from_str(&json).ok());
            if let (Some(saved), Ok(mut settings)) = (saved, app.state::<SettingsState>().0.lock())
            {
                *settings = saved;
            }
            if let Some(window) = app.get_webview_window("main") {
                if let Some(monitor) = window.current_monitor()? {
                    let bounds = monitor.position();
                    let scale = monitor.scale_factor();
                    let width = (640.0 * scale) as i32;
                    let x = bounds.x + (monitor.size().width as i32 - width) / 2;
                    window.set_position(PhysicalPosition::new(x, bounds.y))?;
                }
                window.set_ignore_cursor_events(false)?;
            }
            let settings = MenuItem::with_id(app, "settings", "Impostazioni…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Esci", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings, &quit])?;
            let icon = app
                .default_window_icon()
                .ok_or_else(|| std::io::Error::other("Icona Tauri mancante; genera le icone."))?
                .clone();
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("HeyJev — ascolto vocale")
                .menu(&menu)
                // Tasto destro: menu. Tasto sinistro: impostazioni dirette.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "settings" => {
                        let _ = app.emit("app:open-settings", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let _ = tray.app_handle().emit("app:open-settings", ());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            wake::start_wake_listener,
            wake::set_wake_enabled,
            wake::end_session,
            wake::record_sample,
            apps::open_app,
            apps::list_apps,
            chat::interpret,
            deepgram::deepgram_key_configured,
            deepgram::set_deepgram_key,
            deepgram::speak_text,
            get_settings,
            save_settings,
            show_window,
            hide_window,
            set_listening,
            execute_action,
            jev_key_configured,
            set_jev_key,
            check_for_update,
            install_pending_update,
            ai::ai_create,
            ai::ai_key_configured,
            ai::set_ai_key
        ])
        .run(tauri::generate_context!())
        .expect("errore avviando HeyJev");
}

#[cfg(test)]
mod tests {
    #[test]
    fn wav_header_matches_samples() {
        let wav = super::wav_bytes(&[0.0, 1.0, -1.0], 48_000);
        assert_eq!(wav.len(), 44 + 6);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 48_000);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(i16::from_le_bytes([wav[46], wav[47]]), i16::MAX);
    }
}
