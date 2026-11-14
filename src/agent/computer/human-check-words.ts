/** The words a page uses when a human check stands in the way, for the places that only have the page's text to go
 * by (a replay guard, the consent driver, a frame the detector cannot see into). `detectHumanCheck` (human-check.ts)
 * is the first answer wherever there is a page to look at; these words are the second. Strong evidence only: a
 * footer saying "protected by reCAPTCHA" is an invisible score badge, not a challenge. */
export const CAPTCHA_WORDS = /(?:let's|let us) confirm you are (?:a )?human|complete the security check before continuing|verify (?:that )?you(?:'re| are| a?re) (?:a )?human|i'?m not a robot|are you a robot|complete the (?:captcha|security check)|solve (?:the|this) captcha|select all (?:images|squares)|press (?:and|&) hold|performing security verification|verifies? (?:that )?you are not a bot|checking if the site connection is secure|checking (?:if|that) you are human|checking your browser|cloudflare turnstile|just a moment\.\.\./i;

/** A box that asks to retype distorted characters or answer a human check, by its label. */
export const CAPTCHA_FIELD_WORDS = /type the (?:characters|letters|text|code|word)s? (?:you see|shown|in the image|below)|enter the (?:characters|letters|text|code) (?:you see|shown|in the image|below)|captcha|security (?:code|check|question)|are you (?:a )?human|not a robot/i;
