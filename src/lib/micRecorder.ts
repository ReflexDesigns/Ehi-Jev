/**
 * MicRecorder - Cattura del microfono via Web Audio API.
 *
 * Durante lo stato "listening" fornisce:
 *  - getLevel()          -> RMS 0..1 (rilevamento silenzio + ampiezza onda)
 *  - getFrequencyData()  -> bin di frequenza 0..255 (visualizzazione onda)
 *  - stopAndGetWav()     -> audio completo codificato come WAV PCM 16-bit
 *                           (mono) da inviare a Whisper.cpp per la STT.
 */

export interface AudioFrame {
  level: number;
  freq: Uint8Array;
}

export class MicRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private gain: GainNode | null = null;
  private buffers: Float32Array[] = [];
  private sampleRate = 48000;

  /** Apre il microfono e aggancia analizzatore + registratore PCM. */
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    this.ctx = new AudioContext();
    this.sampleRate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.75;

    // ScriptProcessor (deprecato ma universale): raccoglie i campioni PCM.
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0);
      this.buffers.push(new Float32Array(data));
    };

    // Gain a zero: il processore deve restare connesso alla destinazione
    // per essere eseguito, ma non vogliamo feedback dal microfono.
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;

    this.source.connect(this.analyser);
    this.source.connect(this.processor);
    this.processor.connect(this.gain);
    this.gain.connect(this.ctx.destination);
  }

  /** RMS del frame corrente (0..1). */
  getLevel(): number {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  /** Spettro di frequenza corrente (0..255 per bin). */
  getFrequencyData(): Uint8Array {
    if (!this.analyser) return new Uint8Array(0);
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return data;
  }

  /** Ferma la cattura e restituisce l'audio come WAV (ArrayBuffer). */
  stopAndGetWav(): ArrayBuffer {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.processor?.disconnect();
    this.gain?.disconnect();
    this.source?.disconnect();
    if (this.ctx) void this.ctx.close();

    const samples = concatFloat32(this.buffers);
    return encodeWav(samples, this.sampleRate);
  }
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Codifica campioni Float32 in un buffer WAV PCM 16-bit mono. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // dimensione chunk fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
