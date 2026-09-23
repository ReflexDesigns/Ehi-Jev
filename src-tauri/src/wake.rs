//! Native, offline English wake-word detection backed by sherpa-onnx.
//!
//! The audio callback only moves small PCM chunks to a worker thread; inference
//! never runs on CPAL's real-time callback thread.

use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{channel, sync_channel, Receiver, Sender, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, SampleFormat, SizedSample, Stream, StreamConfig,
};
use serde::Serialize;
use sherpa_onnx::{KeywordSpotter, KeywordSpotterConfig, OnlineStream};
use tauri::{AppHandle, Emitter, State};

use crate::speaker;

#[derive(Default)]
pub struct WakeController {
    enabled: Arc<AtomicBool>,
    started: Arc<AtomicBool>,
    end_session: Arc<AtomicBool>,
    /// Tutorial: il worker registra la prossima frase e la manda qui.
    capture: Arc<Mutex<Option<Sender<Capture>>>>,
}

/// Frase registrata nel tutorial, con l'esito del KWS mentre la si diceva.
pub struct Capture {
    samples: Vec<f32>,
    rate: u32,
    wake: bool,
    snr: f32,
}

#[derive(Serialize)]
pub struct Sample {
    /// Cosa ha capito Whisper.
    text: String,
    /// Il KWS l'ha presa come «Hey Jev».
    wake: bool,
    /// Picco della voce rispetto al rumore di fondo.
    snr: f32,
}

#[tauri::command]
pub fn start_wake_listener(
    app: AppHandle,
    controller: State<'_, WakeController>,
) -> Result<(), String> {
    if controller.started.swap(true, Ordering::AcqRel) {
        // UI ricaricata (es. HMR in sviluppo): il listener gira già, basta riattivarlo.
        controller.enabled.store(true, Ordering::Release);
        return Ok(());
    }

    let kws = match create_keyword_spotter(&app) {
        Ok(kws) => kws,
        Err(error) => {
            controller.started.store(false, Ordering::Release);
            return Err(error);
        }
    };

    let enabled = Arc::clone(&controller.enabled);
    enabled.store(true, Ordering::Release);
    let started = Arc::clone(&controller.started);
    let end_session = Arc::clone(&controller.end_session);
    let capture = Arc::clone(&controller.capture);
    let app_for_worker = app.clone();
    if let Err(error) = thread::Builder::new()
        .name("heyjev-wake-word".into())
        .spawn(move || {
            let result =
                listen_for_keyword(kws, enabled, end_session, capture, app_for_worker.clone());
            started.store(false, Ordering::Release);
            if let Err(error) = result {
                let _ = app_for_worker.emit("app:wake-error", error);
            }
        })
    {
        controller.started.store(false, Ordering::Release);
        return Err(format!("Avvio del motore wake word fallito: {error}"));
    }

    Ok(())
}

#[tauri::command]
pub fn set_wake_enabled(active: bool, controller: State<'_, WakeController>) {
    controller.enabled.store(active, Ordering::Release);
}

/// Chiude la sessione di ascolto (es. "grazie", "silenzio").
#[tauri::command]
pub fn end_session(controller: State<'_, WakeController>) {
    controller.end_session.store(true, Ordering::Release);
}

