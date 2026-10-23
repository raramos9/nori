import type { Origin, PageUrl, Session } from '../graph/model.js';

export type RunStop = 'frontier-exhausted' | 'budget';

// Field values are never recorded, only the labels they were typed into.
export type RuntimeAction =
  | { readonly kind: 'follow-link'; readonly href: PageUrl; readonly name: string | null }
  | { readonly kind: 'interact'; readonly page: PageUrl; readonly click: string; readonly fields: readonly string[] };

export type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// The path is an exact pathname on the run's origin.
export type AllowedRequest = { readonly method: WriteMethod; readonly path: string };

export type Interaction = {
  readonly page: PageUrl;
  readonly fill: readonly { readonly label: string; readonly value: string }[];
  readonly click: string;
  readonly allow: readonly AllowedRequest[];
};

export type Redirect = { readonly to: PageUrl; readonly via: 'http' | 'client' };

export type CaptureKey = number;

// Artifact paths are relative to the run directory the crawler was given, and both files exist on disk
// before the capture is listed.
export type CrawledCapture = {
  readonly key: CaptureKey;
  readonly url: PageUrl;
  readonly httpStatus: number;
  readonly screenshot: string;
  readonly dom: string;
};

export type NavigationStart =
  | { readonly kind: 'entry' }
  | { readonly kind: 'action'; readonly from: CaptureKey; readonly action: RuntimeAction };

export type NavigationLanding =
  | { readonly kind: 'captured'; readonly capture: CaptureKey }
  | { readonly kind: 'aborted'; readonly error: string };

// The chain is [requested, ...redirects.map(to)]. A captured landing's URL is the chain's last element.
export type CrawledNavigation = {
  readonly seq: number;
  readonly start: NavigationStart;
  readonly requested: PageUrl;
  readonly redirects: readonly Redirect[];
  readonly landing: NavigationLanding;
};

export type CrawlResult = {
  readonly origin: Origin;
  readonly session: Session;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly stop: RunStop;
  readonly crawlerVersion: string;
  readonly requests: { readonly allowed: number; readonly blocked: number };
  readonly captures: readonly CrawledCapture[];
  readonly navigations: readonly CrawledNavigation[];
};
