//! La voce di HeyJev: coda audio verso gli altoparlanti (CPAL) che si svuota all'istante
//! quando l'utente la interrompe (barge-in). L'audio arriva da Deepgram Aura in streaming.

use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    SampleFormat, SizedSample, Stream,
};
use tauri::{AppHandle, Emitter};

/// Frequenza dell'audio chiesto a Deepgram Aura (linear16 mono).
pub(crate) const VOICE_RATE: u32 = 24_000;
/// Dopo l'ultimo campione l'uscita resta aperta un attimo: tra una frase e l'altra non si chiude.
const HANGOVER: Duration = Duration::from_millis(400);

static QUEUE: Mutex<VecDeque<f32>> = Mutex::new(VecDeque::new());
static SPEAKING: AtomicBool = AtomicBool::new(false);
static LEVEL: AtomicU32 = AtomicU32::new(0); // RMS recente (bit di un f32) per l'onda del notch
/// Cambia a ogni interruzione: i flussi di voce e le risposte in corso smettono subito.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Ciò che Maia ha detto di recente: il microfono la risente dalle casse (eco).
static SPOKEN: Mutex<Vec<(Instant, String)>> = Mutex::new(Vec::new());
static LAST_END: Mutex<Option<Instant>> = Mutex::new(None);
/// L'eco (e la trascrizione di Deepgram) arriva ancora un po' dopo l'ultima parola.
const ECHO_TAIL: Duration = Duration::from_millis(1500);
const SPOKEN_MEMORY: Duration = Duration::from_secs(60);

/// Avvia il thread degli altoparlanti (una volta, all'avvio dell'app).
pub(crate) fn init(app: &AppHandle) {
    let app = app.clone();
    let _ = thread::Builder::new()
        .name("heyjev-speaker".into())
        .spawn(move || run(app));
}

pub(crate) fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

/// HeyJev sta parlando (o ha appena finito una frase e sta per dire la prossima).
pub(crate) fn speaking() -> bool {
    SPEAKING.load(Ordering::Acquire)
}

/// Maia sta parlando o ha appena smesso: quello che sente il microfono può essere lei.
pub(crate) fn echo_window() -> bool {
    speaking()
        || LAST_END
            .lock()
            .ok()
            .and_then(|end| *end)
            .is_some_and(|end| end.elapsed() < ECHO_TAIL)
}

/// Testo mandato alla voce (per riconoscerne l'eco).
pub(crate) fn remember(text: &str) {
    if let Ok(mut spoken) = SPOKEN.lock() {
        spoken.retain(|(when, _)| when.elapsed() < SPOKEN_MEMORY);
        spoken.push((Instant::now(), text.to_string()));
    }
}

