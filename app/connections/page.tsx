"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../apiFetch";
import { useBusiness } from "../AppShell";
import {
  channelErrorMessage,
  channelOptionLabel,
  connectionView as bufferConnectionView,
  createRequestGuard,
  isBufferAuthorizeUrl,
  isPersonalInstagram,
  outcomeMessage as bufferOutcomeMessage,
  shouldReloadConnection,
  type BufferChannel,
  type BufferConnectionSummary,
  type RequestGuard
} from "../../lib/buffer/connectionsView";
import {
  connectionView as metaConnectionView,
  isMetaAuthorizeUrl,
  outcomeMessage as metaOutcomeMessage,
  parseTargetValue,
  readTarget,
  targetErrorMessage,
  targetLabel,
  targetOptions,
  targetValue,
  type MetaConnectionSummary,
  type MetaTargetChoice
} from "../../lib/meta/connectionsView";

type SelectedChannel = { id: string; name: string; service: string };
type ChannelRow = { channel: SelectedChannel | null; loading: boolean; busy: boolean; message: string };
type TargetRow = { target: MetaTargetChoice | null; loading: boolean; busy: boolean; message: string };

const ANY_ERROR = "We couldn’t reach the server. Check your connection and try again.";

// The server returns the saved channel without its type; the type is only needed
// to warn about personal Instagram accounts and comes from the connection's list.
function readSelectedChannel(value: unknown): SelectedChannel | null {
  if (!value || typeof value !== "object") return null;
  const channel = value as Record<string, unknown>;
  if (typeof channel.id !== "string" || !channel.id) return null;
  return {
    id: channel.id,
    name: typeof channel.name === "string" ? channel.name : channel.id,
    service: typeof channel.service === "string" ? channel.service : ""
  };
}

