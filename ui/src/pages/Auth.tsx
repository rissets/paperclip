import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { healthApi } from "../api/health";
import { CloudSignIn } from "@/components/CloudSignIn";
import { clearCloudSignInAttempt } from "@/lib/cloud-sign-in";
import { tenantSignInReturnPath } from "@/lib/cloudLinks";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { queryKeys } from "../lib/queryKeys";
import { getRememberedInvitePath } from "../lib/invite-memory";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { PaperclipLoading } from "@/components/AnimatedPaperclipIcon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PaperclipLockup } from "../components/PaperclipLockup";

type AuthMode = "sign_in" | "sign_up" | "forgot_password";

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [forgotSuccess, setForgotSuccess] = useState(false);
  const errorId = "auth-error";

  const nextPath = useMemo(
    () => tenantSignInReturnPath(searchParams.get("next") || getRememberedInvitePath() || "/"),
    [searchParams],
  );
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const { data: session, isLoading: isSessionLoading, error: sessionError } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const isExplicitlyLoggedOut = typeof document !== "undefined" && document.cookie.includes("paperclip_logged_out=1");

  useEffect(() => {
    if (session && !isExplicitlyLoggedOut) {
      clearCloudSignInAttempt();
      navigate(nextPath, { replace: true });
    }
  }, [session, navigate, nextPath, isExplicitlyLoggedOut]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "forgot_password") {
        await authApi.forgotPassword(email.trim());
        return;
      }
      if (mode === "sign_in") {
        await authApi.signInEmail({ email: email.trim(), password });
        return;
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
    },
    onSuccess: async () => {
      setError(null);
      if (mode === "forgot_password") {
        setForgotSuccess(true);
        return;
      }
      if (typeof document !== "undefined") {
        document.cookie = "paperclip_logged_out=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      // Reset rather than invalidate: the `["companies"]` entry is shared app-wide and
      // is not account-scoped, so invalidating leaves the previous account's list
      // readable (and any fetch for that session in flight) until the refetch lands.
      // Sign-in can change accounts, so drop the list outright.
      await queryClient.resetQueries({ queryKey: queryKeys.companies.all });
      navigateTopLevel(nextPath);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Authentication failed");
    },
  });

  const isSignUpDisabled = healthQuery.data?.disableSignUp === true;

  const canSubmit =
    mode === "forgot_password"
      ? email.trim().length > 0
      : email.trim().length > 0 &&
        password.trim().length > 0 &&
        (mode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8));

  if (healthQuery.isLoading || (isSessionLoading && !isExplicitlyLoggedOut) || (session && !isExplicitlyLoggedOut)) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <PaperclipLoading className="min-h-0" />
      </div>
    );
  }

  // A health/session failure must not be mistaken for a self-hosted instance.
  if (healthQuery.error || sessionError) {
    return <p role="alert" className="p-6 text-sm text-destructive">Unable to check sign-in. Refresh and try again.</p>;
  }

  if (healthQuery.data?.cloud) {
    return <CloudSignIn cloud={healthQuery.data.cloud} returnTo={nextPath} />;
  }

  return (
    <div className="fixed inset-0 flex bg-background">
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>
      {/* Left half — form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="mb-8">
            <PaperclipLockup className="h-5 w-auto" />
          </div>

          <h1 className="text-xl font-semibold">
            {mode === "forgot_password"
              ? "Reset your password"
              : mode === "sign_in"
                ? "Sign in to Primbon"
                : "Create your Primbon account"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "forgot_password"
              ? "Enter your email address to receive a password reset link."
              : mode === "sign_in"
                ? "Use your email and password to access this instance."
                : "Create an account for this instance. Email confirmation is not required in v1."}
          </p>

          {mode === "forgot_password" && forgotSuccess ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-foreground">
                If an account exists with that email, a password reset link has been sent. Please check your inbox and spam folder.
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  setError(null);
                  setForgotSuccess(false);
                  setMode("sign_in");
                }}
              >
                Back to Sign In
              </Button>
            </div>
          ) : (
            <form
              className="mt-6 space-y-4"
              method="post"
              action={
                mode === "forgot_password"
                  ? "/api/auth/forgot-password"
                  : mode === "sign_up"
                    ? "/api/auth/sign-up/email"
                    : "/api/auth/sign-in/email"
              }
              onSubmit={(event) => {
                event.preventDefault();
                if (mutation.isPending) return;
                if (!canSubmit) {
                  setError("Please fill in all required fields.");
                  return;
                }
                mutation.mutate();
              }}
            >
              {mode === "sign_up" && (
                <div>
                  <label htmlFor="name" className="text-xs text-muted-foreground mb-1 block">Name</label>
                  <input
                    id="name"
                    name="name"
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="name"
                    required
                    aria-required="true"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    autoFocus
                  />
                </div>
              )}
              <div>
                <label htmlFor="email" className="text-xs text-muted-foreground mb-1 block">Email</label>
                <input
                  id="email"
                  name="email"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="username"
                  required
                  aria-required="true"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  autoFocus={mode === "sign_in" || mode === "forgot_password"}
                />
              </div>
              {mode !== "forgot_password" && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="password" className="text-xs text-muted-foreground block">Password</label>
                    {mode === "sign_in" && (
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                        onClick={() => {
                          setError(null);
                          setForgotSuccess(false);
                          setMode("forgot_password");
                        }}
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <input
                    id="password"
                    name="password"
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                    required
                    aria-required="true"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                  />
                </div>
              )}
              {error && (
                <p id={errorId} role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                disabled={mutation.isPending}
                aria-disabled={!canSubmit || mutation.isPending}
                className={`w-full ${!canSubmit && !mutation.isPending ? "opacity-50" : ""}`}
              >
                {mutation.isPending
                  ? "Working…"
                  : mode === "forgot_password"
                    ? "Send Reset Link"
                    : mode === "sign_in"
                      ? "Sign In"
                      : "Create Account"}
              </Button>
              {mode === "forgot_password" && (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    setError(null);
                    setMode("sign_in");
                  }}
                >
                  Back to Sign In
                </Button>
              )}
            </form>
          )}

          {mode !== "forgot_password" && (
            <div className="mt-5 text-sm text-muted-foreground">
              {mode === "sign_in" ? (
                isSignUpDisabled ? (
                  <span>Registration is by invitation only. Contact your workspace administrator for access.</span>
                ) : (
                  <>
                    Need an account?{" "}
                    <button
                      type="button"
                      className="font-medium text-foreground underline underline-offset-2"
                      onClick={() => {
                        setError(null);
                        setMode("sign_up");
                      }}
                    >
                      Create one
                    </button>
                  </>
                )
              ) : (
                <>
                  Already have an account?{" "}
                  <button
                    type="button"
                    className="font-medium text-foreground underline underline-offset-2"
                    onClick={() => {
                      setError(null);
                      setMode("sign_in");
                    }}
                  >
                    Sign in
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right half — ASCII art animation (hidden on mobile) */}
      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
