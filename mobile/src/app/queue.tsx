import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Redirect, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as Linking from "expo-linking";
import { api } from "../api";
import { ApiError, bestEffort } from "../api/client";
import { listBusinesses, type Business } from "../api/businesses";
import { fetchGeneration, listDrafts, type Draft, type GenerationSnapshot } from "../api/drafts";
import { fetchEntitlements, type Entitlements } from "../api/entitlements";
import { fetchProfile, type Profile } from "../api/profile";
import { initials } from "../profile/identity";
import { NotificationOffer } from "../notifications/NotificationOffer";
import { parseBusinessId } from "../notifications/links";
import { buildQueue, isGenerating, queueEmptyMessage, queueHeadline } from "../queue/queueState";
import { selectBusinessId } from "../queue/selection";
import { expiryNote, pausedBusinessMessage, quotaMetMessage, usageFor } from "../queue/planSummary";
import { noBusinessView } from "../queue/onboarding";
import { useSession } from "../auth/SessionProvider";
import { appConfig } from "../config";
import { Avatar, Banner, Button, Chip, Section } from "../ui/components";
import { DraftImage } from "../ui/DraftImage";
import { colors } from "../ui/theme";

function statusChip(draft: Draft) {
  if (draft.status === "draft") return <Chip label="Needs approval" tone="warning" />;
  if (draft.status === "approved") return <Chip label="Approved" tone="success" />;
  if (draft.status === "shared") return <Chip label="Shared by you" />;
  if (draft.status === "failed") return <Chip label="Needs a retry" tone="danger" />;
  return <Chip label={draft.status} />;
}

