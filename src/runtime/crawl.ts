import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Browser, type BrowserContext, chromium, errors, type Page, type Request } from 'playwright-core';
import { z } from 'zod';
import { NoriError } from '../errors.js';
import { type Origin, type PageUrl, parsePageUrl, type Session } from '../graph/model.js';
import { type EgressDecision, startEgressProxy } from './egress-proxy.js';
import type {
  CaptureKey,
  CrawledCapture,
  CrawledNavigation,
  CrawlResult,
  NavigationLanding,
  NavigationStart,
  Redirect,
  RunStop,
  RuntimeAction,
} from './crawl-result.js';

export const CRAWLER_VERSION = '1';

const GOTO_TIMEOUT_MS = 30_000;
const SETTLE_CAP_MS = 5_000;
const QUIET_WINDOW_MS = 500;
const POLL_MS = 100;

export type RequestDecision = 'allowed' | 'blocked' | 'internal';

// A connection the egress proxy turned away. Most are Chrome's own background traffic, which no page
// asked for, so they are logged apart from the page requests the policy blocked.
type LoggedDecision = RequestDecision | 'refused';

// The browser's own resources (its PDF viewer, data and blob URLs) never reach the network.
const INTERNAL_SCHEMES = new Set(['chrome:', 'chrome-extension:', 'data:', 'blob:']);

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function schemeOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

// The whole isolation policy: the run's own origin, read-only methods, nothing else.
export function decideRequest(origin: Origin, method: string, url: string): RequestDecision {
  if (INTERNAL_SCHEMES.has(schemeOf(url))) return 'internal';
  const verb = method.toUpperCase();
  if (verb !== 'GET' && verb !== 'HEAD') return 'blocked';
  return originOf(url) === origin ? 'allowed' : 'blocked';
}

export function pageUrlOrNull(origin: Origin, raw: string): PageUrl | null {
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  return url.origin === origin ? parsePageUrl(origin, url.href) : null;
}

export type RawLink = { readonly href: string; readonly name: string | null };

export function followLinks(origin: Origin, links: readonly RawLink[]): RuntimeAction[] {
  const byHref = new Map<PageUrl, string | null>();
  for (const link of links) {
    const href = pageUrlOrNull(origin, link.href);
    if (href === null) continue;
    if (!byHref.has(href) || byHref.get(href) === null) byHref.set(href, link.name);
  }
  return [...byHref].map(([href, name]) => ({ kind: 'follow-link', href, name }));
}

// httpUrls are the main-frame request chain, oldest first. navigatedUrls are the main-frame commits seen
// while the page settled. Repeats of the previous hop are the same document, not a redirect.
export function buildRedirects(args: {
  readonly origin: Origin;
  readonly requested: PageUrl;
  readonly httpUrls: readonly string[];
  readonly navigatedUrls: readonly string[];
  readonly landing: PageUrl;
}): Redirect[] {
  const { origin, requested, landing } = args;
  const redirects: Redirect[] = [];
  let previous = requested;
  const hop = (raw: string, via: Redirect['via']) => {
    const to = pageUrlOrNull(origin, raw);
    if (to === null || to === previous) return;
    redirects.push({ to, via });
    previous = to;
  };
  for (const url of args.httpUrls) hop(url, 'http');
  for (const url of args.navigatedUrls) hop(url, 'client');
  hop(landing, 'client');
  return redirects;
}

type NetworkEntry = { readonly method: string; readonly url: string; readonly decision: LoggedDecision; status?: number };

type ActionEntry = {
  readonly seq: number;
  readonly start: { readonly kind: 'entry' } | { readonly kind: 'action'; readonly from: CaptureKey; readonly href: PageUrl; readonly name: string | null };
  readonly requested: PageUrl;
  readonly chain: readonly PageUrl[];
  readonly landing: { readonly capture: CaptureKey; readonly url: PageUrl | null } | { readonly error: string };
  readonly reused: boolean;
  readonly consoleErrors: readonly string[];
};

const sha16 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// The only place a CrawledCapture is made, and only after its screenshot and DOM are on disk.
export class RunRecorder {
  private readonly network: NetworkEntry[] = [];
  private readonly byRequest = new WeakMap<Request, NetworkEntry>();
  private readonly actions: ActionEntry[] = [];
  private readonly captures: CrawledCapture[] = [];

  constructor(private readonly dir: string) {}

  async open(): Promise<void> {
    await mkdir(join(this.dir, 'captures'), { recursive: true });
  }

  logRequest(request: Request, decision: RequestDecision): void {
    const entry: NetworkEntry = { method: request.method(), url: request.url(), decision };
    this.network.push(entry);
    this.byRequest.set(request, entry);
  }

  logRefusedConnection({ method, target }: EgressDecision): void {
    this.network.push({ method, url: target, decision: 'refused' });
  }

  logStatus(request: Request, status: number): void {
    const entry = this.byRequest.get(request);
    if (entry !== undefined) entry.status = status;
  }

  logAction(entry: ActionEntry): void {
    this.actions.push(entry);
  }