/// Parole dette da Maia nell'ultimo minuto.
pub(crate) fn spoken_words() -> Vec<String> {
    SPOKEN
        .lock()
        .map(|spoken| {
            spoken
                .iter()
                .filter(|(when, _)| when.elapsed() < SPOKEN_MEMORY)
                .flat_map(|(_, text)| crate::words(text))
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn level() -> f32 {
    f32::from_bits(LEVEL.load(Ordering::Acquire))
}

/// Barge-in: zittisce gli altoparlanti, svuota la coda e invalida la risposta in corso.
pub(crate) fn interrupt() {
    GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut queue) = QUEUE.lock() {
        queue.clear();
    }
}

/// Accoda PCM linear16 little-endian a `VOICE_RATE`, se la risposta non è stata interrotta.
pub(crate) fn push(pcm: &[u8], generation: u64) {
    if generation != self::generation() {
        return;
    }
    if let Ok(mut queue) = QUEUE.lock() {
        queue.extend(
            pcm.chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0),
        );
    }
}

fn queued() -> bool {
    QUEUE.lock().map(|queue| !queue.is_empty()).unwrap_or(false)
}

/// Apre l'uscita solo mentre c'è qualcosa da dire: niente dispositivo audio tenuto occupato.
fn run(app: AppHandle) {
    loop {
        if !queued() {
            thread::sleep(Duration::from_millis(15));
            continue;
        }
        let stream = match open_output() {
            Ok(stream) => stream,
            Err(error) => {
                eprintln!("HeyJev speaker: {error}");
                interrupt();
                thread::sleep(Duration::from_secs(1));
                continue;
            }
        };
        SPEAKING.store(true, Ordering::Release);
        let _ = app.emit("app:speaking", true);
        let mut silent_since: Option<Instant> = None;
        loop {
            thread::sleep(Duration::from_millis(15));
            if queued() {
                silent_since = None;
            } else if silent_since.get_or_insert_with(Instant::now).elapsed() >= HANGOVER {
                break;
            }
        }
        drop(stream);
        LEVEL.store(0, Ordering::Release);
        if let Ok(mut end) = LAST_END.lock() {
            *end = Some(Instant::now());
        }
        SPEAKING.store(false, Ordering::Release);
        let _ = app.emit("app:speaking", false);
    }
}

fn open_output() -> Result<Stream, String> {
    let device = cpal::default_host()
        .default_output_device()
        .ok_or("Nessun altoparlante predefinito.")?;
    let supported = device
        .default_output_config()
        .map_err(|error| format!("Altoparlanti non configurabili: {error}"))?;
    let format = supported.sample_format();
    let config = supported.config();
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, &config, |s| s),
        SampleFormat::I16 => build::<i16>(&device, &config, |s| (s * i16::MAX as f32) as i16),
        SampleFormat::U16 => build::<u16>(&device, &config, |s| ((s + 1.0) * 32767.5) as u16),
        other => Err(format!("Formato altoparlanti non supportato: {other:?}")),
    }?;
    stream
        .play()
        .map_err(|error| format!("Altoparlanti non avviabili: {error}"))?;
    Ok(stream)
}

fn build<T: SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    from_f32: fn(f32) -> T,
) -> Result<Stream, String> {
    let channels = usize::from(config.channels).max(1);
    // Ricampionamento lineare VOICE_RATE → frequenza del dispositivo, a cavallo dei blocchi.
    let step = f64::from(VOICE_RATE) / f64::from(config.sample_rate.0);
    let mut position = 0.0_f64;
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                let Ok(mut queue) = QUEUE.lock() else { return };
                let mut energy = 0.0_f32;
                for frame in data.chunks_mut(channels) {
                    let sample = match (queue.front(), queue.get(1)) {
                        (Some(&a), Some(&b)) => a + (b - a) * position as f32,
                        (Some(&a), None) => a,
                        _ => 0.0,
                    };
                    position += step;
                    while position >= 1.0 && !queue.is_empty() {
                        queue.pop_front();
                        position -= 1.0;
                    }
                    energy += sample * sample;
                    frame.fill(from_f32(sample.clamp(-1.0, 1.0)));
                }
                let rms = (energy / (data.len() / channels).max(1) as f32).sqrt();
                LEVEL.store((rms * 4.0).min(1.0).to_bits(), Ordering::Release);
            },
            |error| eprintln!("HeyJev speaker stream: {error}"),
            None,
        )
        .map_err(|error| format!("Uscita audio non disponibile: {error}"))
}

/// Ricampionamento lineare (microfono → 16 kHz per Deepgram).
pub(crate) fn resample(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || samples.is_empty() {
        return samples.to_vec();
    }
    let step = f64::from(from) / f64::from(to);
    let count = (samples.len() as f64 / step) as usize;
    (0..count)
        .map(|i| {
            let position = i as f64 * step;
            let index = position as usize;
            let a = samples[index.min(samples.len() - 1)];
            let b = samples[(index + 1).min(samples.len() - 1)];
            a + (b - a) * (position - index as f64) as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::resample;

    #[test]
    fn resample_keeps_duration_and_shape() {
        let ramp: Vec<f32> = (0..480).map(|i| i as f32 / 480.0).collect(); // 10 ms a 48 kHz
        let out = resample(&ramp, 48_000, 16_000);
        assert_eq!(out.len(), 160);
        assert!((out[80] - ramp[240]).abs() < 1e-6);
        assert_eq!(resample(&ramp, 16_000, 16_000), ramp);
    }
}
