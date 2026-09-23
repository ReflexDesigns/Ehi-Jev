// Controllo del parser offline sulle trascrizioni reali di Whisper tiny. Uso: npm test
import assert from 'node:assert/strict';
import { parseCommands } from '../src/lib/commandParser.ts';

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
};
for (const [text, actions] of Object.entries(cases)) {
  assert.deepEqual(parseCommands(text), actions, text);
}
console.log(`parser ok (${Object.keys(cases).length} casi)`);
