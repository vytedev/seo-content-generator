import { useState } from "react";
import { AppShell, type WorkspaceScreen } from "../components/AppShell.js";
import { AuthGate } from "../features/auth/AuthGate.js";
import { DraftCheckerPage } from "../pages/DraftCheckerPage.js";
import { CalibrationPage } from "../pages/CalibrationPage.js";
import { BlogPostPage } from "../pages/BlogPostPage.js";
import { WritingGuidesPage } from "../pages/WritingGuidesPage.js";

export function App({
  authMode = "enabled",
  runtimeMode: initialRuntimeMode,
}: {
  authMode?: "enabled" | "test-bypass";
  runtimeMode?: "local" | "test" | "production";
}) {
  const [mode, setMode] = useState<WorkspaceScreen>("blog-post");
  const runtimeMode = initialRuntimeMode ?? "local";
  const workspace = (
    operator: {
      id: "local-operator";
      display_name: string;
      email: string;
      account_type: "Local operator";
    },
    signOut: () => Promise<void>,
  ) => (
    <AppShell
      active={mode}
      onNavigate={setMode}
      operator={operator}
      onSignOut={signOut}
      runtimeMode={runtimeMode}
    >
      {mode === "blog-post" && <BlogPostPage />}
      {mode === "checker" && <DraftCheckerPage />}
      {mode === "reference-documents" && <WritingGuidesPage />}
      {mode === "calibration" && <CalibrationPage />}
    </AppShell>
  );
  if (authMode === "test-bypass")
    return workspace(
      {
        id: "local-operator",
        display_name: "Aaron",
        email: "operator@example.test",
        account_type: "Local operator",
      },
      async () => undefined,
    );
  return <AuthGate>{(session, signOut) => workspace(session.operator, signOut)}</AuthGate>;
}
