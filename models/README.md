# Modello Whisper.cpp

Per preparare il motore wake word offline, esegui `scripts/setup-kws.ps1` dalla
radice del progetto: scarica il modello English KWS e crea i token di `HEY JEV`
in questa cartella.

Scarica il file multilingue `ggml-tiny.bin` dal repository dei modelli
whisper.cpp e salvalo qui come `whisper-tiny.bin`, in modo che il percorso
corrisponda a `WHISPER_MODEL_PATH` in `.env.local`.

L'app lancia `whisper-cli.exe` solo dopo una wake word; il modello non viene
caricato durante l'ascolto passivo.
