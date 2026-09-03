# OntoCopilot FDE Context Sidebar — Design QA

Date: 2026-08-17

## Visual sources

- Existing OntoCopilot shell: `/var/folders/8b/z60nvfzd69xdgn4rx84kbyfh0000gn/T/codex-clipboard-051766a2-bfc8-41fd-934e-33f140a92970.png`
- Model explorer direction: `/Users/yuhancheng/.codex/generated_images/01a00e54-8dec-7f30-9b96-2bc0e478bda2/exec-78ca420a-5141-4685-96e7-cee544b8b253.png`
- Review workspace direction: `/Users/yuhancheng/.codex/generated_images/01a00e54-8dec-7f30-9b96-2bc0e478bda2/exec-1a5a6d6d-59af-481a-a8b0-44a8a78e806c.png`

## Comparison evidence

- Model comparison after removing duplicate controls: `docs/assets/sidebar-design/qa-model-comparison-final-v2.png`
- Same-viewport Review before/after: `docs/assets/sidebar-design/qa-review-fde-before-after-2026-08-17.png`
- Final FDE priority queue: `docs/assets/sidebar-design/17-final-review-wide-priority.png`
- Final batched diagnostics: `docs/assets/sidebar-design/18-final-review-wide-diagnostics.png`
- Model direction + live workflow canvas: `docs/assets/sidebar-design/qa-canvas-comparison-final.png`
- Excel viewer: `docs/assets/sidebar-design/qa-excel-preview-final.png`
- SVG viewer: `docs/assets/sidebar-design/qa-svg-preview-final.png`

The reference and implementation states were normalized into paired comparison images before judging hierarchy, density, spacing, active states, borders, and use of the existing green accent. The final implementation intentionally keeps OntoCopilot's current shell and tokens instead of cloning the reference application's chrome.

## Browser QA

Tested in the open in-app browser against `http://127.0.0.1:8765/`, using an isolated copy of a real project with 2 materials, 182 objects, 110 actions, 25 rules, and 572 authoritative review questions.

- Five sections navigate correctly: Project, Evidence, Model, Review, Delivery.
- Wide and compact sidebar modes preserve the chat workspace.
- Model search/filter, object detail, evidence location, and review links work.
- Workflow canvas loads the 48 nodes actually mapped into the live FlowGraph instead of mixing in 110 unmapped Action candidates; Action, Event, gateway, and terminal types were all present and fitted inside the viewport.
- Canvas zoom, fit, layer filters, object-relation switch, node selection, and node inspector work.
- Selecting a material, artifact, or canvas node creates a current chat reference without falsely creating a write receipt.
- Excel preview renders parsed sheets as scrollable tables; two sheets were verified.
- SVG preview uses the sandboxed `/preview/content` URL rather than the raw artifact URL.
- A successful review answer creates a chat-side context-change receipt with quote, view, and close actions.
- The live Question Ledger now overrides a stale `/context` snapshot after a write; the answered question leaves the default open queue after reload.
- No-material Project and empty-canvas states prefill the generic Ontology draft prompt without sending it.
- The model filter exposes 17 Events and follows the global language setting; no duplicate language switch or “Model current snapshot” badge remains in the sidebar header.
- Review projects 572 authoritative questions into 203 FDE-visible items: 200 business/model questions plus 372 lint findings grouped into 3 expandable diagnostic batches. Original ids, statuses, priorities, Decisions, and the release gate remain authoritative.
- The default blocker is rewritten only in the read projection as an answerable system/API/read-only-scope decision; the original machine finding remains visible in detail.
- Link contracts and Workflow orchestration are first-class review domains. Deferred questions are not counted as Resolved.
- English mode was switched through the existing lower-left global setting. Review navigation, domains, guidance, levels, status, and batch copy changed with it; source-question text intentionally remained verbatim.
- Delivery lists concrete non-publishable DRAFT JSON views for package/schema/DataObjects/Links/Actions/Events/Workflows/Rules/Integrations/Gaps/Questions.
- Browser console: 0 errors, 0 warnings after the final file/model/canvas/review/delivery pass.

## Issues found and fixed during QA

