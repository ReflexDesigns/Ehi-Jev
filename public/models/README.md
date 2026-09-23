# Modelli wake word

HeyJev non usa più Porcupine né richiede una chiave Picovoice. Il motore KWS
locale sherpa-onnx e i suoi modelli sono caricati dal backend Rust da `models/`.

Scarica e prepara il modello English e la keyword personalizzata `HEY JEV` da
PowerShell con `scripts/setup-kws.ps1`. Questa cartella `public/models/` non è
usata dal rilevatore.
