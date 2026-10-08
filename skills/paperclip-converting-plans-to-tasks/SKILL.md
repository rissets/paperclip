---
name: paperclip-converting-plans-to-tasks
description: >
  Convert Paperclip plans into executable issue graphs. Decide whether Paperclip work
  needs delegation, and connect justified tasks with owners, specialty fit, and real dependencies.
  Use when turning an authorized plan into work.
---

# Paperclip — Converting Plans to Tasks

A companion skill for turning a plan into executable Paperclip work. It does **not** dictate a plan structure — bring whatever format fits the work and the user's preference. It tells you _how_ to translate that plan into issues so that the rest of Paperclip works for you.

Keep small, cohesive work on its current ordinary task with one end-to-end owner. A plan's steps, files, and phases do not each need a task.

Create a separate task only for a useful boundary: another owner or permission,
independent parallel output, a real prerequisite, independent review, or substantial
follow-up that needs its own lifecycle. Check the available agents before assigning.
Give each delegate enough context and a clear deliverable to work independently.

Set real dependencies through `blockedByIssueIds` (or the native dependency tool).
Parent/child nesting and prose do not delay execution. Independent work can start
now; dependent work must wait for its prerequisite. Verify the saved relationships.

- **Plan deeply.** Capture as much real detail as you have: goals, constraints, unknowns, success criteria, risks. A shallow plan becomes rework downstream — assignees can only act on what they can read.
- **Minimize the issue graph.** Use as few tasks as possible while still completing and verifying the job. Prefer one end-to-end task with one owner over separate tasks for each step, file, component, or phase. Keep those structural details as checklists or acceptance criteria inside the owning task unless a real execution boundary requires another issue.
- **Split only for a qualifying boundary.** Create a separate subtask only when at least one of these applies:
  - A different specialist, owner, permission boundary, or external actor must own the work.
  - A self-contained deliverable can usefully run in parallel with other work.
  - A hard dependency or handoff needs its own `blockedByIssueIds` lifecycle.
  - A review, QA pass, or governed approval gate has an independent owner.
  - Substantial follow-up work needs independent tracking or retry because it cannot safely be completed and verified in the parent.
- **Know your team.** Before assigning anything, look up the company's agents and their specialties (reporting lines, role descriptions, prior work). Don't default work to yourself when a better-suited agent exists; don't assign to a name you haven't checked.
- **Assign for specialty.** Hand each piece of work to the agent most relevant to it. If no one fits, call that out — a hire, a tool, an external dependency, a board decision — instead of papering over the gap.
- **Take responsibility.** Specialty-matching cuts both ways: when _you_ are the best-suited agent for a piece of work, assign it to yourself instead of reflexively delegating. Don't hand off to avoid load.
- **Use the dependency tree.** Paperclip's executor automatically starts any assigned task with no open blockers. Parent/child issue nesting is structure, not execution blocking. Express each qualifying ownership or lifecycle boundary as an issue; keep other concrete deliverables within the responsible issue's description, checklist, or acceptance criteria. Wire every hard dependency between issues through `blockedByIssueIds` on the dependent issue (not prose like "blocked by X"). When a blocker reaches `done`, dependents auto-wake.
- **Order, then parallelize.** Sequence work by real dependencies, not by personal preference. Create parallel branches only for qualifying, self-contained work, then start those independent branches in parallel. Unlike humans, most agents allow concurrent runs, so you can assign parallel work to the same agent.
- **Write review tasks for the reviewer's boundary.** Reviewers publish findings on their own review task and complete it, including an adverse verdict. Make its description self-contained. Connect the verdict to the owner who must act on it; do not require writes to the parent (low-trust reviewers are guaranteed a 403 there). Wire the dependent issue's `blockedByIssueIds` to the review issue so the verdict wakes the right owner.
- **Enough is enough.** Plans exist to unblock execution, not replace it. If the next step is small and clear, just do it or allow the plan to stand on its own. Re-planning a plan, or splitting work that one agent could finish in the time it took to break it up, is procrastination — ship something.

Honor existing authorization and approval boundaries. Use Paperclip's planning
mechanics when approval is required; decomposition does not create new approval gates.