export default function ConnectionsPage() {
  const { businesses } = useBusiness();

  // Buffer (#29 part 2). Kept working unchanged alongside direct Meta publishing.
  const [summary, setSummary] = useState<BufferConnectionSummary | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectMessage, setConnectMessage] = useState("");
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const [disconnectError, setDisconnectError] = useState("");
  const [rows, setRows] = useState<Record<string, ChannelRow>>({});
  const guards = useRef<Map<string, RequestGuard>>(new Map());

  // Direct Instagram and Facebook publishing (#234).
  const [metaSummary, setMetaSummary] = useState<MetaConnectionSummary | null>(null);
  const [metaLoadFailed, setMetaLoadFailed] = useState(false);
  const [metaOutcome, setMetaOutcome] = useState<string | null>(null);
  const [metaConnectBusy, setMetaConnectBusy] = useState(false);
  const [metaConnectMessage, setMetaConnectMessage] = useState("");
  const [metaConfirmingDisconnect, setMetaConfirmingDisconnect] = useState(false);
  const [metaDisconnectBusy, setMetaDisconnectBusy] = useState(false);
  const [metaDisconnectError, setMetaDisconnectError] = useState("");
  const [metaRows, setMetaRows] = useState<Record<string, TargetRow>>({});
  const metaGuards = useRef<Map<string, RequestGuard>>(new Map());

  const guardFor = useCallback((id: string) => {
    let guard = guards.current.get(id);
    if (!guard) { guard = createRequestGuard(); guards.current.set(id, guard); }
    return guard;
  }, []);

  const metaGuardFor = useCallback((id: string) => {
    let guard = metaGuards.current.get(id);
    if (!guard) { guard = createRequestGuard(); metaGuards.current.set(id, guard); }
    return guard;
  }, []);

  const loadConnection = useCallback(async () => {
    try {
      const response = await apiFetch("/api/buffer/connection");
      if (!response.ok) { setLoadFailed(true); return; }
      const data = await response.json().catch(() => null) as BufferConnectionSummary | null;
      if (!data || typeof data.connected !== "boolean") { setLoadFailed(true); return; }
      setSummary(data);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  const loadMetaConnection = useCallback(async () => {
    try {
      const response = await apiFetch("/api/meta/connection");
      if (!response.ok) { setMetaLoadFailed(true); return; }
      const data = await response.json().catch(() => null) as MetaConnectionSummary | null;
      if (!data || typeof data.configured !== "boolean" || typeof data.connected !== "boolean") {
        setMetaLoadFailed(true);
        return;
      }
      setMetaSummary(data);
      setMetaLoadFailed(false);
    } catch {
      setMetaLoadFailed(true);
    }
  }, []);

  useEffect(() => { void loadConnection(); void loadMetaConnection(); }, [loadConnection, loadMetaConnection]);

  // The callback only places a fixed outcome code in the URL. Show its message
  // once, then drop that parameter so a refresh does not repeat it. Keep any
  // other parameter, such as the selected business.
  useEffect(() => {
    const url = new URL(window.location.href);
    let changed = false;
    if (url.searchParams.has("buffer")) {
      setOutcome(bufferOutcomeMessage(url.searchParams.get("buffer")));
      url.searchParams.delete("buffer");
      changed = true;
    }
    if (url.searchParams.has("meta")) {
      setMetaOutcome(metaOutcomeMessage(url.searchParams.get("meta")));
      url.searchParams.delete("meta");
      changed = true;
    }
    if (changed) window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  // Active connections list channels for every business. A reload starts new
  // per-business requests, so their tokens supersede saves still in flight.
  const loadChannel = useCallback(async (id: string) => {
    const guard = guardFor(id);
    const token = guard.begin();
    setRows(previous => ({ ...previous, [id]: { channel: previous[id]?.channel ?? null, loading: true, busy: false, message: "" } }));
    try {
      const response = await apiFetch(`/api/businesses/${id}/buffer-channel`);
      if (!guard.isLatest(token)) return;
      const data = await response.json().catch(() => null) as { channel?: unknown } | null;
      setRows(previous => ({
        ...previous,
        [id]: {
          channel: response.ok ? readSelectedChannel(data?.channel) : previous[id]?.channel ?? null,
          loading: false,
          busy: false,
          message: response.ok ? "" : "We couldn’t load this business’s channel. Try again."
        }
      }));
    } catch {
      if (!guard.isLatest(token)) return;
      setRows(previous => ({ ...previous, [id]: { channel: previous[id]?.channel ?? null, loading: false, busy: false, message: ANY_ERROR } }));
    }
  }, [guardFor]);

  const loadMetaTarget = useCallback(async (id: string) => {
    const guard = metaGuardFor(id);
    const token = guard.begin();
    setMetaRows(previous => ({ ...previous, [id]: { target: previous[id]?.target ?? null, loading: true, busy: false, message: "" } }));
    try {
      const response = await apiFetch(`/api/businesses/${id}/meta-target`);
      if (!guard.isLatest(token)) return;
      const data = await response.json().catch(() => null) as { target?: unknown } | null;
      setMetaRows(previous => ({
        ...previous,
        [id]: {
          target: response.ok ? readTarget(data?.target) : previous[id]?.target ?? null,
          loading: false,
          busy: false,
          message: response.ok ? "" : "We couldn’t load this business’s target. Try again."
        }
      }));
    } catch {
      if (!guard.isLatest(token)) return;
      setMetaRows(previous => ({ ...previous, [id]: { target: previous[id]?.target ?? null, loading: false, busy: false, message: ANY_ERROR } }));
    }
  }, [metaGuardFor]);

  useEffect(() => {
    if (!summary || bufferConnectionView(summary) !== "active") { setRows({}); return; }
    for (const business of businesses) void loadChannel(String(business.id));
  }, [summary, businesses, loadChannel]);

  useEffect(() => {
    if (!metaSummary || metaConnectionView(metaSummary) !== "active") { setMetaRows({}); return; }
    for (const business of businesses) void loadMetaTarget(String(business.id));
  }, [metaSummary, businesses, loadMetaTarget]);

  async function connect() {
    setConnectBusy(true);
    setConnectMessage("");
    try {
      const response = await apiFetch("/api/buffer/connect", { method: "POST" });
      const data = await response.json().catch(() => null) as { url?: unknown } | null;
      if (response.status === 503) { setConnectMessage(bufferOutcomeMessage("not_configured") ?? ""); return; }
      if (response.status === 403) { setConnectMessage(bufferOutcomeMessage("plan_required") ?? ""); return; }
      if (!response.ok || !isBufferAuthorizeUrl(data?.url)) {
        setConnectMessage("We couldn’t start the connection. Try again.");
        return;
      }
      window.location.assign(data.url);
    } catch {
      setConnectMessage(ANY_ERROR);
    } finally {
      setConnectBusy(false);
    }
  }

  async function connectMeta() {
    setMetaConnectBusy(true);
    setMetaConnectMessage("");
    try {
      const response = await apiFetch("/api/meta/connect", { method: "POST" });
      const data = await response.json().catch(() => null) as { url?: unknown } | null;
      if (response.status === 503) { setMetaConnectMessage(metaOutcomeMessage("not_configured") ?? ""); return; }
      if (response.status === 403) { setMetaConnectMessage(metaOutcomeMessage("plan_required") ?? ""); return; }
      if (!response.ok || !isMetaAuthorizeUrl(data?.url)) {
        setMetaConnectMessage("We couldn’t start the connection. Try again.");
        return;
      }
      window.location.assign(data.url);
    } catch {
      setMetaConnectMessage(ANY_ERROR);
    } finally {
      setMetaConnectBusy(false);
    }
  }

  async function disconnect() {
    setDisconnectBusy(true);
    setDisconnectError("");
    try {
      const response = await apiFetch("/api/buffer/connection", { method: "DELETE" });
      if (!response.ok) { setDisconnectError("We couldn’t disconnect Buffer. Try again."); return; }
      setConfirmingDisconnect(false);
      setRows({});
      await loadConnection();
    } catch {
      setDisconnectError(ANY_ERROR);
    } finally {
      setDisconnectBusy(false);
    }
  }

  async function disconnectMeta() {
    setMetaDisconnectBusy(true);
    setMetaDisconnectError("");
    try {
      const response = await apiFetch("/api/meta/connection", { method: "DELETE" });
      if (!response.ok) { setMetaDisconnectError("We couldn’t disconnect Instagram and Facebook. Try again."); return; }
      setMetaConfirmingDisconnect(false);
      setMetaRows({});
      await loadMetaConnection();
    } catch {
      setMetaDisconnectError(ANY_ERROR);
    } finally {
      setMetaDisconnectBusy(false);
    }
  }

  async function changeChannel(id: string, channelId: string) {
    const guard = guardFor(id);
    const token = guard.begin();
    const before = rows[id]?.channel ?? null;
    const chosen = channelId ? channels.find(channel => channel.id === channelId) : undefined;
    // Show the new choice immediately; the select is disabled while the request
    // runs, and a failure puts the previous channel back.
    const optimistic: SelectedChannel | null = chosen
      ? { id: chosen.id, name: chosen.name, service: chosen.service }
      : null;
    setRows(previous => ({ ...previous, [id]: { channel: optimistic, loading: false, busy: true, message: "" } }));
    try {
      const response = channelId
        ? await apiFetch(`/api/businesses/${id}/buffer-channel`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ channelId })
          })
        : await apiFetch(`/api/businesses/${id}/buffer-channel`, { method: "DELETE" });
      if (!guard.isLatest(token)) return;
      const data = await response.json().catch(() => null) as { channel?: unknown; error?: unknown } | null;
      if (!response.ok) {
        const code = typeof data?.error === "string" ? data.error : null;
        setRows(previous => ({ ...previous, [id]: { channel: before, loading: false, busy: false, message: channelErrorMessage(code) } }));
        if (shouldReloadConnection(code)) void loadConnection();
        return;
      }
      setRows(previous => ({
        ...previous,
        [id]: {
          channel: readSelectedChannel(data?.channel),
          loading: false,
          busy: false,
          message: channelId ? "Channel saved." : "Channel removed."
        }
      }));
    } catch {
      if (!guard.isLatest(token)) return;
      setRows(previous => ({ ...previous, [id]: { channel: before, loading: false, busy: false, message: ANY_ERROR } }));
    }
  }

  async function changeMetaTarget(id: string, value: string) {
    const guard = metaGuardFor(id);
    const token = guard.begin();
    const before = metaRows[id]?.target ?? null;
    const parsed = parseTargetValue(value);
    const option = parsed ? targetOptions(metaSummary?.pages ?? []).find(candidate => candidate.value === value) : undefined;
    // Show the new target immediately; a failure puts the previous one back.
    const optimistic: MetaTargetChoice | null = option ? { target: option.target, page: option.page } : null;
    setMetaRows(previous => ({ ...previous, [id]: { target: optimistic, loading: false, busy: true, message: "" } }));
    try {
      const response = parsed
        ? await apiFetch(`/api/businesses/${id}/meta-target`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ metaPageId: parsed.metaPageId, target: parsed.target })
          })
        : await apiFetch(`/api/businesses/${id}/meta-target`, { method: "DELETE" });
      if (!guard.isLatest(token)) return;
      const data = await response.json().catch(() => null) as { target?: unknown; error?: unknown } | null;
      if (!response.ok) {
        const code = typeof data?.error === "string" ? data.error : null;
        setMetaRows(previous => ({ ...previous, [id]: { target: before, loading: false, busy: false, message: targetErrorMessage(code) } }));
        if (code === "needs_reconnect") void loadMetaConnection();
        return;
      }
      setMetaRows(previous => ({
        ...previous,
        [id]: {
          target: readTarget(data?.target),
          loading: false,
          busy: false,
          message: parsed ? "Posting target saved." : "Posting target removed."
        }
      }));
    } catch {
      if (!guard.isLatest(token)) return;
      setMetaRows(previous => ({ ...previous, [id]: { target: before, loading: false, busy: false, message: ANY_ERROR } }));
    }
  }

  if (!summary && !loadFailed) return <p className="pl-muted" role="status">Loading your connections…</p>;
  if (!summary) {
    return (
      <div className="pl-empty">
        <h2>We couldn’t load your connections</h2>
        <p className="pl-muted">Check your connection and try again.</p>
        <button type="button" className="pl-btn" onClick={() => void loadConnection()}>Try again</button>
      </div>
    );
  }

  const view = bufferConnectionView(summary);
  const channels = summary.channels;
  const metaView = metaSummary ? metaConnectionView(metaSummary) : null;
  const metaOptions = metaSummary ? targetOptions(metaSummary.pages) : [];
  const connectButton = (label: string) => (
    <button type="button" className="pl-btn pl-btn-primary" onClick={() => void connect()} disabled={connectBusy}>
      {connectBusy ? "Opening Buffer…" : label}
    </button>
  );
  const metaConnectButton = (label: string) => (
    <button type="button" className="pl-btn pl-btn-primary" onClick={() => void connectMeta()} disabled={metaConnectBusy}>
      {metaConnectBusy ? "Opening Facebook…" : label}
    </button>
  );

  return (
    <>
      <header className="pl-header">
        <div className="pl-header-text">
          <span className="pl-eyebrow">Settings</span>
          <h1 className="pl-title">Connections</h1>
          <p className="pl-lede">Choose where your approved posts go.</p>
        </div>
      </header>

      {outcome ? <p role="status" className="pl-banner">{outcome}</p> : null}
      {metaOutcome ? <p role="status" className="pl-banner">{metaOutcome}</p> : null}

      <section aria-labelledby="meta-h" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 id="meta-h" className="pl-h2">Instagram and Facebook</h2>
          <p className="pl-muted" style={{ margin: 0 }}>
            Connect your own Instagram Business account or Facebook Page so PraiseLoop can publish
            approved posts for you. Nothing is posted without your approval.
          </p>
        </div>

        {!metaSummary && !metaLoadFailed ? <p className="pl-muted" role="status">Loading Instagram and Facebook…</p> : null}

        {!metaSummary && metaLoadFailed ? (
          <div className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
            <p style={{ margin: 0 }}>We couldn’t load the Instagram and Facebook connection.</p>
            <button type="button" className="pl-btn" onClick={() => void loadMetaConnection()}>Try again</button>
          </div>
        ) : null}

        {metaView === "not_available" ? (
          <div className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <h3 style={{ margin: 0 }}>Not available yet</h3>
            <p style={{ margin: 0 }}>
              Direct posting to Instagram and Facebook isn’t set up on this server yet. Nothing is
              broken and no Facebook request has been made. Buffer still works if you connect it below,
              and your posts stay in the approval queue until a connection is ready.
            </p>
          </div>
        ) : null}

        {metaView === "not_connected" ? (
          <div className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ margin: 0 }}>
              Use Facebook Login to give PraiseLoop access to your Facebook Pages and any linked
              Instagram Business accounts. You can choose one target for each business after connecting.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
              {metaConnectButton("Connect Instagram or Facebook")}
              {metaConnectMessage ? <p role="status" className="pl-small" style={{ margin: 0 }}>{metaConnectMessage}</p> : null}
            </div>
          </div>
        ) : null}

        {metaView === "needs_reconnect" ? (
          <div className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ margin: 0 }}>
              This connection stopped working. Reconnect Instagram or Facebook to keep your targets.
              Until then, PraiseLoop cannot publish through this connection.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
              {metaConnectButton("Reconnect Instagram or Facebook")}
              {metaConnectMessage ? <p role="status" className="pl-small" style={{ margin: 0 }}>{metaConnectMessage}</p> : null}
            </div>
          </div>
        ) : null}

        {metaView === "active" ? (
          <>
            <div className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <p style={{ margin: 0 }}>PraiseLoop can see the Facebook Pages and linked Instagram accounts you approved.</p>
              <p className="pl-small pl-muted" style={{ margin: 0 }}>
                Disconnecting removes PraiseLoop’s saved access to Instagram and Facebook. To remove
                PraiseLoop from your Facebook account itself, revoke it in Facebook’s settings.
              </p>
              {metaConfirmingDisconnect ? (
                <div role="group" aria-label="Confirm disconnect Meta" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <p style={{ margin: 0, fontWeight: 600 }}>Are you sure?</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    <button type="button" className="pl-btn pl-btn-danger" onClick={() => void disconnectMeta()} disabled={metaDisconnectBusy}>
                      {metaDisconnectBusy ? "Disconnecting…" : "Confirm"}
                    </button>
                    <button type="button" className="pl-btn" onClick={() => { setMetaConfirmingDisconnect(false); setMetaDisconnectError(""); }} disabled={metaDisconnectBusy}>
                      Cancel
                    </button>
                  </div>
                  {metaDisconnectError ? <p role="alert" className="pl-small" style={{ margin: 0 }}>{metaDisconnectError}</p> : null}
                </div>
              ) : (
                <div>
                  <button type="button" className="pl-btn" onClick={() => { setMetaConfirmingDisconnect(true); setMetaDisconnectError(""); }}>Disconnect</button>
                </div>
              )}
            </div>

            {metaSummary?.pages.some(page => page.status === "needs_reconnect") ? (
              <div className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
                <p style={{ margin: 0 }}>One or more Facebook Pages need reconnecting before they can publish.</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                  {metaConnectButton("Reconnect Instagram or Facebook")}
                  {metaConnectMessage ? <p role="status" className="pl-small" style={{ margin: 0 }}>{metaConnectMessage}</p> : null}
                </div>
              </div>
            ) : null}

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <h3 className="pl-h2">Posting targets</h3>
                <p className="pl-muted" style={{ margin: 0 }}>Choose one Instagram Business account or Facebook Page for each business.</p>
              </div>
              {businesses.length === 0 ? <p className="pl-muted">Add a business before choosing a target.</p> : null}
              {metaSummary && metaSummary.pages.length === 0 ? (
                <p className="pl-small pl-muted" style={{ margin: 0 }}>
                  No Facebook Pages were found in the account you approved. Add one in Facebook, then
                  reconnect.
                </p>
              ) : null}
              {metaSummary && metaSummary.pages.length > 0 && metaOptions.length === 0 ? (
                <p className="pl-small pl-muted" style={{ margin: 0 }}>
                  None of your Pages can publish. Check that you manage the Page and that it has a
                  linked Instagram Business account for Instagram posting.
                </p>
              ) : null}
              {businesses.map(business => {
                const id = String(business.id);
                const row = metaRows[id];
                const selected = row?.target ?? null;
                const selectedValue = selected ? targetValue(selected.page.id, selected.target) : "";
                const selectedOption = selectedValue ? metaOptions.find(option => option.value === selectedValue) : undefined;
                const selectedPageGone = selected && !metaSummary?.pages.some(page => page.id === selected.page.id);
                return (
                  <div key={id} className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <label className="pl-field" htmlFor={`meta-target-${id}`}>
                      {business.name}
                      <select
                        id={`meta-target-${id}`}
                        className="pl-select"
                        value={selectedValue}
                        disabled={!row || row.loading || row.busy}
                        onChange={event => void changeMetaTarget(id, event.target.value)}
                      >
                        <option value="">No target</option>
                        {/* A saved target whose Page is gone or no longer listed would otherwise show as "No target". */}
                        {selected && !selectedOption ? (
                          <option value={selectedValue}>{targetLabel(selected.page, selected.target)} (no longer available)</option>
                        ) : null}
                        {metaOptions.map(option => (
                          <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    {selectedPageGone ? (
                      <p className="pl-small" style={{ margin: 0 }}>This target is no longer available. Choose another one.</p>
                    ) : selected && (selected.page.status !== "active" || (selectedOption?.reason)) ? (
                      <p className="pl-small" style={{ margin: 0 }}>
                        {selectedOption?.reason ?? "This target needs reconnecting before it can publish."}
                      </p>
                    ) : null}
                    {!selected && metaOptions.length === 0 && metaSummary && metaSummary.pages.length > 0 ? (
                      <p className="pl-small pl-muted" style={{ margin: 0 }}>This business has no usable Instagram or Facebook target yet.</p>
                    ) : null}
                    <p className="pl-small pl-muted" aria-live="polite" style={{ margin: 0 }}>{row?.message ?? ""}</p>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </section>

      <section aria-labelledby="buffer-h" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 id="buffer-h" className="pl-h2">Buffer</h2>
          <p className="pl-muted" style={{ margin: 0 }}>
            Buffer can publish your approved posts to Instagram or Facebook. It stays available while
            direct Instagram and Facebook publishing is being set up.
          </p>
        </div>

        {view === "not_connected" ? (
          <div className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ margin: 0 }}>
              You need a free Buffer account and either an Instagram Business or Creator account, or a
              Facebook Page. Nothing is posted without your approval.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
              {connectButton("Connect Buffer")}
              {connectMessage ? <p role="status" className="pl-small" style={{ margin: 0 }}>{connectMessage}</p> : null}
            </div>
          </div>
        ) : null}

        {view === "needs_reconnect" ? (
          <div className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ margin: 0 }}>
              This Buffer connection stopped working. Reconnect Buffer to keep your channel choices.
              Until then, PraiseLoop cannot see your channels.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
              {connectButton("Reconnect Buffer")}
              {connectMessage ? <p role="status" className="pl-small" style={{ margin: 0 }}>{connectMessage}</p> : null}
            </div>
          </div>
        ) : null}

        {view === "active" ? (
          <>
            <div className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <p style={{ margin: 0 }}>PraiseLoop can see the Instagram and Facebook channels in your Buffer account.</p>
              <p className="pl-small pl-muted" style={{ margin: 0 }}>
                Disconnecting removes PraiseLoop’s saved access to Buffer. To remove PraiseLoop from your
                Buffer account itself, revoke it in Buffer’s settings.
              </p>
              {confirmingDisconnect ? (
                <div role="group" aria-label="Confirm disconnect" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <p style={{ margin: 0, fontWeight: 600 }}>Are you sure?</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    <button type="button" className="pl-btn pl-btn-danger" onClick={() => void disconnect()} disabled={disconnectBusy}>
                      {disconnectBusy ? "Disconnecting…" : "Confirm"}
                    </button>
                    <button type="button" className="pl-btn" onClick={() => { setConfirmingDisconnect(false); setDisconnectError(""); }} disabled={disconnectBusy}>
                      Cancel
                    </button>
                  </div>
                  {disconnectError ? <p role="alert" className="pl-small" style={{ margin: 0 }}>{disconnectError}</p> : null}
                </div>
              ) : (
                <div>
                  <button type="button" className="pl-btn" onClick={() => { setConfirmingDisconnect(true); setDisconnectError(""); }}>Disconnect</button>
                </div>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <h3 className="pl-h2">Channels</h3>
                <p className="pl-muted" style={{ margin: 0 }}>Choose where each business posts. A business can use one channel.</p>
              </div>
              {businesses.length === 0 ? <p className="pl-muted">Add a business before choosing a channel.</p> : null}
              {channels.length === 0 ? (
                <p className="pl-small pl-muted" style={{ margin: 0 }}>
                  No Instagram or Facebook channels were found in your Buffer account. Add one in
                  Buffer, then reload this page.
                </p>
              ) : null}
              {businesses.map(business => {
                const id = String(business.id);
                const row = rows[id];
                const selected = row?.channel ?? null;
                const fullChannel: BufferChannel | undefined = selected ? channels.find(channel => channel.id === selected.id) : undefined;
                return (
                  <div key={id} className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <label className="pl-field" htmlFor={`buffer-channel-${id}`}>
                      {business.name}
                      <select
                        id={`buffer-channel-${id}`}
                        className="pl-select"
                        value={selected?.id ?? ""}
                        disabled={!row || row.loading || row.busy}
                        onChange={event => void changeChannel(id, event.target.value)}
                      >
                        <option value="">No channel</option>
                        {/* A saved channel that is no longer in the Buffer account would otherwise show as "No channel". */}
                        {selected && !fullChannel ? <option value={selected.id}>{selected.name} (no longer available)</option> : null}
                        {channels.map(channel => <option key={channel.id} value={channel.id}>{channelOptionLabel(channel)}</option>)}
                      </select>
                    </label>
                    {fullChannel && isPersonalInstagram(fullChannel) ? (
                      <p className="pl-small" style={{ margin: 0 }}>
                        This looks like a personal Instagram account. Buffer can only remind you to post
                        from it, not post for you.
                      </p>
                    ) : null}
                    <p className="pl-small pl-muted" aria-live="polite" style={{ margin: 0 }}>{row?.message ?? ""}</p>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </section>
    </>
  );
}
