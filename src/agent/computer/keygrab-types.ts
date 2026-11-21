/** What keygrab and the other browser drivers report, as data: where a run stopped, the step only a person can take, and how a run ended.
 * No ClikDeploy or connector meaning lives here; callers map these to their own work. */
export type HumanKind = 'captcha' | 'mfa' | 'sms' | 'payment' | 'identity' | 'app-review' | 'app-registration' | 'vendor-contact' | 'decision' | 'retire' | 'worker-setup';
/** `reasonCode` says what the wall is, set by whoever read the page (keygrab, a driver, an agent). */
export interface HumanStep { kind: HumanKind; url?: string; instructions?: string; reasonCode: string; prefill?: string[] }

/** Where a browser run stopped, as data. */
export interface StopInfo {
  kind: 'captcha' | 'mfa' | 'payment' | 'password' | 'unrecognized-client' | 'choice' | 'unknown';
  /** The recovery agent could not start; retry the work rather than reporting a wall. */ agentUnavailable?: boolean;
  message: string; url: string; pageText: string; controls: string[]; screenshot?: string;
  /** Set when the browser work already knows this is a wall only a person clears (keygrab does). */ human?: HumanStep;
  /** What keygrab did, newest last. */ trail?: string[];
  /** How many browser actions keygrab took (the trail keeps only the last 30). */ actions?: number;
  /** Pages keygrab looked at (addresses, no query). */ visited?: string[];
  /** Menus and searches it read, each as `opener: item | item`. */ menus?: string[];
  /** The hidden tab was left open on the last page: `clikcode computer keygrab-resume <name>` reattaches to it. */ parked?: boolean;
  /** The address keygrab started from. */ vendorUrl?: string;
  /** keygrab signed in to the site during the run. */ signedIn?: boolean;
}
/** How a browser run ended. `capturedOn`: the page a key was captured on (address without query). */
export type DriveOutcome = ({ ok: true; note?: string; actions?: number; /** A recipe was recorded for the next run. */ recipe?: boolean; capturedOn?: string } | { ok: false; stop: StopInfo }) & { agentCalls?: number };

/** Where keygrab sends the key it captures and what it names it. A caller (a script, another product) decides; nothing is assumed. */
export interface KeygrabDelivery {
  /** The name the key is saved under in Secrets Manager (default `<name>/key`). */ secretName?: string;
  /** The name typed into the site's "key name" box (default ClikCode). */ keyName?: string;
  /** Destinations, as capture_secret's send_to takes them. None: the key is only saved. */ sendTo?: Array<{ to: string; with?: Record<string, string>; values?: Record<string, string> }>;
}
