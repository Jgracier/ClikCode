export interface ConnectStart { url: string; stop: () => void }

/** The platform an OAuth connection is made for: what starts it, what confirms it, the names its consent screen shows, and
 * which callback addresses are its own. */
export interface ConsentPlatform {
  /** The client's names as a vendor's consent page shows them ("Authorize ClikDeploy"). */
  appNames: readonly string[];
  /** Whether a redirect_uri or a landing page is the platform's own callback. */
  ownsCallback: (url: URL) => boolean;
  /** values: per-account parts of the vendor's sign-in address ({shop} in {shop}.myshopify.com), by name. */
  start: (connector: string, signal?: AbortSignal, values?: Record<string, string>) => Promise<ConnectStart>;
  status: (connector: string, signal?: AbortSignal) => Promise<{ connected: boolean; reason?: string }>;
}

