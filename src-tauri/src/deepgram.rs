//! Deepgram: ascolto in streaming (nova-3, italiano) e voce Aura 2 Maia, via WebSocket.
//! La chiave resta nel backend: Credential Manager (Impostazioni) o DEEPGRAM_API_KEY.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Url};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

use crate::speaker;

const KEY_ACCOUNT: &str = "deepgram-api-key";
const LISTEN_URL: &str = "wss://api.deepgram.com/v1/listen";
const SPEAK_URL: &str = "wss://api.deepgram.com/v1/speak";
const STT_RATE: u32 = 16_000;
/// Nomi delle app passati a nova-3 come parole chiave ("SmileSync", "PitStop"…).
const MAX_KEYTERMS: usize = 60;

pub(crate) fn key() -> Option<String> {
    crate::secret(KEY_ACCOUNT, &["DEEPGRAM_API_KEY"])
}

#[tauri::command]
pub fn deepgram_key_configured() -> bool {
    key().is_some()
}

/// Verifica la chiave su Deepgram, poi la salva nel Credential Manager.
#[tauri::command]
pub async fn set_deepgram_key(key: String) -> Result<(), String> {
    let key = key.trim();
    crate::check_key_shape(key)?;
    let response = reqwest::Client::new()
        .get("https://api.deepgram.com/v1/projects")
        .header("Authorization", format!("Token {key}"))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "Deepgram non raggiungibile: controlla la connessione.".to_string())?;
    if !response.status().is_success() {
        return Err("Deepgram ha rifiutato la chiave.".into());
    }
    crate::store_secret(KEY_ACCOUNT, key)
}

fn request(url: Url, key: &str) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| error.to_string())?;
    let auth = format!("Token {key}")
        .parse()
        .map_err(|_| "Chiave Deepgram non valida.".to_string())?;
    request.headers_mut().insert("Authorization", auth);
    Ok(request)
}

/// Ascolto di una sessione: il microfono va a Deepgram, ogni frase finita torna come
/// `app:transcript` e le parziali come `app:interim`. Chiudere = far cadere il `Listener`.
pub(crate) struct Listener {
    audio: UnboundedSender<Vec<u8>>,
    failed: Arc<AtomicBool>,
    /// Deepgram sta ancora ascoltando una frase non finita: la sessione non deve chiudersi.
    pending: Arc<AtomicBool>,
}

impl Listener {
    pub(crate) fn start(app: &AppHandle, key: String, apps: Vec<String>) -> Self {
        let (audio, receiver) = unbounded_channel();
        let failed = Arc::new(AtomicBool::new(false));
        let pending = Arc::new(AtomicBool::new(false));
        let (app, failed_task, pending_task) = (app.clone(), Arc::clone(&failed), Arc::clone(&pending));
        tauri::async_runtime::spawn(async move {
            if let Err(error) = listen(&app, &key, &apps, receiver, &pending_task).await {
                failed_task.store(true, Ordering::Release);
                pending_task.store(false, Ordering::Release);
                let _ = app.emit("app:transcript-error", format!("Deepgram: {error} Uso Whisper."));
            }
        });
        Self {
            audio,
            failed,
            pending,
        }
    }

