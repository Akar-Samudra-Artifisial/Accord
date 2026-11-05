# M0 spikes — site `bayutrisnapati.atlassian.net` (environment `development`)

Run on 2026-11-04/05 (UTC) via the development-only web trigger `accord-dev-diag`
(`src/diag/webtrigger.ts`, `?action=spike|status|seed-step`). The trigger URL is not stored in the repo.

| # | Spike | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Forge SQL migrations (`migrationRunner` from `@forge/sql` 4.0.9, run lazily via `ensureSchema()` on first query) | OK | First call applied `v001`…`v011`; next call `appliedNow: []`, `__migrations` has each name exactly once (`v001_create_teamsx1` … `v011_create_demo_seed_stepsx1`); `SELECT COUNT(*) FROM teams` = 0, later 2 |
| 2 | Jira Agile API as app: `GET /rest/agile/1.0/board`, `/board/{id}/sprint`, `/sprint/{id}/issue` | OK (after adding `read:project:jira`) | Before: `HTTP 401 Unauthorized; scope does not match`. After: `{"boards":4,"scrumBoard":4,"sprints":2,"firstSprintIssues":4}`; capacity/commitment loading reads MOB sprints 1/3 (7 open issues) and PAY sprints 2/4 (11) |
| 3 | Queue push → consumer | OK (after fix, version 5.2.0) | Initially `push(...)` returned `400 Bad Request` (no body) for both queues. Root cause: `@forge/events` 3.0.9 pushes schema `forge/app-event-2`, but the manifest still used the v1 consumer form (`resolver: {function, method}`) and the handlers were `Resolver` definitions. Fix: consumers use `function: <key>` and handlers are plain `(event: AsyncEvent)` functions reading `event.body`. After deploy the web trigger pushed to both queues (jobIds returned), `forge logs` shows `accord-negotiation consumer received …` and `accord-demo-seed consumer received ping …`, and `lastQueuePing` was written to `audit_log` |
| 4 | Confluence v2 `POST /wiki/api/v2/pages` + read `body-format=storage`, space create, label | OK | Space `ACCORD` created by the app; page `1212417` "Accord spike page" created and read back (52 storage chars); charter pages `1212438` (MOB) and `1114116` (PAY) carry label `accord-charter` |

## Scopes added for M2

- Jira: `read:project:jira` (Agile board list), `read:issue-details:jira`, `read:jql:jira`, `write:board-scope:jira-software`,
  `manage:jira-project` (project properties), `manage:jira-configuration` (**required by `POST /rest/api/3/project`**;
  without it the call returns `401 scope does not match`).
- Confluence: `read:space:confluence`, `write:space:confluence`, `read:label:confluence`, `write:label:confluence`
  (label via v1 `POST /wiki/rest/api/content/{id}/label`).
- Every scope change triggers a major version (`--approve MAJOR_VERSION_RULE`) and `forge install --upgrade` for Jira and Confluence.

## Demo seed result (step by step through `seed-step`)

| Step | Result |
| --- | --- |
| project:MOB / project:PAY | Created as app (company-managed Scrum template), Scrum boards 4 and 5, project property `accord.demo` set |
| sprints:MOB | Sprint 1 "Mobile Sprint 27" active (4 issues), sprint 3 "Mobile Sprint 28" (3 issues) |
| sprints:PAY | Sprint 2 "Payments Sprint 41" active (6 issues), sprint 4 "Payments Sprint 42" (5 issues); re-run added nothing (idempotent) |
| charter:MOB / charter:PAY | Pages created in space ACCORD, both "Charter valid" |
| history | 6 simulated sprints per team → MOB 6–6.5, PAY 9–10 issues per sprint, labelled "Simulated history" |

Table counts afterwards: `teams 2, charters 2, throughput_samples 12, demo_seed_steps 7`.

## Forge SQL is per installation (Confluence byline)

- Symptom: the "Accord charter" byline on "Mobile team charter" showed "Unknown SQL execution error"; `forge logs`
  had nothing because the resolver returned the error without logging it.
