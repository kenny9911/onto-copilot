# Design Spec — Auth, Settings/Gateway Config, Full Bilingual, Appearance

Date: 2026-08-10
Status: Approved (design); implementation pending
Scope owner: OntoCopilot

## 1. Goal

Add a login gate + account management, an admin config surface (LLM gateway +
env viewer), full zh/en bilingual support (including English command
understanding), and appearance controls (theme, accent, timezone, font/density)
to OntoCopilot — **without** touching the 8 existing tables or the ~14 existing
session routes. Everything is additive and ships behind flags so the app keeps
working at every intermediate step.

### Locked product decisions
1. **Deployment**: single-admin-gate class. **No per-user data isolation** —
   sessions/workspace/global settings are shared across all accounts. The only
   per-user state is display preferences.
2. **Accounts + roles**: multiple accounts, roles `admin` vs `user`. Admin-only:
   edit LLM gateway config, view/edit env config, manage accounts. Any logged-in
   user may use the app (shared data).
3. **Gateway config UI = BASIC**: edit `base_url` + `api_key` (write-only), and
   pick one catalog model per difficulty tier (LOW/MEDIUM/HIGH/CRITICAL). No full
   routing editor (judges/effort/iterations stay code defaults).
4. **Full bilingual zh/en**, including English command understanding (the
   deterministic intent-parser rework is in scope).
5. **Appearance (all)**: dark/light theme (system-follow + manual, persisted),
   accent-color, timezone preference + timestamp displays, font-size/density.

## 2. Architecture — four layers, four seams

```
AUTH GATE        one fail-closed HTTP middleware → request.state.user; require_admin dep
CONFIG PROVIDER  app_setting table + process-global cache → hot-applies to new runs
I18N LAYER       client dictionary + t(); server returns CODES not prose
APPEARANCE       theme/accent/tz/density as per-user prefs (app_user.prefs JSON)
```

The four seams, each resolved once:
- **(a) auth cookie ↔ CORS ↔ SSE** → opaque cookie-session (`HttpOnly; SameSite=Lax`);
  `EventSource` sends the cookie automatically on the same-origin `/stream` GET,
  so SSE needs zero special handling. CORS tightens from `*` to explicit env
  origins + `allow_credentials=True` (browsers forbid `*` + credentials).
- **(b) per-user prefs ↔ global settings** → `app_setting` is GLOBAL (admin-only:
  gateway/caps/tiers); `app_user.prefs` is per-user self-service (theme/accent/
  tz/density/lang). Neither violates shared-data — prefs are display chrome.
- **(c) i18n codes ↔ server prose** → server emits stable CODES; the client
  dictionary owns all display text, so the broadcast SSE stream stays
  language-neutral (two viewers of one shared session each see their own language).
- **(d) single identity surface** → `/api/me` (role + prefs + lang), `require_user`,
  `require_admin` defined once by auth and consumed by settings + appearance.

## 3. Auth + accounts + roles

### Mechanism
- **Opaque cookie-session**: on login mint `secrets.token_urlsafe(32)`, store only
  its `sha256` in `auth_session`, set an `HttpOnly; SameSite=Lax; Path=/` cookie
  (`Secure` conditional on an env flag; default OFF for http). No JWT, no signing
  secret. Chosen because SSE cannot send Authorization headers.
- **Passwords**: stdlib `hashlib.scrypt` (no new dependency), self-describing
  string, `hmac.compare_digest` verify. **Run every hash/verify in a threadpool**
  (`anyio.to_thread.run_sync`) so it never blocks the async event loop / SSE.
- **Gate**: one fail-closed HTTP middleware. Public allowlist: `GET /`,
  `GET /api/health`, `POST /api/login`, `GET /api/auth/status`. Everything else
  under `/api/*` 401s when unauthenticated. Role policy lives in a `require_admin`
  FastAPI dependency on the new `/api/users` and `/api/config` routers. **Existing
  ~14 routes get zero edits.**

### Security posture (hardened per adversarial review)
- **FAIL-CLOSED**: auth turns ON automatically once `count_users() > 0`. Running
  with no auth requires an explicit `ONTOCOPILOT_DEV_NO_AUTH=1` that logs a loud
  startup warning. Absence of a flag never means "wide open." When the dev flag is
  set the middleware injects a synthetic admin so local single-user use and the
  test suite behave exactly as today.
- **First admin via host CLI** (no public bootstrap route): `ontocopilot useradd
  --admin <name>` prompts for a password on the host. Closes the internet-facing
  land-grab race. The assistant never creates accounts or sets passwords.
- **Login throttle**: minimal in-memory per-IP fixed-window counter on `/api/login`
  (no dependency), to blunt DoS/brute-force against the memory-hard hash.
- **No enumeration**: generic `401` for bad-user / bad-password / inactive alike;
  dummy scrypt verify on absent user to equalize timing.
- **Immediate revocation**: deactivate / delete / reset-password purges the user's
  `auth_session` rows AND `resolve_auth` re-checks `user.active` every request.
