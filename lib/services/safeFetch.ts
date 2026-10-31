import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";

// One public page, bounded in every direction: a fixed timeout, a hard body
// limit, and only text content. The address is resolved and checked here rather
// than by the HTTP client, so a redirect or DNS rebinding cannot move a request
// onto a private network.
export const FETCH_TIMEOUT_MS = 5_000;
export const MAX_REDIRECTS = 3;
export const MAX_BODY_BYTES = 512 * 1024;
export const MAX_TEXT_CHARS = 6_000;

export class SafeFetchError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "SafeFetchError";
  }
}

type AddressFamily = 4 | 6;

export type SafeHttpResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
  truncated?: boolean;
};

export type SafeHttpRequest = (
  url: URL,
  options: { signal: AbortSignal; maxBytes: number; address: string; family: AddressFamily }
) => Promise<SafeHttpResponse>;

export type SafeFetchDeps = {
  /** Injectable so tests never touch DNS. Returns every address for the name. */
  lookup?: (hostname: string) => Promise<string[]>;
  /** Injectable so tests never touch the network. */
  request?: SafeHttpRequest;
  timeoutMs?: number;
};

export type SafeFetchResult = {
  url: string;
  text: string;
  bytes: number;
  truncated: boolean;
};

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

function isLocalhostName(host: string): boolean {
  const name = normalizeHost(host);
  return name === "localhost" || name.endsWith(".localhost");
}

function ipv4IsPublic(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  // This network, private ranges, loopback, link-local and CGNAT.
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  // IETF protocol assignments, documentation and benchmarking ranges.
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  // Multicast, reserved and broadcast.
  if (a >= 224) return false;
  return true;
}

