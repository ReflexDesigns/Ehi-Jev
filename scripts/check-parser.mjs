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
};
for (const [text, actions] of Object.entries(cases)) {
  assert.deepEqual(parseCommands(text), actions, text);
}
console.log(`parser ok (${Object.keys(cases).length} casi)`);
