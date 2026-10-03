import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { authUsers, authAccounts, authSessions, authVerifications } from "@paperclipai/db";
import {
  authSessionSchema,
  currentUserProfileSchema,
  updateCurrentUserProfileSchema,
  forgotPasswordSchema,
  resetPasswordWithTokenSchema,
} from "@paperclipai/shared";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { badRequest, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { resolveSentryDsns } from "../sentry-dsn.js";
import { sendPasswordResetEmail } from "../services/email-service.js";
import { deriveAuthCookiePrefix } from "../auth/better-auth.js";
import { extractSessionTokenFromCookieHeader } from "../middleware/auth.js";

async function loadCurrentUserProfile(db: Db, userId: string) {
  const user = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      name: authUsers.name,
      image: authUsers.image,
    })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);

  if (!user) {
    throw unauthorized("Signed-in user not found");
  }

  return currentUserProfileSchema.parse({
    id: user.id,
    email: user.email ?? null,
    name: user.name ?? null,
    image: user.image ?? null,
  });
}

export function authRoutes(db: Db) {
  const router = Router();

  router.get("/get-session", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const user = await loadCurrentUserProfile(db, req.actor.userId);
    res.json(authSessionSchema.parse({
      session: {
        id: `paperclip:${req.actor.source ?? "none"}:${req.actor.userId}`,
        userId: req.actor.userId,
      },
      user,
      // The browser reads this value to open its own Sentry gate — see
      // `ui/src/lib/sentry.ts`. `req.actor.type` already gates this whole
      // handler, so no second authorization check runs here. This field
      // carries the front-end DSN only; it never carries the backend DSN.
      sentryDsn: resolveSentryDsns().frontend,
      // Match the server SDK's runtime environment, including in reused images.
      sentryEnvironment: process.env.SENTRY_ENVIRONMENT || null,
    }));
  });

  router.get("/profile", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    res.json(await loadCurrentUserProfile(db, req.actor.userId));
  });

  router.patch("/profile", validate(updateCurrentUserProfileSchema), async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const patch = updateCurrentUserProfileSchema.parse(req.body);
    const now = new Date();

    const updated = await db
      .update(authUsers)
      .set({
        name: patch.name,
        ...(patch.image !== undefined ? { image: patch.image } : {}),
        updatedAt: now,
      })
      .where(eq(authUsers.id, req.actor.userId))
      .returning({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
      })
      .then((rows) => rows[0] ?? null);

    if (!updated) {
      throw unauthorized("Signed-in user not found");
    }

    res.json(currentUserProfileSchema.parse({
      id: updated.id,
      email: updated.email ?? null,
      name: updated.name ?? null,
      image: updated.image ?? null,
    }));
  });

  router.post("/forgot-password", validate(forgotPasswordSchema), async (req, res) => {
    const email = req.body.email.trim().toLowerCase();
    const user = await db
      .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.email, email))
      .then((rows) => rows[0] ?? null);

    if (user) {
      const resetToken = randomBytes(24).toString("hex");
      const expiresAt = new Date(Date.now() + 3600 * 1000); // 1 hour

      await db
        .insert(authVerifications)
        .values({
          id: randomBytes(16).toString("hex"),
          identifier: `reset-password:${resetToken}`,
          value: user.id,
          expiresAt,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing();

      const origin = process.env.PAPERCLIP_PUBLIC_URL || "http://localhost:3100";
      const resetUrl = `${origin}/auth/reset-password?token=${encodeURIComponent(resetToken)}`;

      await sendPasswordResetEmail({
        email: user.email,
        name: user.name,
        resetUrl,
      });
    }

    res.json({
      status: true,
      message: "If this email is registered, a password reset link has been sent.",
    });
  });

  router.post("/reset-password", validate(resetPasswordWithTokenSchema), async (req, res) => {
    const { token, newPassword } = req.body;
    const verificationId = `reset-password:${token}`;

    const verification = await db
      .select()
      .from(authVerifications)
      .where(eq(authVerifications.identifier, verificationId))
      .then((rows) => rows[0] ?? null);

    if (!verification || verification.expiresAt.getTime() <= Date.now()) {
      throw badRequest("Password reset token is invalid or has expired.");
    }

    const userId = verification.value;
    const hashedPassword = await hashPassword(newPassword);

    await db.transaction(async (tx) => {
      await tx
        .update(authAccounts)
        .set({ password: hashedPassword, updatedAt: new Date() })
        .where(
          and(
            eq(authAccounts.userId, userId),
            eq(authAccounts.providerId, "credential"),
          ),
        );

      await tx
        .delete(authVerifications)
        .where(eq(authVerifications.id, verification.id));

      await tx
        .delete(authSessions)
        .where(eq(authSessions.userId, userId));
    });

    res.json({
      status: true,
      message: "Password has been successfully reset. You can now sign in with your new password.",
    });
  });

  router.post("/sign-in/email", async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!email || !password) {
      throw badRequest("Email and password are required.");
    }

    const user = await db
      .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
      .from(authUsers)
      .where(sql`lower(${authUsers.email}) = ${email}`)
      .then((rows) => rows[0] ?? null);

    if (!user) {
      res.status(401).json({
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
      });
      return;
    }

    const account = await db
      .select({ id: authAccounts.id, password: authAccounts.password })
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.userId, user.id),
          eq(authAccounts.providerId, "credential"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!account?.password) {
      res.status(401).json({
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
      });
      return;
    }

    const valid = await verifyPassword({
      hash: account.password,
      password,
    });

    if (!valid) {
      res.status(401).json({
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
      });
      return;
    }

    const now = new Date();
    const sessionToken = randomBytes(32).toString("hex");
    const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);

    const [createdSession] = await db
      .insert(authSessions)
      .values({
        id: randomBytes(16).toString("hex"),
        userId: user.id,
        token: sessionToken,
        expiresAt: sessionExpiresAt,
        createdAt: now,
        updatedAt: now,
        ipAddress: req.ip || null,
        userAgent: req.header("user-agent") || null,
      })
      .returning();

    const cookiePrefix = deriveAuthCookiePrefix();
    const cookieOpts = {
      httpOnly: true,
      path: "/",
      expires: sessionExpiresAt,
      sameSite: "lax" as const,
    };
    res.cookie(`${cookiePrefix}.session_token`, sessionToken, cookieOpts);
    res.cookie("paperclip.session_token", sessionToken, cookieOpts);
    res.cookie("better-auth.session_token", sessionToken, cookieOpts);
    res.clearCookie("paperclip_logged_out", { path: "/" });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      session: {
        id: createdSession.id,
        token: sessionToken,
        userId: user.id,
        expiresAt: sessionExpiresAt.toISOString(),
      },
    });
  });

  router.post("/sign-out", async (req, res) => {
    const cookieHeader = req.headers.cookie ?? "";
    const sessionToken = extractSessionTokenFromCookieHeader(cookieHeader);

    if (sessionToken) {
      await db.delete(authSessions).where(eq(authSessions.token, sessionToken)).catch(() => {});
    }
    if (req.actor?.sessionId) {
      await db.delete(authSessions).where(eq(authSessions.id, req.actor.sessionId)).catch(() => {});
    }

    const cookiePrefix = deriveAuthCookiePrefix();
    const clearOpts = { path: "/", httpOnly: true };

    res.clearCookie(`${cookiePrefix}.session_token`, clearOpts);
    res.clearCookie("paperclip.session_token", clearOpts);
    res.clearCookie("better-auth.session_token", clearOpts);
    res.cookie(`${cookiePrefix}.session_token`, "", { ...clearOpts, expires: new Date(0), maxAge: 0 });
    res.cookie("paperclip.session_token", "", { ...clearOpts, expires: new Date(0), maxAge: 0 });
    res.cookie("better-auth.session_token", "", { ...clearOpts, expires: new Date(0), maxAge: 0 });

    res.cookie("paperclip_logged_out", "1", { path: "/", httpOnly: false, maxAge: 86400 * 30 });

    res.json({ success: true, redirectTo: "/auth" });
  });

  return router;
}
