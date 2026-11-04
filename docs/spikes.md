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

## Open items

- Visual check of the byline popup in the browser is still pending.

- Queue `400` resolved (see spike 3): M3 negotiation rounds can use the `accord-negotiation` queue.
- `accord-dev-diag` and the `dev-diag` function must be removed before any production deploy (they also make the
  version ineligible for Runs on Atlassian).
- The spike page "Accord spike page" in space ACCORD can be deleted manually.
