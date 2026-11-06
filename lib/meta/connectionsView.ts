// Pure wording and state rules for the web Meta (Instagram / Facebook) connections
// screen (#234). No fetch and no DOM: the page renders these and the tests exercise
// them directly. The server views never carry tokens.
import { META_CREATE_TASKS } from "../integrations/metaPublishing";

export { createRequestGuard, type RequestGuard } from "../buffer/connectionsView";

export type MetaTargetKind = "instagram" | "facebook";
export type MetaPageView = {
  id: number;
  pageId: string;
  name: string;
  instagramBusinessAccountId: string | null;
  tasks: string[];
  status: "active" | "needs_reconnect";
};
export type MetaConnectionSummary = {
  configured: boolean;
  connected: boolean;
  status: "active" | "needs_reconnect" | null;
  pages: MetaPageView[];
};
export type MetaConnectionView = "not_available" | "not_connected" | "active" | "needs_reconnect";
export type MetaTargetChoice = { target: MetaTargetKind; page: MetaPageView };
export type MetaTargetOption = {
  value: string;
  target: MetaTargetKind;
  page: MetaPageView;
  label: string;
  disabled: boolean;
  reason: string | null;
};

// Fixed callback codes only. Unknown values show nothing, so a crafted link
// cannot put text on the page.
const OUTCOME_MESSAGES: Record<string, string> = {
  connected: "Instagram and Facebook are connected.",
  no_pages: "You approved Facebook, but no Facebook Pages were found. Add a Page, then connect again.",
  denied: "You didn’t approve the connection to Facebook. You can try again.",
  expired: "That connection attempt took too long. Please start again.",
  failed: "We couldn’t finish connecting to Instagram and Facebook. Please try again.",
  not_configured: "Direct posting to Instagram and Facebook isn’t set up on this server yet.",
  plan_required: "Automatic posting is included in Pro and Business, so this plan can’t connect Instagram or Facebook. Your phone share sheet and image download still work."
};

export function outcomeMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return OUTCOME_MESSAGES[code] ?? null;
}

// The target routes answer with short codes; owners see a plain sentence.
const TARGET_ERRORS: Record<string, string> = {
  not_configured: "Direct posting isn’t set up on this server yet.",
  plan_required: "Automatic posting is included in Pro and Business, so this plan can’t choose an Instagram account or Facebook Page.",
  expired: "That connection attempt took too long. Reconnect Instagram or Facebook to continue.",
  failed: "We couldn’t finish that change. Try again.",
  not_connected: "Instagram and Facebook aren’t connected. Connect them again to choose where this business posts.",
  needs_reconnect: "This Page needs reconnecting. Reconnect Instagram or Facebook to continue.",
  not_found: "We couldn’t find that business or Page. Reload the page and try again.",
  invalid_target: "Choose an Instagram account or a Facebook Page.",
  instagram_unavailable: "That Facebook Page has no linked Instagram account. Choose Facebook or another Page.",
  page_cannot_publish: "That Facebook Page doesn’t allow PraiseLoop to post. Choose another Page.",
  unknown: "We couldn’t save that posting target. Try again."
};

export function targetErrorMessage(code: string | null | undefined): string {
  return (code ? TARGET_ERRORS[code] : undefined) ?? TARGET_ERRORS.unknown;
}

/** A Page may publish only when Meta granted a create-content task. */
export function pageCanPublish(page: Pick<MetaPageView, "tasks">): boolean {
  return page.tasks.some(task => META_CREATE_TASKS.has(task));
}

/**
 * Fail closed: a connection is only usable when the server says it is configured
 * and active. A missing status is treated as needing reconnect, never as ready.
 */
export function connectionView(summary: MetaConnectionSummary): MetaConnectionView {
  if (!summary.configured) return "not_available";
  if (!summary.connected) return "not_connected";
  return summary.status === "active" ? "active" : "needs_reconnect";
}

export function targetValue(metaPageId: number, target: MetaTargetKind): string {
  return `${metaPageId}:${target}`;
}

export function parseTargetValue(value: string | null | undefined): { metaPageId: number; target: MetaTargetKind } | null {
  if (!value) return null;
  const match = /^(\d+):(instagram|facebook)$/.exec(value);
  if (!match) return null;
  const metaPageId = Number(match[1]);
  if (!Number.isSafeInteger(metaPageId) || metaPageId <= 0) return null;
  return { metaPageId, target: match[2] as MetaTargetKind };
}

export function targetLabel(page: Pick<MetaPageView, "name">, target: MetaTargetKind): string {
  return `${page.name} (${target === "instagram" ? "Instagram" : "Facebook"})`;
}

/**
 * One option per usable target. An Instagram option exists only when the Page has
 * a linked professional account; a Page without a create-content task or a Page
 * flagged for reconnect stays visible but disabled, so the owner sees why.
 */
export function targetOptions(pages: MetaPageView[]): MetaTargetOption[] {
  const options: MetaTargetOption[] = [];
  for (const page of pages) {
    const reasons: string[] = [];
    if (page.status !== "active") reasons.push("This Page needs reconnecting.");
    if (!pageCanPublish(page)) reasons.push("This Page doesn’t allow PraiseLoop to post.");
    for (const target of ["instagram", "facebook"] as const) {
      if (target === "instagram" && !page.instagramBusinessAccountId) continue;
      options.push({
        value: targetValue(page.id, target),
        target,
        page,
        label: targetLabel(page, target),
        disabled: reasons.length > 0,
        reason: reasons[0] ?? null
      });
    }
  }
  return options;
}

/** Read the saved target returned by GET /api/businesses/:id/meta-target. */
export function readTarget(value: unknown): MetaTargetChoice | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (body.target !== "instagram" && body.target !== "facebook") return null;
  const raw = body.page;
  if (!raw || typeof raw !== "object") return null;
  const page = raw as Record<string, unknown>;
  if (typeof page.id !== "number" || !Number.isSafeInteger(page.id) || page.id <= 0) return null;
  if (typeof page.pageId !== "string" || !page.pageId) return null;
  return {
    target: body.target,
    page: {
      id: page.id,
      pageId: page.pageId,
      name: typeof page.name === "string" && page.name ? page.name : page.pageId,
      instagramBusinessAccountId: typeof page.instagramBusinessAccountId === "string" ? page.instagramBusinessAccountId : null,
      tasks: Array.isArray(page.tasks) ? page.tasks.filter((task): task is string => typeof task === "string") : [],
      status: page.status === "active" ? "active" : "needs_reconnect"
    }
  };
}

// The page sends the browser to whatever address the server returns. It is our own
// authenticated API, but only Meta's own sign-in dialog is a valid place to go, so
// anything else is refused rather than navigated to.
export function isMetaAuthorizeUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "www.facebook.com"
      && /^\/v\d{1,3}\.\d{1,3}\/dialog\/oauth$/.test(url.pathname)
      && !url.username
      && !url.password
      && !url.port;
  } catch {
    return false;
  }
}
