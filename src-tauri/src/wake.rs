//! Native, offline English wake-word detection backed by sherpa-onnx.
//!
//! The audio callback only moves small PCM chunks to a worker thread; inference
//! never runs on CPAL's real-time callback thread.

use std::{
    env,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender, TrySendError},
        Arc,
    },
    thread,
    time::Duration,
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, SampleFormat, SizedSample, Stream, StreamConfig,
};
use sherpa_onnx::{KeywordSpotter, KeywordSpotterConfig};
use tauri::{AppHandle, Emitter, Manager, State};

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
    let model_dir = configured_model_dir(app)?;
    let encoder = model_dir.join("encoder-epoch-12-avg-2-chunk-16-left-64.onnx");
    let decoder = model_dir.join("decoder-epoch-12-avg-2-chunk-16-left-64.onnx");
    let joiner = model_dir.join("joiner-epoch-12-avg-2-chunk-16-left-64.onnx");
    let tokens = model_dir.join("tokens.txt");
    let keywords = model_dir.join("keywords.txt");

    for path in [&encoder, &decoder, &joiner, &tokens, &keywords] {
        if !path.is_file() {
            return Err(format!(
                "Modello wake word mancante ({}). Esegui scripts\\setup-kws.ps1.",
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

    KeywordSpotter::create(&config)
        .ok_or_else(|| "sherpa-onnx non riesce a caricare il modello English KWS.".to_string())
}

fn configured_model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let configured = env::var("WAKE_MODEL_DIR")
        .unwrap_or_else(|_| "./models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01".into());
    let configured = PathBuf::from(configured);
    let current_dir = env::current_dir()
        .map_err(|error| format!("Impossibile risolvere WAKE_MODEL_DIR: {error}"))?;
    let local = if configured.is_absolute() {
        configured
    } else {
        current_dir.join(configured)
    };
    if local.is_dir() {
        return Ok(local);
    }

    app.path()
        .resource_dir()
        .map(|resources| {
            resources.join("models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01")
        })
        .map_err(|error| format!("Cartella risorse HeyJev non accessibile: {error}"))
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
    let audio_stream = build_audio_stream(&device, &config, channels, sender, sample_format)?;
    audio_stream
        .play()
        .map_err(|error| format!("Impossibile avviare il microfono: {error}"))?;

    process_audio(receiver, kws, sample_rate, enabled, app)
}

fn build_audio_stream(
    device: &Device,
    config: &StreamConfig,
    channels: usize,
    sender: SyncSender<Vec<f32>>,
    format: SampleFormat,
) -> Result<Stream, String> {
    match format {
        SampleFormat::F32 => {
            build_typed_stream(device, config, channels, sender, |sample: f32| sample)
        }
        SampleFormat::I16 => build_typed_stream(device, config, channels, sender, |sample: i16| {
            sample as f32 / i16::MAX as f32
        }),
        SampleFormat::U16 => build_typed_stream(device, config, channels, sender, |sample: u16| {
            (sample as f32 - 32768.0) / 32768.0
        }),
        other => Err(format!("Formato audio microfono non supportato: {other:?}")),
    }
}

fn build_typed_stream<T>(
    device: &Device,
    config: &StreamConfig,
    channels: usize,
    sender: SyncSender<Vec<f32>>,
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
            |error| eprintln!("HeyJev microphone stream: {error}"),
            None,
        )
        .map_err(|error| format!("Impossibile inizializzare il microfono: {error}"))
}

fn process_audio(
    receiver: Receiver<Vec<f32>>,
    kws: KeywordSpotter,
    sample_rate: i32,
    enabled: Arc<AtomicBool>,
    app: AppHandle,
) -> Result<(), String> {
    let stream = kws.create_stream();
    let mut was_enabled = true;
    loop {
        let samples = match receiver.recv_timeout(Duration::from_millis(500)) {
            Ok(samples) => samples,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Il flusso del microfono si è interrotto.".into())
            }
        };

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
                kws.reset(&stream);
                let _ = app.emit("app:wake-word", result.keyword);
                break;
            }
        }
    }
}