- Docs (Forge SQL storage reference): "Forge SQL provisions a single database instance per installation" and
  "data stored in Jira is not accessible from Confluence or vice versa". The app has two development installations
  (Jira `9780399c…`, Confluence `282fa3b6…`).
- Proof: `accord-dev-diag?action=status` via a Confluence web trigger URL
  (`forge webtrigger create -p Confluence`) returned `teams 0, charters 0, demo_seed_steps 0`, while the Jira URL
  returns MOB/PAY with valid charters. The byline therefore never found the team and depended on a separate,
  freshly migrated database.
- Decision: the byline no longer uses Forge SQL. It reads the page and validates it with the charter parser
  (`charterBylineState`); the team name comes from the page title "<Team> team charter". The Jira side stays the
  single owner of team data and re-syncs charters from Confluence itself. Resolver errors are now `console.error`-ed.
- Verified on 5.4.0: `accord-dev-diag?action=byline&page=1212438` (Confluence install) → Mobile, valid, no missing
  fields; page 1114116 → Payments, valid.

## M3 negotiation on the site (5.5.0)

- `accord-dev-diag?action=create-request&issue=MOB-1&provider=PAY&size=M&min=1&neededBy=2026-11-20&cost=fixed-date`
  created `req-e16d1d4a-…` at 19:15:52Z; `forge logs`: round1 done (3 offers) in 3304 ms, round2 done
  (3 options, recommended 1) in 634 ms. Broker round recorded at 19:15:59Z → deal sheet ready ~7 s after creation
  (target < 60 s). Options: partial 2026-11-14 (meets need, recommended), later 2026-11-28, reject.
- Approval needs the two leads in the browser: identity always comes from `context.accountId`, the diag trigger has
  no way to approve. Approve → apply-contract on the site is still pending browser verification.
- One person may approve as lead of both teams only when `ACCORD_DEMO_ALLOW_SAME_APPROVER=true` (development only,
  since 5.6.0); otherwise dual control refuses the second approval.

## M3 review fixes (5.6.0)

- **Blocks direction (verified):** `accord-dev-diag?action=verify-blocks-link&blocker=PAY-1&blocked=MOB-1` with the
  production `linkBlocks` (`POST /rest/api/3/issueLink` body `inwardIssue: blocker, outwardIssue: blocked`) read back
  `PAY-1 blocks MOB-1` from PAY-1 (entry with `outwardIssue`) and `MOB-1 is blocked by PAY-1` from MOB-1; the test
  link (id 10020) was deleted again. So in the POST body the `inwardIssue` is the "blocks" side, and
  `hasBlocksLink` only counts a Blocks entry on the blocker whose `outwardIssue` is the blocked issue (`isBlocksFrom`).
- **Deliverable idempotency (choice):** primary key is `contracts.deliverable_issue_key` in SQL. Before `createIssue`
  an intent row (`contract:deliverable-intent`) goes to `audit_log`; the unique label `accord-<requestId>` plus JQL is
  only the fallback for "created in Jira, key not stored". If an intent is younger than 20 s and JQL finds nothing,
  the job retries (backoff 10/20/40/80 s) instead of creating again, covering Jira's search index lag. Chosen over a
  pure SQL lock because Jira create is not transactional with SQL; the residual risk is an index lag > 20 s after a
  crash between create and storing the key.
- MOB-1 → PAY request `req-35a12a72-…` on 5.6.0: round1 done (3 offers) in 3341 ms, round2 done in 601 ms,
  `awaiting-approval` ~7 s after creation (`forge logs`).

## M4 monitor, actions and sprint shift on the site (5.10.0)

- **Demo bugs:** `accord-dev-diag?action=demo-bugs` created PAY-15 and PAY-16 (Bug, Highest, labels
  `accord-demo`, `accord-demo-critical`) in active sprint 2; a second call returned `created: []`,
  `existing: [PAY-15, PAY-16]` (idempotent). PAY active sprint now has 9 open committed issues.
