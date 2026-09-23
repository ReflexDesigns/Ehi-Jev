# HeyJev — assistente vocale per Windows

HeyJev è un prototipo desktop Windows 10/11 di assistente a comandi vocali brevi. La wake word offline **“Hey Jev”** fa scendere dall’alto **The Notch** (stile Dynamic Island), un overlay con onda audio reattiva; a riposo resta nascosto sopra lo schermo. La trascrizione usa Whisper.cpp locale; Jev/TypeSafe può classificare il testo in una lista chiusa di azioni. Se l’API non è configurata, viene usato il parser regex locale.

> Jev non è un agente con accesso arbitrario al PC: può eseguire soltanto gli intenti elencati qui sotto. Le frasi naturali e le parafrasi possono essere classificate dall’API, ma sempre verso questa lista consentita.

## Comandi vocali

Pronuncia **“Hey Jev”** una volta: HeyJev resta in ascolto ed esegue ogni frase appena fai una breve pausa, quindi puoi dare più comandi di fila (anche nella stessa frase: “apri terminale e mostra desktop”). Smette di ascoltare dopo qualche secondo di silenzio oppure quando dici **“grazie”**, **“ok”** o **“silenzio”**. Il rilevatore configurato usa la frase inglese `HEY JEV`; la pronuncia italiana “Ehi Jev” potrebbe essere rilevata, ma non è garantita dal modello KWS attuale.

| Cosa dire dopo la wake word | Varianti riconosciute dal parser locale | Azione |
|---|---|---|
| “Apri terminale” / “Open terminal” | “Avvia terminale”, “Launch terminal” | Avvia Windows Terminal (`wt.exe`), con ripiego su `cmd.exe` |
| “Apri Claude” / “Open Claude” | “Launch Claude” | Apre `claude.ai` nel browser predefinito |
| “Apri GPT” / “Open GPT” | “Apri ChatGPT”, “Open ChatGPT” | Apre `chatgpt.com` nel browser predefinito |
| “Mostra desktop” / “Show desktop” | “Mostra scrivania” | Invia **Win + D** |
| “Chiudi questo” / “Close this” | “Chiudi la finestra”, “Close the window” | Chiude (come **Alt + F4**) la finestra attiva quando hai detto “Hey Jev”; mai HeyJev né il desktop |
| “Grazie” / “Silenzio” / “Ok” | “Basta”, “Stop”, “Annulla”, “Thank you” | Chiude la sessione di ascolto |
| “Check the update” / “Controlla aggiornamenti” | “Check for updates”, “Verifica aggiornamenti” | Cerca una release privata firmata e mostra il pulsante di installazione; l’update parte solo dopo il clic |

La lista è definita nel parser offline (`src/lib/commandParser.ts`) e nella classificazione Jev (`src-tauri/src/lib.rs`). Se la trascrizione non corrisponde a un intent consentito, HeyJev non esegue comandi di sistema generici.

## Architettura

| Componente | Implementazione |
|---|---|
| Desktop Windows | Tauri 2, Rust e React/TypeScript |
| Wake word + registrazione comando | sherpa-onnx KWS in Rust + CPAL, offline; `HEY JEV` con varianti foniche (`scripts/setup-kws.ps1`). Dopo la wake word Rust registra il comando sullo stesso stream (fine a pausa, max 6 s): nessun permesso microfono nella WebView |
| Speech-to-text | Whisper.cpp locale (tiny, greedy, ~0,6 s a frase) su un thread dedicato mentre si continua ad ascoltare; lingua dalle Impostazioni (italiano di default, capisce anche i comandi inglesi) |
| Parsing | Regex locale istantanea (più comandi per frase); Jev/TypeSafe `SystemOne` come ripiego per frasi libere |
| Automazioni Windows | Rust + `windows-sys`; `ShellExecuteW` e `SendInput` |
| Overlay | WebView frameless/trasparente, always-on-top; onda Canvas 2D |
| Installer | NSIS per utente corrente: installer Windows **`.exe`** |

L’icona sorgente è `public/app-icon.svg`. `npm run icons` genera le icone Tauri per installer, finestra e tray; la tray usa la stessa icona predefinita dell’app.

## Requisiti

- Windows 10/11 x64 e WebView2 Runtime.
- Node.js 18+ e npm.
- Rust stable con toolchain MSVC, Visual Studio C++ Build Tools e Windows SDK.
- Python 3 per preparare i token del modello KWS durante sviluppo/build.
- Connessione Internet al primo avvio in sviluppo/build per scaricare i modelli KWS e Whisper e il runtime whisper.cpp ufficiale.

## Configurazione locale