/// Tutorial: registra la prossima frase, dice se il KWS l'ha presa come «Hey Jev» e cosa
/// sente Whisper. `wake`: frase di attivazione, trascritta come la trascrive la riserva.
#[tauri::command]
pub async fn record_sample(
    app: AppHandle,
    controller: State<'_, WakeController>,
    wake: bool,
) -> Result<Sample, String> {
    let (sender, receiver) = channel();
    *controller
        .capture
        .lock()
        .map_err(|_| "Microfono non disponibile.".to_string())? = Some(sender);
    let captured = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(Duration::from_secs(12))
    })
    .await
    .map_err(|error| error.to_string())?;
    let Ok(Capture {
        samples,
        rate,
        wake: heard_wake,
        snr,
    }) = captured
    else {
        if let Ok(mut pending) = controller.capture.lock() {
            pending.take();
        }
        return Err("Non ho sentito niente: riprova.".into());
    };
    let prompt = if wake {
        crate::WAKE_PROMPT
    } else {
        crate::WHISPER_PROMPT
    };
    let text = tauri::async_runtime::spawn_blocking(move || {
        crate::transcribe(&app, &samples, rate, prompt)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(Sample {
        text,
        wake: heard_wake,
        snr,
    })
}

fn create_keyword_spotter(app: &AppHandle) -> Result<KeywordSpotter, String> {
    let model_dir = crate::resource_path(
        app,
        "WAKE_MODEL_DIR",
        "models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01",
    )?;
    let encoder = model_dir.join("encoder-epoch-12-avg-2-chunk-16-left-64.onnx");
    let decoder = model_dir.join("decoder-epoch-12-avg-2-chunk-16-left-64.onnx");
    let joiner = model_dir.join("joiner-epoch-12-avg-2-chunk-16-left-64.onnx");
    let tokens = model_dir.join("tokens.txt");
    let keywords = model_dir.join("keywords.txt");

    for path in [&encoder, &decoder, &joiner, &tokens, &keywords] {
        if !path.is_file() {
            return Err(format!(
                "Modello wake word mancante ({}). Reinstalla HeyJev (in sviluppo: npm run setup:kws).",
                path.display()
            ));
        }
    }

    let mut config = KeywordSpotterConfig::default();
    config.model_config.transducer.encoder = Some(encoder.to_string_lossy().into_owned());
    config.model_config.transducer.decoder = Some(decoder.to_string_lossy().into_owned());
    config.model_config.transducer.joiner = Some(joiner.to_string_lossy().into_owned());
    config.model_config.tokens = Some(tokens.to_string_lossy().into_owned());
    config.model_config.provider = Some("cpu".into());
    config.model_config.num_threads = 1;
    config.keywords_file = Some(keywords.to_string_lossy().into_owned());
    config.keywords_score = 1.5;
    // Sotto 0.1 il richiamo non migliora (misurato): il limite è il modello, non la soglia.
    config.keywords_threshold = 0.1;

    KeywordSpotter::create(&config)
        .ok_or_else(|| "sherpa-onnx non riesce a caricare il modello English KWS.".to_string())
}

fn listen_for_keyword(
    kws: KeywordSpotter,
    enabled: Arc<AtomicBool>,
    end_session: Arc<AtomicBool>,
    capture: Arc<Mutex<Option<Sender<Capture>>>>,
    app: AppHandle,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "Nessun microfono Windows predefinito disponibile.".to_string())?;
    let supported = device
        .default_input_config()
        .map_err(|error| format!("Impossibile aprire la configurazione microfono: {error}"))?;
    let sample_format = supported.sample_format();
    let config = supported.config();
    let channels = usize::from(config.channels).max(1);
    let sample_rate = config.sample_rate.0 as i32;
    let (sender, receiver) = sync_channel::<Vec<f32>>(8);
    let failed = Arc::new(AtomicBool::new(false));
    let audio_stream = build_audio_stream(
        &device,
        &config,
        channels,
        sender,
        sample_format,
        Arc::clone(&failed),
    )?;
    audio_stream
        .play()
        .map_err(|error| format!("Impossibile avviare il microfono: {error}"))?;

    process_audio(
        receiver,
        kws,
        sample_rate,
        enabled,
        failed,
        end_session,
        capture,
        app,
    )
}

fn build_audio_stream(
    device: &Device,
    config: &StreamConfig,
    channels: usize,
    sender: SyncSender<Vec<f32>>,
    format: SampleFormat,
    failed: Arc<AtomicBool>,
) -> Result<Stream, String> {
    match format {
        SampleFormat::F32 => {
            build_typed_stream(device, config, channels, sender, failed, |sample: f32| {
                sample
            })
        }
        SampleFormat::I16 => {
            build_typed_stream(device, config, channels, sender, failed, |sample: i16| {
                sample as f32 / i16::MAX as f32
            })
        }
        SampleFormat::U16 => {
            build_typed_stream(device, config, channels, sender, failed, |sample: u16| {
                (sample as f32 - 32768.0) / 32768.0
            })
        }
        other => Err(format!("Formato audio microfono non supportato: {other:?}")),
    }
}

fn build_typed_stream<T>(
    device: &Device,
    config: &StreamConfig,
    channels: usize,
    sender: SyncSender<Vec<f32>>,
    failed: Arc<AtomicBool>,
    to_float: fn(T) -> f32,
) -> Result<Stream, String>
where
    T: SizedSample + Copy + Send + 'static,
{
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                let mono: Vec<f32> = data
                    .chunks(channels)
                    .map(|frame| {
                        frame.iter().copied().map(to_float).sum::<f32>() / frame.len() as f32
                    })
                    .collect();
                if !mono.is_empty() {
                    match sender.try_send(mono) {
                        Ok(()) | Err(TrySendError::Full(_)) => {}
                        Err(TrySendError::Disconnected(_)) => {}
                    }
                }
            },
            // Microfono scollegato/cambiato: il worker esce e il frontend riavvia l'ascolto.
            move |error| {
                eprintln!("HeyJev microphone stream: {error}");
                failed.store(true, Ordering::Release);
            },
            None,
        )
        .map_err(|error| format!("Impossibile inizializzare il microfono: {error}"))
}

