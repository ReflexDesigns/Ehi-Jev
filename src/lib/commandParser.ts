/**
 * Command Parser offline (fallback Regex / Intent matching).
 *
 * Usato quando il backend Jev (TypeSafe) non è configurato o irraggiungibile.
 * Gli intenti supportati rispecchiano i criteri della Choice question
 * inviata a Jev in src-tauri/src/lib.rs (parse_intent).
 * `\s*`: Whisper a volte fonde le parole ("Apriterminale").
 */

export interface ParsedCommand {
  action: string;
  raw: string;
}

interface CommandRule {
  action: string;
  patterns: RegExp[];
}

const RULES: CommandRule[] = [
  {
    action: 'open_terminal',
    patterns: [/\b(apri|avvia|open|launch)\s*(il\s*)?terminal(e)?\b/i],
  },
  {
    action: 'open_claude',
    patterns: [/\b(apri|open)\s*claude\b/i],
  },
  {
    action: 'open_gpt',
    patterns: [/\b(apri|open)\s*(chat\s*gpt|gpt|chatgpt)\b/i],
  },
  {
    action: 'show_desktop',
    patterns: [/\b(mostra|show)\s*(il\s*)?desktop\b/i, /\bmostra\s*scrivania\b/i],
  },
  {
    action: 'close_current',
    patterns: [/\b(chiudi|close)\s*(questo|questa|quest'ultimo|this|la\s*finestra|finestra)\b/i],
  },
  {
    action: 'cancel',
    patterns: [/\b(annulla|cancel|grazie|grazie\s*mille|thank\s*you|ciao)\b/i],
  },
  {
    action: 'check_update',
    patterns: [
      /\b(check|look\s*for|find)\s*(the\s*)?(for\s*)?updates?\b/i,
      /\b(controlla|cerca|verifica)\s*(gli\s*)?aggiornamenti?\b/i,
      /\bcontrolla\s*(gli\s*)?updates?\b/i,
    ],
  },
];

/**
 * Estrae l'azione dal transcript. Ritorna null se nessuna regola
 * corrisponde (il chiamante mostrerà "comando non riconosciuto").
 */
export function parseCommand(transcript: string): ParsedCommand | null {
  const text = transcript.trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(lower)) {
        return { action: rule.action, raw: text };
      }
    }
  }
  return null;
}