1. Crea `.env.local` copiando `.env.example` e inserisci la tua chiave API Jev/TypeSafe. `.env.local` è escluso da Git: **non committare né condividere le chiavi**.
2. Il primo avvio di `npm run tauri:dev` o `npm run tauri:build` prepara automaticamente KWS e Whisper: scarica il modello inglese KWS e genera `keywords.txt`, poi scarica `whisper-cli.exe` e il modello Whisper tiny multilingue. Dopo installazione/setup, la trascrizione resta locale e funziona offline. Per eseguire manualmente i setup:

   ```powershell
   .\scripts\setup-kws.ps1
   .\scripts\setup-whisper.ps1
   ```

3. Modelli e `whisper-cli.exe` vengono trovati nella cartella risorse dell’app (`target\<profilo>\models` in sviluppo, `models\` accanto a `heyjev.exe` una volta installata). `WHISPER_MODEL_PATH`, `WHISPER_CPP_BIN` e `WAKE_MODEL_DIR` servono solo come override. In sviluppo `.env.local` va nella radice del repo; nell’app installata in `%APPDATA%\com.heyjev.app\.env.local`.
4. **Impostazioni**: clic sinistro sull’icona di HeyJev nella system tray, oppure tasto destro → **Impostazioni…**. Lingua dei comandi, sensibilità del microfono (alzala se devi parlare forte), secondi di silenzio prima che smetta di ascoltare, controllo aggiornamenti e token GitHub.
5. Verifica l’accesso al microfono nelle impostazioni di Windows. Al primo avvio premi **Attiva** per avviare il rilevatore.

## Avvio e installer

```powershell
npm install
npm run tauri:dev
```

Per creare l’installer NSIS `.exe` (configurato in `src-tauri/tauri.conf.json`):

```powershell
npm run tauri:build
```

Il file si trova in `src-tauri/target/release/bundle/nsis/`. La build richiede toolchain Rust/MSVC, Python 3, connessione Internet al primo setup e WebView2. L'installer include il modello KWS, il runtime whisper.cpp Windows x64 e il modello Whisper multilingue tiny (circa 75 MiB): è più grande, ma chi lo installa non deve scaricare/configurare modelli e può trascrivere offline. I modelli restano esclusi da Git.

## Aggiornamenti

“**Hey Jev, check the update**” controlla le release firmate nel repository privato. Se manca la credenziale, apri **Impostazioni** → **Token GitHub…**; inserisci il token oppure premi **Importa da .env.local**. Usa un fine-grained token limitato al solo `ReflexDesigns/Ehi-Jev` con **Contents: read**. HeyJev verifica l’accesso e conserva il token nel **Credential Manager di Windows**; non lo salva nel WebView, nel repository o nell’EXE.

Quando trova una versione nuova, The Notch mostra **Installa <versione>**. L’installazione richiede quel clic esplicito e Windows chiude l’app mentre applica il pacchetto firmato. La verifica della firma Tauri è obbligatoria.

La GitHub Action `.github/workflows/release.yml` compila e pubblica installer, firme e `latest.json` a ogni tag Git `v*`. Prima di spingere una nuova release, aggiorna i file versione con `node scripts/set-version.mjs X.Y.Z`, committa la modifica, quindi crea e spingi il tag corrispondente (`vX.Y.Z`). In GitHub Actions deve essere configurato il secret `TAURI_SIGNING_PRIVATE_KEY`; la chiave privata locale è esclusa da Git. **Il primo installer updater-enabled va installato manualmente**: un installer creato prima dell’integrazione dell’updater non può auto-aggiornarsi. Anche 0.2.2 e 0.2.3 (updater e percorsi modelli rotti) vanno sostituite installando la 0.2.4 a mano.

## Struttura principale

```text
src/                         UI React, overlay, wave, parser e registrazione microfono
src-tauri/src/               backend Rust, wake listener, STT, intent e OS control
src-tauri/tauri.conf.json    finestra, CSP, bundle NSIS e icone
scripts/setup-kws.ps1        setup del modello KWS sherpa-onnx
scripts/setup-whisper.ps1    setup whisper.cpp e modello STT multilingue
scripts/set-version.mjs      sincronizza le versioni per una release taggata
.github/workflows/release.yml build/publish automatico delle release firmate
public/app-icon.svg          sorgente SVG icona
models/                      modelli locali (esclusi da Git)
```

## Verifiche

```powershell
npm test
npm run build
cargo check --manifest-path src-tauri\Cargo.toml
```

Per il primo pacchetto locale, installer e firma updater vengono copiati in `release/` (cartella esclusa da Git).
