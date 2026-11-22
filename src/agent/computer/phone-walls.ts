/** What a page says when it refuses the sign-up phone. One definition for the form filler (tools/computer-web.ts phoneForPage, which
 * picks the number to type) and the key-grab runner (keygrab.ts, which decides to type it again): two copies drifted apart. */

/** Words a page uses to refuse a VoIP or virtual number (a Twilio number) for phone verification. Only a refusal counts: a page that
 * merely mentions landlines ("mobile or landline accepted", "we will call your landline") is not one. */
export const VOIP_REFUSED = /\b(?:voip|virtual (?:phone )?numbers?|internet (?:phone|calling) numbers?|non-?mobile (?:phone )?numbers?|landlines? (?:(?:phone )?numbers? )?(?:are |is )?(?:not (?:supported|allowed|accepted|eligible)|(?:can ?not|cannot|can't) (?:be used|receive))|(?:no|not a) landlines?|(?:can ?not|cannot|can't|unable to) (?:send|text)(?: (?:a |the )?(?:code|sms|text|message))?(?: messages?)? to (?:a |this )?landline|this (?:phone )?number (?:type )?(?:is )?not (?:supported|allowed|accepted|eligible)|(?:can ?not|can't|cannot) (?:be )?(?:use|accept)(?:d)? (?:this|that) (?:phone )?number|(?:please )?(?:use|enter|provide) a (?:real|valid|personal) mobile(?: phone)?(?: number)?|real mobile|only mobile (?:phone )?numbers)\b/i;

/** The countries a page asks for by name, as the two-letter codes a profile's phone_<cc> fields use (phone_ca, phone_gb / phone_uk). */
const COUNTRY_NAMES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\b(?:uk|u\.k\.|united kingdom|british|great britain)\b/i, ['gb', 'uk']],
  [/\b(?:canadian|canada)\b/i, ['ca']],
  [/\b(?:australian|australia)\b/i, ['au']],
  [/\b(?:indian|india)\b/i, ['in']],
  [/\b(?:german|germany)\b/i, ['de']],
  [/\b(?:french|france)\b/i, ['fr']],
  [/\b(?:irish|ireland)\b/i, ['ie']],
  [/\b(?:dutch|netherlands)\b/i, ['nl']],
  [/\b(?:spanish|spain)\b/i, ['es']],
  [/\b(?:eu|european)\b/i, ['de', 'fr', 'ie', 'nl', 'es', 'it', 'be', 'at', 'pt', 'se', 'fi', 'dk', 'pl', 'gr', 'lu']],
];

/** The country codes the page asks for ("Only UK mobile numbers are accepted": gb/uk), or undefined when it names none and only
 * refuses this country's ("US numbers are not supported"). */
export function askedCountries(text: string): string[] | undefined {
  const asked = COUNTRY_NAMES.filter(([words]) => words.test(text)).flatMap(([, codes]) => codes);
  return asked.length ? asked : undefined;
}
