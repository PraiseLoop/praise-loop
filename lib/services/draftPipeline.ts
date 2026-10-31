import { renderDraftImage } from "./imageRenderer";
import { selectQuoteCandidates } from "./quoteSelector";
import { generateCaptionVariants } from "./captions";
import { query } from "../db";
import type { BrandTone } from "../branding";

type BusinessRow = {
  id: number;
  name: string;
  brand_colors: Record<string, string> | null;
  logo_url: string | null;
  brand_tone: BrandTone;
  brand_voice?: string | null;
};

type CandidateRow = {
  draftPostId: number;
  reviewId: number;
  quoteText: string;
  score: number;
};

type CaptionSet = { friendly: string; premium: string; playful: string };

type PipelineOptions = {
  perBusinessLimit?: number;
};

export type PipelineResult = {
  businessesScanned: number;
  candidatesInserted: number;
  draftsCompleted: number;
  draftsFailed: number;
};

type DraftPipelineDeps = {
  listBusinesses: () => Promise<BusinessRow[]>;
  selectQuoteCandidates: (businessId: number, limit: number) => Promise<CandidateRow[]>;
  generateCaptionVariants: (params: { businessName: string; quoteText: string; brandTone?: BrandTone; brandVoice?: string | null }) => Promise<CaptionSet>;
  updateDraftCaption: (draftPostId: number, captionText: string) => Promise<void>;
  renderDraftImage: (params: {
    draftPostId: number;
    businessName: string;
    quoteText: string;
    brandHex?: string | null;
    secondaryBrandHex?: string | null;
    logoUrl?: string | null;
    brandTone?: BrandTone;
    templateConfig?: unknown;
  }) => Promise<{ publicPath: string }>;
  updateDraftImagePath: (draftPostId: number, imagePath: string) => Promise<void>;
  markDraftFailed: (draftPostId: number, reason: string) => Promise<void>;
};

function pickCaption(captions: CaptionSet, brandTone: BrandTone) {
  return captions[brandTone] || captions.friendly || captions.premium || captions.playful;
}

export function createDraftGenerationRunner(deps: DraftPipelineDeps) {
  return async function runDraftGenerationJob(options: PipelineOptions = {}): Promise<PipelineResult> {
    const perBusinessLimit = options.perBusinessLimit ?? 5;
    const businesses = await deps.listBusinesses();

    let candidatesInserted = 0;
    let draftsCompleted = 0;
    let draftsFailed = 0;

    for (const business of businesses) {
      const candidates = await deps.selectQuoteCandidates(business.id, perBusinessLimit);
      candidatesInserted += candidates.length;

      for (const candidate of candidates) {
        try {
          const captions = await deps.generateCaptionVariants({
            businessName: business.name,
            quoteText: candidate.quoteText,
            brandTone: business.brand_tone,
            brandVoice: business.brand_voice
          });

          await deps.updateDraftCaption(candidate.draftPostId, pickCaption(captions, business.brand_tone));

          const brandHex = business.brand_colors?.primary ?? null;
          const secondaryBrandHex = business.brand_colors?.secondary ?? null;
          const rendered = await deps.renderDraftImage({
            draftPostId: candidate.draftPostId,
            businessName: business.name,
            quoteText: candidate.quoteText,
            brandHex,
            secondaryBrandHex,
            logoUrl: business.logo_url,
            brandTone: business.brand_tone,
            templateConfig: business.brand_colors
          });

          await deps.updateDraftImagePath(candidate.draftPostId, rendered.publicPath);
          draftsCompleted += 1;
        } catch (err) {
          draftsFailed += 1;
          const message = err instanceof Error ? err.message : String(err);
          await deps.markDraftFailed(candidate.draftPostId, `pipeline_failed: ${message}`);
        }
      }
    }

    return {
      businessesScanned: businesses.length,
      candidatesInserted,
      draftsCompleted,
      draftsFailed
    };
  };
}

const runDraftGenerationWithDb = createDraftGenerationRunner({
  listBusinesses: async () => {
    const businesses = await query<BusinessRow>(
      `SELECT id, name, brand_colors, logo_url, brand_tone, brand_voice
       FROM businesses
       ORDER BY id ASC`
    );
    return businesses.rows;
  },
  selectQuoteCandidates,
  generateCaptionVariants,
  updateDraftCaption: async (draftPostId, captionText) => {
    await query(
      `UPDATE draft_posts
       SET caption_text = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [draftPostId, captionText]
    );
  },
  renderDraftImage,
  updateDraftImagePath: async (draftPostId, imagePath) => {
    await query(
      `UPDATE draft_posts
       SET image_path = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [draftPostId, imagePath]
    );
  },
  markDraftFailed: async (draftPostId, reason) => {
    await query(
      `UPDATE draft_posts
       SET status = 'failed',
           audit_note = LEFT($2, 300),
           updated_at = NOW()
       WHERE id = $1`,
      [draftPostId, reason]
    );
  }
});

export async function runDraftGenerationJob(options: PipelineOptions = {}) {
  return runDraftGenerationWithDb(options);
}

export const __internal = { pickCaption };
