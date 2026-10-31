"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { apiFetch } from "./apiFetch";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Icon, { type IconName } from "./ui/Icon";
import ProfileMenu from "./ProfileMenu";
import type { Profile } from "../lib/services/profile";

export type Business = {
  id: number | string; name: string; timezone: string; logo_url: string | null; brand_tone: string; weekly_target: number;
  brand_voice?: string | null; brand_voice_source_url?: string | null; brand_voice_updated_at?: string | null;
  brand_colors: { primary: string; secondary: string; template: string; quoteSize: string };
};
type BusinessState = {
  status: "loading" | "signed-out" | "error" | "ready";
  businesses: Business[];
  business: Business | null;
  select: (id: number | string) => void;
  reload: () => Promise<void>;
};

const BusinessContext = createContext<BusinessState | null>(null);
const storageKey = "praise-business";

export function useBusiness() {
  const value = useContext(BusinessContext);
  if (!value) throw new Error("useBusiness must be used inside AppShell");
  return value;
}

type ProfileState = {
  profile: Profile | null;
  /** False until the first profile request settles, so pages don't flash the wrong prompt. */
  loaded: boolean;
  /** Saves the name and returns an error message, or null on success. */
  saveName: (name: string) => Promise<string | null>;
};
const ProfileContext = createContext<ProfileState | null>(null);

// One fetch for the menu and the profile page, so editing the name updates both
// without a reload (#150).
export function useProfile() {
  const value = useContext(ProfileContext);
  if (!value) throw new Error("useProfile must be used inside AppShell");
  return value;
}

const nav: { href: string; label: string; icon: IconName; match: string[] }[] = [
  { href: "/approval", label: "This week", icon: "week", match: ["/approval"] },
  { href: "/schedule", label: "Schedule", icon: "calendar", match: ["/schedule"] },
  { href: "/reviews", label: "Reviews", icon: "reviews", match: ["/reviews", "/quotes"] },
  { href: "/brand", label: "Brand", icon: "palette", match: ["/brand"] }
];

function readStored() { try { return localStorage.getItem(storageKey); } catch { return null; } }
function writeStored(id: number | string) { try { localStorage.setItem(storageKey, String(id)); } catch { /* per-viewer convenience only */ } }