- **Monitor (inline, `action=monitor`):** team-PAY pessimistic 9, 14 committed issues. Contract 1 (PAY-12) stays
  on-track, projected 2026-11-28 = agreed max (work ahead 17). Contract 2 (PAY-13) on-track → **at-risk**,
  projected 2026-12-12 > agreed 2026-11-28 (work ahead 20); comments posted on MOB-4 and PAY-13 (audit
  `status-changed`, `notify:1:MOB-4`, `notify:1:PAY-13`, no `comment-failed`). A second run: no change, no comments.
- **Monitor via queue (`action=monitor&queue=1`):** `accord-monitor` → `monitor-consumer` logged
  `accord-monitor team-PAY: contract 1 on-track->on-track, contract 2 at-risk->at-risk`.
- **Shift option:** MOB-1 → PAY, size S, needed by 2026-11-20 (`req-3a6aa2b2-…`) reached `awaiting-approval` with
  the recommended option `on-time-with-shift` (2026-11-14, moves PAY-4 to sprint 4) plus `later`.
- **Sprint move (verified):** `action=verify-sprint-move&issue=PAY-4&sprint=4` uses the production
  `moveIssuesToSprint` (`POST /rest/agile/1.0/sprint/{id}/issue`): read back in sprint 4, then moved back to sprint 2.
  The Agile sprint-issue listing is **eventually consistent** (a read straight after the move still showed sprint 2;
  ~10–15 s later it showed sprint 4), so the diag polls the read-back.
- **Approving the shift option is UI-only (NFR-2, no agent/diag approve).** Steps: open MOB-1 → Accord panel → "Open
  deal sheet" → choose "On time with shift" → Approve as the Mobile lead; then as the Payments lead (or the same
  account with `ACCORD_DEMO_ALLOW_SAME_APPROVER=true`) approve the same option. Expect PAY-4 in "Payments Sprint
  42", a new deliverable that blocks MOB-1, and a `contract:shift` audit row.
- **Rovo actions (`action=actions&account=lead`):** all six handlers returned stored data (PAY charter valid,
  capacity 9–10 simulated with sprints 41/42, contracts 1–2 incl. at-risk, request + deal sheet, options with an
  `earlier-min` 3-day variation, and `create-dependency-request` created `req-786eb3b2-…` from MOB-3). Invalid
  `teamKey` and `costClass` were rejected. The diag acts as the app with the lead's identity; the asUser path is
  only exercised from Rovo chat.

## Scope usage (M4 review round 1)

Grep of `src/` (2026-11-05); no scope was removed, so no `forge install --upgrade` was needed.

| Scope | Used by | Needed in production |
| --- | --- | --- |
| `manage:jira-project` | `src/demo/seed.ts` project properties (`/rest/api/3/project/{key}/properties/…`) | No (seed only) |
| `manage:jira-configuration` | `src/demo/seed.ts` project creation (`POST /rest/api/3/project`) | No (seed only) |
| `write:board-scope:jira-software` | `moveIssuesToBacklog` (`POST /rest/agile/1.0/backlog/issue`, `src/jira/sprints.ts`) in apply-contract shifts and the demo-bug reset | Yes (assumption: the Agile docs list this scope for the backlog move) |
| `write:space:confluence` | `ensureCharterSpace` (space creation for "Create charter page", `src/teams/service.ts`) and the seed | Yes while "Create charter page" may create the space; seed otherwise |

## Seed scope separation (plan, not implemented)

The demo seed needs `manage:jira-project` and `manage:jira-configuration` (project creation and properties), which a
production app should not request; `write:space:confluence` can also go once charter spaces must exist beforehand.
Plan:
1. Move `src/demo/seed*.ts`, the `accord-demo-seed` queue/consumer, the Demo tab resolvers and these scopes into a
   separate demo manifest (`manifest.demo.yml`), selected at build time (copy over `manifest.yml` in CI for the demo
   environment only).
