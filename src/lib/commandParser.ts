/**
 * Command Parser offline (Regex / Intent matching).
 *
 * Primo livello: istantaneo e locale. Jev (TypeSafe) resta il ripiego per le frasi
 * libere che nessuna regola riconosce (src-tauri/src/chat.rs).
 * `\s*` e `p+`: Whisper tiny a volte fonde o raddoppia ("Apriterminale", "Appri").
 */

import { distance } from './voiceProfile.ts';

/**
 * Whisper tiny storpia di una lettera o due le parole dei comandi ("amnula", "opin",
 * "grazzie"): prima delle regole, ogni parola vicina a questo vocabolario diventa quella
 * giusta. Esclusi di proposito i verbi di creazione ("area" → "crea" avvierebbe una
 * dettatura) e "chiudi" ("chiedi" → "chiudi" chiuderebbe una finestra).
 */
const VOCABULARY =
  'apri avvia lancia open launch mostra show check close controlla verifica terminale terminal desktop scrivania finestra window aggiornamenti updates annulla grazie silenzio cancel'.split(
    ' ',
  );

function tolerant(text: string): string {
  return text.replace(/\p{L}+/gu, (word) => {
    if (word.length < 4 || VOCABULARY.includes(word)) return word;
    // "Aprisplora file": verbo attaccato al nome dell'app ("aprile" resta aprile).
    const glued = /^ap+r[ie](\p{L}{4,})$/u.exec(word);
    if (glued) return `apri ${glued[1]}`;
    const near = VOCABULARY.find((v) => Math.abs(v.length - word.length) <= 2 && distance(word, v) <= (v.length >= 7 ? 2 : 1));
    return near ?? word;
  });
}

interface CommandRule {
  action: string;
  patterns: RegExp[];
}

const OPEN = String.raw`\b(?:ap+ri|avvia|open|launch)\s*`;

