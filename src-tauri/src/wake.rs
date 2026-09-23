//! Native, offline English wake-word detection backed by sherpa-onnx.
//!
//! The audio callback only moves small PCM chunks to a worker thread; inference
//! never runs on CPAL's real-time callback thread.

use std::{
    env,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender, TrySendError},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, SampleFormat, SizedSample, Stream, StreamConfig,
};
use sherpa_onnx::{KeywordSpotter, KeywordSpotterConfig};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct WakeController {
    enabled: Arc<AtomicBool>,
    started: Arc<AtomicBool>,
}

#[tauri::command]
pub fn start_wake_listener(
    app: AppHandle,
    controller: State<'_, WakeController>,
) -> Result<(), String> {
    if controller.started.swap(true, Ordering::AcqRel) {
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
    let app_for_worker = app.clone();
    if let Err(error) = thread::Builder::new()
        .name("heyjev-wake-word".into())
        .spawn(move || {
            let result = listen_for_keyword(kws, enabled, app_for_worker.clone());
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
    // Taratura per microfono/ambiente: più basso = più sensibile (più falsi positivi).
    config.keywords_threshold = env::var("WAKE_THRESHOLD")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0.1);

    KeywordSpotter::create(&config)
        .ok_or_else(|| "sherpa-onnx non riesce a caricare il modello English KWS.".to_string())
}

fn listen_for_keyword(
    kws: KeywordSpotter,
    enabled: Arc<AtomicBool>,
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

    process_audio(receiver, kws, sample_rate, enabled, failed, app)
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

/// Comando registrato dopo la wake word sullo stesso stream CPAL: niente secondo
/// microfono nella WebView (prompt permessi, parole iniziali tagliate).
struct Capture {
    samples: Vec<f32>,
    speech: bool,
    quiet: usize,
}

const COMMAND_MAX_SECS: f32 = 6.0;
const COMMAND_NO_SPEECH_SECS: f32 = 3.0;
const COMMAND_END_SILENCE_SECS: f32 = 0.8;

impl Capture {
    fn new() -> Self {
        Self {
            samples: Vec::new(),
            speech: false,
            quiet: 0,
        }
    }

    /// Aggiunge un blocco; `true` quando il comando è finito (pausa dopo il parlato,
    /// nessun parlato, o durata massima).
    fn push(&mut self, samples: &[f32], loud: bool, rate: f32) -> bool {
        self.samples.extend_from_slice(samples);
        self.speech |= loud;
        self.quiet = if loud { 0 } else { self.quiet + samples.len() };
        let secs = self.samples.len() as f32 / rate;
        secs >= COMMAND_MAX_SECS
            || (self.speech && self.quiet as f32 / rate >= COMMAND_END_SILENCE_SECS)
            || (!self.speech && secs >= COMMAND_NO_SPEECH_SECS)
    }
}

fn process_audio(
    receiver: Receiver<Vec<f32>>,
    kws: KeywordSpotter,
    sample_rate: i32,
    enabled: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    app: AppHandle,
) -> Result<(), String> {
    let stream = kws.create_stream();
    let rate = sample_rate as f32;
    // Parlato = RMS sopra VAD_RATIO volte il rumore di fondo (taratura per microfono).
    let vad_ratio: f32 = env::var("VAD_RATIO")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3.0);
    let mut floor = 0.01_f32;
    let mut capture: Option<Capture> = None;
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

        if let Some(command) = capture.as_mut() {
            let threshold = floor * vad_ratio;
            if last_level.elapsed() >= Duration::from_millis(40) {
                last_level = Instant::now();
                let _ = app.emit("app:level", (rms / (threshold * 4.0)).min(1.0));
            }
            if !command.push(&samples, rms > threshold, rate) {
                continue;
            }
            let audio = std::mem::take(&mut command.samples);
            capture = None;
            let _ = app.emit("app:listening-done", ());
            let _ = match crate::transcribe(&app, &audio, sample_rate as u32) {
                Ok(text) => app.emit("app:transcript", text),
                Err(error) => app.emit("app:transcript-error", error),
            };
            // Audio arrivato durante Whisper: vecchio, lo scartiamo.
            while receiver.try_recv().is_ok() {}
            continue;
        }

        // Rumore di fondo: scende subito, risale piano (il parlato non lo gonfia).
        floor = (floor * 1.002).min(rms).max(1e-4);

        if !enabled.load(Ordering::Acquire) {
            if was_enabled {
                kws.reset(&stream);
                was_enabled = false;
            }
            continue;
        }
        was_enabled = true;

        stream.accept_waveform(sample_rate, &samples);
        while kws.is_ready(&stream) {
            kws.decode(&stream);
            let Some(result) = kws.get_result(&stream) else {
                continue;
            };
            if !result.keyword.trim().is_empty() {
                enabled.store(false, Ordering::Release);
                crate::remember_foreground_window();
                kws.reset(&stream);
                capture = Some(Capture::new());
                let _ = app.emit("app:wake-word", result.keyword);
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Capture;

    #[test]
    fn capture_ends_after_pause_or_without_speech() {
        let rate = 1000.0;
        let block = [0.0_f32; 100]; // 0,1 s
        let mut command = Capture::new();
        assert!(!command.push(&block, true, rate));
        for _ in 0..7 {
            assert!(!command.push(&block, false, rate));
        }
        assert!(command.push(&block, false, rate)); // 0,8 s di pausa dopo il parlato

        let mut silent = Capture::new();
        assert!((0..29).all(|_| !silent.push(&block, false, rate)));
        assert!(silent.push(&block, false, rate)); // 3 s senza parlato

        let mut talker = Capture::new();
        assert!((0..59).all(|_| !talker.push(&block, true, rate)));
        assert!(talker.push(&block, true, rate)); // tetto 6 s
    }
}
