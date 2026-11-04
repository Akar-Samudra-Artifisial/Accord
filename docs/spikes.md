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

## Deferred to M4 (review round 1)

- Rovo actions `get-team-capacity` and `evaluate-options` still answer from the demo scenario
  (`src/actions/index.ts`, demo data instead of stored requests).
- Separate the demo seed scopes (`manifest.yml`, project/space creation) from the production build.

## Open items

- Browser check of the deal sheet, two approvals and apply-contract (deliverable issue, link, comments) on the site.

- Visual check of the byline popup in the browser is still pending.

- Queue `400` resolved (see spike 3): M3 negotiation rounds can use the `accord-negotiation` queue.
- `accord-dev-diag` and the `dev-diag` function must be removed before any production deploy (they also make the
  version ineligible for Runs on Atlassian).
- The spike page "Accord spike page" in space ACCORD can be deleted manually.
