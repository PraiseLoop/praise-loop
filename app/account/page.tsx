"use client";
import { useBusiness, useProfile } from "../AppShell";
import { apiFetch } from "../apiFetch";
import ProfileNameForm from "../ProfileNameForm";
import { signIn, signOut } from "next-auth/react";
import { useCallback, useEffect, useState } from "react";
import { ADD_NAME_HINT, ADD_NAME_PROMPT, displayName } from "../../lib/profileDisplay";
import { expiryNote, formatLocalDate, planName, quotaMetMessage } from "../../lib/planDisplay";
import { usePlan } from "../ui/usePlan";

const sources = { default: "Default plan", manual: "Set by PraiseLoop support", store: "App store subscription" } as const;
const yesNo = (value: boolean) => value ? "Included" : "Not included";

type AuthMethod = { provider: string; email: string | null; addedAt: string | null; lastUsedAt: string | null };
const providerNames: Record<string, string> = { google: "Google", apple: "Apple", microsoft: "Microsoft" };
const methodName = (provider: string) => providerNames[provider] ?? provider;
const methodAdded = (addedAt: string | null) => addedAt ? `Added ${addedAt.slice(0, 10)}` : "Added before we tracked method dates";

// The full profile and plan page (#150), reached from the profile menu. The name is
// the only editable part; email is the verified sign-in address and plans are
// changed by operators or a verified store webhook, never here.
export default function AccountPage() {
  const { status } = useBusiness();
  const { profile, loaded } = useProfile();
  const { plan, failed } = usePlan();
  const [editing, setEditing] = useState(false);
  const [methods, setMethods] = useState<AuthMethod[] | null>(null);
  const [methodError, setMethodError] = useState<string | null>(null);
  const [methodNotice, setMethodNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadMethods = useCallback(async () => {
    try {
      const response = await apiFetch("/api/account/methods");
      if (!response.ok) { setMethodError("We couldn’t load your sign-in methods."); return; }
      const data = await response.json() as { methods?: AuthMethod[] };
      setMethods(data.methods ?? []);
      setMethodError(null);
    } catch {
      setMethodError("We couldn’t load your sign-in methods.");
    }
  }, []);

  useEffect(() => { void loadMethods(); }, [loadMethods]);
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get("linked");
    if (linked) setMethodNotice(`${methodName(linked)} linked.`);
  }, []);

  async function unlink(provider: string) {
    setBusy(provider);
    setMethodError(null);
    setMethodNotice(null);
    try {
      const response = await apiFetch("/api/account/methods", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider })
      });
      const data = await response.json().catch(() => null) as { error?: string; methods?: AuthMethod[] } | null;
      if (!response.ok) { setMethodError(data?.error ?? "We couldn’t unlink that method."); return; }
      setMethods(data?.methods ?? []);
      setMethodNotice(`${methodName(provider)} unlinked.`);
    } catch {
      setMethodError("We couldn’t unlink that method.");
    } finally {
      setBusy(null);
    }
  }

  async function deleteAccount() {
    if (confirmDelete !== "DELETE" || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await apiFetch("/api/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        setDeleteError(data?.error ?? "We couldn’t delete your account. Try again.");
        setDeleting(false);
        return;
      }
      // The server already removed the session; this only clears the browser copy.
      try { await signOut({ redirect: false }); } catch { /* the redirect below still leaves signed out */ }
      window.location.assign("/");
    } catch {
      setDeleteError("We couldn’t delete your account. Check your connection and try again.");
      setDeleting(false);
    }
  }

  if (status === "loading" || (!plan && !failed)) return <p className="pl-muted" role="status">Loading your plan…</p>;
  if (!plan) return <div className="pl-empty"><h2>We couldn’t load your plan</h2><p className="pl-muted">Check your connection and reload the page.</p></div>;

  const name = displayName(profile?.name ?? null);
  const note = expiryNote(plan);
  const { limits } = plan;
  const rows: [string, string][] = [
    ["Posts per week, per business", String(limits.postsPerWeek)],
    ["Templates", String(limits.templates)],
    ["Watermark on images", limits.watermark ? "Yes" : "No"],
    ["Automatic review sync", yesNo(limits.reviewSync)],
    ["AI review replies", yesNo(limits.aiReplies)],
    ["Businesses", String(limits.businesses)]
  ];

  return (
    <>
      <header className="pl-header">
        <div className="pl-header-text">
          <span className="pl-eyebrow">Profile</span>
          <h1 className="pl-title">{loaded ? name ?? ADD_NAME_PROMPT : "Your profile"}</h1>
          <p className="pl-lede">{loaded ? name ? profile?.email : ADD_NAME_HINT : ""}</p>
        </div>
      </header>

      <section aria-labelledby="details-h" className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 id="details-h" className="pl-h2">Your details</h2>
        {!loaded ? (
          <p className="pl-muted" role="status">Loading your profile…</p>
        ) : editing ? (
          <ProfileNameForm initial={profile?.name ?? ""} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
        ) : (
          <>
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px 24px" }}>
              <div>
                <dt className="pl-small pl-muted">Name</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>{name ?? ADD_NAME_PROMPT}</dd>
              </div>
              <div>
                <dt className="pl-small pl-muted">Email</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>{profile?.email ?? "…"}</dd>
                <dd className="pl-small pl-muted" style={{ margin: 0 }}>The address you sign in with. Read-only.</dd>
              </div>
            </dl>
            <div>
              <button type="button" className="pl-btn" onClick={() => setEditing(true)}>{name ? "Edit name" : ADD_NAME_PROMPT}</button>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="plan-h" className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="plan-h" className="pl-h2">{planName(plan.plan)} plan</h2>
        <p className="pl-muted" style={{ margin: 0 }}>
          {sources[plan.source]}{plan.expiresAt && plan.plan !== "free" ? `, until ${plan.expiresAt.slice(0, 10)}` : ""}
        </p>
        {note ? <p role="status" style={{ margin: 0, fontWeight: 600 }}>{note}</p> : null}
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px 24px" }}>
          {rows.map(([label, value]) => (
            <div key={label}><dt className="pl-small pl-muted">{label}</dt><dd style={{ margin: 0, fontWeight: 600 }}>{value}</dd></div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="usage-h" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h2 id="usage-h" className="pl-h2">This week</h2>
        {plan.usage.length ? plan.usage.map(u => (
          <div key={u.businessId} className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <strong>{u.name}</strong>
            <span>{u.allocated} of {u.target} {u.target === 1 ? "post" : "posts"} this week</span>
            <span className="pl-small pl-muted">Resets {formatLocalDate(u.resetsOn)} ({u.timezone})</span>
            {quotaMetMessage(plan, u) ? <span className="pl-small">{quotaMetMessage(plan, u)}</span> : null}
          </div>
        )) : <p className="pl-muted">Add a business to see your weekly usage.</p>}
      </section>

      <section aria-labelledby="methods-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="methods-h" className="pl-h2">Sign-in methods</h2>
        <p className="pl-muted" style={{ margin: 0 }}>
          These are the ways you can get into your account. Keep at least one so you can sign in again.
        </p>
        {methodNotice ? <p role="status" style={{ margin: 0, fontWeight: 600 }}>{methodNotice}</p> : null}
        {methodError ? <p role="alert" className="pl-banner">{methodError} <button type="button" className="pl-link-button" onClick={() => void loadMethods()}>Try again</button></p> : null}
        {methods === null && !methodError ? <p className="pl-muted" role="status">Loading your sign-in methods…</p> : null}
        {methods?.length ? methods.map((method, index) => (
          <div key={index} className="pl-panel" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <strong>{methodName(method.provider)}</strong>
              <span className="pl-small pl-muted">{method.email ?? "No email on this method"}</span>
              <span className="pl-small pl-muted">{methodAdded(method.addedAt)}</span>
            </div>
            <button
              type="button"
              className="pl-btn"
              disabled={methods.length < 2 || busy === method.provider}
              onClick={() => void unlink(method.provider)}
            >
              {busy === method.provider ? "Unlinking…" : "Unlink"}
            </button>
          </div>
        )) : methods ? <p className="pl-muted">No sign-in method is linked yet.</p> : null}
        {methods && !methods.some(method => method.provider === "google") ? (
          <div><button type="button" className="pl-btn" onClick={() => void signIn("google", { callbackUrl: "/account?linked=google" })}>Link Google</button></div>
        ) : null}
        {methods?.length === 1 ? <p className="pl-small pl-muted" style={{ margin: 0 }}>You can’t unlink your only method. Add another method first.</p> : null}
      </section>

      <section aria-labelledby="delete-h" className="pl-panel" style={{ borderColor: "#E7C4BB", display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="delete-h" className="pl-h2" style={{ color: "#A3361F" }}>Delete account</h2>
        <p style={{ margin: 0 }}>
          This permanently deletes your account and everything in it: your businesses, reviews, posts,
          drafts, images, sign-in methods and sessions. There is no recovery period, and deleted data
          cannot be restored.
        </p>
        <p className="pl-small pl-muted" style={{ margin: 0 }}>
          Deleting your account does not cancel an App Store or Google Play subscription. Cancel it in
          the App Store (Apple ID → Subscriptions) or Google Play (Payments &amp; subscriptions →
          Subscriptions) first, otherwise the store may keep charging you.
        </p>
        <label htmlFor="delete-confirm" style={{ fontWeight: 600 }}>Type DELETE to confirm</label>
        <input
          id="delete-confirm"
          className="pl-input"
          value={confirmDelete}
          onChange={event => { setConfirmDelete(event.target.value); setDeleteError(null); }}
          autoComplete="off"
          spellCheck={false}
          disabled={deleting}
          style={{ maxWidth: 280 }}
        />
        {deleteError ? <p role="alert" className="pl-small" style={{ margin: 0, color: "#A3361F", fontWeight: 600 }}>{deleteError}</p> : null}
        <div>
          <button
            type="button"
            className="pl-btn pl-btn-danger"
            disabled={confirmDelete !== "DELETE" || deleting}
            onClick={() => void deleteAccount()}
          >
            {deleting ? "Deleting…" : "Delete account"}
          </button>
        </div>
      </section>
    </>
  );
}
