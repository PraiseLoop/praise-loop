import { chargeGeneration } from "../authorization";
import { query } from "../db";
import { generateBrandVoiceProfile } from "./captions";
import { entitlementsFor } from "./entitlements";
import { fetchReadablePage, SafeFetchError } from "./safeFetch";

export const MAX_VOICE_CHARS = 900;
export const MAX_STORED_VOICE_CHARS = 1_200;

export class BrandVoiceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "BrandVoiceError";
  }
}

export type BrandVoiceDeps = {
  fetchPage?: (url: string) => Promise<{ url?: string; text: string }>;
  generateProfile?: (pageText: string) => Promise<string>;
};

/**
 * Length and format only: the profile must be plain text within the stored cap.
 * Content is never treated as trusted instructions; this validation stops model
 * output from carrying markup or unbounded text into a later prompt.
 */
export function normalizeVoiceProfile(raw: string): string {
  let text = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  // A fenced response is a formatting wrapper, not part of the voice.
  text = text.replace(/^```[a-z0-9_-]*\s*\n?/i, "").replace(/\n?```$/, "").trim();
  if (!text) throw new BrandVoiceError("The voice profile came back empty", 502);
  if (!/[a-z]/i.test(text)) throw new BrandVoiceError("The voice profile must be plain words", 502);
  if (text.length > MAX_VOICE_CHARS) {
    throw new BrandVoiceError(`The voice profile must be ${MAX_VOICE_CHARS} characters or fewer`, 502);
  }
  if (/<\/?[a-z][^>]*>/i.test(text)) throw new BrandVoiceError("The voice profile must be plain text", 502);
  return text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
}

/** Brand voice is a Pro feature; every write path (learn and manual save) checks it here. */
export async function assertBrandVoicePlan(ownerId: string) {
  const entitlements = await entitlementsFor(ownerId);
  if (!entitlements.limits.brandVoice) {
    throw new BrandVoiceError("Brand voice is a Pro feature. Upgrade to learn it from your website.", 403);
  }
}

/**
 * Learn a voice profile from one public page. Pro only, one AI call against the
 * owner's daily limit, and nothing is stored unless the whole flow succeeds.
 */
export async function learnBrandVoice(businessId: number, url: string, deps: BrandVoiceDeps = {}) {
  if (!Number.isSafeInteger(businessId) || businessId <= 0) {
    throw new BrandVoiceError("A valid business id is required");
  }

  const business = (
    await query<{ owner_id: string | null }>("SELECT owner_id FROM businesses WHERE id=$1", [businessId])
  ).rows[0];
  if (!business?.owner_id) throw new BrandVoiceError("business not found", 404);

  await assertBrandVoicePlan(business.owner_id);

  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed) throw new BrandVoiceError("Enter your website URL");

  let page: { url?: string; text: string };
  try {
    page = await (deps.fetchPage ?? fetchReadablePage)(trimmed);
  } catch (error) {
    if (error instanceof SafeFetchError) throw new BrandVoiceError(error.message, error.status);
    throw new BrandVoiceError("We couldn’t read that website. Check the URL and try again.");
  }
  if (!page.text.trim()) throw new BrandVoiceError("That page had no readable text");

  // Charge only when an AI call will actually be made.
  if (!(await chargeGeneration(business.owner_id))) {
    throw new BrandVoiceError("Daily AI limit reached. Try again tomorrow.", 429);
  }

  let voice: string;
  try {
    voice = normalizeVoiceProfile(await (deps.generateProfile ?? generateBrandVoiceProfile)(page.text));
  } catch (error) {
    if (error instanceof BrandVoiceError) throw error;
    throw new BrandVoiceError("We couldn’t write a voice profile from that page. Try another page or edit it by hand.", 502);
  }

  const sourceUrl = page.url ?? trimmed;
  const updated = (
    await query<{ brand_voice: string; brand_voice_source_url: string | null; brand_voice_updated_at: Date }>(
      `UPDATE businesses
       SET brand_voice=$2, brand_voice_source_url=$3, brand_voice_updated_at=now()
       WHERE id=$1
       RETURNING brand_voice, brand_voice_source_url, brand_voice_updated_at`,
      [businessId, voice, sourceUrl]
    )
  ).rows[0];
  if (!updated) throw new BrandVoiceError("business not found", 404);

  return {
    voice: updated.brand_voice,
    sourceUrl: updated.brand_voice_source_url,
    updatedAt: new Date(updated.brand_voice_updated_at).toISOString()
  };
}