// On phones the sidebar is hidden, so the switcher also offers adding a business.
// Sign out and the plan live in the profile menu now (#150).
function BusinessSwitcher({ id, withAdd = false }: { id: string; withAdd?: boolean }) {
  const { businesses, business, select } = useBusiness();
  const router = useRouter();
  if (!businesses.length) return null;
  function change(value: string) {
    if (value === "__add") router.push("/onboarding?new=1");
    else select(value);
  }
  return (
    <div className="pl-switcher">
      <label htmlFor={id}>Business</label>
      <select id={id} className="pl-select" value={business?.id ?? ""} onChange={e => change(e.target.value)}>
        {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        {withAdd ? <optgroup label="Account"><option value="__add">+ Add a business</option></optgroup> : null}
      </select>
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [status, setStatus] = useState<BusinessState["status"]>("loading");
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);

  const loadProfile = useCallback(async () => {
    try {
      const response = await apiFetch("/api/profile");
      if (response.ok) setProfile(await response.json());
    } catch { /* the menu stays without a name; the next load tries again */ }
    finally { setProfileLoaded(true); }
  }, []);

  const saveName = useCallback(async (name: string) => {
    try {
      const response = await apiFetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        return body?.error ?? "We couldn’t save your name. Try again.";
      }
      setProfile(await response.json());
      return null;
    } catch {
      return "We couldn’t save your name. Try again.";
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      const response = await apiFetch("/api/businesses");
      if (response.status === 401) { setStatus("signed-out"); return; }
      if (!response.ok) { setStatus("error"); return; }
      const list: Business[] = (await response.json()).businesses ?? [];
      setBusinesses(list);
      setSelectedId(current => {
        const requested = new URL(window.location.href).searchParams.get("businessId") ?? (current ? String(current) : readStored());
        const match = list.find(b => String(b.id) === requested) ?? list[0];
        return match ? String(match.id) : null;
      });
      setStatus("ready");
    } catch { setStatus("error"); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { if (status === "ready") void loadProfile(); }, [status, loadProfile]);

  // A tab left open overnight has a dead session but nothing polling it. When the owner
  // comes back, ask once; apiFetch sends them to sign-in on a 401. Other outcomes are
  // ignored here, and at most one check runs per half minute.
  useEffect(() => {
    let last = Date.now();
    const check = () => {
      if (document.visibilityState === "hidden" || Date.now() - last < 30000) return;
      last = Date.now();
      void apiFetch("/api/businesses").catch(() => undefined);
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => { document.removeEventListener("visibilitychange", check); window.removeEventListener("focus", check); };
  }, []);

  // Ids arrive as strings for bigint columns, so compare them as strings throughout.
  const select = useCallback((id: number | string) => {
    setSelectedId(String(id));
    writeStored(id);
    const url = new URL(window.location.href);
    url.searchParams.set("businessId", String(id));
    window.history.replaceState(null, "", url);
  }, []);

  const business = businesses.find(b => String(b.id) === selectedId) ?? null;
  useEffect(() => { if (business) writeStored(business.id); }, [business]);

  // The landing page, public plans, the development email outbox and onboarding wizard
  // are full-screen flows without app navigation; the plans page must stay readable
  // when signed out.
  const bare = pathname === "/" || pathname === "/plans" || pathname === "/dev/outbox" || pathname.startsWith("/onboarding");
  const value = { status, businesses, business, select, reload };
  const profileValue = { profile, loaded: profileLoaded, saveName };
  if (bare) return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>;

  const current = (item: typeof nav[number]) => item.match.some(path => pathname.startsWith(path)) ? "page" : undefined;
  const brand = <Link href="/approval" className="pl-brand"><span className="pl-brand-mark"><Icon name="loop" strokeWidth={2.2} /></span><span className="pl-brand-text">PraiseLoop</span></Link>;

  return (
    <BusinessContext.Provider value={value}>
      <ProfileContext.Provider value={profileValue}>
        <div className="pl-shell">
          <aside className="pl-sidebar">
            {brand}
            {status === "ready" ? <BusinessSwitcher id="business-switcher" /> : null}
            {status === "ready" ? <Link href="/onboarding?new=1" className="pl-small" style={{ padding: "0 4px", fontWeight: 600, marginTop: -16 }}>+ Add a business</Link> : null}
            <nav aria-label="Main" className="pl-nav">
              {nav.map(item => <Link key={item.label} href={item.href} aria-current={current(item)}><Icon name={item.icon} />{item.label}</Link>)}
            </nav>
            <div className="pl-account">
              {status === "signed-out"
                ? <button type="button" className="pl-btn pl-btn-dark" onClick={() => signIn("google")}>Sign in with Google</button>
                : status === "ready" ? <ProfileMenu /> : null}
            </div>
          </aside>
          <header className="pl-topbar">
            {brand}
            {status === "signed-out"
              ? <button type="button" className="pl-btn pl-btn-dark" onClick={() => signIn("google")}>Sign in</button>
              : status === "ready" ? <div className="pl-topbar-actions"><BusinessSwitcher id="business-switcher-phone" withAdd /><ProfileMenu compact /></div> : null}
          </header>
          <main className="pl-main">
            <div className="pl-container">
              {status === "signed-out" ? (
                <div className="pl-empty">
                  <h2>Sign in to see your posts</h2>
                  <p className="pl-muted">Your businesses, reviews and drafts are private to your account.</p>
                  <button type="button" className="pl-btn pl-btn-primary pl-btn-lg" onClick={() => signIn("google")}>Sign in with Google</button>
                </div>
              ) : status === "error" ? (
                <div className="pl-empty">
                  <h2>We couldn’t load your account</h2>
                  <p className="pl-muted">Check your connection and try again.</p>
                  <button type="button" className="pl-btn" onClick={() => void reload()}>Try again</button>
                </div>
              ) : children}
            </div>
          </main>
          <nav aria-label="Main" className="pl-tabbar">
            {nav.map(item => <Link key={item.label} href={item.href} aria-current={current(item)}><Icon name={item.icon} size={22} />{item.label}</Link>)}
          </nav>
        </div>
      </ProfileContext.Provider>
    </BusinessContext.Provider>
  );
}
