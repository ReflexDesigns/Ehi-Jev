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
  // Solo frasi esplicite, mai scelte da Jev: spegnere per sbaglio costa caro (e c'è «annulla»).
  {
    action: 'shutdown',
    patterns: [/\b(?:spegn(?:i|ere)|spengi|shut\s*down|turn\s*off)\s+(?:(?:il|lo|the|my|questo)\s+)?(?:computer|pc|portatile|laptop)\b/gi],
  },
  {
    action: 'restart',
    patterns: [/\b(?:riavvi(?:a|are)|restart|reboot)\s+(?:(?:il|lo|the|my|questo)\s+)?(?:computer|pc|portatile|laptop)\b/gi],
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
  // Solo fino al comando dopo: «scrivi ls, poi apri l'app X» non chiede di creare un'app.
  const rest = text.slice(verb.index).split(NEXT)[0];
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
const TYPE = /\b(?:scrivi|digit(?:a|i|are)|inserisci|type)\s+(.+)$/i;
/** Fine del testo da scrivere: «scrivi X, poi apri Y» continua con altri comandi.
 *  «… e premi invio» in fondo resta del testo: lo gestisce `type_text`. */
const NEXT =
  /[\s,;.]+(?:e\s+)?(?:poi|dopo|quindi|e|and|then)\s+(?=(?:ap+ri|avvia|lancia|chiudi|scrivi|digit(?:a|i)|inserisci|cerca|mostra|spegni|riavvia|premi(?!\s+invio)|clicca|schiaccia|open|launch|close|type|search|show|press|click)\b)/i;

/** «Premi invio», «clicca su uguale», «schiaccia il tasto tab»: un tasto (press_keys). */
const PRESS =
  /\b(?:premi|clicca|schiaccia|pigia|press|click|hit)\s+(?:(?:su|sul|sullo|on)\s+)?(?:(?:il|lo|l['’]|the)\s*)?(?:(?:tasto|pulsante|bottone|key|button)\s+)?(?:(?:di\s+)?(?:il|lo|l['’])\s*)?(invio|enter|ugual[ei]|equals?|tab|esc|escape|spazio|space|canc|backspace)\b/gi;
/** Come si chiamano i tasti per press_keys in lib.rs. */
const KEY_NAMES: Record<string, string> = {
  invio: 'enter',
  uguale: '=',
  uguali: '=',
  equal: '=',
  equals: '=',
  spazio: 'space',
  canc: 'delete',
  escape: 'esc',
};

const NUMBER_WORDS = Object.entries({
  zero: 0, uno: 1, un: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9,
  dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16,
  diciassette: 17, diciotto: 18, diciannove: 19, venti: 20, vent: 20, trenta: 30, trent: 30,
  quaranta: 40, quarant: 40, cinquanta: 50, cinquant: 50, sessanta: 60, sessant: 60, settanta: 70,
  settant: 70, ottanta: 80, ottant: 80, novanta: 90, novant: 90, cento: 100, cent: 100,
  mille: 1000, mila: 1000, milione: 1e6, milioni: 1e6,
}).sort(([a], [b]) => b.length - a.length);

/** I pezzi di un numero in lettere; "cent" + "ottanta" se "cento" + … non torna. */
function numberParts(rest: string): number[] | null {
  if (!rest) return [];
  for (const [word, value] of NUMBER_WORDS) {
    const tail = rest.startsWith(word) ? numberParts(rest.slice(word.length)) : null;
    if (tail) return [value, ...tail];
  }
  return null;
}

/** «duemilacinquecento», «tremila ottocentocinquanta» → "2500", "3850". */
function spokenNumber(text: string): string | null {
  const parts = numberParts(text);
  if (!parts?.length) return null;
  let [total, current] = [0, 0];
  for (const value of parts) {
    if (value === 100) current = (current || 1) * 100;
    else if (value >= 1000) [total, current] = [total + (current || 1) * value, 0];
    else current += value;
  }
  return String(total + current);
}

const OPERATORS: Record<string, string> = {
  '+': '+', piu: '+', '-': '-', meno: '-', '*': '*', x: '*', '×': '*', per: '*', moltiplicato: '*',
  '/': '/', ':': '/', diviso: '/',
};

/**
 * Un conto detto a voce, come si digita nella calcolatrice: «2500 più 3850» e
 * «duemilacinquecento più tremila ottocentocinquanta» → "2500+3850" (Deepgram scrive i
 * numeri in lettere). Se non è solo un conto: null, il testo si scrive com'è.
 */
export function arithmetic(text: string): string | null {
  const folded = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/(\d)\.(?=\d{3}(?!\d))/g, '$1');
  const out: string[] = [];
  let operand: string[] = [];
  const close = () => {
    const joined = operand.join('');
    operand = [];
    return /^\d+(?:,\d+)?$/.test(joined) ? joined : spokenNumber(joined);
  };
  for (const token of folded.match(/\d+(?:,\d+)?|\p{L}+|[+\-*/×:]/gu) ?? []) {
    const operator = OPERATORS[token];
    if (!operator) {
      if (token !== 'e') operand.push(token); // «duemila e cinquecento»
      continue;
    }
    if (!operand.length && token === 'per' && out.length) continue; // «diviso per»
    const value = close();
    if (value === null) return null;
    out.push(value, operator);
  }
  const last = close();
  return last === null || !out.length ? null : [...out, last].join('');
}

