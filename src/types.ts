/**
 * Stati della macchina a stati dell'applicazione.
 *
 * - idle:       notch nascosto, solo wake word in ascolto passivo.
 * - listening:  wake word rilevata, microfono attivo, onda sonora animata.
 * - processing: comando in elaborazione (STT + parsing + automazione).
 * - done:       risultato mostrato all'utente.
 * - closing:    animazione di chiusura (il notch si riassorbe verso l'alto).
 */
export type AppState = 'setup' | 'idle' | 'listening' | 'processing' | 'done' | 'closing';
