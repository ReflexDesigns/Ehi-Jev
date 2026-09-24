// Controllo del parser offline sulle trascrizioni reali di Whisper tiny. Uso: npm test
import assert from 'node:assert/strict';
import { arithmetic, parseCommands } from '../src/lib/commandParser.ts';
import { applyCorrections, buildProfile, learn } from '../src/lib/voiceProfile.ts';

const cases = {
  'Apriterminale.': ['open_terminal'],
  'Appri terminale.': ['open_terminal'],
  'Apri il terminale': ['open_terminal'],
  'Open terminal.': ['open_terminal'],
  'Apri Claude.': ['open_claude'],
  'Apriclonde.': ['open_claude'],
  'Apri ChatGPT.': ['open_gpt'],
  'Mostra desktop.': ['show_desktop'],
  'Show desktop.': ['show_desktop'],
  'chiudi questo?': ['close_current'],
  'Controlla aggiornamenti.': ['check_update'],
  'Check for updates.': ['check_update'],
  'Apri terminale e poi mostra desktop.': ['open_terminal', 'show_desktop'],
  'Ok, apri terminale.': ['open_terminal'],
  'Apri Claude, grazie.': ['open_claude', 'cancel'],
  'Grazie!': ['cancel'],
  'Silenzio.': ['cancel'],
  'Che tempo fa?': [],
  'Crea un documento sulla storia di Roma.': ['create_document'],
  'Scrivimi un file di testo con la lista della spesa, grazie.': ['create_document', 'cancel'],
  'Crea un documento per il progetto Jev.': ['create_document'],
  'Preparami un sito per la mia pizzeria.': ['create_project'],
  "Crea un'app che apre il terminale.": ['create_project'],
  'Fai un MVP di una todo list.': ['create_project'],
  'Mostra desktop e crea un documento sulle api.': ['show_desktop', 'create_document'],
  'Fai silenzio.': ['cancel'],
  'Cri ha un documento sulla storia della pizza.': ['create_document'],
  'Scrivi mi un file di testo con la lista della spesa.': ['create_document'],
  'Fai un sito e web per il mio portfolio.': ['create_project'],
  'Spegni il computer.': ['shutdown'],
  'Spegni il PC, grazie.': ['shutdown', 'cancel'],
  'Puoi spegnere il pc?': ['shutdown'],
  'Riavvia il PC.': ['restart'],
  'Restart the computer': ['restart'],
  'Spegni la luce.': [],
  'Apri SmileSync.': ['open_app:smilesync'],
  'Apri Pit Stop, grazie.': ['open_app:pit stop', 'cancel'],
  'Apri il file.': ['open_app:file'],
  "Apri l'app Spotify e poi mostra desktop.": ['open_app:spotify', 'show_desktop'],
  'Open Visual Studio Code please': ['open_app:visual studio code'],
  'Apri terminale e poi apri Esplora file.': ['open_terminal', 'open_app:esplora file'],
  'Chiudi Chrome.': ['close_app:chrome'],
  'Chiudi il blocco note, grazie.': ['close_app:blocco note', 'cancel'],
  'Apri Word e chiudi Excel.': ['open_app:word', 'close_app:excel'],
  'Chiudi questa finestra.': ['close_current'],
  'Cerca ricette della carbonara su Google.': ['search:ricette della carbonara'],
  'Cerca il meteo di domani, grazie.': ['search:il meteo di domani', 'cancel'],
  'Cerca gli aggiornamenti.': ['check_update'],
  'Scrivi Ciao Marco, ci vediamo domani alle 3.': ['type_text:Ciao Marco, ci vediamo domani alle 3.'],
  'Scrivi apri il terminale.': ['type_text:apri il terminale.'],
  'Scrivi Città di Roma, grazie.': ['type_text:Città di Roma', 'cancel'],
  'Scrivi un documento sulla storia di Roma.': ['create_document'],
  'Apri il terminale e scrivi questo, poi scrivi herdr e avvio, poi apri Codenotch.': [
    'open_terminal',
    'type_text:questo',
    'type_text:herdr e avvio',
    'open_app:codenotch',
  ],
  "Scrivi ls e premi invio, poi apri l'app Spotify, grazie.": ['type_text:ls e premi invio', 'open_app:spotify', 'cancel'],
  'Scrivi pane e latte.': ['type_text:pane e latte.'],
  'Apri la calcolatrice e digita duemilacinquecento più tremila ottocentocinquanta e clicca su uguale.': [
    'open_app:calcolatrice',
    'type_text:2500+3850',
    'press_keys:=',
  ],
  'Digita 2.500 più 3.850 e premi uguale.': ['type_text:2500+3850', 'press_keys:='],
  'Premi invio.': ['press_keys:enter'],
  'Clicca sul pulsante uguale.': ['press_keys:='],
  'Scrivi grazie per tutto.': ['type_text:grazie per tutto.'],
  // Avanza un pezzo che nessuna regola capisce: decide l'AI (i comandi trovati sono la riserva).
  'Apri la calcolatrice e fai duemilacinquecento più tremila ottocentocinquanta.': ['interpret', 'open_app:calcolatrice'],
  'Apri il terminale, per favore.': ['open_terminal'],
  // Parole storpiate da Whisper tiny (reali e dal confronto modelli).
  'Amnula.': ['cancel'],
  'Anula.': ['cancel'],
  'Grazzie!': ['cancel'],
  'Opin di terminale.': ['open_terminal'],
  'Aprisplora file.': ['open_app:splora file'],
  'Mostra deskop.': ['show_desktop'],
  // …ma non dove sbagliare costa: niente dettatura da "area", niente chiusura da "chiedi".
  "Mostra l'area del sito.": [],
  'Chiedi questo a Claude.': [],
  "Il mese d'aprile.": [],
};
for (const [text, actions] of Object.entries(cases)) {
  assert.deepEqual(parseCommands(text), actions, text);
}
console.log(`parser ok (${Object.keys(cases).length} casi)`);

