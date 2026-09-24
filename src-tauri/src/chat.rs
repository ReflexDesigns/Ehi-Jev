//! Esecutore laconico: le frasi che il parser locale non riconosce vanno a **Jev**
//! (TypeSafe SystemOne), che sceglie in una sola richiesta l'azione e l'app. Quello che Jev
//! non sa fare (più azioni in fila, testo da scrivere, tasti) o scarta come non comando lo
//! decide Gemini Flash-Lite (OpenRouter), che è anche la riserva senza chiave Jev. Niente
//! conversazione: se non è un comando per il PC, `not_a_command`. Ogni scelta arriva al
//! frontend come `app:tool` e viene eseguita, in ordine.

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

const SYSTEM: &str = "Sei Jev, l'esecutore dei comandi vocali di HeyJev su un PC Windows. Non fai conversazione e non rispondi a domande: traduci la frase dell'utente negli strumenti giusti e basta. Se la frase chiede più azioni usa più strumenti, nell'ordine in cui sono dette: «apri la calcolatrice e fai 2500 più 3850» è open_app Calcolatrice, type_text «2500+3850», press_keys «=». Per scrivere o digitare usa type_text, per premere o cliccare un tasto press_keys. Se la frase non chiede un'azione sul PC (domande di cultura, calcoli senza chiedere di farli su un'app, curiosità, chiacchiere, frasi incomplete) usa not_a_command. Usa create_document o create_website solo se l'utente chiede esplicitamente di creare un documento, un testo, un sito o un'app. Se l'utente saluta, ringrazia o dice basta usa end_conversation.";

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
        tool("close_app", "Chiude un'app aperta.", Some(("name", "Nome esatto dell'app, dalla lista delle app installate."))),
        tool("web_search", "Cerca su Google.", Some(("query", "Cosa cercare."))),
        tool("type_text", "Scrive un testo nella finestra in primo piano (o nell'app appena aperta).", Some(("text", "Il testo da scrivere, esattamente come detto; numeri e operazioni in cifre e simboli (2500+3850)."))),
        tool("press_keys", "Preme un tasto o una scorciatoia nella finestra in primo piano (o nell'app appena aperta).", Some(("keys", "Un tasto o una combinazione: enter, tab, esc, =, up, f5, ctrl+s, alt+tab…"))),
        tool("open_terminal", "Apre il terminale di Windows.", None),
        tool("open_claude", "Apre Claude nel browser.", None),
        tool("open_chatgpt", "Apre ChatGPT nel browser.", None),
        tool("show_desktop", "Mostra il desktop.", None),
        tool("close_window", "Chiude la finestra in primo piano.", None),
        tool("close_all", "Chiude tutte le app aperte (tranne HeyJev).", None),
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
    let calls = match crate::jev_key() {
        Some(key) => race(&key, text).await?,
        None => gemini_choose(text).await?,
    };
    // Il frontend le esegue in ordine: «apri X e scrivi Y» scrive nella finestra di X.
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

/// Azioni tra cui sceglie Jev (nome strumento, quando sceglierla).
const ACTIONS: [(&str, &str); 15] = [
    ("open_app", "Aprire, avviare, lanciare, far partire o mettere su un'app o un programma."),
    ("close_app", "Chiudere, spegnere, togliere o levare di torno un'app o un programma nominandolo."),
    ("web_search", "Cercare qualcosa su Google o su internet."),
    ("open_terminal", "Aprire il terminale o il prompt dei comandi."),
    ("open_claude", "Aprire Claude."),
    ("open_chatgpt", "Aprire ChatGPT."),
    ("show_desktop", "Mostrare il desktop o ridurre a icona tutte le finestre."),
    ("close_window", "Chiudere la finestra o l'app che si sta usando."),
    ("close_all", "Chiudere tutte le app, tutti i programmi o tutte le finestre aperte."),
    ("check_updates", "Controllare se c'è un aggiornamento di HeyJev."),
    ("keyboard", "Scrivere o digitare un testo, premere o cliccare un tasto, un pulsante o una scorciatoia (invio, uguale, control S…), fare un conto su un'app."),
    ("create_document", "Scrivere o creare un documento, un testo, una relazione, un file di testo."),
    ("create_website", "Creare un sito, una landing page, un MVP, un'app o un prototipo."),
    ("end_conversation", "Salutare, ringraziare, dire basta o chiudere la conversazione."),
    ("not_a_command", "Una domanda, un calcolo, una curiosità o una frase che non chiede un'azione sul PC."),
];
/// Sotto questa confidenza Jev non è sicuro: meglio non fare niente che fare la cosa sbagliata.
const MIN_CONFIDENCE: f64 = 0.5;
/// …a meno che non sia sicuro dell'app ("il gestionale dell'officina" → PitStop, misurato 0,76).
const APP_CONFIDENCE: f64 = 0.7;
/// Limite di opzioni per domanda dell'API (255), una è "none".
const MAX_APPS: usize = 254;

