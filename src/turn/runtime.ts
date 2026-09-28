/** Compatibility exports for the turn runtime's focused modules. */
export type { TurnRunOptions } from './turn-options.js';
export { usesFallbackTurn, rememberFallbackTurn, nativeAvailableCommands, sessionNativeCommands, persistentTransports, setVendorBackgroundTurnHandler, vendorBackgroundTurnHandlerFor, persistentTransportFor, closePersistentTransport } from './vendor-process.js';
export { turnEnvironment } from './turn-environment.js';
export { providerHasAccountForTurn, nextUsableFailoverAccount } from './account-routing.js';
export { createHandoffBranch, synchronizeNativeTranscript } from './handoff.js';
export { nameSession, preserveInterruptedTurn, discardInterruptedTurn, DurableTurnCheckpoint, startTurnCheckpoint, completeTurnCheckpoint } from './turn-journal.js';
