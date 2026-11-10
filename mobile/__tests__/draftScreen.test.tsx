import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import DraftScreen from "../src/app/draft/[id]";
import { ApiError } from "../src/api/client";
import { useLocalSearchParams } from "expo-router";

jest.mock("../src/api", () => ({ api: { request: jest.fn() } }));

jest.mock("../src/auth/SessionProvider", () => {
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

jest.mock("../src/media/useDraftImage", () => ({
  useDraftImage: () => ({ state: { status: "ready", uri: "file:///cache/draft.png" }, retry: jest.fn() })
}));

jest.mock("../src/media/photoLibrary", () => ({
  photoLibrary: { requestPermission: jest.fn(), saveImage: jest.fn() }
}));

jest.mock("../src/posting/media", () => ({
  downloadDraftImage: jest.fn(),
  discardDraftImage: jest.fn()
}));

jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
jest.mock("expo-sharing", () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));

const { api } = jest.requireMock("../src/api") as { api: { request: jest.Mock } };
const request = api.request;
const params = useLocalSearchParams as jest.Mock;

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

function respond(handler: (path: string, init?: { method?: string; body?: string }) => unknown) {
  request.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => handler(path, init));
}

beforeEach(() => {
  request.mockReset();
  params.mockReturnValue({ id: "12", businessId: "7" });
});

describe("draft detail screen", () => {
  it("shows a loading indicator until the queue list containing the draft arrives", async () => {
    request.mockImplementation(() => new Promise(() => undefined));
    await render(<DraftScreen />);
    expect(screen.getByLabelText("Loading this post")).toBeTruthy();
  });

  it("explains a failed load and offers the way back", async () => {
    respond(() => { throw new ApiError("network"); });
    await render(<DraftScreen />);

    expect(await screen.findByText(/reach PraiseLoop/)).toBeTruthy();
    expect(screen.getByText("Back to the queue")).toBeTruthy();
  });

  it("rejects an empty or over-long caption before sending it", async () => {
    respond(path => {
      if (path.startsWith("/api/drafts?")) return { drafts: [draftRow()] };
      throw new Error(`Unexpected request: ${path}`);
    });
    await render(<DraftScreen />);

    const input = await screen.findByLabelText("Caption");
    await fireEvent.changeText(input, "   ");
    await fireEvent.press(screen.getByText("Save caption"));
    expect(screen.getAllByText("Add a caption before saving.").length).toBeGreaterThan(0);

    await fireEvent.changeText(input, "x".repeat(201));
    await fireEvent.press(screen.getByText("Save caption"));
    expect(screen.getAllByText("Keep the caption to 200 characters or fewer.").length).toBeGreaterThan(0);

    expect(request.mock.calls.some(([path]) => path === "/api/drafts/caption")).toBe(false);
  });

  it("approves the draft with its version and shows the confirmation", async () => {
    const calls: { path: string; body?: unknown }[] = [];
    respond((path, init) => {
      if (path.startsWith("/api/drafts?")) return { drafts: [draftRow()] };
      if (path === "/api/drafts/status") {
        calls.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
        return { draft: draftRow({ version: 4, status: "approved" }) };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    await render(<DraftScreen />);

    await fireEvent.press(await screen.findByText("Approve"));

    expect(await screen.findByText("Approved. Post it whenever you're ready.")).toBeTruthy();
    expect(calls).toEqual([{ path: "/api/drafts/status", body: { draftPostId: 12, status: "approved", version: 3 } }]);
    expect(screen.getByText("approved")).toBeTruthy();
  });

  it("archives the draft with its version and shows the confirmation", async () => {
    const calls: { path: string; body?: unknown }[] = [];
    respond((path, init) => {
      if (path.startsWith("/api/drafts?")) return { drafts: [draftRow()] };
      if (path === "/api/drafts/status") {
        calls.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
        return { draft: draftRow({ version: 4, status: "archived" }) };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    await render(<DraftScreen />);

    await fireEvent.press(await screen.findByText("Archive"));

    expect(await screen.findByText("Archived. It won't be posted.")).toBeTruthy();
    expect(calls).toEqual([{ path: "/api/drafts/status", body: { draftPostId: 12, status: "archived", version: 3 } }]);
    expect(screen.getByText("archived")).toBeTruthy();
  });

  it("reloads the current draft and explains a 409 version conflict", async () => {
    let loads = 0;
    respond(path => {
      if (path.startsWith("/api/drafts?")) {
        loads += 1;
        return {
          drafts: [draftRow(loads === 1 ? {} : { version: 4, caption_text: "Edited on another device." })]
        };
      }
      if (path === "/api/drafts/status") {
        throw new ApiError("conflict", 409, undefined, "Draft changed; refresh and retry");
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    await render(<DraftScreen />);

    await fireEvent.press(await screen.findByText("Approve"));

    expect(await screen.findByText("This post changed somewhere else. Reload and try again.")).toBeTruthy();
    await waitFor(() => expect(loads).toBe(2));
    expect(screen.getByDisplayValue("Edited on another device.")).toBeTruthy();
  });
});
