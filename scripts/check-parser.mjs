// Controllo del parser offline sulle trascrizioni reali di Whisper tiny. Uso: npm test
import assert from 'node:assert/strict';
import { parseCommand } from '../src/lib/commandParser.ts';

const cases = {
  'Apriterminale.': 'open_terminal',
  'Apri il terminale': 'open_terminal',
  'Open terminal.': 'open_terminal',
  'Apri Claude.': 'open_claude',
  'Apri ChatGPT.': 'open_gpt',
  'Mostra desktop.': 'show_desktop',
  'Show desktop.': 'show_desktop',
  'chiudi questo?': 'close_current',
  'Controlla aggiornamenti.': 'check_update',
  'Check for updates.': 'check_update',
  'Grazie!': 'cancel',
  'Che tempo fa?': undefined,
};
for (const [text, action] of Object.entries(cases)) {
  assert.equal(parseCommand(text)?.action, action, text);
}
console.log(`parser ok (${Object.keys(cases).length} casi)`);
