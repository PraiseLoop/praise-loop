import type { BrandTone } from "../../lib/branding";
import type { DevOwnerKey } from "../../lib/devAuth";

// Everything here is invented (see sample-data/README.md). Reviews come from the
// CSVs in sample-data/csv/ through the real import; a draft points at its review by
// `source_review_id` and quotes it verbatim, like the quote selector does.
export type DraftStatus = "draft" | "approved" | "shared" | "archived" | "failed";

export type DraftSeed = {
  review: string;
  quote: string;
  caption: string;
  status: DraftStatus;
};

export type BusinessSeed = {
  name: string;
  owner: DevOwnerKey;
  csv: string;
  timezone: string;
  tone: BrandTone;
  colors: { primary: string; secondary: string; template: string; quoteSize: string };
  weeklyTarget: number;
  /** A sample voice profile so the Pro demo can walk the brand voice feature. */
  brandVoice?: string;
  /** A stub row only: no refresh token is stored, so nothing can sync. */
  googleLocation?: string;
  drafts: DraftSeed[];
};

export const SEED_BUSINESSES: BusinessSeed[] = [
  {
    name: "Demo — Copper Kettle Café",
    owner: "pro",
    csv: "copper-kettle-cafe.csv",
    timezone: "America/Toronto",
    tone: "friendly",
    colors: { primary: "#8c3b2e", secondary: "#f3e6d6", template: "quote-card-v1", quoteSize: "standard" },
    weeklyTarget: 4,
    brandVoice: "Warm, neighbourly and unhurried, with a fondness for small everyday details. We speak like a barista who knows your order, using plain words and gentle humour. Sentences stay short and inviting, never salesy or grand. We celebrate regulars, early mornings and the quiet corner table.\nExamples: “Your usual is ready.” “Save room for a cinnamon bun.”",
    googleLocation: "accounts/1000000001/locations/2000000001",
    drafts: [
      {
        review: "sample-cafe-001",
        quote: "The flat white is the best in the neighbourhood and the staff remember your name.",
        caption: "Best flat white in the neighbourhood ☕ Thanks for saying so, we'll keep the machine warm.",
        status: "draft"
      },
      {
        review: "sample-cafe-002",
        quote: "Quiet corner, fast wifi, and the cinnamon buns sell out for a reason.",
        caption: "A quiet corner and a warm bun — our favourite kind of morning. Cinnamon buns back tomorrow at 8.",
        status: "draft"
      },
      {
        review: "sample-cafe-003",
        quote: "Staff sorted out my order mix-up in about a minute, no fuss at all.",
        caption: "Mistakes happen; fixing them fast is the whole job. Thanks for the patience, Devon.",
        status: "draft"
      },
      {
        review: "sample-cafe-004",
        quote: "Brought my parents here on Sunday and they haven't stopped talking about the scones.",
        caption: "Scones that impress the parents — high praise. See you next Sunday.",
        status: "approved"
      },
      {
        review: "sample-cafe-005",
        quote: "Warm room, warm welcome, and a proper pot of tea.",
        caption: "A proper pot of tea and a warm welcome, every time. Thanks for stopping in, Ruth.",
        status: "shared"
      },
      {
        review: "sample-cafe-011",
        quote: "Best almond croissant I have had outside of Paris.",
        caption: "High praise for the almond croissant. Get there before ten and it's yours.",
        status: "archived"
      },
      // A generation that gave up: the quote was picked but no caption or image exists.
      {
        review: "sample-cafe-018",
        quote: "That is hospitality.",
        caption: "",
        status: "failed"
      }
    ]
  },
  {
    name: "Demo — Hespeler Powder Coating",
    owner: "pro",
    csv: "hespeler-powder-coating.csv",
    timezone: "America/Toronto",
    tone: "premium",
    colors: { primary: "#1f2a44", secondary: "#e4e7ee", template: "quote-card-v1", quoteSize: "standard" },
    weeklyTarget: 3,
    drafts: [
      {
        review: "sample-hpc-001",
        quote: "The gloss black powder coat is perfect and the price was fair.",
        caption: "Four rusty wheels in, four gloss black rims out. Thanks for trusting us with them, Dave.",
        status: "draft"
      },
      {
        review: "sample-hpc-003",
        quote: "After a trip to Hespeler Powder Coating it looks better than the day we bought it.",
        caption: "Rusted patio furniture, reborn. That's the best part of the job.",
        status: "draft"
      },
      {
        review: "sample-hpc-006",
        quote: "Impressive equipment and knowledgeable people.",
        caption: "Dry ice blasting lifts decades of grime without a scratch. Glad it worked on the engine block, Priya.",
        status: "draft"
      },
      {
        review: "sample-hpc-002",
        quote: "Every weld and corner is covered and the finish is like glass.",
        caption: "A 1970s frame, blasted and coated edge to edge. Thank you, Marcus.",
        status: "approved"
      },
      {
        review: "sample-hpc-004",
        quote: "One shop for the whole job saved me a ton of running around.",
        caption: "Blasting, machining and coating under one roof. Thanks for the kind words, Tom.",
        status: "shared"
      },
      {
        review: "sample-hpc-010",
        quote: "That kind of honesty is rare.",
        caption: "We would rather tell you a part isn't worth coating than take your money. Thanks, Sam.",
        status: "archived"
      }
    ]
  },
  {
    name: "Demo — Harbour Bike Repair",
    owner: "free",
    csv: "harbour-bike-repair.csv",
    timezone: "America/Toronto",
    tone: "playful",
    colors: { primary: "#12283a", secondary: "#dfe7ec", template: "quote-card-v1", quoteSize: "standard" },
    weeklyTarget: 1,
    drafts: [
      {
        review: "sample-bike-001",
        quote: "Two days later it rode like new and the bill was lower than I feared.",
        caption: "Six years in a shed, two days on the stand. Ride it often, Kevin!",
        status: "draft"
      },
      {
        review: "sample-bike-005",
        quote: "Quick flat repair before a ride with the kids and they would not even let me pay.",
        caption: "A flat before a family ride is no way to start. Glad we got you rolling, Josh.",
        status: "approved"
      },
      {
        review: "sample-bike-007",
        quote: "I learned more in ten minutes than in a year of guessing.",
        caption: "",
        status: "failed"
      }
    ]
  }
];

// A syntactically valid Expo token that belongs to no device. The worker may try to
// notify it; Expo answers DeviceNotRegistered and the token is dropped.
export const SEED_PUSH_TOKEN = "ExponentPushToken[devseed-synthetic-0001]";