    /// Connessione caduta: la sessione torna a Whisper locale.
    pub(crate) fn failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }

    pub(crate) fn pending(&self) -> bool {
        self.pending.load(Ordering::Acquire)
    }

    /// Microfono (qualsiasi frequenza) → linear16 a 16 kHz.
    pub(crate) fn send(&self, samples: &[f32], rate: u32) {
        let pcm: Vec<u8> = speaker::resample(samples, rate, STT_RATE)
            .into_iter()
            .flat_map(|s| ((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes())
            .collect();
        let _ = self.audio.send(pcm);
    }
}

fn keyterms(apps: &[String]) -> Vec<String> {
    let mut names: Vec<&String> = apps
        .iter()
        .filter(|name| !name.to_lowercase().contains("microsoft") && name.len() <= 30)
        .collect();
    names.sort_by_key(|name| name.len());
    names.dedup();
    names.into_iter().take(MAX_KEYTERMS).cloned().collect()
}

async fn listen(
    app: &AppHandle,
    key: &str,
    apps: &[String],
    mut audio: UnboundedReceiver<Vec<u8>>,
    pending: &AtomicBool,
) -> Result<(), String> {
    let mut params = vec![
        ("model", "nova-3".to_string()),
        ("language", "it".into()),
        ("encoding", "linear16".into()),
        ("sample_rate", STT_RATE.to_string()),
        ("channels", "1".into()),
        ("interim_results", "true".into()),
        // Solo punteggiatura: smart_format scriveva "seconda riga" come "2º riga" (misurato),
        // male per «Scrivi …». I numeri restano come si dicono.
        ("punctuate", "true".into()),
        // Fine frase dopo 300 ms di silenzio; UtteranceEnd come rete di sicurezza.
        ("endpointing", "300".into()),
        ("utterance_end_ms", "1000".into()),
        ("vad_events", "true".into()),
    ];
    params.extend(keyterms(apps).into_iter().map(|term| ("keyterm", term)));
    let url = Url::parse_with_params(LISTEN_URL, &params).map_err(|error| error.to_string())?;
    let (socket, _) = connect_async(request(url, key)?)
        .await
        .map_err(|error| format!("connessione non riuscita ({error})."))?;
    let (mut sink, mut stream) = socket.split();
    let mut finals = String::new();
    let mut open = true;
    loop {
        tokio::select! {
            chunk = audio.recv(), if open => match chunk {
                Some(pcm) => sink.send(Message::binary(pcm)).await.map_err(|e| e.to_string())?,
                // Sessione finita: Deepgram chiude dopo aver mandato le ultime frasi.
                None => {
                    open = false;
                    sink.send(Message::text(r#"{"type":"CloseStream"}"#)).await.map_err(|e| e.to_string())?;
                }
            },
            message = stream.next() => match message {
                Some(Ok(Message::Text(text))) => handle(app, text.as_str(), &mut finals, pending),
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(error.to_string()),
            },
        }
    }
    finish(app, &mut finals, pending);
    Ok(())
}

fn handle(app: &AppHandle, message: &str, finals: &mut String, pending: &AtomicBool) {
    let Ok(message) = serde_json::from_str::<Value>(message) else {
        return;
    };
    match message["type"].as_str() {
        Some("Results") => {
            let text = message["channel"]["alternatives"][0]["transcript"]
                .as_str()
                .unwrap_or("")
                .trim();
            // Mentre Maia parla (e subito dopo) il microfono sente anche lei dalle casse.
            if !text.is_empty() && speaker::echo_window() {
                if is_echo(text, &speaker::spoken_words(), speaker::speaking()) {
                    return;
                }
                // Parole sue, non di Maia: l'utente la interrompe (barge-in).
                if speaker::speaking() {
                    speaker::interrupt();
                    let _ = app.emit("app:barge-in", ());
                }
            }
            if message["is_final"].as_bool() == Some(true) {
                if !text.is_empty() {
                    finals.push(' ');
                    finals.push_str(text);
                }
                if message["speech_final"].as_bool() == Some(true) {
                    finish(app, finals, pending);
                }
            } else if !text.is_empty() {
                pending.store(true, Ordering::Release);
                let _ = app.emit("app:interim", format!("{finals} {text}").trim().to_string());
            }
        }
        Some("UtteranceEnd") => finish(app, finals, pending),
        _ => {}
    }
}

fn finish(app: &AppHandle, finals: &mut String, pending: &AtomicBool) {
    let text = finals.trim();
    if !text.is_empty() {
        let _ = app.emit("app:transcript", text.to_string());
    }
    finals.clear();
    pending.store(false, Ordering::Release);
}

/// Parole che interrompono Maia anche da sole (se non le ha appena dette lei).
const HUSH: [&str; 9] = ["basta", "stop", "aspetta", "zitta", "fermati", "silenzio", "grazie", "annulla", "wait"];

/// La frase sentita è l'eco di Maia o l'utente? Eco = quasi tutte parole che Maia ha appena
/// detto. Mentre parla servono almeno due parole nuove (una parola storpiata dell'eco non
/// deve zittirla); a voce finita basta una risposta breve tutta nuova ("sì").
fn is_echo(heard: &str, spoken: &[String], speaking: bool) -> bool {
    let heard = crate::words(heard);
    if heard.iter().any(|word| HUSH.contains(&word.as_str()) && !spoken.contains(word)) {
        return false;
    }
    let new = heard.iter().filter(|word| !spoken.contains(word)).count();
    let user = (new >= 2 && new * 2 >= heard.len()) || (!speaking && new == heard.len() && new > 0);
    !user
}

/// Voce Aura 2 Maia: il testo arriva a frasi da `text` (anche mentre l'LLM scrive) e
/// l'audio va in coda agli altoparlanti man mano. Si ferma al barge-in.
pub(crate) async fn speak(key: String, mut text: UnboundedReceiver<String>, generation: u64) -> Result<(), String> {
    let url = Url::parse_with_params(
        SPEAK_URL,
        [
            ("model", "aura-2-maia-it".to_string()),
            ("encoding", "linear16".into()),
            ("sample_rate", speaker::VOICE_RATE.to_string()),
        ],
    )
    .map_err(|error| error.to_string())?;
    let (socket, _) = connect_async(request(url, &key)?)
        .await
        .map_err(|error| format!("Voce Deepgram non raggiungibile ({error})."))?;
    let (mut sink, mut stream) = socket.split();
    let (mut sent, mut flushed, mut open) = (0, 0, true);
    let interrupted = || speaker::generation() != generation;
    while (open || flushed < sent) && !interrupted() {
        tokio::select! {
            chunk = text.recv(), if open => match chunk {
                Some(chunk) => {
                    speaker::remember(&chunk);
                    sink.send(Message::text(json!({ "type": "Speak", "text": chunk }).to_string())).await.map_err(|e| e.to_string())?;
                    sink.send(Message::text(r#"{"type":"Flush"}"#)).await.map_err(|e| e.to_string())?;
                    sent += 1;
                }
                None => open = false,
            },
            message = stream.next() => match message {
                Some(Ok(Message::Binary(pcm))) => speaker::push(&pcm, generation),
                Some(Ok(Message::Text(reply))) if reply.as_str().contains("\"Flushed\"") => flushed += 1,
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(error.to_string()),
            },
            // Ricontrolla l'interruzione anche se Deepgram tace.
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }
    if interrupted() {
        let _ = sink.send(Message::text(r#"{"type":"Clear"}"#)).await;
    }
    let _ = sink.send(Message::text(r#"{"type":"Close"}"#)).await;
    Ok(())
}

/// Divide il testo in frasi da mandare alla voce appena sono complete.
pub(crate) fn take_sentence(buffer: &mut String, force: bool) -> Option<String> {
    let cut = buffer
        .char_indices()
        .find(|&(i, c)| ".!?;:\n".contains(c) && i >= 12 && buffer[i + c.len_utf8()..].starts_with([' ', '\n']))
        .map(|(i, c)| i + c.len_utf8());
    let cut = cut.or((force && !buffer.trim().is_empty()).then_some(buffer.len()))?;
    let sentence: String = buffer.drain(..cut).collect();
    Some(sentence.trim().to_string()).filter(|s| !s.is_empty())
}

/// Dice un testo (esito di un comando, avviso): solo se c'è la chiave Deepgram.
pub(crate) fn say(text: &str) {
    let Some(key) = key() else { return };
    // Niente emoji o simboli: Maia li leggerebbe.
    let mut clean: String = text
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || ".,;:!?'’«»\"()%€-".contains(*c))
        .collect();
    let (sender, receiver) = unbounded_channel();
    while let Some(sentence) = take_sentence(&mut clean, true) {
        let _ = sender.send(sentence);
    }
    drop(sender);
    let generation = speaker::generation();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = speak(key, receiver, generation).await {
            eprintln!("HeyJev voce: {error}");
        }
    });
}

#[tauri::command]
pub fn speak_text(text: String) {
    say(&text);
}

#[cfg(test)]
mod tests {
    use super::{is_echo, take_sentence};

    #[test]
    fn maia_echo_is_not_the_user() {
        let spoken = crate::words("La differenza principale è che la RAM è la memoria veloce del computer. Posso aiutarti?");
        // Test reale: il microfono ha risentito Maia dalle casse.
        assert!(is_echo("La", &spoken, true));
        assert!(is_echo("La differenza", &spoken, true));
        assert!(is_echo("la RAM è la memoria del computer", &spoken, true));
        assert!(is_echo("la DTS memoria", &spoken, true)); // una parola storpiata non basta
        // L'utente che interrompe.
        assert!(!is_echo("Basta!", &spoken, true));
        assert!(!is_echo("Grazie.", &spoken, true));
        let polite = crate::words("Grazie a te, a presto!");
        assert!(is_echo("Grazie", &polite, true)); // il "grazie" di Maia non la zittisce
        assert!(!is_echo("apri la calcolatrice", &spoken, true));
        // Risposta breve appena Maia ha finito.
        assert!(!is_echo("Sì.", &spoken, false));
        assert!(is_echo("Sì.", &spoken, true)); // mentre parla una parola sola non la zittisce
    }

    #[test]
    fn sentences_are_cut_for_the_voice() {
        let mut buffer = "Apro Spotify. Poi dimmi tu".to_string();
        assert_eq!(take_sentence(&mut buffer, false).as_deref(), Some("Apro Spotify."));
        assert_eq!(take_sentence(&mut buffer, false), None); // frase non finita: si aspetta
        assert_eq!(take_sentence(&mut buffer, true).as_deref(), Some("Poi dimmi tu"));
        let mut numbers = "Costa 3.50 euro. Ok".to_string(); // il punto dei decimali non taglia
        assert_eq!(take_sentence(&mut numbers, false).as_deref(), Some("Costa 3.50 euro."));
    }
}