/// Sessione dopo la wake word, sullo stesso stream CPAL (niente microfono nella WebView).
/// Ogni frase chiusa da una breve pausa va subito a Whisper mentre si continua ad
/// ascoltare; la sessione finisce dopo `idle_seconds` senza parlato.
struct Session {
    segment: Vec<f32>,
    speech: usize,
    quiet: usize,
    idle: usize,
    peak: f32,
    heard: bool,
}

enum Step {
    Listen,
    Segment(Vec<f32>),
    End,
}

const PAUSE_SECS: f32 = 0.5;
const SEGMENT_MAX_SECS: f32 = 8.0;
const MIN_SPEECH_SECS: f32 = 0.2; // sotto: tosse/rumore, non va a Whisper
const PREROLL_SECS: f32 = 0.3; // audio prima del parlato, per non tagliare l'attacco
const FIRST_COMMAND_WAIT_SECS: f32 = 4.0;
/// Tutorial: sensibilità fissa (quella dell'utente è ciò che si sta calibrando) e attesa.
const CAPTURE_VAD_RATIO: f32 = 2.4;
const CAPTURE_WAIT_SECS: f32 = 6.0;
const KWS_LAG: Duration = Duration::from_millis(1200);
/// Riserva Whisper: solo frasi brevi, le chiacchiere lunghe non sono una chiamata.
const FALLBACK_MAX_SECS: f32 = 3.5;


impl Session {
    fn new() -> Self {
        Self {
            segment: Vec::new(),
            speech: 0,
            quiet: 0,
            idle: 0,
            peak: 0.0,
            heard: false,
        }
    }

    fn push(
        &mut self,
        samples: &[f32],
        rms: f32,
        threshold: f32,
        idle_secs: f32,
        rate: f32,
    ) -> Step {
        let secs = |n: usize| n as f32 / rate;
        let talking = self.speech > 0;
        // Fine frase anche relativa al picco: regge i microfoni con soppressione rumore.
        let loud = rms > threshold && (!talking || rms > self.peak * 0.1);
        self.segment.extend_from_slice(samples);
        self.idle += samples.len();
        if loud {
            self.speech += samples.len();
            self.peak = self.peak.max(rms);
            self.quiet = 0;
        } else if talking {
            self.quiet += samples.len();
        } else {
            let keep = (PREROLL_SECS * rate) as usize;
            if self.segment.len() > keep {
                self.segment.drain(..self.segment.len() - keep);
            }
        }

        // Solo parlato vero tiene aperta la sessione: colpi di rumore brevi no.
        if secs(self.speech) >= MIN_SPEECH_SECS {
            self.idle = 0;
        }
        if self.speech > 0 {
            if secs(self.quiet) < PAUSE_SECS && secs(self.segment.len()) < SEGMENT_MAX_SECS {
                return Step::Listen;
            }
            let segment = std::mem::take(&mut self.segment);
            let enough = secs(self.speech) >= MIN_SPEECH_SECS;
            (self.speech, self.quiet, self.peak) = (0, 0, 0.0);
            if enough {
                self.heard = true;
                return Step::Segment(segment);
            }
            return Step::Listen;
        }
        let limit = if self.heard {
            idle_secs
        } else {
            FIRST_COMMAND_WAIT_SECS.max(idle_secs)
        };
        if secs(self.idle) >= limit {
            Step::End
        } else {
            Step::Listen
        }
    }
}

/// Sessione di ascolto dopo «Hey Jev».
struct Active {
    vad: Session,
    threshold: f32,
    idle_secs: f32,
    /// Deepgram in streaming; `None` o caduto = frasi a Whisper locale.
    listener: Option<crate::deepgram::Listener>,
}

/// Registrazione in corso per il tutorial.
struct Capturing {
    vad: Session,
    threshold: f32,
    wake: bool,
    peak: f32,
    reply: Sender<Capture>,
    /// Frase finita (e quando): si aspetta ancora il KWS.
    done: Option<(Vec<f32>, Instant)>,
}

