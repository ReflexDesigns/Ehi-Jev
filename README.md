# HeyJev — assistente vocale per Windows

HeyJev è un prototipo desktop Windows 10/11 di assistente a comandi vocali brevi. La wake word offline **“Hey Jev”** attiva **The Notch**, un overlay trasparente con onda audio reattiva. La trascrizione usa Whisper.cpp locale; Jev/TypeSafe può classificare il testo in una lista chiusa di azioni. Se l’API non è configurata, viene usato il parser regex locale.

> Jev non è un agente con accesso arbitrario al PC: può eseguire soltanto gli intenti elencati qui sotto. Le frasi naturali e le parafrasi possono essere classificate dall’API, ma sempre verso questa lista consentita.

## Comandi vocali

Prima di ogni comando pronuncia **“Hey Jev”**. Il rilevatore configurato usa la frase inglese `HEY JEV`; la pronuncia italiana “Ehi Jev” potrebbe essere rilevata, ma non è garantita dal modello KWS attuale.

| Cosa dire dopo la wake word | Varianti riconosciute dal parser locale | Azione |
|---|---|---|
| “Apri terminale” / “Open terminal” | “Avvia terminale”, “Launch terminal” | Avvia Windows Terminal (`wt.exe`), con ripiego su `cmd.exe` |
| “Apri Claude” / “Open Claude” | “Launch Claude” | Apre `claude.ai` nel browser predefinito |
| “Apri GPT” / “Open GPT” | “Apri ChatGPT”, “Open ChatGPT” | Apre `chatgpt.com` nel browser predefinito |
| “Mostra desktop” / “Show desktop” | “Mostra scrivania” | Invia **Win + D** |
| “Chiudi questo” / “Close this” | “Chiudi la finestra”, “Close the window” | Invia **Alt + F4** alla finestra attiva; usalo con attenzione |
| “Annulla” / “Cancel” | “Grazie”, “Thank you”, “Ciao” | Annulla/chiude The Notch senza un’altra azione |
| “Check the update” / “Controlla aggiornamenti” | “Check for updates”, “Verifica aggiornamenti” | Cerca una release privata firmata e mostra il pulsante di installazione; l’update parte solo dopo il clic |

La lista è definita nel parser offline (`src/lib/commandParser.ts`) e nella classificazione Jev (`src-tauri/src/lib.rs`). Se la trascrizione non corrisponde a un intent consentito, HeyJev non esegue comandi di sistema generici.

## Architettura

| Componente | Implementazione |
|---|---|
| Desktop Windows | Tauri 2, Rust e React/TypeScript |
| Wake word | sherpa-onnx KWS in Rust + CPAL, offline; modello inglese `HEY JEV` |
| Speech-to-text | Whisper.cpp locale, lingua automatica (`WHISPER_LANGUAGE=auto`) |
| Parsing | Jev/TypeSafe `SystemOne` con lista chiusa di intenti; regex come fallback offline |
| Automazioni Windows | Rust + `windows-sys`; `ShellExecuteW` e `SendInput` |
| Overlay | WebView frameless/trasparente, always-on-top; onda Canvas 2D |
| Installer | NSIS per utente corrente: installer Windows **`.exe`** |

L’icona sorgente è `public/app-icon.svg`. `npm run icons` genera le icone Tauri per installer, finestra e tray; la tray usa la stessa icona predefinita dell’app.

## Requisiti

- Windows 10/11 x64 e WebView2 Runtime.
- Node.js 18+ e npm.
- Rust stable con toolchain MSVC, Visual Studio C++ Build Tools e Windows SDK.
- Python 3 per lo script di preparazione del modello KWS.
- whisper.cpp con `whisper-cli.exe` e un modello GGML compatibile (per esempio `ggml-tiny.bin`).

## Configurazione locale

1. Crea `.env.local` copiando `.env.example` e inserisci la tua chiave API Jev/TypeSafe. `.env.local` è escluso da Git: **non committare né condividere le chiavi**.
2. Prepara il rilevatore KWS da PowerShell:

   ```powershell
   .\scripts\setup-kws.ps1
   ```

3. Scarica un modello whisper.cpp e impostane il percorso in `.env.local`. Installa `whisper-cli.exe` e configura `WHISPER_CPP_BIN` se non è nel `PATH`.
4. Verifica l’accesso al microfono nelle impostazioni di Windows. Al primo avvio premi **Attiva** per avviare il rilevatore.

## Avvio e installer

```powershell
npm install
npm run tauri:dev
```

Per creare l’installer NSIS `.exe` (configurato in `src-tauri/tauri.conf.json`):

```powershell
npm run tauri:build
```

Il file si trova in `src-tauri/target/release/bundle/nsis/`. La build richiede toolchain Rust/MSVC e WebView2. I modelli Whisper e KWS sono esclusi da Git e non vengono distribuiti nel repository; seguire i passaggi sopra per predisporli sulla macchina.

## Aggiornamenti

“**Hey Jev, check the update**” controlla le release firmate nel repository privato. Se manca la credenziale, dalla System Tray scegli **Configura aggiornamenti**; inserisci il token oppure premi **Importa da .env.local**. Usa un fine-grained token limitato al solo `ReflexDesigns/Ehi-Jev` con **Contents: read**. HeyJev verifica l’accesso e conserva il token nel **Credential Manager di Windows**; non lo salva nel WebView, nel repository o nell’EXE.

Quando trova una versione nuova, The Notch mostra **Installa <versione>**. L’installazione richiede quel clic esplicito e Windows chiude l’app mentre applica il pacchetto firmato. La verifica della firma Tauri è obbligatoria.

La GitHub Action `.github/workflows/release.yml` compila e pubblica installer, firme e `latest.json` a ogni tag Git `v*`. Prima di spingere un tag, aggiorna i file versione con `node scripts/set-version.mjs 0.2.1`, committa la modifica, quindi crea e spingi il tag corrispondente (`v0.2.1`). In GitHub Actions deve essere configurato il secret `TAURI_SIGNING_PRIVATE_KEY`; la chiave privata locale è esclusa da Git. **Il primo installer updater-enabled va installato manualmente**: un installer creato prima dell’integrazione dell’updater non può auto-aggiornarsi.

## Struttura principale

```text
src/                         UI React, overlay, wave, parser e registrazione microfono
src-tauri/src/               backend Rust, wake listener, STT, intent e OS control
src-tauri/tauri.conf.json    finestra, CSP, bundle NSIS e icone
scripts/setup-kws.ps1        setup del modello KWS sherpa-onnx
scripts/set-version.mjs      sincronizza le versioni per una release taggata
.github/workflows/release.yml build/publish automatico delle release firmate
public/app-icon.svg          sorgente SVG icona
models/                      modelli locali (esclusi da Git)
```

## Verifiche

```powershell
npm run build
cargo check --manifest-path src-tauri\Cargo.toml
```

Per il primo pacchetto locale, installer e firma updater vengono copiati in `release/` (cartella esclusa da Git).
