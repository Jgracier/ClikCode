/** How long a Stop is given to end a turn before it is asked again, and how many
 * times. A Stop that reached a worker before it had started the turn found
 * nothing to cancel; every client that sends one repeats it on this clock
 * until the turn ends. */
export const STOP_RESEND_MS = 4_000;
export const STOP_RESENDS = 6;
