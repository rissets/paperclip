# Agent Chat Session Optimization and Floating Quick Chat Widget

## 1. Problem and Root Cause Analysis

### A. Context Bloat and Latency Spike (DEC-7 and DEC-9 Analysis)
When analyzing `DEC-7` and `DEC-9` on `http://localhost:3100/DEC/issues/DEC-7` and `http://localhost:3100/DEC/issues/DEC-9`:
1. In `DEC-7`, the Knowledge Agent performed extensive RAG retrieval and document inspection, outputting large text chunks into the runner's terminal stdout.
2. The agent adapter (`pi_local`) recorded this entire terminal output into the agent's persistent CLI session file (`~/.pi/paperclips/...765e6e92-fc82-45a9-b420-67a6b4ebfbea.jsonl`).
3. When `DEC-9` was created (with a simple prompt "hallo"), the adapter reused the existing task session (`taskSessionReused: true`).
4. As a result, the input prompt sent to the LLM grew to **455,936 tokens** (nearly half a million tokens!).
5. Processing ~450k tokens on every heartbeat turn caused the response time to slow down to **40s - 50s**.
6. Each sub-turn of the agent (checking inbox, checking me.json, executing search) incurred another full-context LLM roundtrip, compounding the latency.

### B. Single-Session Ticket vs Multi-Session Chat
- In the current Paperclip implementation:
  - An issue/ticket thread maintains an ongoing conversation.
  - At the route level (`/chats/:agentRef`), the backend strictly enforces a single conversation issue per user and agent (`getConversation` returns `rows[0] ?? null`).
  - There is currently no UI or endpoint to create a separate "New Chat" with a fresh context, nor is there a "Recents Chat" drawer/dropdown.
  - Across separate tickets, when `taskSessionReused` is active in `pi_local`, the runner's disk session file is carried over across tasks if not explicitly reset with `forceFreshSession: true`.

---

## 2. Architecture & Design

### A. Fresh Session Isolation & Token Reset
- When a user starts a **New Chat**:
  - The server creates a new conversation issue for `(companyId, agentId, userId)`.
  - The wake-up dispatch must set `forceFreshSession: true`.
  - The agent adapter (`pi_local`) purges old accumulated bash tool outputs and conversation transcripts for the new session, resetting cached input tokens back to 0.
  - Response latency drops from 40s–50s to fast sub-3s response times.

### B. Multi-Session & Recent Chats API
- Update `server/src/routes/issues.ts` and `server/src/services/issues.ts`:
  - `GET /companies/:companyId/chats/:agentRef/recents`: Returns list of previous chat conversation issues for this user and agent (ordered by `updatedAt DESC`).
  - `POST /companies/:companyId/chats/:agentRef/new`: Creates a new conversation issue with `forceFreshSession: true`, leaving past conversations accessible in the recent list.

### C. Floating Quick Chat Widget (Multica-style)
- **Floating Action Button (FAB)**:
  - Fixed at `bottom-6 right-6` with `z-50`.
  - Circular button (`size-12` / `size-14`), card background, primary hover ring, chat bubble icon (`MessageSquare` / `MessageCircle`).
  - Smooth scale and hover transition.
- **Floating Chat Dialog / Popover**:
  - Positioned anchored at bottom-right (`bottom-20 right-6` or overlay modal).
  - Header:
    - `+ New chat v`: Button with dropdown showing **Recent Chats** list and option to create a fresh chat.
    - Maximize/Expand button (`Maximize2` / `ExternalLink`) linking to the full-page `/chats/:agentRef`.
    - Minimize button (`Minus`) and Close button (`X`).
  - Agent Selector & Greeting:
    - Quick agent switcher dropdown in header or composer.
    - If chat has no messages yet (empty state):
      - Agent Avatar + Name + Role subtitle.
      - 3-4 Quick Starter Action Pills (e.g., "Riset dan ringkas", "Tanya SOP / Dokumen RAG", "Bantu selesaikan tugas").
      - Clicking a starter pill automatically populates or sends the query.
  - Message Thread:
    - Lightweight message bubbles between User and Agent.
    - Real-time polling / query invalidation for streaming and live agent responses.
  - Composer:
    - Input textarea with placeholder `Message [Agent Name]...`.
    - Agent picker button at bottom-left of composer.
    - Send button (up arrow).

---

## 3. Implementation Steps

1. **Backend Endpoints (`server/src/routes/issues.ts` & `server/src/services/issues.ts`)**:
   - Add `listConversations(companyId, agentId, userId)` to `IssueService`.
   - Add `POST /companies/:companyId/chats/:agentRef/new` route to create new clean conversation issues with `forceFreshSession: true`.
   - Add `GET /companies/:companyId/chats/:agentRef/recents` route to fetch recent chats.

2. **Frontend API Client (`ui/src/api/agentChats.ts`)**:
   - Add `listRecents(companyId, agentRef)` and `createFresh(companyId, agentRef)`.

3. **Floating Quick Chat Component (`ui/src/components/chat/QuickChatFloatingWidget.tsx`)**:
   - Implement the FAB button, popover container, header with dropdown recents, agent switcher, greeting with starter pills, and active message thread.
   - Integrate into `ui/src/components/Layout.tsx` so it floats gracefully on all company dashboard pages.

4. **Token-Gate & Typecheck Verification**:
   - Ensure all classes strictly use token variables without raw px/hex/arbitrary bracket values.
   - Run `pnpm check:token-gates`, `pnpm -r typecheck`, and run automated tests.
