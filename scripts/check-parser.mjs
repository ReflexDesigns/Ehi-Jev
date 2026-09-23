// Controllo del parser offline sulle trascrizioni reali di Whisper tiny. Uso: npm test
import assert from 'node:assert/strict';
import { parseCommands } from '../src/lib/commandParser.ts';
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
  'Apri SmileSync.': ['open_app:smilesync'],
  'Apri Pit Stop, grazie.': ['open_app:pit stop', 'cancel'],
  'Apri il file.': ['open_app:file'],
  "Apri l'app Spotify e poi mostra desktop.": ['open_app:spotify', 'show_desktop'],
  'Open Visual Studio Code please': ['open_app:visual studio code'],
  'Apri terminale e poi apri Esplora file.': ['open_terminal', 'open_app:esplora file'],
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

// Imprinting: correzioni imparate dal tutorial.
assert.deepEqual(learn('Apri il terminale', 'Apri il terminale.'), []);
assert.deepEqual(learn('Apri SmileSync', 'Apri Smile Sink.'), [['smile sink', 'smilesync']]);
assert.deepEqual(learn('Open the terminal', 'Open de terminal.'), []); // "de": troppo corta
assert.deepEqual(learn('Show desktop', 'Sciò desktop'), [['scio', 'show']]);
assert.deepEqual(learn('Grazie', 'E poi'), []); // frase diversa del tutto
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
  corrections: [],
  micSensitivity: 5,
});
console.log('imprinting ok');
