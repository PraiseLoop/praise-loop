import { query } from "../db";
import { setupState, type PostingGate, type PostingSetup } from "../posting/postingSetup";
import { postingMode } from "./bufferPosting";
import { selectPostingProvider, type PostingProvider } from "./postingGate";

/**
 * What the owner needs to know about posting for one business (#205, #234): is posting
 * on, is Instagram/Facebook or Buffer connected, and is a usable target chosen. Database
 * only: it never calls a provider, so the pages can ask on every load. The caller has
 * already checked the business is theirs. The provider rule is shared with the scheduler
 * and worker (`selectPostingProvider`), so the banner matches who would receive a post.
 */
export async function getPostingSetup(ownerId: string, businessId: number, mode: PostingGate = postingMode()): Promise<PostingSetup> {
  const connection = await query<{ status: "active" | "needs_reconnect" }>("SELECT status FROM buffer_connections WHERE owner_id=$1", [ownerId]);
  const channel = await query<{ channel_name: string; service: string; channel_type: string }>(
    `SELECT c.channel_name, c.service, c.channel_type
     FROM business_buffer_channels c JOIN buffer_connections bc ON bc.id=c.connection_id
     WHERE c.business_id=$1 AND bc.owner_id=$2`,
    [businessId, ownerId]
  );
  const meta = await query<{
    target: "instagram" | "facebook";
    page_name: string;
    page_status: "active" | "needs_reconnect";
    tasks: string[] | null;
    connection_status: "active" | "needs_reconnect";
  }>(
    `SELECT t.target, p.name AS page_name, p.status AS page_status, p.tasks, c.status AS connection_status
     FROM business_meta_targets t
     JOIN meta_pages p ON p.id=t.meta_page_id
     JOIN meta_connections c ON c.id=p.connection_id
     WHERE t.business_id=$1 AND c.owner_id=$2`,
    [businessId, ownerId]
  );
  const bufferRow = channel.rows[0];
  const metaRow = meta.rows[0];
  const provider: PostingProvider | null = selectPostingProvider({
    metaTarget: !!metaRow,
    bufferChannel: !!bufferRow
  });
  const state = setupState({
    mode,
    buffer: {
      connection: connection.rows[0]?.status ?? null,
      channel: bufferRow ? { service: bufferRow.service, type: bufferRow.channel_type } : null
    },
    meta: {
      connection: metaRow?.connection_status ?? null,
      target: metaRow ? { target: metaRow.target, pageStatus: metaRow.page_status, tasks: metaRow.tasks ?? [] } : null
    }
  });
  return {
    state,
    mode,
    provider,
    channelName: provider === "meta" ? metaRow?.page_name ?? null : bufferRow?.channel_name ?? null,
    channelService: provider === "meta" ? metaRow?.target ?? null : bufferRow?.service ?? null
  };
}
