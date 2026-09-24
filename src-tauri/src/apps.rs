//! «Apri <app>»: cerca il nome detto tra le app del menu Start e la avvia.
//! «Chiudi <app>»: chiude le finestre aperte di quell'app (come Alt+F4).
//! «Chiudi tutte le app»: chiude tutte le app aperte, tranne HeyJev.

use std::{os::windows::process::CommandExt, path::Path, process::Command, sync::Mutex, thread};

use serde_json::Value;
use tauri::{AppHandle, Manager};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HWND, LPARAM},
    Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
    System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    },
    UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindow, GetWindowLongW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible, PostMessageW, GWL_EXSTYLE, GW_OWNER, SC_CLOSE,
        WM_SYSCOMMAND, WS_EX_TOOLWINDOW,
    },
};

use crate::{words, CREATE_NO_WINDOW};

/// (nome, AppID) da `Get-StartApps`: app desktop e dello Store, con i nomi localizzati.
static APPS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/// Voci del menu Start da non aprire mai a voce.
const SKIP: [&str; 10] = [
    "uninstall",
    "disinstall",
    "rimuovi",
    "remove",
    "readme",
    "leggimi",
    "license",
    "licenza",
    "documentation",
    "release notes",
];

fn load() -> Result<Vec<(String, String)>, String> {
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("Elenco app non disponibile: {error}"))?;
    let json: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Elenco app di Windows non leggibile.".to_string())?;
    // Con una sola app ConvertTo-Json restituisce un oggetto, non un array.
    let items = match json {
        Value::Array(items) => items,
        item => vec![item],
    };
    Ok(items
        .iter()
        .filter_map(|item| {
            Some((
                item["Name"].as_str()?.to_string(),
                item["AppID"].as_str()?.to_string(),
            ))
        })
        .filter(|(name, _)| {
            let name = name.to_lowercase();
            !SKIP.iter().any(|skip| name.contains(skip))
        })
        .collect())
}

fn cache(apps: Vec<(String, String)>) {
    if let Ok(mut cached) = APPS.lock() {
        *cached = apps;
    }
}

/// Elenco letto in background all'avvio: il primo «apri …» non aspetta PowerShell.
pub fn preload() {
    thread::spawn(|| {
        if let Ok(apps) = load() {
            cache(apps);
        }
    });
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let current = row[j + 1];
            row[j + 1] = (previous + usize::from(ca != *cb))
                .min(row[j] + 1)
                .min(current + 1);
            previous = current;
        }
    }
    row[b.len()]
}

/// 1 = nome identico; 0,9 = parole consecutive del nome ("file" in "Esplora file");
/// 0,8 = inizio del nome; poi somiglianza ("smile sink" ≈ "SmileSync"); 0 = diversa.
fn score(query: &str, name: &[String]) -> f32 {
    let full = name.concat();
    if full == query {
        return 1.0;
    }
    let mut best = 0.0_f32;
    for start in 0..name.len() {
        let mut joined = String::new();
        for word in &name[start..] {
            joined.push_str(word);
            if joined == query {
                return 0.9;
            }
            let longest = query.chars().count().max(joined.chars().count());
            best = best.max(1.0 - levenshtein(query, &joined) as f32 / longest as f32);
        }
    }
    if query.len() >= 3 && full.starts_with(query) {
        0.8
    } else if best >= 0.75 {
        0.5 + best * 0.2
    } else {
        0.0
    }
}

/// App più somigliante al nome detto; a pari punteggio vince il nome più corto.
fn find(query: &str, apps: &[(String, String)]) -> Option<(String, String)> {
    let query = words(query).concat();
    if query.len() < 2 {
        return None;
    }
    apps.iter()
        .map(|app| (score(&query, &words(&app.0)), app))
        .filter(|(score, _)| *score > 0.0)
        .max_by(|a, b| a.0.total_cmp(&b.0).then(b.1 .0.len().cmp(&a.1 .0.len())))
        .map(|(_, app)| app.clone())
}

#[tauri::command]
pub fn open_app(name: String) -> Result<String, String> {
    let cached = APPS.lock().ok().and_then(|apps| find(&name, &apps));
    let (title, id) = match cached {
        Some(app) => app,
        // Non trovata: forse installata dopo l'avvio, si rilegge l'elenco.
        None => {
            let apps = load()?;
            let found = find(&name, &apps);
            cache(apps);
            found.ok_or_else(|| format!("Non trovo l'app «{}».", name.trim()))?
        }
    };
    crate::opening(Some(&title));
    Command::new("explorer.exe")
        .arg(format!("shell:AppsFolder\\{id}"))
        .spawn()
        .map_err(|error| format!("Impossibile aprire {title}: {error}"))?;
    Ok(format!("{title} aperta."))
}

