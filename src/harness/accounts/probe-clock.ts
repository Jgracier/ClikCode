/** No wall clock on a vendor call. A probe or helper fails when the vendor
 * exits or errors, never because the machine was slow to start it: a fixed
 * limit turned a slow start into a wrong "nothing found". Handed to
 * `captureNativeHarnessOutput`, whose timer takes a number; this is the
 * longest a timer can be (about 24 days), i.e. never. */
export const NO_WALL_CLOCK_MS = 2 ** 31 - 1;
