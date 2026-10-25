import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Browser, type BrowserContext, chromium, errors, type Page, type Request } from 'playwright-core';
import { z } from 'zod';
import { NoriError } from '../errors.js';
import { type Origin, type PageUrl, parsePageUrl, type Session } from '../graph/model.js';
import { type EgressDecision, startEgressProxy } from './egress-proxy.js';
import type {
  AllowedRequest,
  CaptureKey,
  CrawledCapture,
  CrawledNavigation,
  CrawlResult,
  Interaction,
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
const LOCATOR_TIMEOUT_MS = 3_000;

export type RequestDecision = 'allowed' | 'allowlisted' | 'blocked' | 'internal';

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

function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

// The whole isolation policy: the run's own origin and read-only methods, plus the exact write
// requests an interaction names up front.
export function decideRequest(origin: Origin, method: string, url: string, allow: readonly AllowedRequest[] = []): RequestDecision {
  if (INTERNAL_SCHEMES.has(schemeOf(url))) return 'internal';
  if (originOf(url) !== origin) return 'blocked';
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return 'allowed';
  const path = pathnameOf(url);
  return allow.some((rule) => rule.method === verb && rule.path === path) ? 'allowlisted' : 'blocked';
}

const REDACTED = '[redacted]';
const LONG_SECRET = 8;

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

// Short values only count when they are a whole parameter or path segment, so a value like "a" does not
// flag every URL; a long value is distinctive enough to count anywhere in the URL.
export function carriesValue(url: string, values: readonly string[]): boolean {
  if (values.length === 0) return false;
  const whole = new Set<string>();
  try {
    const parsed = new URL(url);
    for (const [, value] of parsed.searchParams) whole.add(value);
    for (const segment of parsed.pathname.split('/')) whole.add(decoded(segment));
    whole.add(decoded(parsed.hash.slice(1)));
  } catch {
    return false;
  }
  return values.some(
    (value) => whole.has(value) || (value.length >= LONG_SECRET && (url.includes(value) || url.includes(encodeURIComponent(value)))),
  );
}

export function redactValues(url: string, values: readonly string[]): string {
  let out: string;
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    for (const [name, value] of [...parsed.searchParams]) if (values.includes(value)) parsed.searchParams.set(name, REDACTED);
    parsed.pathname = parsed.pathname
      .split('/')
      .map((segment) => (values.includes(decoded(segment)) ? REDACTED : segment))
      .join('/');
    out = parsed.href;
  } catch {
    out = '[unparseable url]';
  }
  for (const value of values) {
    if (value.length < LONG_SECRET) continue;
    out = out.split(value).join(REDACTED).split(encodeURIComponent(value)).join(REDACTED);
  }
  return out;
}

function htmlEscaped(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every spelling a value can take on its way into a url, a form body or markup. A short value only
// matches as a whole token, so it cannot chew up the words around it.
export function redactText(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    const forms = new Set([
      value,
      encodeURIComponent(value),
      new URLSearchParams({ v: value }).toString().slice(2),
      htmlEscaped(value),
      htmlEscaped(encodeURIComponent(value)),
    ]);
    for (const form of [...forms].sort((a, b) => b.length - a.length)) {
      const pattern = value.length >= LONG_SECRET ? escapeRegExp(form) : `(?<![\\w%])${escapeRegExp(form)}(?![\\w%])`;
      out = out.replace(new RegExp(pattern, 'g'), REDACTED);
    }
  }
  return out;
}

function redactDeep<T>(value: T, values: readonly string[]): T {
  if (typeof value === 'string') return redactText(value, values) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, values)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, values)])) as T;
  }
  return value;
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

type FollowLink = Extract<RuntimeAction, { readonly kind: 'follow-link' }>;

export function followLinks(origin: Origin, links: readonly RawLink[]): FollowLink[] {
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
  readonly start: { readonly kind: 'entry' } | { readonly kind: 'action'; readonly from: CaptureKey; readonly action: RuntimeAction };
  readonly requested: PageUrl;
  readonly chain: readonly PageUrl[];
  readonly landing: { readonly capture: CaptureKey; readonly url: PageUrl | null } | { readonly error: string };
  readonly reused: boolean;
  readonly consoleErrors: readonly string[];
};

// An interaction that never became a navigation: why it was passed over, failed, or went nowhere.
type InteractionEntry = {
  readonly interaction: { readonly page: PageUrl; readonly click: string; readonly fields: readonly string[] };
  readonly outcome: 'skipped' | 'failed' | 'stayed';
  readonly reason: string;
};

const sha16 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// The only place a CrawledCapture is made, and only after its screenshot and DOM are on disk.
export class RunRecorder {
  private readonly network: NetworkEntry[] = [];
  private readonly byRequest = new WeakMap<Request, NetworkEntry>();
  private readonly actions: (ActionEntry | InteractionEntry)[] = [];
  private readonly captures: CrawledCapture[] = [];
  private readonly secrets = new Set<string>();