/// Finestra principale aperta sul desktop.
struct Window {
    hwnd: isize,
    title: String,
    /// Nome del programma senza estensione, minuscolo ("chrome", "winword").
    exe: String,
}

fn exe_name(pid: u32) -> String {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return String::new();
        }
        let mut path = [0u16; 260];
        let mut size = path.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, path.as_mut_ptr(), &mut size);
        CloseHandle(process);
        if ok == 0 {
            return String::new();
        }
        let path = String::from_utf16_lossy(&path[..size as usize]);
        Path::new(&path)
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    }
}

unsafe extern "system" fn collect(hwnd: HWND, list: LPARAM) -> i32 {
    let windows = &mut *(list as *mut Vec<Window>);
    // Solo finestre principali visibili con un titolo: niente finestrelle di servizio.
    if IsWindowVisible(hwnd) == 0 || !GetWindow(hwnd, GW_OWNER).is_null() {
        return 1;
    }
    let mut title = [0u16; 256];
    let length = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
    let mut class = [0u16; 64];
    let class_length = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
    let class = String::from_utf16_lossy(&class[..class_length.max(0) as usize]);
    if length <= 0 || matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd") {
        return 1;
    }
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    windows.push(Window {
        hwnd: hwnd as isize,
        title: String::from_utf16_lossy(&title[..length as usize]),
        exe: exe_name(pid),
    });
    1
}

fn open_windows() -> Vec<Window> {
    let mut windows: Vec<Window> = Vec::new();
    unsafe { EnumWindows(Some(collect), &mut windows as *mut Vec<Window> as LPARAM) };
    windows
}

/// Finestra "visibile" ma nascosta da Windows: app dello Store sospese, altri desktop virtuali,
/// servizi come "Microsoft Text Input Application".
fn cloaked(hwnd: isize) -> bool {
    let mut cloaked = 0u32;
    let size = std::mem::size_of::<u32>() as u32;
    unsafe { DwmGetWindowAttribute(hwnd as HWND, DWMWA_CLOAKED as u32, &mut cloaked as *mut u32 as *mut _, size) == 0 && cloaked != 0 }
}

/// Un'app aperta, come nella barra delle applicazioni: niente finestrelle strumento (overlay
/// NVIDIA, servizi come AsHotplugCtrl) né finestre nascoste da Windows (misurato).
fn is_app(hwnd: isize) -> bool {
    let extended = unsafe { GetWindowLongW(hwnd as HWND, GWL_EXSTYLE) } as u32;
    extended & WS_EX_TOOLWINDOW == 0 && !cloaked(hwnd)
}

/// «Chiudi tutte le app»: Alt+F4 su ogni app aperta tranne HeyJev (`own`); il lavoro non
/// salvato lo chiede ogni app.
pub(crate) fn close_all(own: Option<isize>) -> Result<String, String> {
    let targets: Vec<isize> = open_windows()
        .into_iter()
        .map(|window| window.hwnd)
        .filter(|&hwnd| Some(hwnd) != own && is_app(hwnd))
        .collect();
    if targets.is_empty() {
        return Err("Nessuna app aperta.".into());
    }
    for &hwnd in &targets {
        unsafe { PostMessageW(hwnd as HWND, WM_SYSCOMMAND, SC_CLOSE as usize, 0) };
    }
    Ok(format!("Chiudo {} app.", targets.len()))
}

/// Le finestre principali aperte adesso: quella che compare dopo «apri X» è di X.
pub(crate) fn window_handles() -> Vec<isize> {
    open_windows().into_iter().map(|window| window.hwnd).collect()
}

/// Una finestra già aperta dell'app ("Calcolatrice"), se c'è.
pub(crate) fn window_of(app: &str) -> Option<isize> {
    let names = [words(app)];
    open_windows().into_iter().find(|window| belongs(window, &names)).map(|window| window.hwnd)
}

/// La finestra è dell'app nominata? Il titolo deve *finire* col nome ("Nuova scheda - Google
/// Chrome", "Documento1 - Word"): "Posta in arrivo - Gmail - Google Chrome" non è "Posta".
/// Oppure il programma si chiama così ("spotify", "winword" per Word).
fn belongs(window: &Window, names: &[Vec<String>]) -> bool {
    let title = words(&window.title);
    names.iter().filter(|name| !name.is_empty()).any(|name| {
        let joined = name.concat();
        title.ends_with(name) || (!window.exe.is_empty() && window.exe.ends_with(&joined))
    })
}

