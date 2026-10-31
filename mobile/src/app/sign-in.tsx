import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Redirect, router } from "expo-router";
import { api } from "../api";
import { ApiError } from "../api/client";
import { fetchMobileConfig, type MobileConfig } from "../api/config";
import { appleSignInAvailable, isAppleSignInCancelled, signInWithApple } from "../auth/apple";
import { googleSignInAvailable, isGoogleSignInCancelled, signInWithGoogle } from "../auth/google";
import { isMicrosoftSignInCancelled, microsoftSignInAvailable, signInWithMicrosoft } from "../auth/microsoft";
import { useSession } from "../auth/SessionProvider";
import { DEMO_OWNERS, type DemoOwnerKey } from "../auth/demoOwners";
import { appConfig } from "../config";
import { Banner, Button } from "../ui/components";
import { colors } from "../ui/theme";

export default function SignInScreen() {
  const { status, sessionEnded, signInDemo, signInEmail, signInGoogle, signInApple, signInMicrosoft } = useSession();
  const [config, setConfig] = useState<MobileConfig | null>(null);
  const [appleReady, setAppleReady] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [emailStage, setEmailStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMobileConfig(api)
      .then(value => { if (!cancelled) setConfig(value); })
      .catch(() => { if (!cancelled) setConfigError("Can’t reach the PraiseLoop server. Check that it is running and that the app points at your machine."); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    appleSignInAvailable()
      .then(available => { if (!cancelled) setAppleReady(available); })
      .catch(() => { /* Hidden when the module or iOS version is unavailable. */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(value => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const demo = useCallback(async (owner: DemoOwnerKey) => {
    setBusy(true);
    setError(null);
    try {
      await signInDemo(owner);
      router.replace("/queue");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Demo sign-in failed.");
    } finally {
      setBusy(false);
    }
  }, [signInDemo]);

  const sendCode = useCallback(async () => {
    if (busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.request("/api/auth/email/request", { method: "POST", body: { email: email.trim() } });
      setEmailStage("code");
      setCooldown(60);
      setNotice("If that address can sign in, we’ve sent a code. It expires in 10 minutes.");
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 429
        ? "Too many attempts. Try again later."
        : cause instanceof Error ? cause.message : "Could not send a code; try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, email]);

  const verifyCode = useCallback(async () => {
    if (busy) return;
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code from the email.");
      return;
    }
    setBusy(true); setError(null);
    try {
      await signInEmail(email.trim(), code.trim());
      router.replace("/queue");
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 429
        ? "Too many attempts. Try again later."
        : cause instanceof Error ? cause.message : "That code is invalid or has expired.");
    } finally {
      setBusy(false);
    }
  }, [busy, code, email, signInEmail]);

  const googleReady = googleSignInAvailable();
  const microsoftReady = microsoftSignInAvailable();

  const continueWithGoogle = useCallback(async () => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const idToken = await signInWithGoogle();
      await signInGoogle(idToken);
      router.replace("/queue");
    } catch (cause) {
      // Cancelling the Google sheet is a no-op, not an error.
      if (isGoogleSignInCancelled(cause)) return;
      setError(cause instanceof ApiError && cause.kind === "signedOut"
        ? "That Google account couldn’t sign in. Try a different one."
        : cause instanceof Error ? cause.message : "Google sign-in failed. Try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, signInGoogle]);

  const continueWithApple = useCallback(async () => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const { identityToken, fullName } = await signInWithApple();
      await signInApple(identityToken, fullName);
      router.replace("/queue");
    } catch (cause) {
      // Cancelling the Apple sheet is a no-op, not an error.
      if (isAppleSignInCancelled(cause)) return;
      setError(cause instanceof ApiError && cause.kind === "signedOut"
        ? "That Apple account couldn’t sign in. Try a different one."
        : cause instanceof Error ? cause.message : "Apple sign-in failed. Try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, signInApple]);

  const continueWithMicrosoft = useCallback(async () => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const idToken = await signInWithMicrosoft();
      await signInMicrosoft(idToken);
      router.replace("/queue");
    } catch (cause) {
      // Closing the Microsoft browser is a no-op, not an error.
      if (isMicrosoftSignInCancelled(cause)) return;
      setError(cause instanceof ApiError && cause.kind === "signedOut"
        ? "That Microsoft account couldn’t sign in. Try a different one."
        : cause instanceof Error ? cause.message : "Microsoft sign-in failed. Try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, signInMicrosoft]);

  if (status === "signedIn") return <Redirect href="/queue" />;

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.eyebrow}>PraiseLoop</Text>
      <Text style={styles.title}>Your week of posts, ready to approve.</Text>
      <Text style={styles.body}>
        Review this week’s drafts, approve them and post from your phone. Setup and branding stay on
        the web app for now.
      </Text>

      {sessionEnded ? <Banner message="Your session ended. Sign in again." tone="warning" /> : null}
      {configError ? <Banner message={configError} tone="danger" /> : null}
      {error ? <Banner message={error} tone="danger" /> : null}
      {notice ? <Banner message={notice} /> : null}
      {config === null && !configError ? <ActivityIndicator /> : null}

      {appleReady ? (
        <Button label="Continue with Apple" onPress={() => { void continueWithApple(); }} loading={busy} />
      ) : null}

      {googleReady ? (
        <Button label="Continue with Google" onPress={() => { void continueWithGoogle(); }} loading={busy} />
      ) : null}

      {microsoftReady ? (
        <Button label="Continue with Microsoft" onPress={() => { void continueWithMicrosoft(); }} loading={busy} />
      ) : null}

      <View style={styles.form}>
        <Text style={styles.label}>Sign in with email</Text>
        <TextInput
          style={[styles.input, emailStage === "code" && styles.inputMuted]}
          value={email}
          onChangeText={setEmail}
          editable={emailStage === "email" && !busy}
          placeholder="you@yourbusiness.com"
          inputMode="email"
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textContentType="emailAddress"
          accessibilityLabel="Email address"
        />
        {emailStage === "code" ? (
          <TextInput
            style={styles.input}
            value={code}
            onChangeText={value => setCode(value.replace(/\D/g, "").slice(0, 6))}
            editable={!busy}
            placeholder="6-digit code"
            inputMode="numeric"
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={6}
            accessibilityLabel="6-digit sign-in code"
          />
        ) : null}
        <Button
          label={emailStage === "email" ? "Email me a code" : "Sign in"}
          onPress={() => { void (emailStage === "email" ? sendCode() : verifyCode()); }}
          loading={busy}
        />
        {emailStage === "code" ? (
          <>
            <Button
              label={cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
              kind="secondary"
              disabled={busy || cooldown > 0}
              onPress={() => { void sendCode(); }}
            />
            <Button
              label="Use a different address"
              kind="secondary"
              disabled={busy}
              onPress={() => { setEmailStage("email"); setCode(""); setError(null); setNotice(null); setCooldown(0); }}
            />
          </>
        ) : null}
      </View>

      {config?.devAuth ? (
        <View style={styles.actions}>
          <Banner message="Demo mode: this server signs in a synthetic owner with seeded posts. No Google account is involved." tone="warning" />
          {DEMO_OWNERS.map(owner => (
            <Button key={owner.key} label={owner.label} onPress={() => { void demo(owner.key); }} loading={busy} kind="secondary" />
          ))}
        </View>
      ) : null}

      {appConfig.variant !== "production" ? (
        <Text style={styles.small}>API: {appConfig.apiBaseUrl || "not configured"}</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, justifyContent: "center", gap: 14, padding: 28, backgroundColor: colors.background },
  eyebrow: { fontSize: 13, fontWeight: "700", letterSpacing: 1.4, textTransform: "uppercase", color: colors.muted },
  title: { fontSize: 34, lineHeight: 40, fontWeight: "700", color: colors.ink },
  body: { fontSize: 16, lineHeight: 23, color: colors.muted },
  form: { gap: 10, marginTop: 8 },
  label: { fontSize: 14, fontWeight: "700", color: colors.ink },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.line, borderRadius: 12, paddingHorizontal: 14, fontSize: 16, color: colors.ink, backgroundColor: colors.surface },
  inputMuted: { color: colors.muted },
  actions: { gap: 12, marginTop: 8 },
  small: { fontSize: 12, color: colors.faint, marginTop: 12 }
});