  counts(): { allowed: number; blocked: number } {
    const count = (decision: LoggedDecision) => this.network.filter((entry) => entry.decision === decision).length;
    return { allowed: count('allowed'), blocked: count('blocked') };
  }

  allCaptures(): readonly CrawledCapture[] {
    return this.captures;
  }

  async capture(page: Page, url: PageUrl, httpStatus: number): Promise<CrawledCapture> {
    const name = sha16(url);
    const screenshot = `captures/${name}.png`;
    const dom = `captures/${name}.html`;
    await page.screenshot({ path: join(this.dir, screenshot), fullPage: true, animations: 'disabled' });
    await writeFile(join(this.dir, dom), await page.content());
    for (const file of [screenshot, dom]) {
      if ((await stat(join(this.dir, file))).size === 0) throw new Error(`empty artifact ${file}`);
    }
    const capture: CrawledCapture = { key: this.captures.length, url, httpStatus, screenshot, dom };
    this.captures.push(capture);
    return capture;
  }

  async close(): Promise<void> {
    const lines = (rows: readonly object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join('');
    await writeFile(join(this.dir, 'network.ndjson'), lines(this.network));
    await writeFile(join(this.dir, 'actions.ndjson'), lines(this.actions));
  }
}

async function launchChrome(proxyServer: string): Promise<Browser> {
  try {
    return await chromium.launch({
      channel: 'chrome',
      headless: true,
      proxy: { server: proxyServer },
      args: [
        '--disable-component-update',
        '--disable-sync',
        '--disable-features=OptimizationHints,AutofillServerCommunication',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/distribution 'chrome' is not found|Executable doesn't exist/.test(message)) {
      throw new NoriError('Google Chrome is not installed, and nori verify drives the system Chrome. Install Chrome and retry.');
    }
    throw error;
  }
}

export type IsolatedBrowser = { readonly browser: Browser; readonly close: () => Promise<void> };

// Chrome reaches the network only through a proxy that admits the run's origin, and Playwright
// routes loopback through it too, so a local app gets the same guarantee as a remote one.
export async function launchIsolatedBrowser({ origin, recorder }: { origin: Origin; recorder: RunRecorder }): Promise<IsolatedBrowser> {
  const proxy = await startEgressProxy({
    origin,
    onDecision: (decision) => {
      if (!decision.allowed) recorder.logRefusedConnection(decision);
    },
  });
  try {
    const browser = await launchChrome(proxy.server);
    return {
      browser,
      close: async () => {
        await browser.close();
        await proxy.close();
      },
    };
  } catch (error) {
    await proxy.close();
    throw error;
  }
}

export async function openContext(
  browser: Browser,
  args: { readonly origin: Origin; readonly storageStatePath?: string | undefined; readonly recorder: RunRecorder },
): Promise<BrowserContext> {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    ...(args.storageStatePath === undefined ? {} : { storageState: args.storageStatePath }),
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const decision = decideRequest(args.origin, request.method(), request.url());
    args.recorder.logRequest(request, decision);
    if (decision === 'blocked') return route.abort('blockedbyclient');
    return route.continue();
  });
  context.on('response', (response) => args.recorder.logStatus(response.request(), response.status()));
  return context;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const LINKS_SCRIPT = `Array.from(document.querySelectorAll('a[href]'))
  .filter((a) => typeof a.href === 'string')
  .map((a) => ({
    href: a.href,
    name: (a.getAttribute('aria-label') || a.textContent || a.getAttribute('title') || '').replace(/\\s+/g, ' ').trim() || null,
  }))`;
const linksSchema = z.array(z.object({ href: z.string(), name: z.string().nullable() }));

class PageWatch {
  navigatedUrls: string[] = [];
  documents: { url: string; status: number }[] = [];
  consoleErrors: string[] = [];
  lastNavigationAt = Date.now();

  constructor(page: Page) {
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      this.navigatedUrls.push(frame.url());
      this.lastNavigationAt = Date.now();
    });
    page.on('response', (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        this.documents.push({ url: response.url(), status: response.status() });
      }
    });
    page.on('console', (message) => {
      if (message.type() === 'error') this.consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => this.consoleErrors.push(error.message));
  }

  reset(): void {
    this.navigatedUrls = [];
    this.documents = [];
    this.consoleErrors = [];
    this.lastNavigationAt = Date.now();
  }

  statusFor(origin: Origin, landing: PageUrl): number | null {
    const exact = this.documents.findLast((doc) => pageUrlOrNull(origin, doc.url) === landing);
    return (exact ?? this.documents.at(-1))?.status ?? null;
  }
}

async function settle(page: Page, watch: PageWatch): Promise<void> {
  const deadline = Date.now() + SETTLE_CAP_MS;
  try {
    await page.waitForLoadState('networkidle', { timeout: SETTLE_CAP_MS });
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
  }
  while (Date.now() < deadline && Date.now() - watch.lastNavigationAt < QUIET_WINDOW_MS) await sleep(POLL_MS);
}

function requestChain(request: Request | null): string[] {
  const urls: string[] = [];
  for (let current = request; current !== null; current = current.redirectedFrom()) urls.unshift(current.url());
  return urls;
}