#[tauri::command]
pub fn close_app(app: AppHandle, name: String) -> Result<String, String> {
    // Nome detto e nome vero dal menu Start ("chrome" → "Google Chrome").
    let resolved = APPS.lock().ok().and_then(|apps| find(&name, &apps)).map(|(title, _)| title);
    let mut names = vec![words(&name)];
    if let Some(title) = &resolved {
        names.push(words(title));
    }
    let own = app
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize);
    let label = resolved.unwrap_or_else(|| name.trim().to_string());
    let targets: Vec<Window> = open_windows()
        .into_iter()
        .filter(|window| Some(window.hwnd) != own && belongs(window, &names))
        .collect();
    if targets.is_empty() {
        return Err(format!("Nessuna finestra di {label} aperta."));
    }
    for window in &targets {
        unsafe { PostMessageW(window.hwnd as HWND, WM_SYSCOMMAND, SC_CLOSE as usize, 0) };
    }
    Ok(format!("{label} chiusa."))
}

/// Nomi già in memoria, senza aspettare PowerShell (thread audio, conversazione).
pub(crate) fn cached() -> Vec<String> {
    APPS.lock()
        .map(|apps| apps.iter().map(|(name, _)| name.clone()).collect())
        .unwrap_or_default()
}

/// Nomi delle app installate (il tutorial ne fa leggere un paio).
#[tauri::command]
pub fn list_apps() -> Vec<String> {
    let mut apps = APPS.lock().map(|apps| apps.clone()).unwrap_or_default();
    if apps.is_empty() {
        apps = load().unwrap_or_default();
        cache(apps.clone());
    }
    apps.into_iter().map(|(name, _)| name).collect()
}

#[cfg(test)]
mod tests {
    use super::{belongs, find, is_app, open_windows, Window};
    use crate::words;

    /// Solo lettura: cosa chiuderebbe «chiudi tutte le app» (HeyJev a parte).
    /// cargo test open_windows_now -- --ignored --nocapture
    #[test]
    #[ignore = "legge le finestre del desktop"]
    fn open_windows_now() {
        for window in open_windows() {
            let verdict = if is_app(window.hwnd) { "chiude" } else { "resta" };
            println!("{verdict:<6} {:<18} {}", window.exe, window.title);
        }
    }

    #[test]
    fn close_matches_the_app_not_a_tab_title() {
        let window = |title: &str, exe: &str| Window { hwnd: 0, title: title.into(), exe: exe.into() };
        let chrome = [words("chrome"), words("Google Chrome")];
        assert!(belongs(&window("Nuova scheda - Google Chrome", "chrome"), &chrome));
        assert!(belongs(&window("Documento1 - Word", "winword"), &[words("word")]));
        assert!(belongs(&window("Senza titolo - Blocco note", "notepad"), &[words("blocco note")]));
        assert!(belongs(&window("Artista - Canzone", "spotify"), &[words("Spotify")]));
        // "chiudi posta" non chiude la scheda di Gmail in Chrome, "chiudi word" non chiude WordPad.
        assert!(!belongs(&window("Posta in arrivo - Gmail - Google Chrome", "chrome"), &[words("posta")]));
        assert!(!belongs(&window("Documento - WordPad", "wordpad"), &[words("word")]));
    }

    #[test]
    fn spoken_names_find_the_right_app() {
        let apps: Vec<(String, String)> = [
            "Esplora file",
            "FileZilla",
            "PitStop Workshop Manager",
            "SmileSync",
            "Google Chrome",
            "Word",
        ]
        .iter()
        .map(|name| (name.to_string(), String::new()))
        .collect();
        let found = |query: &str| find(query, &apps).map(|app| app.0);
        assert_eq!(found("file").as_deref(), Some("Esplora file"));
        assert_eq!(found("Esplora file").as_deref(), Some("Esplora file"));
        assert_eq!(found("FileZilla").as_deref(), Some("FileZilla"));
        assert_eq!(found("pit stop").as_deref(), Some("PitStop Workshop Manager"));
        assert_eq!(found("Smile Sync").as_deref(), Some("SmileSync"));
        assert_eq!(found("smile sink").as_deref(), Some("SmileSync"));
        assert_eq!(found("chrome").as_deref(), Some("Google Chrome"));
        assert_eq!(found("Word.").as_deref(), Some("Word"));
        assert_eq!(found("Photoshop"), None);
        assert_eq!(found("e"), None);
    }
}