1. Wide viewer originally nested the object detail inside its directory column, crushing it into an unusable third column. The viewer directory now retains only the relevant list; preview/canvas owns the main pane.
2. The aggregated `/context` snapshot could visually overwrite a just-updated Question Ledger record. Live ledger records now merge by id and override the older snapshot.
3. The no-material next-step copy only suggested upload. It now presents upload and a clearly marked, ungrounded generic Ontology draft as equal starting paths.
4. Machine lint originally dominated Review with hundreds of repeated missing-primary-key/orphan-object rows. The FDE read model now batches homogeneous diagnostics and ranks business decisions by domain and impact.
5. “170 objects have no ActionType/OpenAPI endpoint” was technically true but not answerable. Its UI projection now asks which objects are written by an owning system/API and which are intentionally read-only, out of scope, or not applicable.
6. Review previously treated deferred items as resolved and could repeatedly steal focus after refresh/language changes. Resolved now requires answered/cancelled authority records, and focus references are consumed once.

## Intentional behavior

- Preview/focus is not a mutation. Only successful review writes and real exports publish chat receipts.
- Generic scenario output is `DRAFT`, `INFERRED`, zero-evidence, and cannot claim customer confirmation.
- FDE review grouping is read-only: it never merges Decisions or downgrades release blockers. Opening a batched member returns to the authoritative Question.
- Original material/question prose is not machine-translated; this preserves customer wording and evidence fidelity.
- XLSX/DOCX preview reuses existing parsed chunks; it does not silently parse binary files during a read-only GET. Unsupported or unavailable previews fall back to an explicit download action.
- PNG/SVG inline rendering is restricted by server-side allowlists and active-content checks.

## Verification

- Final focused regression (Review, sidebar, context/model/sync, preview, Question Ledger, Ontology Package, DRAFT routes and wiring): 381 passed across 11 files.
- Canonical/package/route focused regression from the package compiler pass: 299 passed.
- TypeScript `--noEmit`: passed.
- Generated UI consistency check: passed.
- `git diff --check`: passed.

final result: passed

---

# OntoCopilot Live Browser — Design QA

Date: 2026-08-31

## Visual source and evidence

- Source visual truth: `/var/folders/8b/z60nvfzd69xdgn4rx84kbyfh0000gn/T/codex-clipboard-14241290-bbec-4fd8-84ee-260ba33c3a74.png`
- Browser-rendered implementation: `docs/audit/live-browser-ui/live-browser-default-engine-unavailable.png`
- Local implementation URL: `http://127.0.0.1:8765/`

## Findings

- Ordinary HTTP(S) tabs now open in the primary `浏览` mode instead of presenting Reader or AI summary first.
- The control hierarchy remains intentionally compact: Back, Forward, Reload, address, Open, two surface choices, language, and AI summary. Reader/translation/summary remain secondary tools.
- The live surface uses same-origin screenshot pixels rather than a third-party iframe; click coordinates, wheel input, and non-submitting keyboard input are supported.
- The unavailable-engine state is explicit and offers three honest recovery paths: Retry Browser, Use Reader, and Open external.
- Hidden resource tabs do not start browser runtimes. Returning to a tab reopens the last persisted live URL rather than its original URL.
- The live frame URL is bound to the current session id, validated browser id, and exact frame sequence. The rendered image suppresses referrers, and unmount cleanup uses a keepalive close request.

## Verification

- Focused WebPreview, ContextSidebar, and WorkbenchTabs regressions: 163 passed.
- UI build/serve regressions: 8 passed.
- TypeScript `--noEmit`: passed.
- Generated UI bundle and application build: passed.
- Live browser engine rendering requires the running service to be restarted with the new backend routes. The screenshot documents the correct default-Live UI and honest pre-restart fallback state.

final result: UI passed; runtime visual pending service restart

---

# OntoCopilot Web Workbench Tabs & Reader — Design QA

Date: 2026-08-28

## Comparison target

- Source visual truth: `/Users/yuhancheng/.codex/generated_images/019feee1-32ee-79c2-9b1f-75e72142b705/exec-4d30f271-a229-4bb4-afc3-0d4a78ef0647.png`
- Browser-rendered implementation: `/Users/yuhancheng/dev/OntoChat/artifacts/design-qa/workbench-web-preview/implementation-web-wide.jpg`
- Full-view comparison (source and implementation in one image): `/Users/yuhancheng/dev/OntoChat/artifacts/design-qa/workbench-web-preview/comparison-full-final.png`
- Focused Sidebar comparison (source and implementation in one image): `/Users/yuhancheng/dev/OntoChat/artifacts/design-qa/workbench-web-preview/comparison-sidebar-final.png`
- Local implementation URL: `http://127.0.0.1:8765/`

## Normalization

