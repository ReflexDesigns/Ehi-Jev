//! Orchestrazione AI via OpenRouter: Gemini Flash scrive documenti (in Download),
//! DeepSeek Flash genera progetti (in `%USERPROFILE%\<nome>`).

use std::{
    env, fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

// Alias "latest" di OpenRouter: puntano sempre all'ultima versione Flash.
const DOC_MODEL: &str = "~google/gemini-flash-latest";
const CODE_MODEL: &str = "~deepseek/deepseek-flash-latest";
const OPENROUTER: &str = "https://openrouter.ai/api/v1";
const KEY_SERVICE: &str = "com.heyjev.app";
const KEY_ACCOUNT: &str = "openrouter-api-key";
const MAX_FILES: usize = 200;
const MAX_BYTES: usize = 5_000_000;

const DOC_PROMPT: &str = "Sei lo scrittore di HeyJev. Scrivi il documento che l'utente chiede, completo e ben strutturato, nella lingua della richiesta. La richiesta è dettata a voce: ignora esitazioni, saluti ed errori di trascrizione. Formato Markdown (.md), oppure testo semplice (.txt) solo se l'utente chiede un file di testo. Rispondi SOLO con JSON: {\"filename\": \"nome-breve.md\", \"content\": \"...\"}.";

const CODE_PROMPT: &str = "Sei lo sviluppatore di HeyJev. Crea il progetto che l'utente chiede (sito, MVP, app, prototipo): completo, funzionante e curato nel design. Preferisci lo stack più semplice che basta: un sito statico HTML/CSS/JS senza build step se possibile (index.html nella radice). Includi un README.md con cosa fa e come avviarlo. La richiesta è dettata a voce: ignora esitazioni, saluti ed errori di trascrizione. Niente file binari. Rispondi SOLO con JSON: {\"name\": \"nome-progetto-kebab-case\", \"files\": [{\"path\": \"percorso/relativo.ext\", \"content\": \"...\"}]}.";

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, KEY_ACCOUNT)
        .map_err(|_| "Windows Credential Manager non è disponibile.".to_string())
}

fn api_key() -> Result<String, String> {
    key_entry()
        .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        .or_else(|_| env::var("OPENROUTER_API_KEY"))
        .map(|key| key.trim().to_string())
        .ok()
        .filter(|key| !key.is_empty() && !key.starts_with("your_"))
        .ok_or_else(|| {
            "Chiave OpenRouter non configurata: Impostazioni → Chiave OpenRouter.".into()
        })
}

#[tauri::command]
pub fn ai_key_configured() -> bool {
    api_key().is_ok()
}

/// Verifica la chiave su OpenRouter e la salva nel Credential Manager.
#[tauri::command]
pub async fn set_ai_key(key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.len() < 20 || key.len() > 512 || key.chars().any(char::is_whitespace) {
        return Err("Chiave OpenRouter non valida.".into());
    }
    let response = client(15)?
        .get(format!("{OPENROUTER}/key"))
        .bearer_auth(&key)
        .send()
        .await
        .map_err(|_| "OpenRouter non raggiungibile: controlla la connessione.".to_string())?;
    if !response.status().is_success() {
        return Err("OpenRouter ha rifiutato la chiave.".into());
    }
    key_entry()?
        .set_password(&key)
        .map_err(|_| "Windows non ha salvato la chiave nel Credential Manager.".into())
}

fn client(timeout: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .user_agent("HeyJev")
        .build()
        .map_err(|error| error.to_string())
}

/// Una chiamata chat a OpenRouter che deve restituire un oggetto JSON.
async fn complete(model: &str, system: &str, request: &str, timeout: u64) -> Result<Value, String> {
    let response = client(timeout)?
        .post(format!("{OPENROUTER}/chat/completions"))
        .bearer_auth(api_key()?)
        .header("X-Title", "HeyJev")
        .json(&json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": request }
            ],
            "response_format": { "type": "json_object" }
        }))
        .send()
        .await
        .map_err(|error| format!("OpenRouter non ha risposto: {error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Risposta OpenRouter non valida: {error}"))?;
    if !status.is_success() {
        let detail = body["error"]["message"]
            .as_str()
            .unwrap_or("nessun dettaglio");
        return Err(format!("OpenRouter HTTP {status}: {detail}"));
    }
    let content = body["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "OpenRouter non ha restituito testo.".to_string())?;
    // Alcuni modelli avvolgono il JSON in ```json … ```: si prende dalla prima { all'ultima }.
    let json = content
        .find('{')
        .zip(content.rfind('}'))
        .map(|(start, end)| &content[start..=end])
        .ok_or_else(|| "Il modello non ha restituito JSON.".to_string())?;
    serde_json::from_str(json).map_err(|error| format!("JSON del modello non valido: {error}"))
}

