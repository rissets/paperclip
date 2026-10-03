import { useState } from "react";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PaperclipLockup } from "../components/PaperclipLockup";

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token")?.trim() ?? "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!token) {
      setError("Reset token is missing. Please use the link provided in your email.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);
    try {
      await authApi.resetPassword({ token, newPassword: password });
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset password. The link may have expired.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 flex bg-background">
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>

      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="mb-8">
            <PaperclipLockup className="h-5 w-auto" />
          </div>

          <h1 className="text-xl font-semibold">Set New Password</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Please enter your new password below.
          </p>

          {success ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-foreground">
                Your password has been reset successfully. You can now sign in with your new credentials.
              </div>
              <Button
                type="button"
                className="w-full"
                onClick={() => navigate("/auth", { replace: true })}
              >
                Sign In
              </Button>
            </div>
          ) : !token ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
                Invalid or missing reset token. Please request a new password reset link.
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => navigate("/auth", { replace: true })}
              >
                Go to Sign In
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div>
                <label htmlFor="new-password" className="text-xs text-muted-foreground mb-1 block">
                  New Password
                </label>
                <input
                  id="new-password"
                  name="new-password"
                  type="password"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  autoFocus
                />
              </div>

              <div>
                <label htmlFor="confirm-password" className="text-xs text-muted-foreground mb-1 block">
                  Confirm New Password
                </label>
                <input
                  id="confirm-password"
                  name="confirm-password"
                  type="password"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>

              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}

              <Button
                type="submit"
                disabled={isSubmitting || password.length < 8 || !confirmPassword}
                className="w-full"
              >
                {isSubmitting ? "Resetting…" : "Reset Password"}
              </Button>

              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => navigate("/auth", { replace: true })}
              >
                Back to Sign In
              </Button>
            </form>
          )}
        </div>
      </div>

      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