- Source pixels: 1487 × 1058.
- Implementation screenshot pixels: 894 × 811.
- Browser CSS viewport: 894 × 811; reported device pixel ratio: 2. The Browser capture is normalized to CSS-pixel dimensions.
- Full-view comparison: source scaled proportionally to 1140 × 811; implementation retained at 894 × 811.
- Focused comparison: source Sidebar region cropped to 837 × 1058 then proportionally scaled to 640 × 810; implementation Sidebar region cropped to 384 × 810. The implementation was deliberately tested in a narrower real Sidebar than the wide concept to exercise the responsive contract.
- State: existing采购 project session, external page opened as an immutable reader snapshot, Chinese/bilingual translation available, AI summary expanded with citations, and webpage saved into AssetMemory.

## Findings and iteration history

### Iteration 1 — blocked

- [P1] Real public webpages could not be fetched by the production transport on Node 22.
  - Evidence: the first browser capture showed a blocked page with no reader body; the durable page record reported `fetch_failed`. The pinned lookup was being interpreted as an all-address lookup, producing `ERR_INVALID_IP_ADDRESS`.
  - Fix: advertise the already-validated pinned IP family on the HTTP(S) request and add a real socket-level regression test.
- [P1] One Back click appeared to do nothing after navigating within a resource tab.
  - Evidence: every successful `onPageChange` was reflected by the parent as a new `pageId` prop and appended as a duplicate history entry.
  - Fix: identify the parent acknowledgement of an internally emitted immutable page and replace the current history entry instead of appending it. A controlled-parent regression now asserts one-click Back behavior.
- [P2] “存为材料” confirmed success, but the existing 文件 page did not show the new webpage until a full session reload.
  - Fix: after the durable save succeeds, refresh only the authoritative `asset_memory` projection with a session-id guard and repaint the existing File workbench.

### Iteration 2 — passed

- Post-fix browser evidence: `/Users/yuhancheng/dev/OntoChat/artifacts/design-qa/workbench-web-preview/implementation-web-wide.jpg`.
- The same page tab now supports address navigation, one-click Back/Forward, Refresh, external open, original/Chinese/bilingual modes, version-bound AI summary, citation-to-chat prefill, and immediate save-to-material visibility.
- The fixed `工作台` tab remains non-closable; returning to it preserves all six existing pages and their local state. Resource pages occupy the same Sidebar content region rather than replacing the workbench architecture.
- No actionable P0/P1/P2 visual or interaction findings remain.

## Required fidelity surfaces

- Fonts and typography: the implementation retains OntoCopilot's existing serif product mark and sans-serif application hierarchy. Web-reader display text uses a stronger editorial scale and readable line height. The source concept's exact dark-theme font rendering is intentionally not forced when the active product appearance is light.
- Spacing and layout rhythm: the tab strip, browser controls, summary, and reader follow the concept's vertical hierarchy. At the real 384 px Sidebar width, controls wrap without hiding navigation or persistent actions; at wider saved Sidebar widths they return to the more horizontal concept layout.
- Colors and tokens: existing OntoCopilot surface, border, ink, and green semantic-accent tokens are reused. Light-vs-dark appearance follows the user's global application theme instead of hard-coding the mock's dark state.
- Image quality and asset fidelity: no raster or placeholder approximation was introduced. The reader renders trusted text snapshots and native citation controls; live third-party HTML is never copied into the app. The concept's SAP content was replaced only for deterministic QA with the real public `example.com` snapshot.
- Copy and content: Chinese action labels are concise and stateful. The UI explicitly distinguishes safe reader snapshot, blocked live embedding, translation progress, version-bound summary, chat citation, and saved material rather than claiming that an unavailable webpage is live.

## Primary interactions tested

- Open and close the `+` URL input; reject unsafe schemes.
- Create/deduplicate a sibling web resource tab without unmounting the six-page workbench.
- Fetch two public pages through redirect/DNS/IP/content-size guards.
- Navigate by address; Back and Forward restore immutable page ids with one click.
- Switch original, Chinese, and bilingual modes.
- Generate and reopen a digest-bound AI summary; locate citations.
- Prefill the central chat with page/summary citation identity without auto-sending.
- Save two webpage snapshots; verify immediate visibility under the existing 文件 page and persistence after reload.
- Resize the Sidebar to the wide workbench state and verify responsive wrapping at the compact state.
- Browser console checked after the final pass: 0 errors, 0 warnings.

## Residual, accepted differences

- The concept image uses a 1487 px dark desktop canvas while the in-app Browser QA surface is 894 px wide and currently uses the user's light appearance. Layout and interaction hierarchy were compared in both full-view and focused Sidebar crops; theme and viewport differences are intentional product constraints, not implementation drift.
- The deterministic QA page is intentionally small. Production pages can provide many paragraphs; the Reader region is independently scrollable and remains bounded by the Sidebar.

final result: passed