  constructor(private readonly dir: string) {}

  registerSecrets(values: readonly string[]): void {
    for (const value of values) if (value !== '') this.secrets.add(value);
  }

  async open(): Promise<void> {
    await mkdir(join(this.dir, 'captures'), { recursive: true });
  }

  logRequest(request: Request, decision: RequestDecision): void {
    const entry: NetworkEntry = { method: request.method(), url: request.url(), decision };
    this.network.push(entry);
    this.byRequest.set(request, entry);
  }

  logLeakedRequest(request: Request, redactedUrl: string): void {
    this.network.push({ method: request.method(), url: redactedUrl, decision: 'blocked' });
  }

  logRefusedConnection({ method, target }: EgressDecision): void {
    this.network.push({ method, url: target, decision: 'refused' });
  }

  logStatus(request: Request, status: number): void {
    const entry = this.byRequest.get(request);
    if (entry !== undefined) entry.status = status;
  }

  logAction(entry: ActionEntry | InteractionEntry): void {
    this.actions.push(entry);
  }

  counts(): { allowed: number; blocked: number } {
    const count = (decision: LoggedDecision) => this.network.filter((entry) => entry.decision === decision).length;
    return { allowed: count('allowed') + count('allowlisted'), blocked: count('blocked') };
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
    const secrets = [...this.secrets];
    const lines = (rows: readonly object[]) => rows.map((row) => `${JSON.stringify(redactDeep(row, secrets))}\n`).join('');
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
  args: {
    readonly origin: Origin;
    readonly storageStatePath?: string | undefined;
    readonly recorder: RunRecorder;
    readonly allow?: readonly AllowedRequest[];
    readonly secrets?: readonly string[];
    readonly onLeak?: () => void;
  },
): Promise<BrowserContext> {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    ...(args.storageStatePath === undefined ? {} : { storageState: args.storageStatePath }),
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const secrets = args.secrets ?? [];
    if (carriesValue(request.url(), secrets)) {
      args.recorder.logLeakedRequest(request, redactValues(request.url(), secrets));
      args.onLeak?.();
      return route.abort('blockedbyclient');
    }
    const decision = decideRequest(args.origin, request.method(), request.url(), args.allow);
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

class LeakedValue extends Error {}

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
  readonly interactions?: readonly Interaction[];
  readonly budgets: Budgets;
  readonly dir: string;
  // Links whose (source, target) key pair was already queued wait until every new pair has been walked.
  readonly screenKey?: (url: PageUrl) => string;
};

type Loaded = {
  readonly redirects: readonly Redirect[];
  readonly landing: NavigationLanding;
  readonly landingUrl: PageUrl | null;
  readonly links: readonly FollowLink[];
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

    const screenKey = options.screenKey ?? ((url: PageUrl) => url);
    const queue: Pending[] = [...new Set(options.seeds)].map((requested) => ({ start: { kind: 'entry' }, requested }));
    const deferred: Pending[] = [];
    const queuedPairs = new Set<string>();
    let stop: RunStop = 'frontier-exhausted';
    const exhausted = () =>
      recorder.allCaptures().length >= budgets.maxCaptures ||
      navigations.length >= budgets.maxNavigations ||
      Date.now() - startedAt.getTime() >= budgets.maxMillis;
    for (let head = 0, deferredHead = 0; ; ) {
      const pending = head < queue.length ? queue[head++] : deferred[deferredHead++];
      if (pending === undefined) break;
      if (exhausted()) {
        stop = 'budget';
        break;
      }
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
        start: pending.start,
        requested: pending.requested,
        chain: [pending.requested, ...loaded.redirects.map((redirect) => redirect.to)],
        landing: loaded.landing.kind === 'aborted' ? { error: loaded.landing.error } : { capture: loaded.landing.capture, url: loaded.landingUrl },
        reused: remembered !== undefined,
        consoleErrors: remembered === undefined ? loaded.consoleErrors : [],
      });

