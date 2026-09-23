# HeyJev

**L’assistente vocale per Windows che scende dal bordo dello schermo.**
Dici «Hey Jev»: un’isola nera stile Dynamic Island cola giù dall’alto, ti ascolta ed esegue. Apre app, controlla Windows, scrive documenti e crea siti con l’AI. Niente chiacchiere: capisce quello che dici anche detto a modo tuo, lo fa subito, poi risale e sparisce.

*Voice command executor for Windows 10/11: say “Hey Jev” and give orders. Real-time Italian speech via Deepgram streaming, free phrasing mapped to actions by Gemini Flash, offline wake word. It executes, it doesn't chat.*

<!-- Screenshot dell'isola in ascolto / impostazioni / tutorial: in arrivo. -->

## Cosa sa fare

| | |
|---|---|
| 🚀 **Apre qualsiasi app** | «Apri Spotify», «Apri Esplora file», «Apri PitStop»: cerca il nome tra le app del menu Start, anche se lo dici o lo trascrive in modo un po’ diverso. |
| 🪟 **Controlla Windows** | Mostra il desktop, chiude la finestra attiva, apre il terminale, Claude o ChatGPT. |
| 📝 **Scrive documenti** | «Crea un documento sulla storia di Roma» → Gemini Flash scrive un file Markdown in **Download** e lo apre. |
| 🌐 **Crea siti e MVP** | «Preparami un sito per una pizzeria» → DeepSeek Flash genera il progetto completo in `C:\Users\<tu>\<nome-progetto>` e lo apre nel browser. |
| 🎯 **Capisce come parli tu** | Deepgram trascrive in tempo reale; i comandi noti partono all’istante, le frasi libere («metti su SmileSync», «apri il programma per i file») le interpreta **Jev** (TypeSafe) in circa 0,4 secondi. |
| 🤐 **Laconico** | Esegue e basta: non fa conversazione e non risponde a domande di cultura. Parla (voce Aura 2 **Maia**) solo per errori e avvisi, e se parli sopra si zittisce. |
| 🔁 **Conversazione continua** | Una sola «Hey Jev», poi quanti comandi vuoi, anche nella stessa frase («apri il terminale e mostra il desktop»). «Grazie» chiude. |
| 🎓 **Impara la tua voce** | Al primo avvio un tutorial di un minuto: dici «Hey Jev» e leggi qualche frase. HeyJev impara come ti sente. |
| 🔔 **Ti avvisa** | Quando un documento o un sito è pronto arriva una notifica di Windows (disattivabile). |
| 🔄 **Si aggiorna da solo** | Controlla le release firmate su GitHub e si installa con un clic. |

## Privacy

- La wake word «Hey Jev» è **sempre offline** (sherpa-onnx): finché non la dici, niente audio esce dal PC.
- Dopo «Hey Jev», con la chiave Deepgram, l’audio della conversazione va a **Deepgram** per la trascrizione in tempo reale e il testo delle risposte torna come voce. Senza chiave (o scegliendo *Whisper, sul PC* nelle Impostazioni) la trascrizione resta locale con Whisper.cpp.
- A **Jev/TypeSafe** va il testo delle frasi che il parser locale non riconosce; a **OpenRouter** le richieste di documenti e siti (e le frasi libere solo se Jev non risponde); a GitHub il controllo aggiornamenti.
- Le chiavi API stanno nel **Credential Manager di Windows**: non nel codice, non nell’installer, non in file di testo.
- HeyJev esegue solo le azioni elencate qui sotto: non è un agente con accesso libero al PC. I file generati dall’AI non possono uscire dalla cartella del progetto.

## Installazione

