/** The real ports of `connectors qualify`: ClikDeploy's discover for the addresses, the ClikCode browser for rendering (one named tab per vendor, 20 s a page). */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { DeployClient } from './connector-runner.js';
import type { PageRole, QualifyPorts, RenderedPage } from './connector-qualify.js';

export const PAGE_BUDGET_MS = 20_000;
export const qualifyTab = (id: string): string => `qualify-${id.replace(/[^a-z0-9-]/g, '-')}`;

/** The addresses in a connector_discover answer. */
export function addressesFrom(data: unknown): { homepage?: string; signupUrl?: string; pricingUrl?: string } {
  const d = (data ?? {}) as { signup?: { url?: string }; evidence?: Array<{ purpose?: string; url?: string }> };
  const byPurpose = (p: string): string | undefined => d.evidence?.find(e => e.purpose === p && typeof e.url === 'string')?.url;
  const homepage = byPurpose('signup page');
  const signupUrl = d.signup?.url ?? byPurpose('signup link');
  const pricingUrl = byPurpose('pricing link');
  return { ...(homepage ? { homepage } : {}), ...(signupUrl ? { signupUrl } : {}), ...(pricingUrl ? { pricingUrl } : {}) };
}

/** Runs in the page (plain JavaScript, the project has no DOM types): the visible text and the signals the classifier needs. */
export const READ_PAGE = `(() => {
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const inputs = Array.from(document.querySelectorAll('input')).filter(i => !['hidden', 'submit', 'button', 'checkbox', 'radio', 'search'].includes(i.type) && visible(i));
  const hasEmailField = inputs.some(i => i.type === 'email' || /e-?mail/i.test([i.name, i.placeholder, i.id, i.getAttribute('aria-label') || '', i.autocomplete].join(' ')));
  const hasForm = inputs.some(i => ['email', 'password', 'tel'].includes(i.type) || /e-?mail|phone/i.test(i.name + ' ' + i.placeholder));
  const captchaWidget = Array.from(document.querySelectorAll('.h-captcha, .cf-turnstile, .g-recaptcha, iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]'))
    .some(el => { if (el.closest('.grecaptcha-badge') || el.getAttribute('data-size') === 'invisible') return false; const r = el.getBoundingClientRect(); return visible(el) && r.width >= 150 && r.height >= 50; });
  const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 400).map(a => ({ href: a.href, text: (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) })).filter(l => l.text);
  return { text: ((document.body && document.body.innerText) || '').slice(0, 150000), hasForm, hasEmailField, captchaWidget, links };
})()`;

export function qualifyPorts(stateDir: string, client: DeployClient, options: { budgetMs?: number; dumpDir?: string } = {}): QualifyPorts {
  const budgetMs = options.budgetMs ?? PAGE_BUDGET_MS;
  return {
    async discover(id) { return addressesFrom(await client.tool('connector_discover', { id })); },
    async render(id, role: PageRole, url): Promise<RenderedPage> {
      const { openComputerPage } = await import('./browser.js');
      const dead = (error: string): RenderedPage => ({ role, url, text: '', hasForm: false, hasEmailField: false, captchaWidget: false, error });
      let timer: NodeJS.Timeout | undefined;
      const work = (async (): Promise<RenderedPage> => {
        const page = await openComputerPage(stateDir, qualifyTab(id));
        let status: number | undefined;
        try {
          const response = await page.goto(url, { timeout: budgetMs, waitUntil: 'domcontentloaded' });
          status = response?.status();
        } catch (error) { return dead(String(error instanceof Error ? error.message : error).split('\n')[0]!.slice(0, 160)); }
        await page.waitForLoadState('networkidle', { timeout: Math.min(6_000, budgetMs) }).catch(quiet('agent/computer/connector-qualify-live'));
        await page.waitForTimeout(800).catch(quiet('agent/computer/connector-qualify-live'));
        const read = await page.evaluate(READ_PAGE) as Pick<RenderedPage, 'text' | 'hasForm' | 'hasEmailField' | 'captchaWidget' | 'links'>;
        return { role, url: page.url() || url, ...(status !== undefined ? { status } : {}), ...read };
      })();
      const late = new Promise<RenderedPage>(resolve => { timer = setTimeout(() => resolve(dead(`page budget of ${Math.round(budgetMs / 1000)}s used`)), budgetMs + 4_000); });
      const dump = async (page: RenderedPage): Promise<RenderedPage> => {
        if (options.dumpDir) { const { mkdir, writeFile } = await import('node:fs/promises'); await mkdir(options.dumpDir, { recursive: true }); await writeFile(`${options.dumpDir}/${id}.${role}.txt`, `${page.url}\nstatus ${page.status} form ${page.hasForm} email ${page.hasEmailField} captcha ${page.captchaWidget}\n\n${page.text}`).catch(quiet('agent/computer/connector-qualify-live')); }
        return page;
      };
      try { return await dump(await Promise.race([work, late])); } catch (error) { return dead(String(error instanceof Error ? error.message : error).split('\n')[0]!.slice(0, 160)); } finally { clearTimeout(timer); work.catch(quiet('agent/computer/connector-qualify-live')); }
    },
    async close(id) { await (await import("./browser.js")).closeComputerPage(stateDir, qualifyTab(id)).catch(quiet("agent/computer/connector-qualify-live")); },
  };
}