      if (remembered === undefined && loaded.landing.kind === 'captured' && loaded.landingUrl !== null) {
        const from = screenKey(loaded.landingUrl);
        for (const action of loaded.links) {
          const pair = `${from} ${screenKey(action.href)}`;
          (queuedPairs.has(pair) ? deferred : queue).push({ start: { kind: 'action', from: loaded.landing.capture, action }, requested: action.href });
          queuedPairs.add(pair);
        }
      }
    }

    // A page captured here has never seen a filled value: the context has no secrets and only the crawl's session.
    const captureInCleanContext = async (url: PageUrl): Promise<CaptureKey | null> => {
      const cleanContext = await openContext(browser, { origin, storageStatePath: options.storageStatePath, recorder });
      try {
        const cleanPage = await cleanContext.newPage();
        const cleanWatch = new PageWatch(cleanPage);
        const response = await cleanPage.goto(url, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS });
        await settle(cleanPage, cleanWatch);
        if (pageUrlOrNull(origin, cleanPage.url()) !== url) return null;
        const status = cleanWatch.statusFor(origin, url) ?? response?.status();
        if (status === undefined) return null;
        return (await recorder.capture(cleanPage, url, status)).key;
      } catch {
        return null;
      } finally {
        await cleanContext.close();
      }
    };

    // Each interaction gets its own context: a login or sign-out must not change the session the next
    // one starts from, nor the crawl above.
    for (const interaction of stop === 'budget' ? [] : (options.interactions ?? [])) {
      if (exhausted()) {
        stop = 'budget';
        break;
      }
      const fields = interaction.fill.map(({ label }) => label);
      const summary = { page: interaction.page, click: interaction.click, fields };
      const startKey = capturedByUrl.get(interaction.page);
      if (startKey === undefined) {
        recorder.logAction({ interaction: summary, outcome: 'skipped', reason: 'the crawl did not capture this page' });
        continue;
      }
      const secrets = interaction.fill.map(({ value }) => value).filter((value) => value !== '');
      recorder.registerSecrets(secrets);
      let leaked = false;
      const interactionContext = await openContext(browser, {
        origin,
        storageStatePath: options.storageStatePath,
        recorder,
        allow: interaction.allow,
        secrets,
        onLeak: () => {
          leaked = true;
        },
      });
      try {
        const interactionPage = await interactionContext.newPage();
        const interactionWatch = new PageWatch(interactionPage);
        await interactionPage.goto(interaction.page, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS });
        await settle(interactionPage, interactionWatch);
        const startUrl = pageUrlOrNull(origin, interactionPage.url());
        if (startUrl !== interaction.page) {
          recorder.logAction({ interaction: summary, outcome: 'skipped', reason: `landed on ${interactionPage.url()}` });
          continue;
        }
        for (const { label, value } of interaction.fill) {
          await interactionPage.getByLabel(label, { exact: true }).fill(value, { timeout: LOCATOR_TIMEOUT_MS });
        }
        interactionWatch.reset();
        await interactionPage.getByRole('button', { name: interaction.click, exact: true }).click({ timeout: LOCATOR_TIMEOUT_MS });
        await settle(interactionPage, interactionWatch);

        const urlsSeen = [interactionPage.url(), ...interactionWatch.navigatedUrls];
        if (leaked || urlsSeen.some((url) => carriesValue(url, secrets))) throw new LeakedValue();

        const landingUrl = pageUrlOrNull(origin, interactionPage.url());
        if (landingUrl === null) throw new Error(`left the origin: ${interactionPage.url()}`);
        if (landingUrl === startUrl) {
          recorder.logAction({ interaction: summary, outcome: 'stayed', reason: 'the url did not change' });
          continue;
        }
        const firstUrl = interactionWatch.navigatedUrls.map((url) => pageUrlOrNull(origin, url)).find((url) => url !== null && url !== startUrl);
        const requested = firstUrl ?? landingUrl;
        const redirects = buildRedirects({
          origin,
          requested,
          httpUrls: [],
          navigatedUrls: interactionWatch.navigatedUrls,
          landing: landingUrl,
        });
        let landingKey = capturedByUrl.get(landingUrl);
        if (landingKey === undefined) {
          const clean = await captureInCleanContext(landingUrl);
          if (clean === null) {
            recorder.logAction({ interaction: summary, outcome: 'failed', reason: 'the landing page could not be captured in a clean context' });
            continue;
          }
          landingKey = clean;
          capturedByUrl.set(landingUrl, landingKey);
        }

        const action: RuntimeAction = { kind: 'interact', page: interaction.page, click: interaction.click, fields };
        const seq = navigations.length;
        navigations.push({
          seq,
          start: { kind: 'action', from: startKey, action },
          requested,
          redirects,
          landing: { kind: 'captured', capture: landingKey },
        });
        recorder.logAction({
          seq,
          start: { kind: 'action', from: startKey, action },
          requested,
          chain: [requested, ...redirects.map((redirect) => redirect.to)],
          landing: { capture: landingKey, url: landingUrl },
          reused: false,
          consoleErrors: [],
        });
      } catch (error) {
        const reason =
          leaked || error instanceof LeakedValue
            ? 'the form put a filled value in a url'
            : error instanceof Error
              ? (error.message.split('\n')[0] ?? 'unknown error')
              : String(error);
        recorder.logAction({ interaction: summary, outcome: 'failed', reason });
      } finally {
        await interactionContext.close();
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