export type Budgets = { readonly maxCaptures: number; readonly maxNavigations: number; readonly maxMillis: number };

export type CrawlOptions = {
  readonly origin: Origin;
  readonly session: Session;
  readonly storageStatePath?: string | undefined;
  readonly seeds: readonly PageUrl[];
  readonly budgets: Budgets;
  readonly dir: string;
};

type Loaded = {
  readonly redirects: readonly Redirect[];
  readonly landing: NavigationLanding;
  readonly landingUrl: PageUrl | null;
  readonly links: readonly RuntimeAction[];
  readonly consoleErrors: readonly string[];
};

type Pending = { readonly start: NavigationStart; readonly requested: PageUrl };

export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const { origin, budgets } = options;
  const startedAt = new Date();
  const recorder = new RunRecorder(options.dir);
  await recorder.open();
  const { browser, close } = await launchIsolatedBrowser({ origin, recorder });
  try {
    const context = await openContext(browser, { origin, storageStatePath: options.storageStatePath, recorder });
    const page = await context.newPage();
    const watch = new PageWatch(page);
    const capturedByUrl = new Map<PageUrl, CaptureKey>();
    const memo = new Map<PageUrl, Loaded>();
    const navigations: CrawledNavigation[] = [];

    const aborted = (error: unknown): Loaded => ({
      redirects: [],
      landing: { kind: 'aborted', error: error instanceof Error ? error.message.split('\n')[0] ?? 'unknown error' : String(error) },
      landingUrl: null,
      links: [],
      consoleErrors: [...watch.consoleErrors],
    });

    const load = async (requested: PageUrl): Promise<Loaded> => {
      watch.reset();
      try {
        const response = await page.goto(requested, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS });
        await settle(page, watch);
        const landingUrl = pageUrlOrNull(origin, page.url());
        if (landingUrl === null) return aborted(new Error(`left the origin: ${page.url()}`));
        const status = watch.statusFor(origin, landingUrl) ?? response?.status();
        if (status === undefined) return aborted(new Error('no document response'));
        const redirects = buildRedirects({
          origin,
          requested,
          httpUrls: requestChain(response?.request() ?? null),
          navigatedUrls: watch.navigatedUrls,
          landing: landingUrl,
        });
        const known = capturedByUrl.get(landingUrl);
        if (known !== undefined) {
          return { redirects, landing: { kind: 'captured', capture: known }, landingUrl, links: [], consoleErrors: [...watch.consoleErrors] };
        }
        const capture = await recorder.capture(page, landingUrl, status);
        capturedByUrl.set(landingUrl, capture.key);
        const links = followLinks(origin, linksSchema.parse(await page.evaluate(LINKS_SCRIPT)));
        return { redirects, landing: { kind: 'captured', capture: capture.key }, landingUrl, links, consoleErrors: [...watch.consoleErrors] };
      } catch (error) {
        return aborted(error);
      }
    };

    const queue: Pending[] = [...new Set(options.seeds)].map((requested) => ({ start: { kind: 'entry' }, requested }));
    let stop: RunStop = 'frontier-exhausted';
    for (let head = 0; head < queue.length; head++) {
      const exhausted =
        recorder.allCaptures().length >= budgets.maxCaptures ||
        navigations.length >= budgets.maxNavigations ||
        Date.now() - startedAt.getTime() >= budgets.maxMillis;
      if (exhausted) {
        stop = 'budget';
        break;
      }
      const pending = queue[head];
      if (pending === undefined) break;
      const remembered = memo.get(pending.requested);
      const loaded = remembered ?? (await load(pending.requested));
      if (remembered === undefined) memo.set(pending.requested, loaded);

      navigations.push({
        seq: navigations.length,
        start: pending.start,
        requested: pending.requested,
        redirects: loaded.redirects,
        landing: loaded.landing,
      });
      recorder.logAction({
        seq: navigations.length - 1,
        start:
          pending.start.kind === 'entry'
            ? { kind: 'entry' }
            : { kind: 'action', from: pending.start.from, href: pending.start.action.href, name: pending.start.action.name },
        requested: pending.requested,
        chain: [pending.requested, ...loaded.redirects.map((redirect) => redirect.to)],
        landing: loaded.landing.kind === 'aborted' ? { error: loaded.landing.error } : { capture: loaded.landing.capture, url: loaded.landingUrl },
        reused: remembered !== undefined,
        consoleErrors: remembered === undefined ? loaded.consoleErrors : [],
      });

      if (remembered === undefined && loaded.landing.kind === 'captured') {
        for (const action of loaded.links) {
          queue.push({ start: { kind: 'action', from: loaded.landing.capture, action }, requested: action.href });
        }
      }
    }

    return {
      origin,
      session: options.session,
      startedAt,
      finishedAt: new Date(),
      stop,
      crawlerVersion: CRAWLER_VERSION,
      requests: recorder.counts(),
      captures: recorder.allCaptures(),
      navigations,
    };
  } finally {
    await close();
    await recorder.close();
  }
}
