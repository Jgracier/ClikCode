/** The wording `clikcode connectors qualify` reads on a RENDERED sign-up, pricing or developer page. The first five lists are a copy of the lists the
 * server's discover uses (packages/platform-domains/src/domains/connectors/connector-pipeline-front-config.ts, `discover` and `triage`); a test compares them
 * with that file when the ClikDeploy checkout is on this computer. The rest are the kinds the server does not name yet. All matching is plain lower-case
 * substrings, except the patterns below, which are bounded. */
export const SERVER_PHRASES = {
  captcha: ['recaptcha', 'hcaptcha', 'turnstile', 'captcha', 'prove you are human'],
  phone: ['verify your phone', 'sms code', 'phone number verification', 'text message code', 'phone number is required', 'mobile number is required'],
  card: ['credit card required', 'card required', 'add a payment method', 'enter your card', 'payment method required', 'billing information required'],
  sales: ['contact sales', 'talk to sales', 'request a demo', 'book a demo', 'contact us for access', 'request access', 'schedule a demo'],
  appReview: ['app review', 'partner approval', 'apply for access', 'approval required', 'business verification', 'waitlist', 'wait list', 'partner program', 'become a partner', 'apply to become'],
} as const;

/** Wording the server's lists do not cover, seen on real sign-up pages. */
export const EXTRA_PHRASES = {
  captcha: ["i'm not a robot", 'i am not a robot', 'verify you are human', 'confirm you are human', 'select all images'],
  phone: ['enter your phone number', 'we will text you', "we'll text you", 'send me a code by sms', 'verification code by sms', 'confirm your mobile number'],
  card: ['a card is required', 'card is required', 'credit card is required', 'requires a credit card', 'card details required', 'payment details required', 'enter your credit card', 'card required to start', 'add a credit card', 'credit card to start'],
  workEmail: ['use your work email', 'use a work email', 'use your business email', 'use a business email', 'use your company email', 'must be a work email', 'work email required', 'work email is required', 'business email required', 'valid business email', 'enter a business email', 'enter your work email address to', 'company email address is required', 'corporate email address', 'no personal email', 'work emails only', 'business emails only'],
  workEmailLabel: ['work email', 'business email', 'company email'],
  freeMail: ['personal email addresses are not', 'free email', 'personal email is not', 'gmail', 'yahoo and hotmail', 'public email domains', 'personal email addresses'],
  slack: ['sign in with slack', 'continue with slack', 'add to slack', 'slack workspace', 'log in with slack', 'install the slack app', 'get started in slack'],
  noApi: ['does not offer an api', 'do not offer an api', "don't offer an api", 'no public api', 'does not have a public api', 'we do not have an api', 'api is not available', 'api is not publicly', 'no api available', 'does not have an api', 'no api access'],
  approval: ['requires approval', 'require approval', 'must be approved', 'manual approval', 'request api access', 'api access request', 'apply for api access', 'api access is by invitation', 'api access by approval', 'api access is granted', 'subject to approval', 'invite only', 'invitation only'],
} as const;

/** "no credit card required" is not a wall: a hit is ignored when one of these stands just before or after it. */
export const NEGATION_BEFORE = /(?:\bno|\bnot|\bwithout|\bnever|\bzero|\bdon'?t need|\bdoesn'?t need|\bno need for(?: a)?|\bfree[,;]?(?: and)? no)\s+(?:\w+\s+){0,3}$/;
export const NEGATION_AFTER = /^\s*(?:is |are )?(?:not |never |no longer )(?:required|needed|necessary)|^\s*(?:is |are )?(?:optional|unnecessary)|^\s*\bnot (?:required|needed)/;

/** An API named near a plan name: the API is gated by a paid plan. */
export const PLAN_NAMES = '(?:paid|premium|pro|professional|business|enterprise|advanced|growth|scale|team|teams|plus|elite|ultimate|unlimited|standard|starter|essential|essentials|agency|corporate|higher|upper|top)';
export const GATED_BY_PLAN = new RegExp(
  [
    `\\bapi\\b[^.\\n]{0,80}\\b(?:available|included|offered|accessible|only|restricted|limited|requires?|reserved|unlock(?:ed)?|enabled)\\b[^.\\n]{0,60}\\b${PLAN_NAMES}\\b[^.\\n]{0,24}\\b(?:plans?|tiers?|subscriptions?|accounts?|customers?|users?|packages?|editions?)\\b`,
    `\\b${PLAN_NAMES}\\b[^.\\n]{0,24}\\b(?:plans?|tiers?|subscriptions?|accounts?|customers?|users?|packages?|editions?)\\b[^.\\n]{0,60}\\b(?:only|required|needed|include[sd]?|with|get|unlock)\\b[^.\\n]{0,40}\\bapi\\b`,
    `\\bupgrade\\b[^.\\n]{0,60}\\b(?:to|for)\\b[^.\\n]{0,30}\\bapi\\b`,
    `\\bapi\\b[^.\\n]{0,40}\\bupgrade\\b`,
    `\\bapi access\\b[^.\\n]{0,40}\\bnot (?:available|included)\\b`,
  ].join('|'));
export const ENTERPRISE_API = /\bapi\b[^.\n]{0,100}(?:\benterprise\b|엔터프라이즈)|(?:\benterprise\b|엔터프라이즈)[^.\n]{0,100}\bapi\b/;
/** An integration or the API said to need an upgrade ("to integrate your funnels with your stack of tools, upgrade to a paid plan"). */
export const INTEGRATE_UPGRADE = /\b(?:integrat\w*|connect\w*|webhooks?)\b[^.\n]{0,90}\b(?:upgrade|paid plan|paid account|subscribe)\b|\b(?:upgrade|paid plan|paid account)\b[^.\n]{0,60}\b(?:integrat\w*|webhooks?)\b/;
/** Slack as the way in: the product is installed into a Slack workspace, so a key needs one. */
export const SLACK_ONBOARDING = /\b(?:connect your slack workspace|install\w*\s+(?:\w+\s+){0,4}(?:in|to|into|on)\s+(?:your\s+)?slack|requires? (?:a )?slack|slack (?:workspace )?(?:is )?required|must have (?:a )?slack)\b/;
/** A pricing page's plan headings, to see under which plan a feature line stands. */
export const PLAN_HEADING = /^(free|basic|starter|plus|pro|professional|premium|business|team|teams|growth|scale|standard|enterprise|advanced|essential|essentials|unlimited|agency|personal|prime|custom)(?: plan)?$/i;
