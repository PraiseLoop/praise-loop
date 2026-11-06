import { ApiError } from "../src/api/client";
import { INVITE_ONLY_MESSAGE, isInviteOnly } from "../src/auth/inviteOnly";

describe("invite-only sign-up", () => {
  it("maps the stable server code to the shared message", () => {
    const refusal = new ApiError("http", 403, INVITE_ONLY_MESSAGE, undefined, "invite_only");
    expect(isInviteOnly(refusal)).toBe(true);
  });

  it("does not treat an ordinary failure as invite-only", () => {
    expect(isInviteOnly(new ApiError("http", 403, "That didn’t work.", undefined, "forbidden"))).toBe(false);
    expect(isInviteOnly(new ApiError("signedOut", 401))).toBe(false);
    expect(isInviteOnly(new Error("network"))).toBe(false);
  });
});
