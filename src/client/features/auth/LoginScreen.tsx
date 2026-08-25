import { useId, useState, type FormEvent } from "react";
import { Eye, EyeOff, LockKeyhole } from "lucide-react";
import loginEditorial from "../../assets/login-editorial.webp";
import mobelarisLogo from "../../assets/LOGO-MOBELARIS_Final.webp";
import { AsyncNotice } from "../../components/AsyncNotice.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Button } from "../../components/ui/button.js";
import { Field, FieldLabel } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { AuthApiError, login } from "../../lib/auth-api.js";
import type { AuthSession } from "../../../shared/contracts/auth.js";

/** Fades a status notice in on the 150–180ms curve used app-wide; a no-op under reduced motion (tokens.css). */
const NOTICE_TRANSITION = "animate-in fade-in-0 duration-[170ms] ease-[cubic-bezier(0.25,1,0.5,1)]";

export function LoginScreen({
  message,
  onAuthenticated,
}: {
  message?: string;
  onAuthenticated: (session: AuthSession) => void;
}) {
  const id = useId().replaceAll(":", "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      onAuthenticated(await login(email, password));
    } catch (caught) {
      if (caught instanceof AuthApiError && caught.status === 401)
        setError("The email or password is incorrect.");
      else if (caught instanceof AuthApiError && caught.status === 429)
        setError("Too many sign-in attempts. Wait a few minutes before trying again.");
      else setError("The private workspace is temporarily unavailable. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="flex h-14 items-center justify-between border-b border-rule bg-paper px-4 sm:px-6">
        <img src={mobelarisLogo} alt="Mobelaris" width={230} height={37} className="h-6 w-auto" />
        <span className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">
          SEO Production
        </span>
      </header>

      <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center bg-canvas p-6 md:p-10">
        <section className="w-full max-w-sm md:max-w-5xl" aria-labelledby={`${id}-heading`}>
          {/* One shared outer radius with clipping, so the form and image read as a
              single composition — the image inherits this corner rather than carrying
              its own. */}
          <div className="grid overflow-hidden rounded-login-surface border border-rule bg-paper md:min-h-[32rem] md:grid-cols-2">
            <div className="min-w-0 p-8 md:p-10 lg:p-14">
              <PageHeader
                id={`${id}-heading`}
                eyebrow="Private editorial workspace"
                title="Operator sign in"
                className="mb-8"
              />

              <form onSubmit={submit} className="space-y-7">
                {message && !error && (
                  <div className={NOTICE_TRANSITION}>
                    <AsyncNotice message={message} tone="warning" />
                  </div>
                )}
                {error && (
                  <div className={NOTICE_TRANSITION}>
                    <AsyncNotice message={error} tone="error" />
                  </div>
                )}

                <Field>
                  <FieldLabel htmlFor={`${id}-email`}>Email</FieldLabel>
                  <Input
                    id={`${id}-email`}
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={busy}
                    required
                    className="h-12 rounded-login-field px-4"
                    autoFocus
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor={`${id}-password`}>Password</FieldLabel>
                  <div className="relative">
                    <Input
                      id={`${id}-password`}
                      type={visible ? "text" : "password"}
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      disabled={busy}
                      required
                      className="h-12 rounded-login-field px-4 pr-12"
                    />
                    <button
                      type="button"
                      className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-login-field text-muted outline-none transition-colors hover:text-ink focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                      aria-label={visible ? "Hide password" : "Show password"}
                      onClick={() => setVisible((current) => !current)}
                      disabled={busy}
                    >
                      {visible ? (
                        <EyeOff aria-hidden="true" className="size-4" />
                      ) : (
                        <Eye aria-hidden="true" className="size-4" />
                      )}
                    </button>
                  </div>
                </Field>

                <Button
                  type="submit"
                  size="lg"
                  className="h-12 w-full rounded-login-control"
                  loading={busy}
                  disabled={!email || !password}
                >
                  <LockKeyhole aria-hidden="true" />
                  {busy ? "Signing in…" : "Sign in"}
                </Button>
              </form>
            </div>

            {/* Decorative editorial column: no information the form does not already carry. */}
            <div className="relative hidden border-l border-rule md:block">
              <img
                src={loginEditorial}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
              />
            </div>
          </div>

          <p className="mt-8 border-t border-rule pt-5 text-center font-mono text-[0.7rem] text-muted">
            Local operator access
          </p>
        </section>
      </main>
    </>
  );
}
