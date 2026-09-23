//! Esecutore laconico: le frasi che il parser locale non riconosce vanno a Gemini Flash
//! (OpenRouter), che deve solo scegliere lo strumento giusto. Niente conversazione, niente
//! risposte a domande generiche: se non è un comando per il PC, `not_a_command`.
//! Ogni strumento scelto arriva al frontend come `app:tool` e viene eseguito subito.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// Scelto su tool_eval (11 frasi, strumento obbligatorio): 3.5 Flash-Lite 11/11 in 0,66 s
/// (max 0,96 s); 3.5 Flash 11/11 ma 1,8 s (max 11 s); 2.5 Flash 11/11 in 1,2 s.
const MODEL: &str = "google/gemini-3.5-flash-lite";
const MAX_TURNS: usize = 6;

/// Ultime richieste della sessione: servono per "e poi chiudila", "aprila di nuovo".
static HISTORY: Mutex<Vec<Value>> = Mutex::new(Vec::new());
static BUSY: AtomicBool = AtomicBool::new(false);

const SYSTEM: &str = "Sei Jev, l'esecutore dei comandi vocali di HeyJev su un PC Windows. Non fai conversazione e non rispondi a domande: traduci la frase dell'utente nello strumento giusto e basta. Se la frase non chiede un'azione sul PC (domande di cultura, calcoli, curiosità, chiacchiere, frasi incomplete) usa not_a_command. Usa create_document o create_website solo se l'utente chiede esplicitamente di creare un documento, un testo, un sito o un'app. Se l'utente saluta, ringrazia o dice basta usa end_conversation.";

/// Nuova sessione («Hey Jev»): si riparte da zero.
pub(crate) fn reset() {
    if let Ok(mut history) = HISTORY.lock() {
        history.clear();
    }
}

/// Gemini sta ancora scegliendo: la sessione non deve chiudersi per silenzio.
pub(crate) fn busy() -> bool {
    BUSY.load(Ordering::Acquire)
}

fn tool(name: &str, description: &str, parameter: Option<(&str, &str)>) -> Value {
    let parameters = match parameter {
        Some((field, about)) => json!({
            "type": "object",
            "properties": { field: { "type": "string", "description": about } },
            "required": [field]
        }),
        None => json!({ "type": "object", "properties": {} }),
    };
    json!({ "type": "function", "function": { "name": name, "description": description, "parameters": parameters } })
}

fn tools() -> Value {
    json!([
        tool("open_app", "Apre un'app installata.", Some(("name", "Nome esatto dell'app, dalla lista delle app installate."))),
        tool("open_terminal", "Apre il terminale di Windows.", None),
        tool("open_claude", "Apre Claude nel browser.", None),
        tool("open_chatgpt", "Apre ChatGPT nel browser.", None),
        tool("show_desktop", "Mostra il desktop.", None),
        tool("close_window", "Chiude la finestra in primo piano.", None),
        tool("check_updates", "Controlla se c'è una nuova versione di HeyJev.", None),
        tool("create_document", "Fa scrivere un documento (file Markdown in Download).", Some(("request", "La richiesta completa: argomento, contenuto, stile."))),
        tool("create_website", "Fa creare un sito, un MVP o un'app (cartella nel profilo utente).", Some(("request", "La richiesta completa: cosa deve fare e come deve essere."))),
        tool("end_conversation", "L'utente ha finito: saluta, ringrazia o dice basta.", None),
        tool("not_a_command", "La frase non chiede un'azione sul PC.", None),
    ])
}

/// Sceglie gli strumenti per una frase che non è un comando diretto; il frontend li esegue
/// (`app:tool`). Ritorna i nomi scelti.
#[tauri::command]
pub async fn interpret(app: AppHandle, text: String) -> Result<Vec<String>, String> {
    let text = text.trim().to_string();
    if text.is_empty() || text.len() > 2_000 {
        return Err("Frase vuota o troppo lunga.".into());
    }
    BUSY.store(true, Ordering::Release);
    let result = choose(&app, &text).await;
    BUSY.store(false, Ordering::Release);
    result
}

