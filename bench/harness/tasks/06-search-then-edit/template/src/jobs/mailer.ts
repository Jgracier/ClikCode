export interface MailerConfig {
  host: string;
  from: string;
  dryRun: boolean;
}

export function mailerConfig(): MailerConfig {
  return {
    host: process.env.SMTP_HOST || 'localhost',
    from: process.env.MAIL_FROM || 'noreply@example.com',
    dryRun: process.env.MAIL_DRY_RUN === '1',
  };
}