const RULES: CommandRule[] = [
  { action: 'open_terminal', patterns: [new RegExp(OPEN + String.raw`(?:(?:il|the|di|de)\s*)?terminal(?:e)?\b`, 'gi')] },
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

/**
 * Richieste all'AI: verbo di creazione + cosa creare. Vince il primo oggetto detto
 * ("un documento per il progetto" = documento). Il resto della frase è la richiesta.
 * "Cria", "Cri ha": come Whisper tiny sente a volte "Crea".
 */
const CREATE = /\b(?:cr[ei]a(?:mi)?|cri\s*ha|scrivi(?:mi)?|prepara(?:mi)?|genera(?:mi)?|fa(?:i|mmi)|create|write|make|build|generate)\b/i;
const CREATE_KINDS: [string, RegExp][] = [
  [
    'create_document',
    /\b(?:document[oi]|file|testo|txt|markdown|md|relazion[ei]|articol[oi]|letter[ae]|appunti|note|report|riassunto|guida|document|text|article|letter|notes|summary)\b/i,
  ],
  [
    'create_project',
    /\b(?:sit[oi]|website|web\s*app|mvp|progett[oi]|app|applicazion[ei]|landing|prototip[oi]|gioco|dashboard|project|site|game)\b/i,
  ],
];

function creation(text: string): { action: string; index: number } | null {
  const verb = CREATE.exec(text);
  if (!verb) return null;
  const rest = text.slice(verb.index);
  const kinds = CREATE_KINDS.map(([action, noun]) => ({ action, at: rest.search(noun) })).filter((k) => k.at >= 0);
  if (!kinds.length) return null;
  kinds.sort((a, b) => a.at - b.at);
  return { action: kinds[0].action, index: verb.index };
}

/**
 * «Apri <nome>» che non è un comando fisso: app del menu Start (`open_app:<nome>`,
 * cercata con tolleranza in src-tauri/src/apps.rs). Il nome finisce a pausa, "e", "poi", "grazie"…
 */
const OPEN_APP =
  /\b(?:ap+ri|avvia|lancia|open|launch|start)\s+(?:(?:l['’]\s*)?app(?:licazione)?\s+|il\s+programma\s+|l['’]\s*|(?:il|lo|la|i|gli|le|the)\s+)?([^,.;:!?]+?)\s*(?=[,.;:!?]|\s(?:e|ed|and|poi|then|per\s+favore|please|grazie|thanks?)\b|$)/gi;

/** «Chiudi <nome>» che non è «chiudi questo/la finestra»: chiude le finestre di quell'app. */
const CLOSE_APP =
  /\b(?:chiudi|close)\s+(?:(?:l['’]\s*)?app(?:licazione)?\s+|il\s+programma\s+|l['’]\s*|(?:il|lo|la|i|gli|le|the)\s+)?([^,.;:!?]+?)\s*(?=[,.;:!?]|\s(?:e|ed|and|poi|then|per\s+favore|please|grazie|thanks?)\b|$)/gi;

/** «Cerca <cosa> (su Google)»: ricerca nel browser. «Cerca aggiornamenti» resta check_update. */
const SEARCH =
  /\b(?:cerca(?:mi)?|search(?:\s+for)?)\s+(?:su\s+google\s+)?([^,.;:!?]+?)(?:\s+(?:su|on|in)\s+(?:google|internet|web))?\s*(?=[,.;:!?]|$)/gi;

/** «Scrivi <testo>»: tutto quello che segue si digita (dalla frase originale: maiuscole e accenti). */
const TYPE = /\b(?:scrivi|digita|type)\s+(.+)$/i;
/** Un «grazie» in fondo è per Jev, non da scrivere. */
const THANKS = /[\s,.;]+(?:grazie(?:\s+mille)?|thank\s*you)[.!]?\s*$/i;

/** Parole che chiudono la sessione di ascolto. */
const STOP = /\b(?:grazie(?:\s*mille)?|silenzio|basta|stop|ok(?:ay)?|annulla|cancel|ciao|thank\s*you)\b/gi;

/**
 * Estrae tutti i comandi della frase, nell'ordine in cui sono detti.
 * "grazie"/"ok"/"silenzio" chiudono (`cancel`) solo se arrivano dopo l'ultimo
 * comando: "ok, apri terminale" apre il terminale, "apri terminale, grazie" apre e chiude.
 */
export function parseCommands(transcript: string): string[] {
  const text = tolerant(transcript.toLowerCase());
  const found: { action: string; index: number }[] = [];
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      for (const match of text.matchAll(pattern)) found.push({ action: rule.action, index: match.index ?? 0 });
    }
  }
  for (const [pattern, action] of [[OPEN_APP, 'open_app'], [CLOSE_APP, 'close_app'], [SEARCH, 'search']] as const) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (!found.some((command) => command.index === index)) found.push({ action: `${action}:${match[1]}`, index });
    }
  }
  // Dopo "crea …" il resto è la richiesta per l'AI, non altri comandi.
  const create = creation(text);
  const typed = create ? null : TYPE.exec(text);
  const original = TYPE.exec(transcript);
  if (create) {
    found.splice(0, found.length, ...found.filter((command) => command.index < create.index), create);
  } else if (typed && original) {
    // Anche «scrivi apri il terminale» o «scrivi ciao Marco» si scrive e basta: niente
    // comandi né parole di chiusura dentro il testo; chiude solo un «grazie» in fondo.
    const before = found.filter((command) => command.index < typed.index).sort((a, b) => a.index - b.index);
    const actions = [...before.map((command) => command.action), `type_text:${original[1].replace(THANKS, '')}`];
    return THANKS.test(original[1]) ? [...actions, 'cancel'] : actions;
  }
  found.sort((a, b) => a.index - b.index);
  const lastCommand = found.length ? found[found.length - 1].index : -1;
  const lastStop = [...text.matchAll(STOP)].pop()?.index ?? -1;
  const actions = found.map((command) => command.action);
  if (lastStop > lastCommand) actions.push('cancel');
  return actions;
}