1. Scarica `HeyJev_<versione>_x64-setup.exe` dall’**[ultima release](https://github.com/ReflexDesigns/Ehi-Jev/releases/latest)**.
2. Avvialo: si installa per il tuo utente, senza permessi di amministratore. Windows SmartScreen può avvisare che l’editore è sconosciuto (l’installer non ha una firma Authenticode): **Ulteriori informazioni → Esegui comunque**.
3. Al primo avvio una **procedura guidata** ti fa creare e incollare le chiavi, una alla volta, con il link alla pagina giusta: **Deepgram** (ascolto e voce, credito gratuito all’iscrizione), **Jev** (esegue i comandi detti a modo tuo) e **OpenRouter** (documenti e siti). Ogni chiave viene verificata prima di essere salvata; puoi saltarle e rifarlo da **Impostazioni → Chiavi**. Senza chiavi HeyJev funziona lo stesso, offline, con i comandi diretti.
4. Poi, **prima di iniziare**, dici «Hey Jev» cinque volte: HeyJev impara come lo dici (**Registra voce**).

Requisiti: Windows 10/11 x64, microfono, WebView2 (già presente su Windows 11).

## Comandi vocali

Dopo «Hey Jev» HeyJev resta in ascolto ed esegue ogni frase appena fai una pausa. Smette dopo qualche secondo di silenzio o quando dici **«grazie»**, **«ok»** o **«silenzio»**.

| Cosa dire | Varianti | Cosa succede |
|---|---|---|
| «Apri Spotify» | «Avvia…», «Lancia…», «Open…», «Apri l’app…» | Apre l’app del menu Start col nome più simile |
| «Apri terminale» | «Open terminal» | Windows Terminal (o `cmd.exe`) |
| «Apri Claude» / «Apri ChatGPT» | «Open Claude», «Apri GPT» | Il sito nel browser predefinito |
| «Mostra desktop» | «Show desktop», «Mostra scrivania» | **Win + D** |
| «Chiudi questo» | «Chiudi la finestra», «Close this» | Chiude la finestra che era attiva quando hai chiamato HeyJev (mai HeyJev né il desktop) |
| «Chiudi Chrome» | «Chiudi Word», «Chiudi il blocco note» | Chiude le finestre aperte di quell’app, come Alt+F4 (i documenti non salvati te li chiede l’app) |
| «Cerca … su Google» | «Cerca il meteo di domani», «Cercami su internet…» | Apre la ricerca Google nel browser |
| «Scrivi …» | «Scrivi Ciao Marco, a domani e premi invio» | Digita il testo nella finestra che avevi davanti; Invio solo se lo chiedi |
| «Crea un documento su …» | «Scrivimi un file / una relazione / un articolo…» | Documento `.md` (o `.txt`) in **Download** |
| «Crea un sito / un MVP / un’app …» | «Preparami una landing / un prototipo…» | Progetto in `C:\Users\<tu>\<nome-progetto>` |
| «Controlla aggiornamenti» | «Check for updates» | Cerca una nuova versione; si installa solo dopo il tuo clic |
| «Spegni il PC» / «Riavvia il PC» | «Spegni il computer», «Restart the computer» | Te lo dice e aspetta 15 secondi: «annulla» lo ferma. Un’app con lavoro non salvato blocca lo spegnimento |
| «Grazie» / «Silenzio» | «Ok», «Basta», «Stop», «Thank you» | Chiude l’ascolto |
| Qualsiasi altra frase | «Fammi vedere il desktop», «Metti su SmileSync» | Jev sceglie il comando giusto; se non è un comando (es. «che circonferenza ha la Terra?») non fa niente |

**Richieste all’AI**: dopo «crea un documento/sito…» tutto quello che dici fino a «grazie» (o al silenzio) diventa la richiesta. Il lavoro va avanti in background: l’isola e la notifica ti dicono quando è pronto.

## Registra voce

Ognuno dice «Hey Jev» a modo suo, e il rilevatore offline è addestrato sull’inglese. **Registra voce** (al primo avvio, o **Impostazioni → Registra voce**) ti fa dire «Hey Jev» cinque volte e impara:

- **come ti chiama**: se il rilevatore non ti riconosce sempre, attiva un ascolto di riserva che riconosce la tua «Hey Jev» così come la pronunci tu;
- **il volume della tua voce**: regola la sensibilità del microfono.

Con **Whisper** (offline, senza Deepgram) leggi anche i comandi più comuni (apri e chiudi Chrome, Word, Excel, Blocco note…) e **quelle che scrivi tu**, per esempio i nomi delle app che non capisce: se sente «Smile Sink» quando dici «SmileSync», da lì in poi corregge da solo. Passando da Deepgram a Whisper nelle Impostazioni, la registrazione completa parte da sola.

In **Impostazioni → Parole imparate** vedi cosa ha imparato (come ti chiama, le tue parole, le correzioni) e togli con ✕ quello che non ti piace. Puoi aggiungere un’altra «Hey Jev» o insegnare una parola nuova al volo: la scrivi, premi Registra, la dici. La prova la fa chi ascolta davvero: con Deepgram la parola diventa una delle sue parole chiave, con Whisper una correzione.

Tutto resta sul tuo PC, in `%APPDATA%\com.heyjev.app\settings.json`.

## Impostazioni

Clic sull’icona nella system tray (o tasto destro → **Impostazioni…**):

- lingua dei comandi (italiano, inglese, automatica) e **chi ascolta**: Deepgram (online, consigliato) o Whisper sul PC (offline);
- sensibilità del microfono e secondi di silenzio prima di smettere di ascoltare;
- notifica di Windows a lavoro AI finito;
- **Chiave Deepgram** ([console.deepgram.com](https://console.deepgram.com)): ascolto in streaming (nova-3, italiano) e voce Aura 2 Maia;
- **Chiave Jev** ([typesafe.ai](https://docs.typesafe.ai/api)): Jev, il modello System One di TypeSafe, sceglie in circa 0,4 s il comando e l’app per le frasi dette a modo tuo;
- **Chiave OpenRouter** ([openrouter.ai/keys](https://openrouter.ai/keys)): documenti (Gemini Flash) e siti (DeepSeek Flash); Gemini 3.5 Flash-Lite fa anche da riserva se Jev non risponde. Si paga a consumo su OpenRouter;
- **Chiavi** (procedura guidata), **Registra voce**, **Parole imparate** e controllo aggiornamenti.

Le chiavi vengono verificate prima del salvataggio.

## Come funziona

| Pezzo | Tecnologia |
|---|---|
| App desktop | [Tauri 2](https://tauri.app): backend Rust, interfaccia React/TypeScript |
| Wake word | [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) keyword spotting, offline, in Rust + CPAL; riserva Whisper imparata nel tutorial |
| Ascolto | [Deepgram](https://deepgram.com) nova-3 in streaming WebSocket (italiano, fine frase automatica, le tue parole e i nomi delle app come parole chiave); senza chiave [whisper.cpp](https://github.com/ggml-org/whisper.cpp) locale |
| Voce | Deepgram Aura 2 `aura-2-maia-it` via WebSocket, solo per errori e avvisi; si zittisce se parli (l’eco delle casse è riconosciuta dal contenuto) |
| Comandi | Parser locale istantaneo e tollerante (`src/lib/commandParser.ts`); frasi libere a **Jev** (TypeSafe System One): azione e app in una richiesta, ~0,4 s; se tarda oltre 1,2 s corre anche Gemini 3.5 Flash-Lite e vince il primo (`src-tauri/src/chat.rs`) |
| Esecuzione | Codice Rust di HeyJev sul PC: app del menu Start, scorciatoie Windows, finestre |
| App installate | `Get-StartApps` + ricerca tollerante del nome (`src-tauri/src/apps.rs`) |
| AI | [OpenRouter](https://openrouter.ai): Gemini Flash per i documenti, DeepSeek Flash per i progetti |
| L’isola | Finestra trasparente sempre in primo piano; animazioni solo CSS |
| Installer e aggiornamenti | NSIS per utente + Tauri updater con firma obbligatoria |

## Sviluppo

Serve: Windows 10/11 x64, Node.js 18+, Rust stable (MSVC) con Visual Studio C++ Build Tools, Python 3 (prepara i token del modello KWS).

```powershell
npm install
npm run tauri:dev     # al primo avvio scarica i modelli KWS e Whisper in models/
```

Le chiavi in sviluppo si possono mettere in `.env.local` (vedi `.env.example`, escluso da Git). Verifiche:

```powershell
npm test                                          # parser comandi e tutorial voce
npm run build                                     # TypeScript + Vite
cargo test --manifest-path src-tauri\Cargo.toml   # backend Rust
```

`npm run tauri:build` crea l’installer in `src-tauri/target/release/bundle/nsis/`; include modelli e runtime Whisper (~75 MiB), così chi installa non deve configurare nulla.

**Release**: `node scripts/set-version.mjs X.Y.Z`, commit, poi tag `vX.Y.Z`. La GitHub Action `.github/workflows/release.yml` compila, firma e pubblica installer e `latest.json` (serve il secret `TAURI_SIGNING_PRIVATE_KEY`).

```text
src/                     interfaccia: isola, impostazioni, tutorial, parser comandi
src-tauri/src/lib.rs     comandi Tauri, Whisper, azioni Windows, impostazioni, updater
src-tauri/src/wake.rs    microfono, wake word, sessione di ascolto, barge-in, tutorial
src-tauri/src/deepgram.rs ascolto in streaming e voce Aura 2 Maia
src-tauri/src/speaker.rs  altoparlanti: coda audio che si svuota all'istante
src-tauri/src/chat.rs     frase libera → comando (Jev, riserva Gemini)
src-tauri/src/apps.rs    ricerca e avvio delle app installate
src-tauri/src/ai.rs      documenti e progetti via OpenRouter
scripts/                 setup modelli, versioni, test del parser
```

## Limiti noti

- Solo Windows 10/11 x64.
- Senza Deepgram, Whisper tiny è pensato per comandi brevi: frasi lunghe e nomi rari possono uscire storpiati (il tutorial aiuta).
- Mentre Maia parla, per zittirla servono almeno due parole diverse dalle sue, oppure «basta», «stop», «aspetta», «grazie».
- L’installer non ha una firma Authenticode, quindi SmartScreen avvisa al primo download.