/// AGC + KWS su un blocco audio; restituisce la keyword se scatta (e riazzera lo stream).
fn feed_kws(
    kws: &KeywordSpotter,
    stream: &OnlineStream,
    sample_rate: i32,
    samples: &[f32],
    rms: f32,
    noise: f32,
    envelope: &mut f32,
) -> Option<String> {
    // Il modello perde la wake word se la voce arriva bassa (misurato). Inviluppo a salita
    // istantanea e discesa lenta; guadagno 1..10 ma senza portare il rumore di fondo oltre
    // ~0,005 (una stanza rumorosa amplificata lo confonde).
    *envelope = rms.max(*envelope * 0.997).max(1e-4);
    let max_gain = (0.005 / noise).clamp(1.0, 10.0);
    let gain = (0.1 / *envelope).clamp(1.0, max_gain);
    let boosted: Vec<f32> = samples.iter().map(|s| s * gain).collect();
    stream.accept_waveform(sample_rate, &boosted);
    while kws.is_ready(stream) {
        kws.decode(stream);
        if let Some(result) = kws.get_result(stream) {
            if !result.keyword.trim().is_empty() {
                kws.reset(stream);
                return Some(result.keyword);
            }
        }
    }
    None
}

/// Riserva: la frase comincia come l'utente dice «Hey Jev» (imparato nel tutorial)?
/// Restituisce il resto, cioè un comando detto di seguito.
fn wake_match(text: &str, aliases: &[String]) -> Option<String> {
    let heard = crate::words(text);
    aliases
        .iter()
        .map(|alias| crate::words(alias))
        .find(|alias| !alias.is_empty() && heard.starts_with(alias))
        .map(|alias| heard[alias.len()..].join(" "))
}

