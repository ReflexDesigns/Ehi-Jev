/**
 * Command Parser offline (Regex / Intent matching).
 *
 * Primo livello: istantaneo e locale. Jev (TypeSafe) resta il ripiego per le frasi
 * libere che nessuna regola riconosce (src-tauri/src/lib.rs, parse_intent).
 * `\s*` e `p+`: Whisper tiny a volte fonde o raddoppia ("Apriterminale", "Appri").
 */

interface CommandRule {
  action: string;
  patterns: RegExp[];
}

const OPEN = String.raw`\b(?:ap+ri|avvia|open|launch)\s*`;

const RULES: CommandRule[] = [
  { action: 'open_terminal', patterns: [new RegExp(OPEN + String.raw`(?:il\s*)?terminal(?:e)?\b`, 'gi')] },
  // "Apriclonde", "apri cloud": come Whisper tiny sente "Claude".
  { action: 'open_claude', patterns: [new RegExp(OPEN + String.raw`(?:cl[ao]u?n?de|cloud)\b`, 'gi')] },
  { action: 'open_gpt', patterns: [new RegExp(OPEN + String.raw`(?:chat\s*gpt|gpt)\b`, 'gi')] },
  {
    action: 'show_desktop',
    patterns: [/\b(?:mostra|show)\s*(?:il\s*)?desktop\b/gi, /\bmostra\s*(?:la\s*)?scrivania\b/gi],
  },
  {
    action: 'close_current',
    patterns: [/\b(?:chiudi|close)\s*(?:questo|questa|quest'ultimo|this|(?:la\s*)?finestra|the\s*window)\b/gi],
  },
  {
    action: 'check_update',
    patterns: [
      /\b(?:check|look\s*for|find)\s*(?:the\s*)?(?:for\s*)?updates?\b/gi,
      /\b(?:controlla|cerca|verifica)\s*(?:gli\s*)?(?:aggiornament[oi]|updates?)\b/gi,
    ],
  },
];

/** Parole che chiudono la sessione di ascolto. */
const STOP = /\b(?:grazie(?:\s*mille)?|silenzio|basta|stop|ok(?:ay)?|annulla|cancel|ciao|thank\s*you)\b/gi;

/**
 * Estrae tutti i comandi della frase, nell'ordine in cui sono detti.
 * "grazie"/"ok"/"silenzio" chiudono (`cancel`) solo se arrivano dopo l'ultimo
 * comando: "ok, apri terminale" apre il terminale, "apri terminale, grazie" apre e chiude.
 */
export function parseCommands(transcript: string): string[] {
  const text = transcript.toLowerCase();
  const found: { action: string; index: number }[] = [];
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      for (const match of text.matchAll(pattern)) found.push({ action: rule.action, index: match.index ?? 0 });
    }
  }
  found.sort((a, b) => a.index - b.index);
  const lastCommand = found.length ? found[found.length - 1].index : -1;
  const lastStop = [...text.matchAll(STOP)].pop()?.index ?? -1;
  const actions = found.map((command) => command.action);
  if (lastStop > lastCommand) actions.push('cancel');
  return actions;
}