- **Guards**: cannot delete/demote the last active admin; cannot self-delete.
- **CORS**: parse `ONTOCOPILOT_CORS_ORIGINS`; reject `*` and empty entries when
  credentials are on; default empty = same-origin (how it deploys).

### Endpoints
- Public: `GET /api/auth/status`, `POST /api/login`.
- Authed: `POST /api/logout`, `GET /api/me`, `POST /api/me/password`,
  `PATCH /api/me/prefs`.
- Admin (`APIRouter(prefix="/api/users", dependencies=[Depends(require_admin)])`):
  `GET /api/users`, `POST /api/users`, `PATCH /api/users/{id}` (role/active),
  `POST /api/users/{id}/reset-password`, `DELETE /api/users/{id}`.

## 4. Data model (new tables — SQLite-safe, Python-generated ids/hashes)

Add via the existing 4-place lockstep (schema.py + migration + repo.py both impls
+ tests). IDs, password hashes, and token hashes are generated in **Python** (no
`gen_random_uuid`/`GENERATED`/pgcrypto — must run on SQLite + MemoryRepo).

### `app_user` (migration 0002_accounts)
`id` TEXT PK (uuid4 hex) · `username` TEXT UNIQUE NOT NULL (normalized
`strip().lower()`) · `password_hash` TEXT NOT NULL · `role` TEXT NOT NULL DEFAULT
`'user'` CHECK in (`admin`,`user`) · `active` BOOL NOT NULL DEFAULT true ·
**`prefs` JSON NOT NULL DEFAULT '{}'** (appearance/lang blob — MUST exist in 0002
since applied migrations are checksum-locked) · `created_at`/`updated_at` timestamptz.

### `auth_session` (migration 0002_accounts)
`token_hash` TEXT PK (sha256 of cookie token) · `user_id` TEXT FK→app_user
ON DELETE CASCADE · `created_at`/`last_seen_at`/`expires_at` timestamptz ·
INDEX on `user_id` (for revoke-all). Expired rows filtered on read + periodic prune.

### `app_setting` (migration 0003_app_settings)
`key` TEXT PK · `value` JSON NOT NULL · `updated_at` timestamptz. Global key/value.
Keys: `gateway.base_url`, `gateway.api_key` (write-only), `gateway.model.{low,medium,high,critical}`,
`budget.usd_cap`, `budget.chat_usd_cap`.

### Repo / MemoryRepo notes
- `UserRow`, `AuthSessionRow`, `SettingRow` dataclasses; `UserRow.public()` NEVER
  includes `password_hash`.
- MemoryRepo dicts `_users`, `_auth`, `_settings`. **These are top-level — do NOT
  add them to `delete_session()`'s per-session cascade tuple** (that would wipe
  accounts/settings on a session delete). `delete_user()` manually cascades `_auth`.
- Username uniqueness maps to the SAME 409 in both impls (PG IntegrityError /
  Memory explicit check) — parity-tested, not just the happy path.

## 5. Config provider

- `appconfig.py`: process-global cache warmed at lifespan, **atomically swapped**
  on every admin PUT (build new dict, rebind module global in one statement).
- Four read-sites read **setting → env → (raise)**: `_gateways` (resolved base_url/
  key + budget caps + model overrides), `_reason` chat cap.
- `resolved_llm_config()` does DB→env→raise **itself** (never calls the raising
  `llm_config()` as a baseline) so UI-only config works.
- `gateway_routing(model_overrides, catalog)`: pick the per-tier model from
  overrides, **derive `effort` from the chosen `ModelCard`** (effort-less model ⇒
  `effort=None`, so Flash/Haiku never 400). Judges stay code defaults. **Validate
  ≥1 heterogeneous judge remains** after overrides, else 422.
- **Hot-apply to NEW runs only**: `_gateways()` already rebuilds per run; the
  resolved routing is **snapshotted onto each run** so a mid-session change cannot
  mix two models into one Recorder-replayed artifact.
- **api_key at rest**: write-only over API + redacted echo, **plaintext-in-DB**
  (same trust model as `.env`). Fernet/secret-key encryption is CUT from v1.
- **Env viewer**: read-only mirror; secrets redacted **including the password in
  `DATABASE_URL`**. Restart-required vars (DATABASE_URL, workspace) shown read-only.

## 6. Full bilingual — staged