async fn choose(app: &AppHandle, text: &str) -> Result<Vec<String>, String> {
    let apps = crate::apps::cached();
    let mut messages = vec![json!({
        "role": "system",
        "content": format!("{SYSTEM}\nApp installate: {}.", apps.join(", "))
    })];
    messages.extend(HISTORY.lock().map(|h| h.clone()).unwrap_or_default());
    messages.push(json!({ "role": "user", "content": text }));

    let body: Value = reqwest::Client::new()
        .post("https://openrouter.ai/api/v1/chat/completions")
        .bearer_auth(crate::ai::api_key()?)
        .header("X-Title", "HeyJev")
        .timeout(Duration::from_secs(15))
        .json(&request(MODEL, messages))
        .send()
        .await
        .map_err(|_| "OpenRouter non raggiungibile.".to_string())?
        .json()
        .await
        .map_err(|error| format!("Risposta OpenRouter non valida: {error}"))?;
    let calls = tool_calls(&body);
    if calls.is_empty() {
        return Err(body["error"]["message"]
            .as_str()
            .map(|detail| format!("OpenRouter: {detail}"))
            .unwrap_or_else(|| "Nessun comando riconosciuto.".into()));
    }
    for (name, args) in &calls {
        let _ = app.emit("app:tool", json!({ "name": name, "args": args }));
    }
    let names: Vec<String> = calls.into_iter().map(|(name, _)| name).collect();
    if let Ok(mut history) = HISTORY.lock() {
        history.push(json!({ "role": "user", "content": text }));
        history.push(json!({ "role": "assistant", "content": format!("[{}]", names.join(", ")) }));
        let excess = history.len().saturating_sub(MAX_TURNS * 2);
        history.drain(..excess);
    }
    Ok(names)
}

/// Solo strumenti, niente testo: più rapido e nessuna chiacchiera possibile.
fn request(model: &str, messages: Vec<Value>) -> Value {
    json!({
        "model": model,
        "messages": messages,
        "tools": tools(),
        "tool_choice": "required",
        "reasoning": { "effort": "minimal" }
    })
}

/// (nome, argomenti) degli strumenti scelti; i nomi a volte arrivano come "default_api.x".
fn tool_calls(body: &Value) -> Vec<(String, Value)> {
    body["choices"][0]["message"]["tool_calls"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|call| {
            let name = call["function"]["name"].as_str()?;
            let name = name.rsplit('.').next().unwrap_or(name).to_string();
            let args = call["function"]["arguments"]
                .as_str()
                .and_then(|args| serde_json::from_str(args).ok())
                .unwrap_or_else(|| json!({}));
            Some((name, args))
        })
        .collect()
}

#[cfg(test)]
mod tool_eval {
    use serde_json::json;
    use std::time::Instant;

    /// Ogni modello sceglie lo strumento giusto? E quanto ci mette? (chiave OpenRouter dell'app)
    /// HEYJEV_MODELS=a,b cargo test tool_eval -- --ignored --nocapture
    #[test]
    #[ignore = "rete + chiave OpenRouter"]
    fn tool_eval() {
        let cases = [
            ("Fammi partire Spotify per favore", "open_app"),
            ("Puoi farmi vedere il desktop?", "show_desktop"),
            ("Scrivimi un documento sulla storia di Venezia", "create_document"),
            ("Che circonferenza ha la Terra?", "not_a_command"),
            ("Quanto fa diciassette per ventitré?", "not_a_command"),
            ("Ok basta così, grazie", "end_conversation"),
            ("Mi serve fare due conti, apri la calcolatrice", "open_app"),
            ("Chiudi questa finestra", "close_window"),
            ("Preparami una landing page per il mio studio dentistico", "create_website"),
            ("Metti su SmileSync", "open_app"),
            ("Vorrei lavorare sul gestionale dell'officina", "open_app"),
        ];
        let key = crate::ai::api_key().unwrap();
        let system = format!(
            "{}\nApp installate: Spotify, Calcolatrice, Esplora file, SmileSync, PitStop Workshop Manager, Google Chrome.",
            super::SYSTEM
        );
        for model in std::env::var("HEYJEV_MODELS").unwrap().split(',') {
            let (mut ok, mut times) = (0, Vec::new());
            for (text, expected) in cases {
                let start = Instant::now();
                let messages = vec![json!({ "role": "system", "content": system }), json!({ "role": "user", "content": text })];
                let body: serde_json::Value = tauri::async_runtime::block_on(async {
                    reqwest::Client::new()
                        .post("https://openrouter.ai/api/v1/chat/completions")
                        .bearer_auth(&key)
                        .json(&super::request(model, messages))
                        .send().await.unwrap().json().await.unwrap()
                });
                times.push(start.elapsed().as_millis());
                let calls = super::tool_calls(&body);
                let first = calls.first().map(|(name, _)| name.as_str()).unwrap_or("");
                ok += usize::from(first == expected);
                let error = body["error"]["message"].as_str().unwrap_or("");
                println!("TOOL {model} | {text} -> {calls:?} {error}");
            }
            times.sort();
            println!("SCORE {model}: {ok}/{} giusti, mediana {} ms, max {} ms", cases.len(), times[times.len() / 2], times[times.len() - 1]);
        }
    }
}
