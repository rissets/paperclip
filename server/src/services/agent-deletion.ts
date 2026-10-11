import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  agents,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  activityLog,
  assets,
  approvals,
  approvalComments,
  budgetReservations,
  costEvents,
  financeEvents,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  issueExecutionDecisions,
  issues,
  issueComments,
  issueThreadInteractions,
  principalPermissionGrants,
  type Db,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";

export async function deleteAgentDependencies(tx: Db, companyId: string, id: string) {
  const [decisionHold] = await tx.select({ id: budgetReservations.id }).from(budgetReservations).where(and(
    eq(budgetReservations.companyId, companyId), eq(budgetReservations.agentId, id),
    eq(budgetReservations.state, "held"), sql`${budgetReservations.decisionInvocationId} is not null`,
  )).limit(1);
  if (decisionHold) throw conflict("Wait for active decisions or resolve their unknown charges in Costs before deleting this agent", {
    code: "agent_decision_accounting_pending",
  });
  await issueThreadInteractionService(tx).cancelPendingForDeletedAddressee(companyId, id);
  await tx
    .update(issueThreadInteractions)
    .set({ createdByAgentId: null, resolvedByAgentId: null })
    .where(
      or(
        eq(issueThreadInteractions.createdByAgentId, id),
        eq(issueThreadInteractions.resolvedByAgentId, id),
      ),
    );
  await tx.update(agents).set({ reportsTo: null }).where(eq(agents.reportsTo, id));
  await tx
    .update(issues)
    .set({ assigneeAgentId: null, createdByAgentId: null, conversationAgentId: null })
    .where(
      or(
        eq(issues.assigneeAgentId, id),
        eq(issues.createdByAgentId, id),
        eq(issues.conversationAgentId, id),
      ),
    );
  await tx.update(assets).set({ createdByAgentId: null }).where(eq(assets.createdByAgentId, id));
  await tx.delete(approvalComments).where(eq(approvalComments.authorAgentId, id));
  await tx.update(approvals).set({ requestedByAgentId: null }).where(eq(approvals.requestedByAgentId, id));
  await tx.update(goals).set({ ownerAgentId: null }).where(eq(goals.ownerAgentId, id));
  await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.agentId, id));
  const agentRunIds = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.agentId, id));
  if (agentRunIds.length > 0) {
    const runIdList = agentRunIds.map((r) => r.id);
    await tx.delete(heartbeatRunEvents).where(inArray(heartbeatRunEvents.runId, runIdList));
    await tx.delete(financeEvents).where(inArray(financeEvents.heartbeatRunId, runIdList));
    await tx.delete(costEvents).where(inArray(costEvents.heartbeatRunId, runIdList));
  }
  await tx.delete(financeEvents).where(eq(financeEvents.agentId, id));
  await tx.delete(costEvents).where(eq(costEvents.agentId, id));
  await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, id));
  await tx.delete(activityLog).where(
    or(
      eq(activityLog.agentId, id),
      sql`${activityLog.runId} in (select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.agentId} = ${id})`,
    ),
  );
  await tx.delete(issueExecutionDecisions).where(eq(issueExecutionDecisions.actorAgentId, id));
  await tx.delete(issueComments).where(eq(issueComments.authorAgentId, id));
  await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, id));
  await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id));
  await tx.delete(agentApiKeys).where(eq(agentApiKeys.agentId, id));
  await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, id));
  await tx.delete(principalPermissionGrants).where(and(
    eq(principalPermissionGrants.companyId, companyId),
    eq(principalPermissionGrants.principalType, "agent"),
    eq(principalPermissionGrants.principalId, id),
  ));
}
