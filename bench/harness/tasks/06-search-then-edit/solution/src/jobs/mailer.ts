import { readEnv } from '../config/env.ts';

export interface MailerConfig {
  host: string;
  from: string;
  dryRun: boolean;
}

export function mailerConfig(): MailerConfig {
  return {
    host: readEnv('SMTP_HOST', 'localhost'),
    from: readEnv('MAIL_FROM', 'noreply@example.com'),
    dryRun: readEnv('MAIL_DRY_RUN') === '1',
  };
}