#[allow(clippy::too_many_arguments)]
fn process_audio(
    receiver: Receiver<Vec<f32>>,
    kws: KeywordSpotter,
    sample_rate: i32,
    enabled: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    end_requested: Arc<AtomicBool>,
    capture: Arc<Mutex<Option<Sender<Capture>>>>,
    app: AppHandle,
) -> Result<(), String> {
    let stream = kws.create_stream();
    let rate = sample_rate as f32;

    // Whisper gira su un thread a parte: mentre trascrive una frase si ascolta la successiva.
    let pending = Arc::new(AtomicUsize::new(0));
    let (segments, segment_receiver) = channel::<Vec<f32>>();
    {
        let (app, pending) = (app.clone(), Arc::clone(&pending));
        thread::Builder::new()
            .name("heyjev-whisper".into())
            .spawn(move || {
                for segment in segment_receiver {
                    let heard =
                        crate::transcribe(&app, &segment, sample_rate as u32, crate::WHISPER_PROMPT);
                    let _ = match heard {
                        Ok(text) => app.emit("app:transcript", text),
                        Err(error) => app.emit("app:transcript-error", error),
                    };
                    pending.fetch_sub(1, Ordering::AcqRel);
                }
            })
            .map_err(|error| format!("Avvio del worker Whisper fallito: {error}"))?;
    }

    // Riserva Whisper per chi il KWS non riconosce bene (attiva se il tutorial ha
    // imparato `wake_aliases`): frasi brevi → Whisper → confronto con gli alias.
    let checking = Arc::new(AtomicBool::new(false));
    let (hits, hit_receiver) = channel::<(u64, String)>();
    let mut generation = 0_u64; // cambia a ogni sessione: scarta i risultati arrivati tardi
    let mut fallback: Option<(Session, f32)> = None;
    let mut aliases: Vec<String> = Vec::new();
    let mut vad_ratio = 2.4_f32;
    let mut settings_read: Option<Instant> = None;

    let mut noise = 0.01_f32;
    let mut envelope = 0.01_f32;
    let mut session: Option<Active> = None;
    let mut capturing: Option<Capturing> = None;
    let mut last_level = Instant::now();
    let mut was_enabled = true;
    loop {
        if failed.load(Ordering::Acquire) {
            return Err("Il microfono si è scollegato o è cambiato.".into());
        }
        let samples = match receiver.recv_timeout(Duration::from_millis(500)) {
            Ok(samples) => samples,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Il flusso del microfono si è interrotto.".into())
            }
        };
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();

        if let Some(active) = session.as_mut() {
            let speaking = speaker::speaking();
            if last_level.elapsed() >= Duration::from_millis(40) {
                last_level = Instant::now();
                // Onda del notch: la voce di HeyJev mentre parla, il microfono mentre ascolta.
                let level = if speaking {
                    speaker::level()
                } else {
                    (rms / (active.threshold * 4.0)).min(1.0)
                };
                let _ = app.emit("app:level", level);
            }
            // A Deepgram va sempre il microfono: anche mentre Maia parla, così la si può
            // interrompere. L'eco della sua voce la riconosce deepgram.rs dal contenuto
            // (il volume non basta: il microfono del portatile la sente forte).
            let streaming = active.listener.as_ref().is_some_and(|l| !l.failed());
            if let Some(listener) = active.listener.as_ref().filter(|_| streaming) {
                listener.send(&samples, sample_rate as u32);
            }
            // Il silenzio si conta da quando la risposta è finita, non mentre arriva.
            if pending.load(Ordering::Acquire) > 0
                || speaking
                || crate::chat::busy()
                || active.listener.as_ref().is_some_and(|l| l.pending())
            {
                active.vad.idle = 0;
            }
            let step = active
                .vad
                .push(&samples, rms, active.threshold, active.idle_secs, rate);
            if let Step::Segment(segment) = step {
                // Senza Deepgram (o se è caduto) le frasi vanno a Whisper; l'eco mai.
                if !streaming && !speaker::echo_window() {
                    pending.fetch_add(1, Ordering::AcqRel);
                    let _ = app.emit("app:segment", ());
                    let _ = segments.send(segment);
                }
            } else if (!speaking && end_requested.swap(false, Ordering::AcqRel))
                || (matches!(step, Step::End) && pending.load(Ordering::Acquire) == 0)
            {
                session = None; // chiude anche lo stream Deepgram
                let _ = app.emit("app:session-end", ());
            }
            continue;
        }

        // Tutorial: registra una frase; il KWS resta acceso per dire se l'avrebbe presa.
        if capturing.is_none() {
            if let Some(reply) = capture.lock().ok().and_then(|mut pending| pending.take()) {
                kws.reset(&stream);
                capturing = Some(Capturing {
                    vad: Session::new(),
                    threshold: noise * CAPTURE_VAD_RATIO,
                    wake: false,
                    peak: 0.0,
                    reply,
                    done: None,
                });
            }
        }
        if let Some(active) = capturing.as_mut() {
            if last_level.elapsed() >= Duration::from_millis(40) {
                last_level = Instant::now();
                let _ = app.emit("app:level", (rms / (active.threshold * 4.0)).min(1.0));
            }
            if feed_kws(&kws, &stream, sample_rate, &samples, rms, noise, &mut envelope).is_some()
            {
                active.wake = true;
            }
            // Il KWS scatta fino a ~1 s dopo la fine della frase: si risponde dopo.
            if let Some((_, ended)) = &active.done {
                if active.wake || ended.elapsed() >= KWS_LAG {
                    if let Some(Capturing {
                        done: Some((segment, _)),
                        wake,
                        peak,
                        reply,
                        ..
                    }) = capturing.take()
                    {
                        let _ = reply.send(Capture {
                            samples: segment,
                            rate: sample_rate as u32,
                            wake,
                            snr: peak / noise,
                        });
                    }
                }
                continue;
            }
            active.peak = active.peak.max(rms);
            match active
                .vad
                .push(&samples, rms, active.threshold, CAPTURE_WAIT_SECS, rate)
            {
                Step::Segment(segment) => active.done = Some((segment, Instant::now())),
                Step::End => capturing = None, // silenzio: il comando risponde "non ho sentito"
                Step::Listen => {}
            }
            continue;
        }

        // Rumore tipico (mediana mobile): il minimo lo sottostimava e il rumore della
        // stanza passava per parlato, tenendo la sessione aperta.
        noise = (noise * if rms > noise { 1.002 } else { 0.998 }).max(1e-4);

        if !enabled.load(Ordering::Acquire) {
            if was_enabled {
                kws.reset(&stream);
                fallback = None;
                generation += 1;
                was_enabled = false;
            }
            continue;
        }
        was_enabled = true;

        let mut woke = feed_kws(&kws, &stream, sample_rate, &samples, rms, noise, &mut envelope)
            .map(|keyword| (keyword, String::new()));

        if settings_read.is_none_or(|read| read.elapsed() >= Duration::from_secs(5)) {
            let settings = crate::current_settings(&app);
            aliases = settings.wake_aliases.clone();
            vad_ratio = settings.vad_ratio();
            settings_read = Some(Instant::now());
        }
        if !aliases.is_empty() && woke.is_none() {
            let (vad, threshold) =
                fallback.get_or_insert_with(|| (Session::new(), noise * vad_ratio));
            match vad.push(&samples, rms, *threshold, 5.0, rate) {
                Step::Segment(segment)
                    if segment.len() as f32 <= FALLBACK_MAX_SECS * rate
                        && !checking.swap(true, Ordering::AcqRel) =>
                {
                    let (app, aliases, hits, checking) = (
                        app.clone(),
                        aliases.clone(),
                        hits.clone(),
                        Arc::clone(&checking),
                    );
                    let tag = generation;
                    thread::spawn(move || {
                        if let Ok(text) = crate::transcribe(
                            &app,
                            &segment,
                            sample_rate as u32,
                            crate::WAKE_PROMPT,
                        ) {
                            if let Some(rest) = wake_match(&text, &aliases) {
                                let _ = hits.send((tag, rest));
                            }
                        }
                        checking.store(false, Ordering::Release);
                    });
                }
                Step::End => fallback = None, // soglia ricalcolata sul rumore attuale
                _ => {}
            }
        }
        while let Ok((tag, rest)) = hit_receiver.try_recv() {
            if tag == generation && woke.is_none() {
                woke = Some(("whisper".into(), rest));
            }
        }

        if let Some((keyword, rest)) = woke {
            enabled.store(false, Ordering::Release);
            end_requested.store(false, Ordering::Release);
            crate::remember_foreground_window();
            kws.reset(&stream);
            fallback = None;
            generation += 1;
            let settings = crate::current_settings(&app);
            let listener = (settings.recognition == "deepgram")
                .then(crate::deepgram::key)
                .flatten()
                .map(|key| crate::deepgram::Listener::start(&app, key, crate::apps::cached()));
            crate::chat::reset();
            session = Some(Active {
                vad: Session::new(),
                threshold: noise * settings.vad_ratio(),
                idle_secs: settings.idle_seconds,
                listener,
            });
            let _ = app.emit("app:wake-word", keyword);
            // «Hey Jev apri il terminale» tutto d'un fiato: il comando è già nella frase.
            if !rest.is_empty() {
                let _ = app.emit("app:transcript", rest);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{wake_match, Session, Step};

    fn step(session: &mut Session, loud: bool) -> Step {
        let block = [0.0_f32; 100]; // 0,1 s a 1 kHz
        session.push(&block, if loud { 1.0 } else { 0.0 }, 0.5, 2.0, 1000.0)
    }

    #[test]
    fn session_splits_phrases_and_ends_after_silence() {
        let mut session = Session::new();
        for _ in 0..3 {
            assert!(matches!(step(&mut session, true), Step::Listen));
        }
        for _ in 0..4 {
            assert!(matches!(step(&mut session, false), Step::Listen));
        }
        // 0,5 s di pausa dopo il parlato: la frase parte per Whisper.
        match step(&mut session, false) {
            Step::Segment(segment) => assert_eq!(segment.len(), 800),
            _ => panic!("frase attesa"),
        }
        // Dopo una frase bastano idle_secs (2 s) di silenzio per chiudere.
        assert!((0..19).all(|_| matches!(step(&mut session, false), Step::Listen)));
        assert!(matches!(step(&mut session, false), Step::End));
    }

    #[test]
    fn session_waits_longer_for_first_command_and_drops_noise() {
        let mut session = Session::new();
        assert!(matches!(step(&mut session, true), Step::Listen)); // 0,1 s: tosse
        assert!((0..5).all(|_| matches!(step(&mut session, false), Step::Listen))); // scartata
                                                                                    // La tosse non riazzera l'attesa: 4 s dall'inizio, non dalla tosse.
        assert!((0..33).all(|_| matches!(step(&mut session, false), Step::Listen)));
        assert!(matches!(step(&mut session, false), Step::End));
    }

    #[test]
    fn fallback_matches_learned_wake_phrase() {
        let aliases = vec!["Ehi, Jeff.".to_string(), "hey jev".to_string()];
        assert_eq!(wake_match("Ehi Jeff!", &aliases).as_deref(), Some(""));
        assert_eq!(
            wake_match("Ehi, Jeff, apri il terminale.", &aliases).as_deref(),
            Some("apri il terminale")
        );
        assert_eq!(wake_match("Hey Jev.", &aliases).as_deref(), Some(""));
        assert_eq!(wake_match("Ehi, come stai?", &aliases), None);
        assert_eq!(wake_match("Jeff ha chiamato", &aliases), None);
        assert_eq!(wake_match("[Musica]", &["musica".to_string()]), None);
    }
}
