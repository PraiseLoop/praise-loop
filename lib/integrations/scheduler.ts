export type SchedulePayload = {
  draftPostId: number; businessId: number;
  captionText: string;
  /** Unguessable, time-limited URL the provider fetches; never the private /api/media path. */
  mediaUrl: string;
};
/** A provider accepted the request. `status` is the provider's own word for the post (draft, sending, sent, ...). */
export type ScheduleReceipt = { provider: "buffer" | "meta" | "fake"; externalId: string; status: string };
export type PostStatusReceipt = { status: string; externalLink: string | null; sentAt: string | null; errorMessage: string | null };
export interface SchedulerAdapter {
  submitPost(payload: SchedulePayload): Promise<ScheduleReceipt>;
  getPostStatus(externalId: string): Promise<PostStatusReceipt>;
}
// Explicit local/test fake. Never reports a real post and never logs content.
export class StubSchedulerAdapter implements SchedulerAdapter {
  async submitPost(payload: SchedulePayload): Promise<ScheduleReceipt> {
    return { provider: "fake", status: "draft", externalId: `fake-${payload.draftPostId}` };
  }
  async getPostStatus(): Promise<PostStatusReceipt> {
    return { status: "draft", externalLink: null, sentAt: null, errorMessage: null };
  }
}
