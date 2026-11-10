import { act, render, screen } from "@testing-library/react-native";
import QueueScreen from "../src/app/queue";
import { ApiError } from "../src/api/client";

jest.mock("../src/api", () => ({ api: { request: jest.fn() } }));

jest.mock("../src/auth/SessionProvider", () => {
  // A stable session object: screens put handleError in useCallback dependencies,
  // and a new function on every render would re-run the focus effects forever.
  const session = {
    status: "signedIn",
    token: "synthetic-mobile-token",
    sessionEnded: false,
    handleError: jest.fn(),
    expire: jest.fn()
  };
  return { useSession: () => session };
});

jest.mock("expo-router", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    Redirect: () => null,
    router: { push: jest.fn(), back: jest.fn() },
    useFocusEffect: (callback: () => void | (() => void)) => React.useEffect(callback, [callback]),
    useLocalSearchParams: jest.fn(() => ({})),
    usePreventRemove: jest.fn()
  };
});

jest.mock("react-native-safe-area-context", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require("react-native");
  return { SafeAreaView: View };
});

jest.mock("../src/notifications/NotificationOffer", () => ({ NotificationOffer: () => null }));

jest.mock("../src/media/useDraftImage", () => ({
  useDraftImage: () => ({ state: { status: "ready", uri: "file:///cache/draft.png" }, retry: jest.fn() })
}));

const { api } = jest.requireMock("../src/api") as { api: { request: jest.Mock } };
const request = api.request;

const business = {
  id: 7,
  name: "Sample Café",
  timezone: "UTC",
  logo_url: null,
  brand_tone: "warm",
  weekly_target: 3,
  brand_colors: { primary: "#112233", secondary: "#445566", template: "quote-card-v1", quoteSize: "medium" }
};

const entitlements = {
  plan: "free",
  source: "default",
  expiresAt: null,
  expired: false,
  limits: { postsPerWeek: 3, templates: 1, watermark: true, reviewSync: false, aiReplies: false, brandVoice: false, businesses: 1 },
  usage: [{
    businessId: 7,
    name: "Sample Café",
    timezone: "UTC",
    resetsOn: "Monday",
    allocated: 0,
    target: 3,
    weeklyTarget: 3,
    quotaMet: false
  }]
};

const profile = { name: "Sam Owner", email: "sam@example.invalid", nameSource: "owner", provider: "google", initials: "SO" };

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "12",
    version: 3,
    quote_text: "Best flat white in the neighbourhood.",
    caption_text: "Thanks for saying so.",
    image_path: "/api/media/draft-12.png",
    status: "draft",
    shared_at: null,
    scheduled_for: null,
    created_at: "2026-11-02T12:00:00Z",
    rating: 5,
    author_name: "Priya S.",
    reviewed_at: "2026-11-01T12:00:00Z",
    source: "manual",
    job_state: "complete",
    error_code: null,
    provider_state: null,
    ...overrides
  };
}

function generation(overrides: Record<string, unknown> = {}) {
  return { jobs: [], periods: [], current_period: null, ...overrides };
}

function respond(handler: (path: string) => unknown) {
  request.mockImplementation(async (path: string) => handler(path));
}

function happyPath(drafts: Record<string, unknown>[], generationBody: Record<string, unknown> = generation()) {
  respond(path => {
    if (path === "/api/businesses") return { businesses: [business] };
    if (path.startsWith("/api/drafts?")) return { drafts };
    if (path.startsWith("/api/generation?")) return generationBody;
    if (path === "/api/entitlements") return entitlements;
    if (path === "/api/profile") return profile;
    throw new Error(`Unexpected request: ${path}`);
  });
}

beforeEach(() => {
  request.mockReset();
});

describe("weekly approval queue screen", () => {
  it("shows a loading indicator while the first queue request is in flight", async () => {
    request.mockImplementation(() => new Promise(() => undefined));
    await render(<QueueScreen />);
    expect(screen.getByLabelText("Loading this week's posts")).toBeTruthy();
  });

  it("shows the empty-week headline and guidance when there are no posts", async () => {
    happyPath([]);
    await render(<QueueScreen />);

    expect(await screen.findByText("No posts this week yet")).toBeTruthy();
    expect(screen.getByText(/Posts appear here after the weekly review pick/)).toBeTruthy();
  });

  it("shows generation progress and keeps unfinished posts out of review", async () => {
    happyPath(
      [draftRow({ caption_text: "", image_path: null, job_state: "running" })],
      generation({
        jobs: [{ id: "1", draft_id: "12", state: "running", attempts: 0, manual_retries: 0, error_code: null, period_start: "2026-11-09" }],
        periods: [{ period_start: "2026-11-09", target: 3, allocated: 3, completed: 0, reason: "queued", timezone: "UTC" }],
        current_period: "2026-11-09"
      })
    );
    await render(<QueueScreen />);

    expect(await screen.findByText("This week's posts are still being made")).toBeTruthy();
    expect(screen.getByText(/Making 0 of 3 posts/)).toBeTruthy();
    expect(screen.getByText("Being made")).toBeTruthy();
    expect(screen.queryByText("Ready to review")).toBeNull();
  });

  it("explains a server failure instead of showing an empty week", async () => {
    respond(path => {
      if (path === "/api/businesses") return { businesses: [business] };
      if (path.startsWith("/api/drafts?")) throw new ApiError("http", 500, "Database unavailable");
      if (path.startsWith("/api/generation?")) return generation();
      if (path === "/api/entitlements") return entitlements;
      if (path === "/api/profile") return profile;
      throw new Error(`Unexpected request: ${path}`);
    });
    await render(<QueueScreen />);

    expect(await screen.findByText("Couldn't load this week's posts.")).toBeTruthy();
    expect(screen.queryByText("No posts this week yet")).toBeNull();
  });

  it("says the business queue could not be loaded while offline", async () => {
    respond(path => {
      if (path === "/api/businesses") return { businesses: [business] };
      if (path.startsWith("/api/drafts?")) throw new ApiError("network");
      if (path.startsWith("/api/generation?")) return generation();
      if (path === "/api/entitlements") return entitlements;
      if (path === "/api/profile") return profile;
      throw new Error(`Unexpected request: ${path}`);
    });
    await render(<QueueScreen />);

    expect(await screen.findByText(/this business's posts can't be loaded until you reconnect/)).toBeTruthy();
    expect(screen.queryByText("No posts this week yet")).toBeNull();
  });

  it("keeps the last loaded queue on screen read-only when a refresh goes offline", async () => {
    happyPath([draftRow()]);
    await render(<QueueScreen />);

    expect(await screen.findByText("Best flat white in the neighbourhood.")).toBeTruthy();

    respond(path => {
      if (path.startsWith("/api/drafts?") || path.startsWith("/api/generation?")) throw new ApiError("network");
      if (path === "/api/entitlements") return entitlements;
      throw new Error(`Unexpected request: ${path}`);
    });
    const [scroll] = screen.root.queryAll(instance => instance.type === "RCTScrollView");
    await act(async () => {
      scroll.props.refreshControl.props.onRefresh();
    });

    expect(await screen.findByText(/Offline — showing the last loaded queue/)).toBeTruthy();
    expect(screen.getByText("Best flat white in the neighbourhood.")).toBeTruthy();
  });
});