function DraftRow({ draft, businessId }: { draft: Draft; businessId: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open the post quoting ${draft.author_name ?? "a reviewer"}`}
      onPress={() => router.push({ pathname: "/draft/[id]", params: { id: String(draft.id), businessId: String(businessId) } })}
      style={styles.card}
    >
      {draft.image_path ? (
        <DraftImage
          imagePath={draft.image_path}
          style={styles.thumb}
          label={`Post image quoting ${draft.author_name ?? "a reviewer"}`}
        />
      ) : (
        <View style={[styles.thumb, styles.thumbEmpty]}><Text style={styles.thumbEmptyText}>No image</Text></View>
      )}
      <View style={styles.cardBody}>
        {statusChip(draft)}
        <Text style={styles.quote} numberOfLines={2}>{draft.quote_text}</Text>
        <Text style={styles.caption} numberOfLines={2}>{draft.caption_text || "No caption yet"}</Text>
        <Text style={styles.meta}>{draft.author_name ?? "Reviewer"} · {draft.rating ? `${draft.rating}★` : "unrated"}</Text>
      </View>
    </Pressable>
  );
}

export default function QueueScreen() {
  const { status, handleError } = useSession();
  const [businesses, setBusinesses] = useState<Business[] | null>(null);
  const [businessId, setBusinessId] = useState<number | null>(null);
  // Keyed by business: a switch must never show the previous business's drafts
  // under the new name, even when the new request fails.
  const [queue, setQueue] = useState<{ businessId: number; drafts: Draft[]; generation: GenerationSnapshot } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  // Best effort and read-only: a failed plan request must not hide the queue.
  const [plan, setPlan] = useState<Entitlements | null>(null);
  // Only the avatar needs the profile here; the rest of it lives on the profile
  // screen. Reloaded on focus so a name edited there shows up on the way back.
  const [profile, setProfile] = useState<Profile | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Refresh has no effect cleanup of its own, so it checks the selection again
  // after awaiting and drops a response for a business the owner left.
  const businessIdRef = useRef<number | null>(null);

  useEffect(() => { businessIdRef.current = businessId; }, [businessId]);

  // A notification deep-links to /queue?businessId=...; the owned list decides
  // whether that id is selectable, so another owner's id falls back to the first.
  const params = useLocalSearchParams<{ businessId?: string }>();
  const linkedBusinessId = parseBusinessId(params.businessId);
  // The link applies once; the param stays in the route, so a later refresh must
  // keep the business the owner tapped instead of snapping back to it.
  const appliedLinkRef = useRef<number | null>(null);

  // Fetchers stay pure so the effects below only set state after an await.
  const fetchBusinesses = useCallback(() => listBusinesses(api), []);
  const fetchQueue = useCallback((id: number) => Promise.all([
    listDrafts(api, id),
    fetchGeneration(api, id),
    bestEffort(fetchEntitlements(api))
  ]), []);

  // The avatar is owner-wide, not per business, so it loads (and reloads on
  // focus) even when the owner has no business yet.
  useFocusEffect(useCallback(() => {
    if (status !== "signedIn") return;
    let cancelled = false;
    void (async () => {
      try {
        const loadedProfile = await bestEffort(fetchProfile(api));
        if (!cancelled) setProfile(loadedProfile);
      } catch (cause) {
        if (cancelled) return;
        handleError(cause);
      }
    })();
    return () => { cancelled = true; };
  }, [handleError, status]));

  const applyBusinesses = useCallback((list: Business[]) => {
    setBusinesses(list);
    const selection = selectBusinessId({
      linked: linkedBusinessId,
      appliedLink: appliedLinkRef.current,
      current: businessIdRef.current,
      businesses: list
    });
    appliedLinkRef.current = selection.appliedLink;
    setBusinessId(selection.businessId);
    setError(null);
  }, [linkedBusinessId]);

  useEffect(() => {
    if (status !== "signedIn") return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchBusinesses();
        if (!cancelled) applyBusinesses(list);
      } catch (cause) {
        if (cancelled) return;
        handleError(cause);
        setError(cause instanceof ApiError && cause.kind === "network" ? "Can't reach the server. Check your connection and pull to refresh." : "Couldn't load your businesses.");
      }
    })();
    return () => { cancelled = true; };
  }, [applyBusinesses, fetchBusinesses, handleError, status]);

  // Also runs on focus, so approving or archiving on the detail screen shows up
  // as soon as the owner comes back to the list.
  useFocusEffect(useCallback(() => {
    if (status !== "signedIn" || !businessId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [drafts, generation, entitlements] = await fetchQueue(businessId);
        if (cancelled) return;
        setQueue({ businessId, drafts, generation });
        setPlan(entitlements);
        setOffline(false);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        handleError(cause);
        if (cause instanceof ApiError && cause.kind === "network") {
          // Keep the last loaded queue for this business visible; it is read-only.
          setOffline(true);
        } else {
          setError("Couldn't load this week's posts.");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [businessId, fetchQueue, handleError, status]));

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (businessId) {
        const selected = businessId;
        const [drafts, generation, entitlements] = await fetchQueue(selected);
        // The owner may have switched businesses while this was in flight; their
        // newer load must win, or the check below would leave them on a spinner.
        if (businessIdRef.current !== selected) return;
        setQueue({ businessId: selected, drafts, generation });
        setPlan(entitlements);
        setOffline(false);
        setError(null);
      } else {
        // The initial request failed; a pull-to-refresh must be able to recover
        // the business list and pick the first business, not just refetch it.
        applyBusinesses(await fetchBusinesses());
      }
    } catch (cause) {
      handleError(cause);
      setOffline(cause instanceof ApiError && cause.kind === "network");
    } finally {
      setRefreshing(false);
    }
  }, [applyBusinesses, businessId, fetchBusinesses, fetchQueue, handleError]);

  if (status === "signedOut") return <Redirect href="/sign-in" />;

  const noBusiness = noBusinessView(businesses, appConfig.apiBaseUrl);
  const openOnboarding = () => {
    if (!noBusiness?.onboardingUrl) return;
    void Linking.openURL(noBusiness.onboardingUrl).catch(() => {
      setError("Couldn’t open the web app on this phone.");
    });
  };

  const business = businesses?.find(item => item.id === businessId) ?? null;
  const loaded = queue && queue.businessId === businessId ? queue : null;
  const view = loaded ? buildQueue(loaded.drafts, loaded.generation) : null;
  const generating = view ? isGenerating(view) : false;
  const usage = usageFor(plan, businessId);
  const pausedMessage = plan && usage?.paused ? pausedBusinessMessage(plan) : null;
  const limitMessage = plan && usage && !usage.paused ? quotaMetMessage(plan, usage) : null;

  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(); }} tintColor={colors.muted} />}
      >
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>This week</Text>
            <Text style={styles.title}>{business?.name ?? "PraiseLoop"}</Text>
          </View>
          <Avatar
            initials={initials(profile)}
            accessibilityLabel="Open your profile"
            onPress={() => router.push("/profile")}
          />
        </View>

        {businesses && businesses.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.picker}>
            {businesses.map(item => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityState={{ selected: item.id === businessId }}
                onPress={() => setBusinessId(item.id)}
                style={[styles.pickerItem, item.id === businessId && styles.pickerItemSelected]}
              >
                <Text style={[styles.pickerText, item.id === businessId && styles.pickerTextSelected]} numberOfLines={1}>{item.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        <NotificationOffer />

        {noBusiness ? (
          <View style={styles.noBusiness}>
            <Text style={styles.headline}>{noBusiness.heading}</Text>
            <Text style={styles.noBusinessBody}>{noBusiness.body}</Text>
            {noBusiness.onboardingUrl ? (
              <Button label="Set up on the web" onPress={openOnboarding} />
            ) : null}
            <Button
              label="Check again"
              kind="secondary"
              loading={refreshing}
              onPress={() => { void refresh(); }}
            />
          </View>
        ) : null}

        {offline ? (
          <Banner
            message={loaded
              ? "Offline — showing the last loaded queue. Changes are unavailable until you reconnect."
              : "Offline — this business's posts can't be loaded until you reconnect."}
            tone="warning"
          />
        ) : null}
        {error && !offline ? <Banner message={error} tone="danger" /> : null}

        {!loaded && !noBusiness && !error && !offline ? <ActivityIndicator style={styles.loading} /> : null}

        {view ? (
          <>
            <View style={styles.hero}>
              <Text style={styles.headline}>{queueHeadline(view, generating)}</Text>
              {view.progress ? (
                <Text style={styles.progress}>
                  {generating
                    ? `Making ${view.progress.completed} of ${view.progress.target} posts…`
                    : `${view.progress.completed} of ${view.progress.target} posts this week`}
                </Text>
              ) : null}
            </View>

            {pausedMessage ? <Banner message={pausedMessage} tone="warning" /> : null}

            {limitMessage && plan && usage ? <Banner message={`${limitMessage} New posts start ${usage.resetsOn}.${expiryNote(plan) ? ` ${expiryNote(plan)}` : ""}`} tone="warning" /> : null}

            {queueEmptyMessage(view) && view.readyCount === 0 && !limitMessage ? (
              <Banner message={queueEmptyMessage(view)} />
            ) : null}

            {view.awaiting.length > 0 ? (
              <Section title="Ready to review">
                {view.awaiting.map(draft => <DraftRow key={draft.id} draft={draft} businessId={businessId ?? 0} />)}
              </Section>
            ) : null}

            {view.making.length > 0 ? (
              <Section title="Being made" hint="These posts can be reviewed once their caption and image are ready.">
                {view.making.map(draft => (
                  <Text key={draft.id} style={styles.caption} numberOfLines={2}>“{draft.quote_text}”</Text>
                ))}
              </Section>
            ) : null}

            {view.failed.length > 0 ? (
              <Section title="Needs attention" hint="Open a post to retry it from the web for now.">
                {view.failed.map(draft => <DraftRow key={draft.id} draft={draft} businessId={businessId ?? 0} />)}
              </Section>
            ) : null}

            {view.approved.length > 0 ? (
              <Section title="Approved — ready to post" hint="Open a post, then tap Post to share it to Instagram or Facebook.">
                {view.approved.map(draft => <DraftRow key={draft.id} draft={draft} businessId={businessId ?? 0} />)}
              </Section>
            ) : null}

            {view.scheduled.length > 0 ? (
              <Section title="Scheduled" hint="Scheduled on the web app. They are read-only here.">
                {view.scheduled.map(draft => <DraftRow key={draft.id} draft={draft} businessId={businessId ?? 0} />)}
              </Section>
            ) : null}

            {view.shared.length > 0 ? (
              <Section title="Shared" hint="Owner-reported, so these are not claimed as verified publications.">
                {view.shared.map(draft => <DraftRow key={draft.id} draft={draft} businessId={businessId ?? 0} />)}
              </Section>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, paddingBottom: 48, gap: 12 },
  header: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  headerText: { flex: 1, gap: 4 },
  eyebrow: { fontSize: 12, fontWeight: "700", letterSpacing: 1.4, textTransform: "uppercase", color: colors.muted },
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700", color: colors.ink },
  picker: { gap: 8, paddingVertical: 4 },
  pickerItem: { borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, paddingHorizontal: 14, paddingVertical: 8, maxWidth: 220 },
  pickerItemSelected: { backgroundColor: colors.ink, borderColor: colors.ink },
  pickerText: { fontSize: 14, color: colors.ink },
  pickerTextSelected: { color: "#ffffff", fontWeight: "600" },
  loading: { marginTop: 24 },
  noBusiness: { gap: 12, marginTop: 24 },
  noBusinessBody: { fontSize: 16, lineHeight: 23, color: colors.muted },
  hero: { gap: 4, marginTop: 8 },
  headline: { fontSize: 22, lineHeight: 28, fontWeight: "700", color: colors.ink },
  progress: { fontSize: 14, color: colors.muted },
  card: { flexDirection: "row", gap: 12, padding: 10, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  thumb: { width: 84, height: 84, borderRadius: 12, backgroundColor: colors.line },
  thumbEmpty: { alignItems: "center", justifyContent: "center" },
  thumbEmptyText: { fontSize: 11, color: colors.faint },
  cardBody: { flex: 1, gap: 4 },
  quote: { fontSize: 15, lineHeight: 20, fontWeight: "600", color: colors.ink },
  caption: { fontSize: 13, lineHeight: 18, color: colors.muted },
  meta: { fontSize: 12, color: colors.faint }
});
