import { useEffect, useState } from "react";
import type { AuthSession } from "../../../shared/contracts/auth.js";
import mobelarisMark from "../../assets/Mobelaris-Logo-M.png";
import { AUTH_EXPIRED_EVENT, clearCsrfToken } from "../../lib/api.js";
import { AuthApiError, fetchAuthSession, logout } from "../../lib/auth-api.js";
import { LoginScreen } from "./LoginScreen.js";

export function AuthGate({
  children,
}: {
  children: (session: AuthSession, signOut: () => Promise<void>) => React.ReactNode;
}) {
  const [state, setState] = useState<"checking" | "authenticated" | "anonymous">("checking");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchAuthSession()
      .then((loaded) => {
        if (cancelled) return;
        setSession(loaded);
        setState("authenticated");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        clearCsrfToken();
        setState("anonymous");
        if (!(error instanceof AuthApiError) || error.status !== 401)
          setMessage("The private workspace could not verify your session. Sign in to continue.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const expired = () => {
      clearCsrfToken();
      setSession(null);
      setState("anonymous");
      setMessage(
        "Your session expired. Sign in again to continue; saved pipeline progress is safe.",
      );
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
  }, []);

  async function signOut() {
    let revoked = false;
    try {
      await logout();
      revoked = true;
    } catch {
      // Hide private content locally even when the server cannot confirm
      // revocation, but never claim the still-possible session is safe.
    } finally {
      clearCsrfToken();
      setSession(null);
      setState("anonymous");
      setMessage(
        revoked
          ? "You have signed out safely."
          : "The workspace is hidden, but the server could not confirm sign-out. Close this browser and try again later.",
      );
      window.history.replaceState(null, "", window.location.pathname);
    }
  }

  if (state === "checking")
    return (
      <main className="grid min-h-screen place-items-center bg-canvas" aria-busy="true">
        <div className="text-center" role="status" aria-live="polite">
          <img src={mobelarisMark} alt="" className="mx-auto mb-4 size-10 object-contain" />
          <p className="text-sm font-semibold text-ink">Opening the private workspace…</p>
          <p className="mt-1 text-xs text-muted">Checking your operator session</p>
        </div>
      </main>
    );

  if (state === "anonymous" || !session)
    return (
      <LoginScreen
        message={message}
        onAuthenticated={(authenticated) => {
          setSession(authenticated);
          setMessage("");
          setState("authenticated");
        }}
      />
    );

  return <>{children(session, signOut)}</>;
}
