import { query } from "../db";
import { setupState, type PostingGate, type PostingSetup } from "../posting/postingSetup";
import { postingMode } from "./bufferPosting";

/**
 * What the owner needs to know about posting for one business (#205): is posting on, is
 * Buffer connected, and is a usable channel chosen. Database only: it never calls Buffer,
 * so the pages can ask on every load. The caller has already checked the business is theirs.
 */
export async function getPostingSetup(ownerId: string, businessId: number, mode: PostingGate = postingMode()): Promise<PostingSetup> {
  const connection = await query<{ status: "active" | "needs_reconnect" }>("SELECT status FROM buffer_connections WHERE owner_id=$1", [ownerId]);
  const channel = await query<{ channel_name: string; service: string; channel_type: string }>(
    `SELECT c.channel_name, c.service, c.channel_type
     FROM business_buffer_channels c JOIN buffer_connections bc ON bc.id=c.connection_id
     WHERE c.business_id=$1 AND bc.owner_id=$2`,
    [businessId, ownerId]
  );
  const row = channel.rows[0];
  const state = setupState({
    mode,
    connection: connection.rows[0]?.status ?? null,
    channel: row ? { service: row.service, type: row.channel_type } : null
  });
  return { state, mode, channelName: row?.channel_name ?? null, channelService: row?.service ?? null };
}
