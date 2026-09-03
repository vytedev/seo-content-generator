import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button.js";
import {
  disconnectGoogle,
  fetchGoogleConnectionStatus,
  type GoogleConnectionStatus,
} from "../../lib/google-api.js";

export function GoogleDocsConnection() {
  const [status, setStatus] = useState<GoogleConnectionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const result = new URLSearchParams(window.location.search);
    const code = result.get("code");
    if (result.get("google") === "success") setError("");
    if (result.get("google") === "error") {
      setError(
        code === "access_denied"
          ? "Google access was not granted. You can try connecting again."
          : "Google could not be connected. You can try again.",
      );
    }
    fetchGoogleConnectionStatus()
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch(() => {
        if (!cancelled) setError("Connection status unavailable. Try again shortly.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status)
    return (
      <p className="mt-3 text-sm text-muted" role="status" aria-live="polite">
        Checking connection…
      </p>
    );
  if (!status.configured)
    return (
      <p className="mt-3 text-sm text-muted">
        Google Docs is not configured. Add the required OAuth configuration before connecting.
      </p>
    );

  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await disconnectGoogle();
      setStatus({
        configured: true,
        connected: false,
        docs_connected: false,
        gsc_connected: false,
        connected_at: null,
      });
    } catch {
      setError("Google could not be disconnected.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      {error ? (
        <p className="mb-2 text-sm text-danger" role="alert" aria-live="assertive">
          {error}
        </p>
      ) : null}
      {status.docs_connected ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-success" role="status" aria-live="polite">
              ● Google Docs connected
            </span>
            <Button type="button" variant="outline" size="sm" loading={busy} onClick={disconnect}>
              Disconnect
            </Button>
          </div>
          {status.gsc_connected ? (
            <p className="text-sm text-success">● Search Console enrichment connected</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted">Search Console enrichment is optional.</span>
              <Button type="button" variant="outline" size="sm" asChild>
                <a href="/api/integrations/google/connect?purpose=gsc">Connect Search Console</a>
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div>
          <p className="mb-2 text-sm text-muted">Configured, but not connected.</p>
          <Button type="button" variant="outline" size="sm" asChild>
            <a href="/api/integrations/google/connect?purpose=docs">Connect Google Docs</a>
          </Button>
        </div>
      )}
    </div>
  );
}
