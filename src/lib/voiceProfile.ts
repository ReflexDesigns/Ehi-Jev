/**
 * Imprinting della voce (tutorial). L'utente legge frasi note: dove Whisper sente altro
 * si impara una correzione [sentito, voluto], applicata poi a ogni trascrizione. Dalle
 * «Hey Jev» registrate si impara come Whisper sente la wake word (riserva del KWS) e
 * dal volume della voce la sensibilità del microfono.
 */

import type { Settings, VoiceSample } from './osControl';

export type Correction = [heard: string, meant: string];

export interface TutorialResult {
  expected: string;
  wake: boolean;
  sample: VoiceSample;
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '');

/** Parole minuscole senza accenti né punteggiatura (come `words` in lib.rs). Via i tag di
 *  Whisper per i suoni ("[Musica]", "(risate)"): non sono parole dette. */
export function words(text: string): string[] {
  return fold(text.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, ' '))
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Parole troppo comuni per diventare da sole una correzione ("e" → "grazie" romperebbe tutto;
// "fai" → "fail" rompeva «fai un sito», "fa il" → "file" «che tempo fa il weekend»).
const COMMON = new Set(
  'e ed o poi il lo la i gli le l un una uno di a da in con su per che non si fa fai fare apri chiudi crea scrivi cerca mostra the and or an to of on for then ok'.split(
    ' ',
  ),
);

/** Distanza di edit (Levenshtein). */
export function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), row[j] + 1, next[j - 1] + 1);
    }
    row = next;
  }
  return row[b.length];
}

/** Tratti della frase letta che Whisper ha sentito diversi: [sentito, voluto]. */
export function learn(expected: string, heard: string): Correction[] {
  const e = words(expected);
  const h = words(heard);
  const [he, ee] = [h.join(''), e.join('')];
  // LCS sulle parole: i tratti fra parole uguali sono le differenze.
  const lcs = Array.from({ length: h.length + 1 }, () => new Array<number>(e.length + 1).fill(0));
  for (let i = h.length - 1; i >= 0; i--) {
    for (let j = e.length - 1; j >= 0; j--) {
      lcs[i][j] = h[i] === e[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  // Frase diversa del tutto (rumore di fondo, altra frase): niente da imparare. Senza
  // parole in comune serve una somiglianza più stretta.
  const limit = lcs[0][0] ? 0.6 : 0.4;
  if (!h.length || distance(he, ee) > limit * Math.max(he.length, ee.length)) return [];
  const out: Correction[] = [];
  let [i, j, gapH, gapE] = [0, 0, 0, 0];
  const flush = () => {
    const [hs, es] = [h.slice(gapH, i), e.slice(gapE, j)];
    if (hs.length && es.length && hs.join('').length >= 3 && !hs.every((w) => COMMON.has(w))) {
      out.push([hs.join(' '), es.join(' ')]);
    }
  };
  while (i < h.length || j < e.length) {
    if (i < h.length && j < e.length && h[i] === e[j]) {
      flush();
      [i, j] = [i + 1, j + 1];
      [gapH, gapE] = [i, j];
    } else if (j < e.length && (i >= h.length || lcs[i][j + 1] >= lcs[i + 1][j])) j++;
    else i++;
  }
  flush();
  return out;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Applica le correzioni imparate; se nessuna tocca la frase la restituisce intatta. */
export function applyCorrections(text: string, corrections: Correction[]): string {
  if (!corrections.length) return text;
  const folded = fold(text);
  let out = folded;
  for (const [heard, meant] of corrections) {
    const pattern = heard.split(' ').map(escape).join('[^\\p{L}\\p{N}]+');
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu'), meant);
  }
  return out === folded ? text : out;
}

const VAD_RATIOS = [5, 4, 3, 2.4, 1.8]; // come Settings::vad_ratio in lib.rs

/** Una «Hey Jev» sentita da Whisper vale come alias solo se contiene "Jev" o quasi
 *  ("jeff", "gev"…): rumore e altre voci non diventano alias. */
export const likeJev = (alias: string) => words(alias).some((w) => /^(?:d?j|g)e(?:v+|f+|b)$/.test(w));

/** Profilo voce da salvare nelle impostazioni, più il riepilogo per l'utente. */
export function buildProfile(results: TutorialResult[]) {
  const wake = results.filter((r) => r.wake);
  const wakeHits = wake.filter((r) => r.sample.wake).length;
  // Il rilevatore offline non la prende sempre: si impara come la sente Whisper.
  const wakeAliases =
    wakeHits < wake.length ? [...new Set(wake.map((r) => words(r.sample.text).join(' ')))].filter(likeJev).slice(0, 8) : [];
  const phrases = results.filter((r) => !r.wake);
  const learned = new Map<string, string>();
  for (const r of phrases) {
    for (const [heard, meant] of learn(r.expected, r.sample.text)) learned.set(heard, meant);
  }
  const corrections = [...learned].slice(0, 64) as Correction[];
  // Sensibilità meno alta che lascia la voce almeno 3 volte sopra la soglia.
  const snr = Math.min(...results.map((r) => r.sample.snr));
  const level = VAD_RATIOS.findIndex((ratio) => snr >= ratio * 3);
  const profile: Pick<Settings, 'wakeAliases'> & Partial<Pick<Settings, 'micSensitivity' | 'corrections'>> = {
    wakeAliases,
  };
  // Solo "Hey Jev" (Deepgram): le correzioni imparate per Whisper restano com'erano.
  if (phrases.length) profile.corrections = corrections;
  if (results.length) profile.micSensitivity = level < 0 ? 5 : level + 1; // tutto saltato: resta com'era
  return { profile, wakeHits, wakeTotal: wake.length };
}