/// Nome file/cartella sicuro: niente separatori, caratteri riservati o punti iniziali.
fn safe_name(raw: &str, fallback: &str) -> String {
    let name: String = raw
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || " -_.".contains(c) {
                c
            } else {
                '-'
            }
        })
        .take(80)
        .collect();
    let name = name.trim_matches(|c: char| c == '.' || c == ' ' || c == '-');
    if name.is_empty() {
        fallback.into()
    } else {
        name.into()
    }
}

/// Primo percorso libero: `nome`, `nome (2)`, `nome (3)`…
fn unique(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    (1..)
        .map(|n| {
            let stem = if n == 1 {
                stem.to_string()
            } else {
                format!("{stem} ({n})")
            };
            dir.join(if ext.is_empty() {
                stem
            } else {
                format!("{stem}.{ext}")
            })
        })
        .find(|path| !path.exists())
        .expect("infiniti candidati")
}

/// Percorso relativo scritto dal modello: solo componenti normali, dentro la cartella progetto.
fn project_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if relative.contains(':')
        || !path
            .components()
            .any(|part| matches!(part, Component::Normal(_)))
        || !path
            .components()
            .all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!("Percorso non consentito nel progetto: {relative}"));
    }
    Ok(root.join(path))
}

#[tauri::command]
pub async fn ai_create(app: AppHandle, kind: String, request: String) -> Result<String, String> {
    let request = request.trim();
    if request.is_empty() || request.len() > 4_000 {
        return Err("Richiesta vuota o troppo lunga.".into());
    }
    match kind.as_str() {
        "create_document" => {
            let answer = complete(DOC_MODEL, DOC_PROMPT, request, 180).await?;
            let content = answer["content"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| "Il modello non ha scritto il documento.".to_string())?;
            let filename = safe_name(answer["filename"].as_str().unwrap_or(""), "documento");
            let (stem, ext) = match filename.rsplit_once('.') {
                Some((stem, ext)) if ext.eq_ignore_ascii_case("txt") => (stem, "txt"),
                Some((stem, ext)) if ext.eq_ignore_ascii_case("md") => (stem, "md"),
                _ => (filename.as_str(), "md"),
            };
            let downloads = app
                .path()
                .download_dir()
                .map_err(|error| error.to_string())?;
            let path = unique(&downloads, stem, ext);
            fs::write(&path, content)
                .map_err(|error| format!("Salvataggio non riuscito: {error}"))?;
            let _ = crate::open_url(&path.to_string_lossy());
            Ok(format!(
                "Documento salvato in Download: {}",
                file_name(&path)
            ))
        }
        "create_project" => {
            let answer = complete(CODE_MODEL, CODE_PROMPT, request, 600).await?;
            let files = answer["files"]
                .as_array()
                .filter(|files| !files.is_empty() && files.len() <= MAX_FILES)
                .ok_or_else(|| "Il modello non ha restituito i file del progetto.".to_string())?;
            let name = safe_name(answer["name"].as_str().unwrap_or(""), "nuovo-progetto");
            let home = app.path().home_dir().map_err(|error| error.to_string())?;
            let root = unique(&home, &name, "");
            // Valida tutto prima di scrivere: niente progetti a metà fuori dalla cartella.
            let mut total = 0;
            let mut planned = Vec::new();
            for file in files {
                let path = project_path(&root, file["path"].as_str().unwrap_or(""))?;
                let content = file["content"].as_str().unwrap_or("");
                total += content.len();
                planned.push((path, content));
            }
            if total > MAX_BYTES {
                return Err("Progetto troppo grande (oltre 5 MB).".into());
            }
            for (path, content) in planned {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::write(&path, content)
                    .map_err(|error| format!("Scrittura non riuscita: {error}"))?;
            }
            let index = root.join("index.html");
            let _ = crate::open_url(&root.to_string_lossy());
            if index.is_file() {
                let _ = crate::open_url(&index.to_string_lossy());
            }
            Ok(format!("Progetto creato: {}", root.display()))
        }
        _ => Err("Tipo di creazione non consentito.".into()),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_paths_stay_inside_project() {
        let root = Path::new("C:\\Users\\x\\sito");
        assert!(project_path(root, "index.html").is_ok());
        assert!(project_path(root, "css/style.css").is_ok());
        assert!(project_path(root, "./app.js").is_ok());
        for bad in [
            "../evil.txt",
            "C:\\evil.txt",
            "\\evil.txt",
            "a/../../b",
            "",
            "x:y",
            ".",
        ] {
            assert!(project_path(root, bad).is_err(), "{bad}");
        }
        assert_eq!(
            safe_name("..\\..\\Storia di Roma?.md", "d"),
            "Storia di Roma-.md"
        );
        assert_eq!(safe_name("...", "d"), "d");
    }
}