function parseIpv6(address: string): number[] | null {
  let value = address.toLowerCase();
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);

  // Turn a dotted IPv4 tail into two hextets before splitting on ":".
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) return null;
    const parts = value.slice(lastColon + 1).split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    value = `${value.slice(0, lastColon + 1)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  if (halves.length === 1 && missing !== 0) return null;

  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const hextets = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return hextets.every((hextet) => Number.isInteger(hextet)) ? hextets : null;
}

function embeddedIpv4IsPublic(high: number, low: number): boolean {
  return ipv4IsPublic(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
}

function ipv6IsPublic(address: string): boolean {
  const hextets = parseIpv6(address);
  if (!hextets) return false;
  if (hextets.every((hextet) => hextet === 0)) return false; // unspecified
  if (hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1) return false; // loopback
  if ((hextets[0] & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((hextets[0] & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((hextets[0] & 0xff00) === 0xff00) return false; // multicast
  if (hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff) {
    return embeddedIpv4IsPublic(hextets[6], hextets[7]); // IPv4-mapped ::ffff:0:0/96
  }
  if (hextets.slice(0, 4).every((hextet) => hextet === 0) && hextets[4] === 0xffff && hextets[5] === 0) {
    return embeddedIpv4IsPublic(hextets[6], hextets[7]); // IPv4-translated ::ffff:0:0/96
  }
  if (hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((hextet) => hextet === 0)) {
    return embeddedIpv4IsPublic(hextets[6], hextets[7]); // NAT64 64:ff9b::/96
  }
  if (hextets.slice(0, 6).every((hextet) => hextet === 0)) {
    return embeddedIpv4IsPublic(hextets[6], hextets[7]); // deprecated IPv4-compatible ::/96
  }
  if (hextets[0] === 0x2002) return embeddedIpv4IsPublic(hextets[1], hextets[2]); // 6to4
  if (hextets[0] === 0x2001 && hextets[1] === 0) return false; // Teredo tunnel
  return true;
}

/** True only for a public unicast address; every private or special range is false. */
export function isPublicAddress(address: string): boolean {
  const value = normalizeHost(address);
  const family = isIP(value);
  if (family === 4) return ipv4IsPublic(value);
  if (family === 6) return ipv6IsPublic(value);
  return false;
}

function parsePageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new SafeFetchError("Use a valid website URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("Only http and https websites are supported");
  }
  if (url.username || url.password) throw new SafeFetchError("The website URL cannot include credentials");
  // The URL parser drops a default port, so any port left here is non-standard. Refusing those keeps this
  // from being used to probe other services on a public host.
  if (url.port) throw new SafeFetchError("Use the website address without a port number");
  if (!url.hostname) throw new SafeFetchError("Use a valid website URL");
  return url;
}

function sameRegistrableHost(from: URL, to: URL): boolean {
  const a = normalizeHost(from.hostname);
  const b = normalizeHost(to.hostname);
  return a === b || `www.${a}` === b || `www.${b}` === a;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

async function verifyHost(url: URL, lookup: (hostname: string) => Promise<string[]>): Promise<{ address: string; family: AddressFamily }> {
  const host = normalizeHost(url.hostname);
  if (!host || isLocalhostName(host)) throw new SafeFetchError("That website is not a public address");

  const literal = isIP(host);
  if (literal) {
    if (!isPublicAddress(host)) throw new SafeFetchError("That website is not a public address");
    return { address: host, family: literal as AddressFamily };
  }

  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new SafeFetchError("That website could not be found");
  }
  if (!addresses.length) throw new SafeFetchError("That website could not be found");
  // Every answer must be public: a name with one private answer could be used
  // to reach an internal service depending on which answer the client picks.
  if (addresses.some((address) => !isPublicAddress(address))) {
    throw new SafeFetchError("That website is not a public address");
  }
  const address = normalizeHost(addresses[0]);
  const family = isIP(address) as AddressFamily;
  return { address, family };
}

function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  return headers[name.toLowerCase()];
}

export function readableText(body: string, contentType: string): string {
  let text = body;
  if (contentType === "text/html") {
    text = text
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ");
    text = text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, code: string) => {
      if (code.startsWith("#")) {
        const number = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : " ";
      }
      const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      return entities[code.toLowerCase()] ?? match;
    });
  }
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

const defaultRequest: SafeHttpRequest = (url, options) =>
  new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const requestOptions: https.RequestOptions = {
      method: "GET",
      signal: options.signal,
      headers: {
        accept: "text/html,text/plain;q=0.9",
        "user-agent": "PraiseLoopBrandVoice/1.0"
      },
      // Connect to the address already verified above; never resolve the name a
      // second time, where rebinding could swap in a private answer.
      lookup: ((_hostname: string, lookupOptions: unknown, callback: (...args: any[]) => void) => {
        if (lookupOptions && typeof lookupOptions === "object" && (lookupOptions as { all?: boolean }).all) {
          callback(null, [{ address: options.address, family: options.family }]);
        } else {
          callback(null, options.address, options.family);
        }
      }) as any
    };

    const req = transport.request(url, requestOptions, (res) => {
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: Buffer.concat(chunks).toString("utf8"),
          truncated
        });
      };
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (size + chunk.length > options.maxBytes) {
          const take = options.maxBytes - size;
          if (take > 0) chunks.push(chunk.subarray(0, take));
          size = options.maxBytes;
          truncated = true;
          finish();
          res.destroy();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      res.on("end", finish);
      res.on("close", finish);
      res.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
    req.on("error", (error) => reject(error));
    req.end();
  });

function timeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SafeFetchError("That website took too long to respond", 504));
    }, ms);
  });
  return Promise.race([promise, expired]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Fetch one public page and return its readable text. Redirects stay on the same
 * host (or its www. variant), every hop re-resolves and verifies, and the body is
 * read to a fixed limit.
 */
export async function fetchReadablePage(rawUrl: string, deps: SafeFetchDeps = {}): Promise<SafeFetchResult> {
  const lookup = deps.lookup ?? defaultLookup;
  const request = deps.request ?? defaultRequest;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let current = parsePageUrl(rawUrl);
  let redirects = 0;

  for (;;) {
    const verified = await verifyHost(current, lookup);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SafeFetchError("That website took too long to respond", 504);

    const controller = new AbortController();
    let response: SafeHttpResponse;
    try {
      response = await timeout(
        request(current, {
          signal: controller.signal,
          maxBytes: MAX_BODY_BYTES,
          address: verified.address,
          family: verified.family
        }),
        remaining,
        controller
      );
    } catch (error) {
      if (error instanceof SafeFetchError) throw error;
      throw new SafeFetchError("That website could not be reached", 502);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = headerValue(response.headers, "location");
      if (!location) throw new SafeFetchError("That website sent an empty redirect");
      if (redirects >= MAX_REDIRECTS) throw new SafeFetchError("That website redirected too many times");
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new SafeFetchError("That website sent an invalid redirect");
      }
      if (!sameRegistrableHost(current, next)) {
        throw new SafeFetchError("That website redirected to a different site");
      }
      current = parsePageUrl(next.toString());
      redirects += 1;
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new SafeFetchError("That website could not be read", 502);
    }

    const contentType = (headerValue(response.headers, "content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "text/html" && contentType !== "text/plain") {
      throw new SafeFetchError("That page is not readable text");
    }

    const buffer = Buffer.from(response.body, "utf8");
    const truncated = response.truncated === true || buffer.length > MAX_BODY_BYTES;
    const body = buffer.length > MAX_BODY_BYTES ? buffer.subarray(0, MAX_BODY_BYTES).toString("utf8") : response.body;

    return {
      url: current.toString(),
      text: readableText(body, contentType),
      bytes: Math.min(buffer.length, MAX_BODY_BYTES),
      truncated
    };
  }
}
