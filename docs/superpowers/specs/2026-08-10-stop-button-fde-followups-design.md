# Design Spec — Stop Button + AI-Generated FDE Recommended Questions

Date: 2026-08-10
Status: Approved (design); implementation pending
Scope owner: OntoCopilot

## 1. Goal

Two independent UX upgrades to the chat surface (`ui/index.html` + `server.py`),
built inside the existing style — no redesign:

1. **Stop button.** The composer's send arrow (`↑`) becomes a stop control (`■`)
   while generation is running — for **both** a chat turn *and* the 梳理 pipeline
   — and clicking it interrupts the current generation. When work finishes it
   reverts to the arrow.
2. **AI recommended questions.** Replace the heuristic recommended-question
   generator (`onto/prompts.py`) with an AI call that, given the current project
   context, predicts what an FDE engineer would most likely ask next. Applies to
   post-turn followups **and** post-materials opening prompts. Heuristics stay as
   the fallback.

### Locked product decisions
1. **"Pause" = stop/interrupt** the current generation (ChatGPT-style), **not**
   pause-and-resume. There is no mid-run state to resume from.
2. **Scope = chat + 梳理 pipeline.** Both running states are stoppable.
3. **Icon = `■`** (universal stop-generating glyph), inside the existing black
   circular button.
4. **Foreground priority.** The composer button governs the foreground (a chat
   turn in flight); the background 梳理 task is also stoppable from its
   action-bar chip. See the button state machine in §2.2.
5. **Recommended questions via a separate model call**, delivered out-of-band so
   the reply is never delayed. Applies to chat followups **and** post-materials
   opening prompts; the truly-empty-session openers (no context) stay heuristic.

## 2. Part 1 — Stop button

### 2.1 The problem today
Neither generation is cancellable:
- **Chat** runs *inline* inside the `POST /chat` request handler (`_reason` →
  `ConversationAgent.run`, `max_steps=5`). Nothing else can reach it to stop it.
- **梳理** runs as `asyncio.create_task(_run_pipeline(...))` at 4 call sites
  (`server.py:512,1413,1492,1923`) whose task handle is **discarded**.

So the work is: give each a stored task handle + one cancel endpoint.

### 2.2 Backend — cancellable work + one stop endpoint
- **`Session` gains two fields** (`server.py:91`): `chat_task: asyncio.Task | None`
  and `run_task: asyncio.Task | None` (both default `None`, not persisted).
- **`/chat` wraps reasoning in a task.** `s.chat_task = asyncio.create_task(_reason(...))`
  then `await s.chat_task`. Wrap the await in
  `try/except asyncio.CancelledError`: on cancel, publish a short
  `（已停止）` assistant turn, `_persist(status=False)`, and return
  `{stopped: true}`. Clear `s.chat_task` in a `finally`. Catching a *child*
  task's `CancelledError` does not cancel the endpoint coroutine itself, so this
  is safe. (The `approved+pending` replay fast-path is left unwrapped — it is a
  sub-second deterministic replay.)
- **`_run_pipeline` stores its handle** at all 4 call sites (`s.run_task = asyncio.create_task(...)`).
  Add an `except asyncio.CancelledError` branch **before** the existing
  `except Exception` (CancelledError is a `BaseException`, so the generic
  handler never swallows it; the existing `finally: backend.aclose()` still
  runs). The branch sets `s.status = "stopped"`, emits a new `run.cancelled`
  event, then re-raises (correct asyncio semantics).
- **New endpoint** `POST /api/sessions/{sid}/stop`, body `{target: "chat"|"run"|"all"}`
  (default `"all"`): cancels whichever of `s.chat_task` / `s.run_task` is live
  and not done; returns `{stopped: [...]}`. Idempotent — stopping nothing is a
  no-op 200.
- **New status `"stopped"`**: added to the frontend `statusText` map as `已停止`;
  treated as non-busy and restartable (materials present + not-done ⇒ action bar
  shows 开始/重新梳理). `run.cancelled` is added to the SSE refresh trigger list
  (`server` frontend `connect()` at `index.html:504`).

### 2.3 Frontend — button state machine
A module var `let CHAT_ABORT = null;`. `sendChat()` creates
`CHAT_ABORT = new AbortController()` and threads `signal: CHAT_ABORT.signal`
through the `fetch` options (`j()` already forwards its init object). An
`AbortError` in the `catch` is swallowed (no error bubble).

The `#send` button is (re)computed in `render()` **and** on composer `input`
(so typing during 梳理 flips it to send). Priority order:

1. **`THINKING`** (chat turn in flight) → `■` 停止 → `stopChat()`. *(foreground)*
2. else **input has non-empty text** → `↑` 发送 → `sendChat()`. *(so you can always
   talk to it while 梳理 runs — the app's defining interaction)*
3. else **梳理 running** (`status ∈ {parsing, extracting}`) → `■` 停止 →
   `stopRun()`. *(honors "task running → stop button")*
4. else → `↑` 发送.

- `stopChat()`: `CHAT_ABORT?.abort()` then `POST /stop {target:"chat"}`;
  `stopThinking(); render()`.
- `stopRun()`: `POST /stop {target:"run"}`.
- The **action-bar "正在梳理…" chip** (`paintActions`, `index.html:1055`) gains a
  small `✕ 停止` calling `stopRun()` — a redundant, always-available 梳理 stop
  for the case where a chat turn is *also* in flight (then the composer shows
  chat-stop, per rule 1).
- CSS: a `.cbtn.stop` modifier reuses the black-circle `.cbtn.go` look with the
  `■` glyph. No new visual language.

### 2.4 Edge cases
- **Stop with nothing running** → 200 no-op.
- **Task finishes between click and cancel** → `.done()` guard skips it.
- **Client abort races the response** → `/stop` on the server is the source of
  truth for halting compute; the client abort only unblocks the UI.
- **Cost accounting** on a stopped chat: `_chat_usd` is only updated inside
  `_reason` after `agent.run` returns; a cancelled turn simply doesn't bill the
  final step (partial kernel spend already emitted stays as-is).

## 3. Part 2 — AI recommended questions

### 3.1 Today
`onto/prompts.py` is pure heuristics: `followup_prompts` (keyword-echo `_ECHO`
over the answer + fact rules) and `opening_prompts` (state-rule table). Good as a
floor, but not context-aware and not FDE-shaped.

### 3.2 Mechanism — one AI helper, three seams, SSE delivery
- **`_ai_recommend(s, *, slot, user_text=None, reply=None) -> list[dict] | None`**
  (new, in `server.py` next to `_say`). Builds context from `_context_brief(s)`
  (product stats, materials, 已拍板 decisions, 待拍板 count, 建议), the corpus
  findings, the last few dialogue turns, and — for `slot="followup"` — the just-
  produced `reply`. Calls `gw.call("CHAT.recommend", …, system=_FDE_SYSTEM,
  difficulty=Difficulty.LOW, schema=_FOLLOWUPS_SCHEMA, max_tokens≈400)` — the
  same call pattern as `_say()`. Adds cost to `_chat_usd`. Returns `None` on any
  error/empty so callers fall back.
- **`_FOLLOWUPS_SCHEMA`**: `{questions: [{text, send?}]}`, max 3. `send` optional
  (display text vs. what gets sent), matching the existing `Prompt` contract so
  the frontend `.pchip` renderer is unchanged.
- **`_FDE_SYSTEM`** persona: *predict the 3 most likely next questions a Forward-
  Deployed Engineer would ask given the current project state — specific,
  actionable, grounded in the materials/产物; only ask what is answerable and
  useful; no fluff/greetings.* Carries over the two disciplines already written
  in `prompts.py`'s module docstring.
- **Delivery is out-of-band.** `/chat` still returns the **heuristic** followups
  immediately (zero added reply latency, always something). It then spawns
  `asyncio.create_task(_emit_ai_prompts(s, slot="followup", turn=run_id, ...))`,
  which computes AI questions and `s.emit("prompts.ready", slot, turn, questions)`.
  Same pattern fires at the **materials** seam (after `/files`) and the
  **run-complete** seam (after 梳理 reaches `awaiting_answer`/`run.completed`).
- **Frontend** `connect()` handles `prompts.ready`: routes `slot="followup"` →
  `FOLLOWUPS`, `slot="opening"` → `PROMPTS`, then `render()`. The chips visibly
  upgrade from heuristic to AI a beat after the reply. (Guard: apply followups
  only if `turn` matches the latest turn, so a stale in-flight generation can't
  overwrite newer chips.)

### 3.3 Fallback & cost
- Model down / cost cap hit / empty result → `_ai_recommend` returns `None`, the
  already-shown heuristic chips stand. Nothing regresses offline.
- Reuses the existing `_chat_usd` cap (`ONTOCOPILOT_CHAT_USD_CAP`). One extra
  LOW-difficulty ~400-token call per turn — small, and skippable under cap.
- Empty-session openers (no materials, no corpus) stay heuristic — nothing to
  personalize from.

## 4. File-level change list
- `src/ontocopilot/server.py`
  - `Session`: `+chat_task`, `+run_task`.
  - `chat()`: wrap `_reason` in `s.chat_task`; handle `CancelledError`.
  - `_run_pipeline()`: store handle (×4 sites); `except CancelledError` branch;
    emit `run.cancelled`; status `stopped`.
  - `+ stop()` endpoint.
  - `+ _ai_recommend`, `+ _emit_ai_prompts`, `+ _FDE_SYSTEM`, `+ _FOLLOWUPS_SCHEMA`;
    spawn at chat/upload/run-complete seams.
- `ui/index.html`
  - `CHAT_ABORT`; `sendChat` signal + AbortError swallow.
  - `#send` state machine in `render()` + on `input`; `stopChat`/`stopRun`.
  - `statusText` `+stopped`; `run.cancelled` + `prompts.ready` in `connect()`.
  - action-bar 梳理 `✕ 停止`; `.cbtn.stop` CSS.
- `src/ontocopilot/onto/prompts.py` — unchanged (kept as fallback).

## 5. Testing
- **Cancellation (backend, pytest)**: start a `_run_pipeline`, `POST /stop`,
  assert status → `stopped` and a `run.cancelled` event; assert a second `/stop`
  is a no-op 200. Chat: start a slow `_reason` (stub gateway), `/stop`, assert
  `{stopped:true}` and a `（已停止）` turn.
- **Recommend fallback**: force `gw.call` to raise → assert heuristic followups
  still returned by `/chat` and no 500.
- **Manual/UI**: arrow↔■ flip across the 4 state-machine branches; type-during-梳理
  keeps send; action-bar ✕ stops 梳理 while a chat is in flight; chips upgrade
  from heuristic to AI on `prompts.ready`.

## 6. Out of scope
- True pause/resume of a run.
- Token-level streaming of the chat reply (backend still returns the whole turn;
  the typewriter effect is frontend-only, unchanged).
- Per-user isolation of any of this (consistent with the shared-data model in the
  auth spec).
