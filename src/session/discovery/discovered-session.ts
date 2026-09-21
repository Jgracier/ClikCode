/** One session found in a vendor's own history, whoever found it. */



export interface DiscoveredNativeSession {
  nativeId: string;
  /** What to show in the resume list. May be a real title the harness wrote,
   * or -- failing that -- the opening of the first message, which is a
   * preview and not a name. `titleIsGenerated` says which. */
  title?: string;
  /** True only when `title` is a title the HARNESS generated, rather than the
   * first message truncated. Adoption names a session from this and nothing
   * else: a preview written into `name` looks like a title forever after, and
   * stops nameSession from ever replacing it with a real one. */
  titleIsGenerated?: boolean;
  updatedAt?: string;
  /** Real epoch millis when known (every filesystem-based discoverer has the
   * file's own mtime). Shell-table discoverers only have whatever display
   * text the vendor printed ("yesterday", "11:16 AM", a bare date) — parsed
   * into this when the format is unambiguous, left unset otherwise, so an
   * unsortable value is never guessed into a false position. */
  updatedAtMs?: number;
}
