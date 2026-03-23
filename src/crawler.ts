import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { NetworkInterceptor, CapturedRequest } from './interceptor';

export interface CrawlOptions {
  baseUrl: string;
  maxPages: number;
  maxDepth: number;
  timeout: number;
  waitForIdle: number;
  headless: boolean;
  fillForms: boolean;
  clickButtons: boolean;
  verbose: boolean;
}

export interface CrawlResult {
  pagesVisited: string[];
  requests: CapturedRequest[];
  errors: string[];
  duration: number;
}

const DEFAULT_OPTIONS: Partial<CrawlOptions> = {
  maxPages: 50,
  maxDepth: 3,
  timeout: 30000,
  waitForIdle: 2000,
  headless: true,
  fillForms: true,
  clickButtons: true,
  verbose: false,
};

// Dummy data for form filling
const FORM_DATA: Record<string, string> = {
  email: 'test@example.com',
  password: 'TestPassword123!',
  name: 'Test User',
  username: 'testuser',
  first_name: 'Test',
  last_name: 'User',
  phone: '+1234567890',
  address: '123 Test Street',
  city: 'Testville',
  zip: '12345',
  country: 'US',
  search: 'test query',
  q: 'search test',
  message: 'This is a test message.',
  title: 'Test Title',
  description: 'Test description for spec-sniffer.',
  url: 'https://example.com',
};

function getFormValue(fieldName: string, fieldType: string): string {
  const lower = fieldName.toLowerCase();

  // Check by input type
  if (fieldType === 'email') return FORM_DATA.email;
  if (fieldType === 'password') return FORM_DATA.password;
  if (fieldType === 'tel') return FORM_DATA.phone;
  if (fieldType === 'url') return FORM_DATA.url;
  if (fieldType === 'number') return '42';

  // Check by name
  for (const [key, value] of Object.entries(FORM_DATA)) {
    if (lower.includes(key)) return value;
  }

  return 'test';
}

function isSameOrigin(url: string, baseUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(baseUrl);
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options } as CrawlOptions;
  const startTime = Date.now();

  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: opts.baseUrl, depth: 0 }];
  const errors: string[] = [];

  const interceptor = new NetworkInterceptor(opts.baseUrl);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({ headless: opts.headless });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'spec-sniffer/1.0',
    });

    const page = await context.newPage();
    page.setDefaultTimeout(opts.timeout);

    await interceptor.attach(page);

    while (queue.length > 0 && visited.size < opts.maxPages) {
      const current = queue.shift()!;
      const normalizedUrl = current.url.split('#')[0].split('?')[0];

      if (visited.has(normalizedUrl)) continue;
      if (!isSameOrigin(current.url, opts.baseUrl)) continue;
      if (current.depth > opts.maxDepth) continue;

      visited.add(normalizedUrl);

      if (opts.verbose) {
        console.log(`  [${visited.size}/${opts.maxPages}] ${current.url} (depth: ${current.depth})`);
      }

      try {
        await page.goto(current.url, { waitUntil: 'networkidle', timeout: opts.timeout });
        await page.waitForTimeout(opts.waitForIdle);

        // Fill forms with dummy data
        if (opts.fillForms) {
          await fillPageForms(page, opts.verbose);
        }

        // Click interactive elements
        if (opts.clickButtons) {
          await clickPageButtons(page, opts.verbose);
          await page.waitForTimeout(opts.waitForIdle);
        }

        // Extract links for further crawling
        const links = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a[href]'))
            .map((a) => (a as HTMLAnchorElement).href)
            .filter((href) => href && !href.startsWith('javascript:') && !href.startsWith('mailto:'));
        });

        for (const link of links) {
          const normalizedLink = link.split('#')[0].split('?')[0];
          if (!visited.has(normalizedLink) && isSameOrigin(link, opts.baseUrl)) {
            queue.push({ url: link, depth: current.depth + 1 });
          }
        }
      } catch (err: any) {
        errors.push(`Error crawling ${current.url}: ${err.message}`);
      }
    }

    return {
      pagesVisited: Array.from(visited),
      requests: interceptor.getRequests(),
      errors,
      duration: Date.now() - startTime,
    };
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

async function fillPageForms(page: Page, verbose: boolean): Promise<void> {
  try {
    const forms = await page.$$('form');

    for (const form of forms) {
      const inputs = await form.$$('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');

      for (const input of inputs) {
        try {
          const tagName = await input.evaluate((el) => el.tagName.toLowerCase());
          const inputType = await input.getAttribute('type') || 'text';
          const inputName = (await input.getAttribute('name')) || (await input.getAttribute('id')) || '';

          if (tagName === 'select') {
            // Select a non-empty option
            const options = await input.$$('option');
            if (options.length > 1) {
              const value = await options[1].getAttribute('value');
              if (value) {
                await input.selectOption(value);
              }
            }
          } else if (inputType === 'checkbox' || inputType === 'radio') {
            await input.check().catch(() => {});
          } else if (tagName === 'textarea' || ['text', 'email', 'password', 'tel', 'url', 'search', 'number'].includes(inputType)) {
            const value = getFormValue(inputName, inputType);
            await input.fill(value);
          }
        } catch {
          // Skip inaccessible inputs
        }
      }

      // Submit the form
      try {
        const submitBtn = await form.$('button[type="submit"], input[type="submit"]');
        if (submitBtn) {
          await submitBtn.click();
          await page.waitForTimeout(1000);
        }
      } catch {
        // Form submission may navigate away, that's fine
      }
    }
  } catch (err: any) {
    if (verbose) console.log(`  Form fill error: ${err.message}`);
  }
}

async function clickPageButtons(page: Page, verbose: boolean): Promise<void> {
  try {
    // Click buttons that might trigger API calls
    const buttons = await page.$$('button:not([type="submit"]), [role="button"], .btn');

    for (const btn of buttons.slice(0, 10)) {
      try {
        const isVisible = await btn.isVisible();
        if (!isVisible) continue;

        const text = await btn.textContent();
        // Skip destructive-sounding buttons
        if (text && /delete|remove|destroy|logout|sign.?out/i.test(text)) continue;

        await btn.click();
        await page.waitForTimeout(500);
      } catch {
        // Button click may fail, that's ok
      }
    }
  } catch (err: any) {
    if (verbose) console.log(`  Button click error: ${err.message}`);
  }
}
