//! «Apri <app>»: cerca il nome detto tra le app del menu Start e la avvia.

use std::{os::windows::process::CommandExt, process::Command, sync::Mutex, thread};

use serde_json::Value;

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
    Command::new("explorer.exe")
        .arg(format!("shell:AppsFolder\\{id}"))
        .spawn()
        .map_err(|error| format!("Impossibile aprire {title}: {error}"))?;
    Ok(format!("{title} aperta."))
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
    use super::find;

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
