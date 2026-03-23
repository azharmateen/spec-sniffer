import { Page, Request, Response } from 'playwright';

export interface CapturedRequest {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  requestBody: any | null;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: any | null;
  contentType: string;
  duration: number;
  resourceType: string;
}

// Filter out static assets and non-API requests
const IGNORE_EXTENSIONS = [
  '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.map', '.webp', '.avif',
];

const IGNORE_PATTERNS = [
  /^data:/,
  /hot-update/,
  /webpack/,
  /sockjs/,
  /__vite/,
  /favicon/,
  /chrome-extension/,
];

function isApiRequest(url: string, resourceType: string): boolean {
  // Include XHR and fetch requests
  if (resourceType === 'xhr' || resourceType === 'fetch') return true;

  // Filter by extension
  const urlPath = new URL(url).pathname.toLowerCase();
  if (IGNORE_EXTENSIONS.some((ext) => urlPath.endsWith(ext))) return false;

  // Filter by pattern
  if (IGNORE_PATTERNS.some((p) => p.test(url))) return false;

  return false; // Only capture explicit XHR/fetch by default
}

function parseQueryParams(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  try {
    const parsed = new URL(url);
    parsed.searchParams.forEach((value, key) => {
      params[key] = value;
    });
  } catch {
    // Ignore parse errors
  }
  return params;
}

function extractPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function safeParseBody(response: Response): Promise<any | null> {
  try {
    const contentType = response.headers()['content-type'] || '';
    if (contentType.includes('application/json')) {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    if (contentType.includes('text/')) {
      return await response.text();
    }
    return null;
  } catch {
    return null;
  }
}

async function safeParseRequestBody(request: Request): Promise<any | null> {
  try {
    const postData = request.postData();
    if (!postData) return null;

    try {
      return JSON.parse(postData);
    } catch {
      return postData;
    }
  } catch {
    return null;
  }
}

function headersToRecord(headers: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    // Skip sensitive headers
    if (['cookie', 'authorization', 'set-cookie'].includes(key.toLowerCase())) {
      clean[key] = '[REDACTED]';
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export class NetworkInterceptor {
  private captured: CapturedRequest[] = [];
  private requestTimings: Map<string, number> = new Map();
  private idCounter: number = 0;
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async attach(page: Page): Promise<void> {
    // Track request start times
    page.on('request', (request) => {
      const url = request.url();
      const resourceType = request.resourceType();

      if (!isApiRequest(url, resourceType)) return;

      const id = `req_${++this.idCounter}`;
      this.requestTimings.set(url + request.method(), Date.now());
    });

    // Capture response data
    page.on('response', async (response) => {
      const request = response.request();
      const url = request.url();
      const resourceType = request.resourceType();

      if (!isApiRequest(url, resourceType)) return;

      const timingKey = url + request.method();
      const startTime = this.requestTimings.get(timingKey) || Date.now();
      this.requestTimings.delete(timingKey);

      const requestBody = await safeParseRequestBody(request);
      const responseBody = await safeParseBody(response);

      const captured: CapturedRequest = {
        id: `req_${++this.idCounter}`,
        timestamp: Date.now(),
        method: request.method(),
        url: url,
        path: extractPath(url),
        query: parseQueryParams(url),
        headers: headersToRecord(request.headers()),
        requestBody,
        responseStatus: response.status(),
        responseHeaders: headersToRecord(response.headers()),
        responseBody,
        contentType: response.headers()['content-type'] || '',
        duration: Date.now() - startTime,
        resourceType,
      };

      this.captured.push(captured);
    });
  }

  getRequests(): CapturedRequest[] {
    return [...this.captured];
  }

  getApiRequests(): CapturedRequest[] {
    // Filter to only requests that look like API calls
    return this.captured.filter((r) => {
      // Must be JSON or similar content type
      const ct = r.contentType.toLowerCase();
      return (
        ct.includes('json') ||
        ct.includes('xml') ||
        ct.includes('form') ||
        ct.includes('text/plain') ||
        r.requestBody !== null
      );
    });
  }

  clear(): void {
    this.captured = [];
    this.requestTimings.clear();
  }
}