/// Jev risponde di solito in ~0,4 s, ma a volte supera i 5 s (misurato: 3 richieste su 11).
/// Se entro `HEDGE` non ha risposto parte anche Gemini (~0,7 s): vince il primo che riesce.
const HEDGE: Duration = Duration::from_millis(1200);

async fn race(key: &str, text: &str) -> Result<Vec<(String, Value)>, String> {
    let jev = jev_choose(key, text);
    tokio::pin!(jev);
    if let Ok(jev) = tokio::time::timeout(HEDGE, &mut jev).await {
        return match jev {
            Ok(calls) if !passes(&calls) => Ok(calls),
            jev => second_opinion(gemini_choose(text).await, jev),
        };
    }
    // Jev in ritardo: si corre in due.
    let gemini = gemini_choose(text);
    tokio::pin!(gemini);
    tokio::select! {
        jev = &mut jev => match jev {
            Ok(calls) if !passes(&calls) => Ok(calls),
            jev => second_opinion(gemini.await, jev),
        },
        calls = &mut gemini => match calls { Ok(calls) => Ok(calls), Err(_) => jev.await },
    }
}

/// Jev passa la mano: "non è un comando", oppure più azioni, testo o tasti che non sa fare.
fn passes(calls: &[(String, Value)]) -> bool {
    calls.iter().all(|(name, _)| name == "not_a_command")
}

/// Decide Gemini; se non risponde vale Jev ("non è un comando") o, se era un errore, Gemini.
fn second_opinion(
    gemini: Result<Vec<(String, Value)>, String>,
    jev: Result<Vec<(String, Value)>, String>,
) -> Result<Vec<(String, Value)>, String> {
    gemini.or_else(|error| jev.map_err(|_| error))
}

/// Jev sceglie l'azione, l'app per "apri …" e se basta un'azione sola: tre domande nella
/// stessa richiesta.
async fn jev_choose(key: &str, text: &str) -> Result<Vec<(String, Value)>, String> {
    let answers = crate::jev_ask(key, text, questions(crate::apps::cached())).await?;
    Ok(vec![pick(&answers, text)])
}

fn questions(installed: Vec<String>) -> Value {
    let actions: serde_json::Map<String, Value> = ACTIONS
        .iter()
        .map(|(name, about)| (name.to_string(), json!(about)))
        .collect();
    let mut apps: serde_json::Map<String, Value> =
        installed.into_iter().take(MAX_APPS).map(|name| (name, Value::Null)).collect();
    apps.insert("none".into(), json!("Nessuna app della lista."));
    json!({
        "action": {
            "type": "choice",
            "instructions": "Frase detta a voce all'assistente di un PC Windows: che azione chiede?",
            "criteria": actions
        },
        "app": {
            "type": "choice",
            "instructions": "Se la frase chiede di aprire o chiudere un'app, quale di queste? Altrimenti none.",
            "criteria": apps
        },
        "steps": {
            "type": "choice",
            "instructions": "Frase detta a voce all'assistente di un PC Windows: chiede una sola azione o più cose?",
            "criteria": {
                "one": "Una sola azione (aprire o chiudere un'app, chiudere tutte le app insieme, cercare, mostrare il desktop, creare un documento o un sito, salutare) o nessuna azione.",
                "many": "Più azioni una dopo l'altra, oppure scrivere o digitare un testo, fare un conto su un'app, premere o cliccare un tasto o un pulsante."
            }
        }
    })
}

/// Dalla risposta di Jev allo strumento da eseguire.
fn pick(answers: &Value, text: &str) -> (String, Value) {
    let action = answers["action"]["choice"].as_str().unwrap_or("not_a_command");
    let sure = answers["action"]["confidence"].as_f64().unwrap_or(0.0) >= MIN_CONFIDENCE;
    let app = answers["app"]["choice"].as_str().unwrap_or("none");
    let app_sure = app != "none" && answers["app"]["confidence"].as_f64().unwrap_or(0.0) >= APP_CONFIDENCE;
    let many = answers["steps"]["choice"] == "many"
        && answers["steps"]["confidence"].as_f64().unwrap_or(0.0) >= MIN_CONFIDENCE;
    let (name, args) = match action {
        // Più azioni, testo o tasti: Jev non li sa fare, passa a Gemini (vedi `passes`).
        _ if many => ("not_a_command", json!({})),
        "keyboard" => ("not_a_command", json!({})),
        _ if !sure && app_sure => ("open_app", json!({ "name": app })),
        _ if !sure => ("not_a_command", json!({})),
        "open_app" | "close_app" if app == "none" => ("not_a_command", json!({})),
        "open_app" | "close_app" => (action, json!({ "name": app })),
        // La frase intera è la richiesta: il modello che scrive ignora il "creami…".
        "create_document" | "create_website" => (action, json!({ "request": text })),
        // Google capisce la frase intera ("cercami come si fa la carbonara").
        "web_search" => (action, json!({ "query": text })),
        known if ACTIONS.iter().any(|(name, _)| *name == known) => (known, json!({})),
        _ => ("not_a_command", json!({})),
    };
    (name.to_string(), args)
}

