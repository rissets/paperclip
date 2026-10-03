import { Router, type Request, type Response } from "express";
import { randomBytes, createHash } from "node:crypto";
import { and, eq, inArray, isNull, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  authAccounts,
  authSessions,
  authVerifications,
  companies,
  companyMemberships,
  userInvitations,
  userAgentAssignments,
  agents,
} from "@paperclipai/db";
import {
  createUserInvitationSchema,
  acceptUserInvitationSchema,
  forgotPasswordSchema,
  resetPasswordWithTokenSchema,
  assignUsersToAgentSchema,
  assignAgentsToUserSchema,
} from "@paperclipai/shared";
import { hashPassword } from "better-auth/crypto";
import { badRequest, forbidden, notFound, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { userRbacService } from "../services/user-rbac-service.js";
import { sendInvitationEmail, sendPasswordResetEmail } from "../services/email-service.js";
import { deriveAuthCookiePrefix } from "../auth/better-auth.js";
import { assertCompanyAccess } from "./authz.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function userInvitationRoutes(db: Db) {
  const router = Router();
  const rbac = userRbacService(db);

  // 1. Create a User Invitation (multi-workspace, role, optional agent assignments)
  router.post("/invitations", validate(createUserInvitationSchema), async (req: Request, res: Response) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required to invite users");
    }

    const { email, name, role, companyIds, agentIds } = req.body;

    // Verify inviter has admin/owner rights in all target companies (or is instance admin)
    if (!req.actor.isInstanceAdmin) {
      for (const cId of companyIds) {
        const inviterRole = await rbac.getUserRoleInCompany(cId, req.actor.userId);
        if (inviterRole !== "owner" && inviterRole !== "admin") {
          throw forbidden(`You do not have permission to invite users to company ${cId}`);
        }
      }
    }

    // Load company names for email notification
    const targetCompanies = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(inArray(companies.id, companyIds));

    const companyNames = targetCompanies.map((c) => c.name);

    // Generate secure token
    const token = randomBytes(24).toString("hex");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000); // 7 days

    const [created] = await db
      .insert(userInvitations)
      .values({
        email: email.trim().toLowerCase(),
        name: name?.trim() || null,
        role,
        companyIds,
        agentIds: agentIds || [],
        token,
        tokenHash,
        invitedByUserId: req.actor.userId,
        status: "pending",
        expiresAt,
      })
      .returning();

    // Determine public URL
    const origin = process.env.PAPERCLIP_PUBLIC_URL || "http://localhost:3100";
    const inviteUrl = `${origin}/invite/${token}`;

    // Send invitation email via SMTP
    await sendInvitationEmail({
      email: email.trim().toLowerCase(),
      name: name?.trim() || null,
      inviterName: req.actor.userName,
      companyNames,
      role,
      inviteUrl,
    });

    res.status(201).json({
      id: created.id,
      email: created.email,
      name: created.name,
      role: created.role,
      companyIds: created.companyIds,
      agentIds: created.agentIds,
      token,
      inviteUrl,
      expiresAt: created.expiresAt,
      status: created.status,
    });
  });

  // 2. Inspect an invitation (public)
  router.get("/invitations/:token", async (req: Request, res: Response) => {
    const token = String(req.params.token || "").trim();
    if (!token) throw badRequest("Missing invitation token");

    const tokenHash = hashToken(token);
    const invite = await db
      .select()
      .from(userInvitations)
      .where(eq(userInvitations.tokenHash, tokenHash))
      .then((rows) => rows[0] ?? null);

    if (!invite) {
      throw notFound("Invitation not found");
    }

    if (invite.status !== "pending" || invite.expiresAt.getTime() <= Date.now()) {
      throw badRequest(
        invite.status === "accepted"
          ? "This invitation has already been accepted."
          : "This invitation has expired or been revoked.",
      );
    }

    const targetCompanies = await db
      .select({ id: companies.id, name: companies.name, issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(inArray(companies.id, invite.companyIds));

    let assignedAgentNames: string[] = [];
    if (invite.agentIds.length > 0) {
      const assignedAgents = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, invite.agentIds));
      assignedAgentNames = assignedAgents.map((a) => a.name);
    }

    res.json({
      email: invite.email,
      name: invite.name,
      role: invite.role,
      companyNames: targetCompanies.map((c) => c.name),
      companies: targetCompanies,
      agentNames: assignedAgentNames,
      expiresAt: invite.expiresAt,
    });
  });

  // 3. Accept invitation & create account (public)
  router.post("/invitations/:token/accept", validate(acceptUserInvitationSchema), async (req: Request, res: Response) => {
    const token = String(req.params.token || "").trim();
    const { name, password } = req.body;

    const tokenHash = hashToken(token);
    const invite = await db
      .select()
      .from(userInvitations)
      .where(eq(userInvitations.tokenHash, tokenHash))
      .then((rows) => rows[0] ?? null);

    if (!invite) throw notFound("Invitation not found");
    if (invite.status !== "pending" || invite.expiresAt.getTime() <= Date.now()) {
      throw badRequest("This invitation is no longer valid.");
    }

    const hashedPassword = await hashPassword(password);
    const now = new Date();
    const sessionToken = randomBytes(32).toString("hex");
    const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000); // 30 days

    let targetUserId = "";

    await db.transaction(async (tx) => {
      // 1. Check or create user in authUsers
      const existingUser = await tx
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.email, invite.email))
        .then((rows) => rows[0] ?? null);

      if (existingUser) {
        targetUserId = existingUser.id;
        await tx
          .update(authUsers)
          .set({ name: name.trim(), emailVerified: true, updatedAt: now })
          .where(eq(authUsers.id, targetUserId));
      } else {
        const [newUser] = await tx
          .insert(authUsers)
          .values({
            id: randomBytes(16).toString("hex"),
            name: name.trim(),
            email: invite.email,
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        targetUserId = newUser.id;
      }

      // 2. Set password in authAccounts
      const existingAccount = await tx
        .select({ id: authAccounts.id })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.userId, targetUserId),
            eq(authAccounts.providerId, "credential"),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (existingAccount) {
        await tx
          .update(authAccounts)
          .set({ password: hashedPassword, updatedAt: now })
          .where(eq(authAccounts.id, existingAccount.id));
      } else {
        await tx.insert(authAccounts).values({
          id: randomBytes(16).toString("hex"),
          userId: targetUserId,
          accountId: invite.email,
          providerId: "credential",
          issuer: "local:credential",
          password: hashedPassword,
          createdAt: now,
          updatedAt: now,
        });
      }

      // 3. Grant company memberships for all invited workspaces
      for (const compId of invite.companyIds) {
        const existingMem = await tx
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, compId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, targetUserId),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (existingMem) {
          await tx
            .update(companyMemberships)
            .set({ membershipRole: invite.role, status: "active", updatedAt: now })
            .where(eq(companyMemberships.id, existingMem.id));
        } else {
          await tx.insert(companyMemberships).values({
            companyId: compId,
            principalType: "user",
            principalId: targetUserId,
            membershipRole: invite.role,
            status: "active",
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      // 4. Assign agents
      if (invite.agentIds.length > 0) {
        for (const agentId of invite.agentIds) {
          const agentRow = await tx
            .select({ companyId: agents.companyId })
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0] ?? null);

          if (agentRow) {
            await tx
              .insert(userAgentAssignments)
              .values({
                userId: targetUserId,
                agentId,
                companyId: agentRow.companyId,
                assignedByUserId: invite.invitedByUserId,
                createdAt: now,
              })
              .onConflictDoNothing();
          }
        }
      }

      // 5. Mark invitation accepted
      await tx
        .update(userInvitations)
        .set({
          status: "accepted",
          acceptedAt: now,
          updatedAt: now,
        })
        .where(eq(userInvitations.id, invite.id));

      // 6. Create active Better Auth session
      await tx.insert(authSessions).values({
        id: randomBytes(16).toString("hex"),
        userId: targetUserId,
        token: sessionToken,
        expiresAt: sessionExpiresAt,
        createdAt: now,
        updatedAt: now,
        ipAddress: req.ip || null,
        userAgent: req.header("user-agent") || null,
      });
    });

    // Set Better Auth session cookie
    const cookiePrefix = deriveAuthCookiePrefix();
    res.cookie(`${cookiePrefix}.session_token`, sessionToken, {
      httpOnly: true,
      path: "/",
      expires: sessionExpiresAt,
      sameSite: "lax",
    });

    res.json({
      success: true,
      userId: targetUserId,
      email: invite.email,
      name: name.trim(),
    });
  });

  // 4. Forgot Password endpoint (public)
  router.post("/auth/forgot-password", validate(forgotPasswordSchema), async (req: Request, res: Response) => {
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

  // 5. Reset Password with token endpoint (public)
  router.post("/auth/reset-password", validate(resetPasswordWithTokenSchema), async (req: Request, res: Response) => {
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
      // Update password
      await tx
        .update(authAccounts)
        .set({ password: hashedPassword, updatedAt: new Date() })
        .where(
          and(
            eq(authAccounts.userId, userId),
            eq(authAccounts.providerId, "credential"),
          ),
        );

      // Consume verification token
      await tx
        .delete(authVerifications)
        .where(eq(authVerifications.id, verification.id));

      // Revoke older sessions
      await tx
        .delete(authSessions)
        .where(eq(authSessions.userId, userId));
    });

    res.json({
      status: true,
      message: "Password has been successfully reset. You can now sign in with your new password.",
    });
  });

  // 6. Get current user's RBAC status in a company
  router.get("/companies/:companyId/my-rbac", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId, { readOnly: true });

    const userId = req.actor.userId || "local-board";
    const status = await rbac.getUserRbacStatus(companyId, userId, req.actor.isInstanceAdmin);
    res.json(status);
  });

  // 7. Get assigned users for an agent
  router.get("/companies/:companyId/agents/:agentId/assigned-users", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await assertCompanyAccess(req, companyId, { readOnly: true });

    const users = await rbac.getAssignedUsersForAgent(companyId, agentId);
    res.json(users);
  });

  // 8. Assign users to an agent (admin/owner only)
  router.put(
    "/companies/:companyId/agents/:agentId/assigned-users",
    validate(assignUsersToAgentSchema),
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      await assertCompanyAccess(req, companyId);

      const userId = req.actor.userId || "local-board";
      const isPrivileged = req.actor.isInstanceAdmin || (await rbac.isOwnerOrAdmin(companyId, userId));
      if (!isPrivileged) {
        throw forbidden("Only an owner or admin can assign users to an agent.");
      }

      await rbac.assignUsersToAgent(companyId, agentId, req.body.userIds, userId);
      res.json({ success: true });
    },
  );

  // 9. Get assigned agents for a user in a company
  router.get("/companies/:companyId/users/:userId/assigned-agents", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const targetUserId = req.params.userId as string;
    await assertCompanyAccess(req, companyId, { readOnly: true });

    const agentIds = await rbac.getAssignedAgentsForUser(companyId, targetUserId);
    res.json(agentIds);
  });

  // 10. Assign agents to a user in a company (admin/owner only)
  router.put(
    "/companies/:companyId/users/:userId/assigned-agents",
    validate(assignAgentsToUserSchema),
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const targetUserId = req.params.userId as string;
      await assertCompanyAccess(req, companyId);

      const userId = req.actor.userId || "local-board";
      const isPrivileged = req.actor.isInstanceAdmin || (await rbac.isOwnerOrAdmin(companyId, userId));
      if (!isPrivileged) {
        throw forbidden("Only an owner or admin can assign agents to a user.");
      }

      await rbac.assignAgentsToUser(companyId, targetUserId, req.body.agentIds, userId);
      res.json({ success: true });
    },
  );

  return router;
}