// Conti detti a voce, come si digitano nella calcolatrice.
assert.equal(arithmetic('duemilacinquecento più tremila ottocentocinquanta'), '2500+3850');
assert.equal(arithmetic('centottanta diviso per tre.'), '180/3');
assert.equal(arithmetic('ventuno per 1,5'), '21*1,5');
assert.equal(arithmetic('milleduecento meno trentatré'), '1200-33');
assert.equal(arithmetic('ciao Marco'), null);
assert.equal(arithmetic('grazie per tutto'), null);
assert.equal(arithmetic('2500'), null); // un numero da solo si scrive com'è

// Imprinting: correzioni imparate dal tutorial.
assert.deepEqual(learn('Apri il terminale', 'Apri il terminale.'), []);
assert.deepEqual(learn('Apri SmileSync', 'Apri Smile Sink.'), [['smile sink', 'smilesync']]);
assert.deepEqual(learn('Open the terminal', 'Open de terminal.'), []); // "de": troppo corta
assert.deepEqual(learn('Show desktop', 'Sciò desktop'), [['scio', 'show']]);
assert.deepEqual(learn('Grazie', 'E poi'), []); // frase diversa del tutto
assert.deepEqual(learn('Fail', 'Fai.'), []); // "fai" → "fail" romperebbe «fai un sito»
assert.deepEqual(learn('Apri Esplora file', 'Apri esplora fa il.'), []); // e "fa il" → "file" «che tempo fa il…»
assert.deepEqual(learn('Apri il terminale', 'Aprilterminale'), [['aprilterminale', 'apri il terminale']]);
const fixes = [['smile sink', 'smilesync'], ['scio', 'show']];
assert.equal(applyCorrections('Apri Smile, Sink!', fixes), 'Apri smilesync!');
assert.equal(applyCorrections('Sciò desktop.', fixes), 'show desktop.');
assert.equal(applyCorrections('Apri il terminale.', fixes), 'Apri il terminale.');
assert.deepEqual(parseCommands(applyCorrections('Sciò desktop.', fixes)), ['show_desktop']);
const sample = (text, wake, snr = 20) => ({ text, wake, snr });
const { profile, wakeHits } = buildProfile([
  { expected: 'Hey Jev', wake: true, sample: sample('Ehi, Jeff.', false) },
  { expected: 'Hey Jev', wake: true, sample: sample('Hey Jev.', true) },
  { expected: 'Apri SmileSync', wake: false, sample: sample('Apri Smile Sink.', false, 9.5) },
]);
assert.equal(wakeHits, 1);
assert.deepEqual(profile.wakeAliases, ['ehi jeff', 'hey jev']);
assert.deepEqual(profile.corrections, [['smile sink', 'smilesync']]);
assert.equal(profile.micSensitivity, 3); // voce 9,5× il rumore: soglia 3× regge con margine 3
// Rumore di fondo durante il tutorial (secondo giro reale): niente alias o correzioni spazzatura.
const noisy = buildProfile([
  { expected: 'Hey Jev', wake: true, sample: sample('[Musica]', false) },
  { expected: 'Hey Jev', wake: true, sample: sample('Hai taggiare.', false) },
  { expected: 'Hey Jev', wake: true, sample: sample('Hey.', false) },
  { expected: 'Hey Jev', wake: true, sample: sample('Ehi, Jeff.', false) },
  { expected: 'Apri il terminale', wake: false, sample: sample('Che ci sono?', false) },
  { expected: 'Crea un documento', wake: false, sample: sample('Ma ci sono il mio.', false) },
  { expected: 'Thank you', wake: false, sample: sample('[Musica]', false) },
]).profile;
assert.deepEqual(noisy.wakeAliases, ['ehi jeff']);
assert.deepEqual(noisy.corrections, []);
assert.deepEqual(buildProfile([{ expected: 'Hey Jev', wake: true, sample: sample('Hey Jev', true, 2) }]).profile, {
  wakeAliases: [],
  micSensitivity: 5, // voce appena sopra il rumore: sensibilità massima; niente frasi → correzioni intatte
});
const wakeOnly = buildProfile([
  { expected: 'Hey Jev', wake: true, sample: sample('Hey Jev.', true) },
  { expected: 'Hey Jev', wake: true, sample: sample('E Jev.', false) },
]).profile;
assert.equal('corrections' in wakeOnly, false); // con Deepgram si registra solo "Hey Jev"
assert.deepEqual(wakeOnly.wakeAliases, ['hey jev', 'e jev']);
console.log('imprinting ok');