2. Production manifest keeps read scopes plus `write:jira-work`, `write:sprint:jira-software`, `write:page:confluence`.
3. The Demo tab renders only when the `getSeedStatus` resolver exists (feature flag via env `ACCORD_DEMO=true`).
4. Re-run `forge lint` for both manifests; `forge install --upgrade` is needed when scopes shrink.

## Deferred to M4 (review round 1) — resolved in M4

- Rovo actions now use stored requests and live Jira data (`src/actions/services.ts`; no `src/demo` imports).
- Seed scope separation: plan above.

## Second site one-atlas-vyyd (M4)

- Fresh install: five parallel resolvers failed in `MigrationRunner.run` (concurrent DDL). Fixed by the memoized,
  retrying `ensureSchema` guard (`src/sql/db.ts`) plus the lifecycle trigger `accord-lifecycle`. Diag status after
  deploy 5.16.0: 16 migrations applied, none pending.
- Foreign projects MOB and PAY exist on that site; the seed created ACMOB (board 214) and ACPAY (board 215), space
  ACCORD (free there), both charters valid. bayutrisnapati keeps MOB/PAY/ACCORD (recognised as Accord's).
- The 01:03Z `Failed to execute migration` errors (v008–v010) came before the 5.16.0 deploy (01:16Z); none since.
- Rovo agents are registered once per installation. The Jira and Confluence installs each have their own copy, so
  each agent shows twice in the picker. Temporary `installContext` logging in 5.17.0 showed this: chat in a Jira issue
  ran actions in the Jira install `d65f40bf` and returned ACPAY realistic = 10. Rovo Home ran both copies in the
  Confluence install `81a97658`, whose SQL is empty, and returned `Team ACPAY is not registered`.
- Fix (applied after user confirmation): `app.compatibility` is set with `jira: required: true` and
  `confluence: required: false`. Steps: uninstall Confluence installs `81a97658` and `282fa3b6`, deploy 5.19.0,
  then `forge install --product confluence` on both sites. `forge install list` now shows one installation per site,
  shared by Jira (required) and Confluence: `d65f40bf` and `9780399c`. In Rovo Home each agent appears once.
  Delegate reports ACPAY at 9–10 per sprint; Broker answers honestly that there are no contracts. Bylines show
  "Charter valid" on both sites. Just removing Confluence would not have been enough: charter page creation calls
  `requestConfluence`.
- 5.20.0: the panel's "Needed by" defaults to today (UTC) + 21 days (`src/frontend/dates.ts`). Before, the
  DatePicker showed 2/18/1993.
- Not reproduced: both agents (including Accord Broker) appear on the site, and the issue panel opens on
  ACMOB-1 through "View app actions" → Accord, the same way as on bayutrisnapati.

## rovo:mcp module (M6, FR-18, 5.28.0)

- Syntax from the Forge `rovo:mcp` reference (Preview): `key`, `name` (max 30 characters) and `tools` (action
  keys); at most one module per app. Module `accord-mcp` lists `list-teams`, `get-request`, `list-contracts` and
  `create-dependency-request`; no approve tool (NFR-2).
- `forge lint` found no issues and `forge deploy -e development` accepted it as 5.28.0, a minor version. No new
  scopes, so `forge install list` showed both installations (`d65f40bf`, `9780399c`) Up-to-date without
  `forge install --upgrade`. No EAP flag was needed.
- Not checked yet: calling the tools from a Rovo Studio custom agent and from an external client (an admin has to
  enable the tools under Connected apps first).

## Open items

- Browser check of the deal sheet, two approvals and apply-contract (deliverable issue, link, comments) on the site.

- Visual check of the byline popup in the browser is still pending.

- Queue `400` resolved (see spike 3): M3 negotiation rounds can use the `accord-negotiation` queue.
- `accord-dev-diag` and the `dev-diag` function must be removed before any production deploy (they also make the
  version ineligible for Runs on Atlassian).
- The spike page "Accord spike page" in space ACCORD can be deleted manually.
