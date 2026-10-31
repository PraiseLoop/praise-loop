import assert from "node:assert/strict";
import {
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  MAX_TEXT_CHARS,
  fetchReadablePage,
  isPublicAddress,
  readableText,
  type SafeHttpRequest
} from "../lib/services/safeFetch";

// No network and no DNS: both are injected for every case.
const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";

function html(body: string, contentType = "text/html; charset=utf-8", headers: Record<string, string> = {}) {
  return { status: 200, headers: { "content-type": contentType, ...headers }, body };
}

function redirect(location: string, status = 302) {
  return { status, headers: { location, "content-type": "text/html" }, body: "" };
}

const publicLookup = async () => [PUBLIC_V4];

async function rejectsAddress(url: string, lookup = publicLookup) {
  const request: SafeHttpRequest = async () => {
    throw new Error("a rejected address must never be requested");
  };
  await assert.rejects(() => fetchReadablePage(url, { lookup, request }), /not a public address/, url);
}

async function publicHostTest() {
  const calls: Array<{ url: URL; address: string }> = [];
  const result = await fetchReadablePage("https://example.com/about", {
    lookup: publicLookup,
    request: async (url, options) => {
      calls.push({ url, address: options.address });
      return html("<html><head><style>.nav{display:none}</style><script>alert('x')</script></head><body><h1>Hello &amp; welcome</h1><p>Tea   and\n cake.</p></body></html>");
    }
  });

  assert.equal(result.text, "Hello & welcome Tea and cake.");
  assert.equal(result.url, "https://example.com/about");
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, PUBLIC_V4, "the HTTP call connects to the verified address");
  assert.equal(calls[0].url.hostname, "example.com");
}

async function publicIpv6Test() {
  const result = await fetchReadablePage("https://example.com/", {
    lookup: async () => [PUBLIC_V6],
    request: async (_url, options) => {
      assert.equal(options.family, 6);
      assert.equal(options.address, PUBLIC_V6);
      return html("plain text", "text/plain");
    }
  });
  assert.equal(result.text, "plain text");
}

async function privateAddressesTest() {
  const literals: Array<[string, string]> = [
    ["http://localhost/", "localhost"],
    ["http://127.0.0.1/", "127.0.0.1"],
    ["http://10.1.2.3/", "10.1.2.3"],
    ["http://172.16.0.1/", "172.16.0.1"],
    ["http://172.31.255.254/", "172.31.255.254"],
    ["http://192.168.1.1/", "192.168.1.1"],
    ["http://169.254.169.254/", "169.254.169.254"],
    ["http://100.64.0.1/", "100.64.0.1"],
    ["http://0.0.0.0/", "0.0.0.0"],
    ["http://224.0.0.1/", "224.0.0.1"],
    ["http://[::1]/", "::1"],
    ["http://[fc00::1]/", "fc00::1"],
    ["http://[fd12:3456::1]/", "fd12:3456::1"],
    ["http://[fe80::1]/", "fe80::1"],
    ["http://[febf::1]/", "febf::1"],
    ["http://[::]/", "::"],
    ["http://[::ffff:10.0.0.1]/", "::ffff:10.0.0.1"],
    ["http://[::ffff:127.0.0.1]/", "::ffff:127.0.0.1"],
    ["http://[::ffff:0:10.0.0.1]/", "::ffff:0:10.0.0.1"],
    ["http://[64:ff9b::10.0.0.1]/", "64:ff9b::10.0.0.1"],
    ["http://[2002:0a00:0001::]/", "2002:0a00:0001::"],
    ["http://[2001:0000::1]/", "2001:0000::1"]
  ];
  for (const [url, address] of literals) {
    assert.equal(isPublicAddress(address), false, url);
    await rejectsAddress(url);
  }

  // A name that resolves only to a private address is refused after DNS.
  await rejectsAddress("https://internal.example/", async () => ["10.0.0.5"]);
  await rejectsAddress("https://mixed.example/", async () => [PUBLIC_V4, "192.168.0.9"]);
  await rejectsAddress("https://mixed-v6.example/", async () => [PUBLIC_V6, "fe80::1"]);
}

