# Modelli locali (esclusi da Git)

`npm run setup:models` (eseguito anche da `tauri dev`/`tauri build`) prepara:

- `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/` — wake word offline English e `keywords.txt` per `HEY JEV` (`scripts/setup-kws.ps1`).
- `whisper/ggml-tiny.bin` e `whisper/bin/` — modello Whisper tiny multilingue e `whisper-cli.exe` ufficiale (`scripts/setup-whisper.ps1`).

Download verificati con SHA-256. `src-tauri/tauri.conf.json` copia nell'installer solo i file usati, in `models\` accanto a `heyjev.exe`.
