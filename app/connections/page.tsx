"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../apiFetch";
import { useBusiness } from "../AppShell";
import {
  channelErrorMessage,
  channelOptionLabel,
  connectionView,
  createRequestGuard,
  isBufferAuthorizeUrl,
  isPersonalInstagram,
  outcomeMessage,
  shouldReloadConnection,
  type BufferChannel,
  type BufferConnectionSummary,
  type RequestGuard
} from "../../lib/buffer/connectionsView";

type SelectedChannel = { id: string; name: string; service: string };
type ChannelRow = { channel: SelectedChannel | null; loading: boolean; busy: boolean; message: string };

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

  const guardFor = useCallback((id: string) => {
    let guard = guards.current.get(id);
    if (!guard) { guard = createRequestGuard(); guards.current.set(id, guard); }
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

  useEffect(() => { void loadConnection(); }, [loadConnection]);

  // The callback only places a fixed outcome code in the URL. Show its message
  // once, then drop that parameter so a refresh does not repeat it. Keep any
  // other parameter, such as the selected business.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("buffer")) return;
    const code = url.searchParams.get("buffer");
    setOutcome(outcomeMessage(code));
    url.searchParams.delete("buffer");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
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

  useEffect(() => {
    if (!summary || connectionView(summary) !== "active") { setRows({}); return; }
    for (const business of businesses) void loadChannel(String(business.id));
  }, [summary, businesses, loadChannel]);

  async function connect() {
    setConnectBusy(true);
    setConnectMessage("");
    try {
      const response = await apiFetch("/api/buffer/connect", { method: "POST" });
      const data = await response.json().catch(() => null) as { url?: unknown } | null;
      if (response.status === 503) { setConnectMessage(outcomeMessage("not_configured") ?? ""); return; }
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
        const message = channelErrorMessage(code);
        setRows(previous => ({ ...previous, [id]: { channel: before, loading: false, busy: false, message } }));
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

  const view = connectionView(summary);
  const channels = summary.channels;
  const connectButton = (label: string) => (
    <button type="button" className="pl-btn pl-btn-primary" onClick={() => void connect()} disabled={connectBusy}>
      {connectBusy ? "Opening Buffer…" : label}
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

      {view === "not_connected" ? (
        <section aria-labelledby="buffer-h" className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <h2 id="buffer-h" className="pl-h2">Buffer</h2>
          <p style={{ margin: 0 }}>
            Buffer can publish your approved posts to Instagram or Facebook for you. You need a free
            Buffer account and either an Instagram Business or Creator account, or a Facebook Page.
            Nothing is posted without your approval, and automatic posting is not turned on yet.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            {connectButton("Connect Buffer")}
            {connectMessage ? <p role="status" className="pl-small" style={{ margin: 0 }}>{connectMessage}</p> : null}
          </div>
        </section>
      ) : null}

      {view === "needs_reconnect" ? (
        <section aria-labelledby="reconnect-h" className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <h2 id="reconnect-h" className="pl-h2">Buffer</h2>
          <p style={{ margin: 0 }}>
            This Buffer connection stopped working. Reconnect Buffer to keep your channel choices.
            Until then, PraiseLoop cannot see your channels.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            {connectButton("Reconnect Buffer")}
            {connectMessage ? <p role="status" className="pl-small" style={{ margin: 0 }}>{connectMessage}</p> : null}
          </div>
        </section>
      ) : null}

      {view === "active" ? (
        <>
          <section aria-labelledby="connected-h" className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <h2 id="connected-h" className="pl-h2">Connected</h2>
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
          </section>

          <section aria-labelledby="channels-h" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <h2 id="channels-h" className="pl-h2">Channels</h2>
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
          </section>
        </>
      ) : null}
    </>
  );
}