/// Riserva senza chiave Jev: Gemini Flash con strumento obbligatorio.
async fn gemini_choose(text: &str) -> Result<Vec<(String, Value)>, String> {
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
    Ok(calls)
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
mod jev_eval {
    use std::time::Instant;

    /// Jev sceglie azione e app giuste? Quanto ci mette? (chiave Jev dell'app)
    /// cargo test jev_eval -- --ignored --nocapture
    #[test]
    #[ignore = "rete + chiave Jev"]
    fn jev_eval() {
        let cases = [
            ("Fammi partire Spotify per favore", "open_app", "Spotify"),
            ("Puoi farmi vedere il desktop?", "show_desktop", ""),
            ("Scrivimi un documento sulla storia di Venezia", "create_document", ""),
            ("Che circonferenza ha la Terra?", "not_a_command", ""),
            ("Quanto fa diciassette per ventitré?", "not_a_command", ""),
            ("Ok basta così, grazie", "end_conversation", ""),
            ("Mi serve fare due conti, apri la calcolatrice", "open_app", "Calcolatrice"),
            ("Chiudi questa finestra", "close_window", ""),
            ("Preparami una landing page per il mio studio dentistico", "create_website", ""),
            ("Metti su SmileSync", "open_app", "SmileSync"),
            ("Vorrei lavorare sul gestionale dell'officina", "open_app", "PitStop Workshop Manager"),
            ("Chiudi Chrome", "close_app", "Google Chrome"),
            ("Levami di torno la calcolatrice", "close_app", "Calcolatrice"),
            ("Cercami su internet come si fa la carbonara", "web_search", ""),
            // Più azioni, testo o tasti: Jev passa la mano a Gemini (not_a_command).
            ("Apri la calcolatrice e fai duemilacinquecento più tremila ottocentocinquanta", "not_a_command", ""),
            ("Clicca su uguale", "not_a_command", ""),
            ("Salva il file con control esse", "not_a_command", ""),
            ("Premi invio", "not_a_command", ""),
            ("Chiudi tutte le applicazioni", "close_all", ""),
            ("Levami di torno tutti i programmi aperti", "close_all", ""),
        ];
        let key = crate::jev_key().expect("chiave Jev nel Credential Manager");
        let apps = ["Spotify", "Calcolatrice", "Esplora file", "SmileSync", "PitStop Workshop Manager", "Google Chrome"];
        let questions = super::questions(apps.map(String::from).to_vec());
        let (mut ok, mut times) = (0, Vec::new());
        for (text, action, app) in cases {
            let start = Instant::now();
            let answers = tauri::async_runtime::block_on(crate::jev_ask(&key, text, questions.clone()));
            times.push(start.elapsed().as_millis());
            if let Err(error) = &answers { println!("JEV ERRORE {text}: {error} ({} ms)", times.last().unwrap()); }
            let answers = answers.unwrap_or_default();
            let (name, args) = super::pick(&answers, text);
            let good = name == action && (app.is_empty() || args["name"] == app);
            ok += usize::from(good);
            println!(
                "JEV {} {text} -> {name} {args} (azione {} {:.2}, app {} {:.2}, passi {} {:.2})",
                if good { "ok" } else { "NO" },
                answers["action"]["choice"], answers["action"]["confidence"].as_f64().unwrap_or(0.0),
                answers["app"]["choice"], answers["app"]["confidence"].as_f64().unwrap_or(0.0),
                answers["steps"]["choice"], answers["steps"]["confidence"].as_f64().unwrap_or(0.0)
            );
        }
        times.sort();
        println!("SCORE jev: {ok}/{} giusti, mediana {} ms, max {} ms", cases.len(), times[times.len() / 2], times[times.len() - 1]);
    }
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

#[cfg(test)]
mod race_eval {
    use std::time::Instant;

    /// Percorso completo (Jev + riserva Gemini) con le app vere del PC.
    /// cargo test race_eval -- --ignored --nocapture
    #[test]
    #[ignore = "rete + chiavi Jev e OpenRouter"]
    fn race_eval() {
        crate::apps::list_apps(); // carica l'elenco del menu Start
        let key = crate::jev_key().expect("chiave Jev");
        for text in [
            "Fammi partire Spotify per favore",
            "Mi serve fare due conti, apri la calcolatrice",
            "Metti su SmileSync",
            "Vorrei lavorare sul gestionale dell'officina",
            "Apri il programma per i file",
            "Che circonferenza ha la Terra?",
            "Puoi farmi vedere il desktop?",
            "Ok basta così, grazie",
            "Apri la calcolatrice e fai duemilacinquecento più tremila ottocentocinquanta",
            "Metti su la calcolatrice, digita 12 per 7 e poi premi uguale",
            "Clicca su uguale",
            "Salva il file con control esse",
            "Quanto fa diciassette per ventitré?",
        ] {
            let start = Instant::now();
            let calls = tauri::async_runtime::block_on(super::race(&key, text));
            println!("RACE {:>5} ms  {text} -> {calls:?}", start.elapsed().as_millis());
        }
    }
}