/** Il testo di «scrivi …», o il conto già pronto per la calcolatrice. */
const typing = (text: string) => `type_text:${arithmetic(text) ?? text}`;
/** Un «grazie» in fondo è per Jev, non da scrivere. */
const THANKS = /[\s,.;]+(?:grazie(?:\s+mille)?|thank\s*you)[.!]?\s*$/i;

/** Parole che chiudono la sessione di ascolto. */
const STOP = /\b(?:grazie(?:\s*mille)?|silenzio|basta|stop|ok(?:ay)?|annulla|cancel|ciao|thank\s*you)\b/gi;

/** Parole che da sole non chiedono niente: se avanza solo questo, i comandi trovati bastano. */
const FILLER = new Set(
  'e ed o poi dopo quindi and then per favore piacere please grazie mille thanks thank you ok okay silenzio basta stop ciao annulla cancel puoi potresti mi ti hey ehi jev adesso ora subito'.split(
    ' ',
  ),
);

/** Quante parole della frase nessuna regola ha capito («apri la calcolatrice e *fai 2 più 2*»). */
function leftover(text: string, spans: { index: number; end: number }[]): number {
  let rest = text;
  for (const { index, end } of spans) rest = rest.slice(0, index) + ' '.repeat(end - index) + rest.slice(end);
  return (rest.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').match(/\p{L}+|\d+/gu) ?? []).filter((word) => !FILLER.has(word)).length;
}

/**
 * Estrae tutti i comandi della frase, nell'ordine in cui sono detti.
 * "grazie"/"ok"/"silenzio" chiudono (`cancel`) solo se arrivano dopo l'ultimo
 * comando: "ok, apri terminale" apre il terminale, "apri terminale, grazie" apre e chiude.
 * Se avanza una parte che nessuna regola capisce, in testa c'è `interpret`: decide l'AI
 * sulla frase intera, e i comandi trovati restano la riserva se l'AI non c'è.
 */
export function parseCommands(transcript: string): string[] {
  const text = tolerant(transcript.toLowerCase());
  const found: { action: string; index: number; end: number }[] = [];
  const add = (action: string, match: RegExpMatchArray) => {
    const index = match.index ?? 0;
    if (!found.some((command) => command.index === index)) found.push({ action, index, end: index + match[0].length });
  };
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      for (const match of text.matchAll(pattern)) add(rule.action, match);
    }
  }
  for (const [pattern, action] of [[OPEN_APP, 'open_app'], [CLOSE_APP, 'close_app'], [SEARCH, 'search']] as const) {
    for (const match of text.matchAll(pattern)) add(`${action}:${match[1]}`, match);
  }
  for (const match of text.matchAll(PRESS)) add(`press_keys:${KEY_NAMES[match[1]] ?? match[1]}`, match);
  // Dopo "crea …" il resto è la richiesta per l'AI, non altri comandi.
  const create = creation(text);
  const typed = create ? null : TYPE.exec(text);
  const original = TYPE.exec(transcript);
  if (create) {
    found.splice(0, found.length, ...found.filter((command) => command.index < create.index), { ...create, end: text.length });
  } else if (typed && original) {
    // Anche «scrivi apri il terminale» o «scrivi ciao Marco» si scrive e basta: niente
    // comandi né parole di chiusura dentro il testo; chiude solo un «grazie» in fondo.
    const before = found.filter((command) => command.index < typed.index).sort((a, b) => a.index - b.index);
    const next = NEXT.exec(original[1]);
    if (next) {
      const rest = original[1].slice(next.index + next[0].length);
      return [...before.map((command) => command.action), typing(original[1].slice(0, next.index)), ...parseCommands(rest)];
    }
    const actions = [...before.map((command) => command.action), typing(original[1].replace(THANKS, ''))];
    return THANKS.test(original[1]) ? [...actions, 'cancel'] : actions;
  }
  found.sort((a, b) => a.index - b.index);
  const lastCommand = found.length ? found[found.length - 1].index : -1;
  const lastStop = [...text.matchAll(STOP)].pop()?.index ?? -1;
  const actions = found.map((command) => command.action);
  if (lastStop > lastCommand) actions.push('cancel');
  return actions.length && leftover(text, found) >= 2 ? ['interpret', ...actions] : actions;
}