- **Stage A**: UI dictionary `{zh,en}` + `t()`/`fmt()`; `data-i18n` on static nodes;
  language switcher; `<html lang>`; **model replies in chosen language** via a
  one-line directive threaded into `converse.py._SYSTEM` from a per-request
  transient `Session.lang` (captured at request time — the background pipeline
  can't read cookies).
- **Stage B**: convert the ~6 user-facing `HTTPException` prose sites + auth/settings
  errors + ~5 node titles + default session title to **stable CODES** rendered by
  the dictionary; bilingual suggestion chips in `prompts.py`; per-lang `_ECHO`
  needle tables.
- **Stage C**: `kernel/intent.py` refactored into parallel `_ZH`/`_EN` regex
  `RuleTable`s selected by lang — preserves ADR-5 determinism/zero-cost for both
  languages. English ordinal-word slot patterns added ("the second one"). Test
  asserts identical Intent + slots per language and that English-UNKNOWN stays
  UNKNOWN (drop the over-strict confidence-equality clause).
- **Not translated**: extracted domain data (entity names, calibers) and CJK slugs
  (`ids.py` deliberately preserves CJK — do NOT ASCII-ify). No English artifact/xlsx.

## 7. Appearance (per-user prefs)

- **Theme**: variableize the ~30 stray hardcoded colors into `:root` tokens; dark
  palette via `@media(prefers-color-scheme:dark)` + `:root[data-theme]` overrides;
  system/light/dark toggle; no-flash `<head>` boot script.
- **Accent**: **curated presets only** (custom color picker cut — WCAG contrast
  risk); derivations via `color-mix()`.
- **Timezone + timestamps**: add `created_at` to the session list and event
  timestamps to the API responses that omit them; format client-side with
  `Intl.DateTimeFormat` in the chosen tz. Storage stays UTC. **NB: epoch is in
  SECONDS here (`time.time()`), not `now_ms()` — ×1000 before `new Date()`.**
  Validate IANA tz server-side; guard the client formatter.
- **Font/density**: body `--fs` (S/M/L) + `data-density` (compact/comfortable);
  bounded, no full px→rem refactor.
- **Persistence**: `localStorage` pre-login; per-user `app_user.prefs` when logged
  in (server wins on login, mirrors to localStorage; first-login local→server migrate).

## 8. Build sequence

`P1` auth data layer (schema/migration/repo both impls + parity tests + scrypt/token helpers) →
`P2` auth middleware + login/logout/me/status + CORS tighten + env readers →
`P3` admin accounts CRUD + guards →
`P4` settings storage + config provider + gateway_routing refactor + rewire read-sites →
`P5` config UI (basic) + env viewer →
`P6` login/bootstrap/accounts overlays →
`P7` i18n Stage A →
`P8` i18n Stage B →
`P9` i18n Stage C (English commands) →
`P10` appearance frontend →
`P11` appearance persistence + login sync →
`P12` flip auth on (host CLI seeds first admin; smoke-test SSE).

Each phase keeps the test suite green; auth stays OFF until P6 ships (flip at P12).

## 9. Cross-cutting footguns (must-respect)

- Migration numbers: `0002_accounts`, `0003_app_settings` (both subsystems must not
  reuse `0002`). `app_user.prefs` must exist in 0002 (checksum-locked, no later ALTER).
- Freeze `/api/me` response contract (role + full prefs + lang) in P2 before consumers ship.
- Pin `require_user`/`require_admin` signatures as a stable internal API in P2.
- `delete_session()` cascade tuple must NOT gain the new top-level dicts.
- "Codes-not-prose": any new emit/error carries codes+data, not sentences; review
  with a CJK-in-response grep so English mode ships no stray Chinese.
- Cookie `Secure` on http silently drops the cookie → login loop; default OFF.
- Single-process assumption (auth DB lookup, appconfig cache, in-memory SESSIONS/SSE)
  — fine for current single-process reality; breaks under multi-worker. Noted.

## 10. YAGNI — explicitly NOT building

No per-user data isolation · no full routing editor · no JWT/signing secret · no
Fernet/secret-key encryption · no public self-registration · no login audit trail
(v1) · no custom color picker · no full px→rem refactor · no server-side message
catalog / per-connection locale · no `updated_at` surfacing · no global admin-set
default language.

## 11. Defaulted decisions (open to change)

1. First admin via host CLI (not a public route).
2. Fail-closed: auth auto-on once accounts exist; `ONTOCOPILOT_DEV_NO_AUTH=1` opts out locally.
3. Login id = username (email accepted in the same field).
4. api_key: write-only + redacted, plaintext-in-DB; encryption deferred.
5. Timezone default: follow browser (Asia/Shanghai offered as a pick).
6. Cookie `Secure`: off by default (http), env-flag on behind HTTPS.
7. Minimal per-IP login throttle included.
8. Session lifetime: 7-day cookie; self password change allowed.

## 12. Testing strategy

- Reuse the `params=['memory','sql']` parity fixture for every new table
  (round-trip, uniqueness→409, `delete_user` cascades `auth_session`,
  `delete_session` leaves users/settings, `prefs` shallow-merge parity).
- `tests/test_auth.py`: scrypt unit; `httpx.AsyncClient(app)` with
  `dependency_overrides[get_repo]=MemoryRepo` and `ONTOCOPILOT_AUTH=1`:
  login→me→admin CRUD→logout, 401 unauth, 403 non-admin, last-admin/self-delete
  guards, allowlist reachability, auth-off synthetic-admin path.
- `tests/test_intent.py`: bilingual matrix (identical Intent+slots per language;
  English-UNKNOWN stays UNKNOWN).
- `tests/test_config.py`: setting→env→raise precedence; effort-derivation;
  judge-pool-not-empty validation; api_key write-only/redaction; DATABASE_URL redaction.