async function redirectTests() {
  // A private redirect target is refused before a second request (the host
  // change is rejected before it is even resolved).
  let requests = 0;
  await assert.rejects(
    () => fetchReadablePage("https://example.com/start", {
      lookup: publicLookup,
      request: async () => {
        requests += 1;
        return redirect("http://127.0.0.1/secret");
      }
    }),
    /redirected to a different site|not a public address/
  );
  assert.equal(requests, 1);

  // A same-host redirect is re-resolved, so a second DNS answer cannot reach a
  // private address.
  let lookups = 0;
  await assert.rejects(
    () => fetchReadablePage("https://rebind.example/start", {
      lookup: async () => {
        lookups += 1;
        return lookups === 1 ? [PUBLIC_V4] : ["10.0.0.5"];
      },
      request: async () => redirect("/next")
    }),
    /not a public address/
  );
  assert.equal(lookups, 2);

  // A redirect to another site is refused even when both are public.
  await assert.rejects(
    () => fetchReadablePage("https://example.com/start", {
      lookup: publicLookup,
      request: async () => redirect("https://other.example/page")
    }),
    /different site/
  );

  // The host's www. variant is the one allowed host change.
  const seen: string[] = [];
  const allowed = await fetchReadablePage("https://example.com/start", {
    lookup: async (hostname) => {
      assert.ok(hostname === "example.com" || hostname === "www.example.com");
      return [PUBLIC_V4];
    },
    request: async (url) => {
      seen.push(url.hostname);
      return url.hostname === "example.com" ? redirect("https://www.example.com/page") : html("Welcome");
    }
  });
  assert.equal(allowed.url, "https://www.example.com/page");
  assert.deepEqual(seen, ["example.com", "www.example.com"]);

  // More than three redirects is refused.
  let hops = 0;
  await assert.rejects(
    () => fetchReadablePage("https://example.com/r0", {
      lookup: publicLookup,
      request: async (_url) => {
        hops += 1;
        return redirect(`/r${hops}`);
      }
    }),
    /redirected too many times/
  );
  assert.equal(hops, MAX_REDIRECTS + 1);
}

async function bodyLimitTest() {
  const body = "a".repeat(MAX_BODY_BYTES + 4096);
  const result = await fetchReadablePage("https://example.com/big", {
    lookup: publicLookup,
    request: async () => html(body, "text/plain")
  });
  assert.equal(result.bytes, MAX_BODY_BYTES);
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, MAX_TEXT_CHARS);

  // The injected response's own truncated flag is honoured too.
  const flagged = await fetchReadablePage("https://example.com/big", {
    lookup: publicLookup,
    request: async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: "short", truncated: true })
  });
  assert.equal(flagged.truncated, true);
}

async function rejectionTests() {
  await assert.rejects(
    () => fetchReadablePage("https://example.com/data", {
      lookup: publicLookup,
      request: async () => html("{}", "application/json")
    }),
    /not readable text/
  );

  await assert.rejects(
    () => fetchReadablePage("https://user:secret@example.com/", { lookup: publicLookup, request: async () => html("x") }),
    /cannot include credentials/
  );

  await assert.rejects(
    () => fetchReadablePage("file:///etc/passwd", { lookup: publicLookup, request: async () => html("x") }),
    /Only http and https/
  );

  await assert.rejects(
    () => fetchReadablePage("https://example.com/missing", {
      lookup: publicLookup,
      request: async () => ({ status: 404, headers: { "content-type": "text/html" }, body: "not found" })
    }),
    /could not be read/
  );
}

async function timeoutTest() {
  await assert.rejects(
    () => fetchReadablePage("https://example.com/slow", {
      lookup: publicLookup,
      timeoutMs: 20,
      request: () => new Promise(() => {})
    }),
    /took too long/
  );
}

async function readableTextTest() {
  assert.equal(readableText("<p>One</p><script>bad()</script><style>p{}</style><p>Two &nbsp; three</p>", "text/html"), "One Two three");
  assert.equal(readableText("a\r\n\tb   c", "text/plain"), "a b c");
  assert.equal(readableText("x".repeat(MAX_TEXT_CHARS + 10), "text/plain").length, MAX_TEXT_CHARS);
}

async function main() {
  await publicHostTest();
  await publicIpv6Test();
  await privateAddressesTest();
  await redirectTests();
  await bodyLimitTest();
  await rejectionTests();
  await timeoutTest();
  await readableTextTest();
  console.log("safe fetch tests passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
