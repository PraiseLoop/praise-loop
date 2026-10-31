import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isSignedOut } from "../api/client";
import { draftImageLoader } from "../media/draftImage";
import { sessionStore } from "./store";
import { signInDemo as requestDemoSession, signInWithAppleToken, signInWithEmail, signInWithGoogleToken, signInWithMicrosoftToken, signOut as revokeSession } from "./session";
import type { DemoOwnerKey } from "./demoOwners";

type SessionStatus = "loading" | "signedOut" | "signedIn";

type SessionValue = {
  status: SessionStatus;
  token: string | null;
  // True after the server ended the session (as opposed to the owner signing out),
  // so the sign-in screen can say why.
  sessionEnded: boolean;
  signInDemo: (owner: DemoOwnerKey) => Promise<void>;
  signInEmail: (email: string, code: string) => Promise<void>;
  signInGoogle: (idToken: string) => Promise<void>;
  signInApple: (identityToken: string, fullName: string | null) => Promise<void>;
  signInMicrosoft: (idToken: string) => Promise<void>;
  signOut: () => Promise<void>;
  // Call from a screen's catch: a 401 clears the keychain and returns the app to
  // sign-in, which is what the API means by "session ended".
  handleError: (error: unknown) => void;
  // For a typed failure that did not arrive as a thrown ApiError.
  expire: () => void;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [token, setToken] = useState<string | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    sessionStore
      .load()
      .then(stored => {
        if (cancelled) return;
        setToken(stored);
        setStatus(stored ? "signedIn" : "signedOut");
      })
      .catch(() => {
        if (cancelled) return;
        setToken(null);
        setStatus("signedOut");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signInDemo = useCallback(async (owner: DemoOwnerKey) => {
    await requestDemoSession(owner);
    setToken(sessionStore.current());
    setSessionEnded(false);
    setStatus("signedIn");
  }, []);

  const signInEmail = useCallback(async (email: string, code: string) => {
    await signInWithEmail(email, code);
    setToken(sessionStore.current());
    setSessionEnded(false);
    setStatus("signedIn");
  }, []);

  const signInGoogle = useCallback(async (idToken: string) => {
    await signInWithGoogleToken(idToken);
    setToken(sessionStore.current());
    setSessionEnded(false);
    setStatus("signedIn");
  }, []);

  const signInApple = useCallback(async (identityToken: string, fullName: string | null) => {
    await signInWithAppleToken(identityToken, fullName);
    setToken(sessionStore.current());
    setSessionEnded(false);
    setStatus("signedIn");
  }, []);

  const signInMicrosoft = useCallback(async (idToken: string) => {
    await signInWithMicrosoftToken(idToken);
    setToken(sessionStore.current());
    setSessionEnded(false);
    setStatus("signedIn");
  }, []);

  const signOut = useCallback(async () => {
    await revokeSession();
    // Draft images are owner-private; do not let a later session reuse them.
    draftImageLoader.clear();
    setToken(null);
    setSessionEnded(false);
    setStatus("signedOut");
  }, []);

  const expire = useCallback(() => {
    void sessionStore.clear();
    draftImageLoader.clear();
    setToken(null);
    setSessionEnded(true);
    setStatus("signedOut");
  }, []);

  const handleError = useCallback((error: unknown) => {
    if (isSignedOut(error)) expire();
  }, [expire]);

  const value = useMemo(
    () => ({ status, token, sessionEnded, signInDemo, signInEmail, signInGoogle, signInApple, signInMicrosoft, signOut, handleError, expire }),
    [status, token, sessionEnded, signInDemo, signInEmail, signInGoogle, signInApple, signInMicrosoft, signOut, handleError, expire]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
