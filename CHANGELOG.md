# Changelog

All notable changes are recorded here. The format follows Keep a Changelog; versions follow SemVer.

## [Unreleased]

### Fixed
- A new contract on freshly seeded demo data was At risk right after it was applied (agreed Nov 15, projected Nov 29) and the deal sheet had only one option: the planner now uses the contract monitor's projection for every request, not only renegotiations, so it never offers a date the monitor already projects as missed. On the seed data a short-notice request gets "on time with a shift" plus "later", and "Reset demo bugs" brings the contract back On track.
- Shifting work for an option now moves it out of the active and next sprint when that is what lowers the monitor's projection, instead of into the next sprint where it still counted.
- A renegotiation after "Add critical bugs to Payments" on fresh seed data offered only "Later date": shiftable work in the next sprint (which the monitor counts as work ahead) can now be moved out too, so the deal sheet also offers "On time with a shift". Red-line work, including the demo bugs, is never moved.
- The planner orders the provider's other contracts like the monitor (agreed latest date, then age): only contracts agreed by an option's date count as work ahead, and a date that would push an on-track contract at risk is not offered.
- Issue panel: the first click on "Open deal sheet" right after a request moved to "Awaiting approval" sometimes did nothing. Background refreshes no longer re-render the panel when nothing changed, the button keeps the same click handler across refreshes, and "Your decision is needed." appears beside the button instead of pushing it down. The issue panel now expands the deal sheet inline under the request ("Open deal sheet" / "Hide deal sheet") instead of opening a modal, so it no longer depends on a modal opening right after Jira refreshes the issue; approve and reject work the same. The global page Inbox keeps the modal.
- Audit tab: new events appear while the tab is open (light refresh every 12 seconds for 10 minutes after the last interaction, without flicker).
- Deal sheet: an "on time with a shift" option names where the work goes ("Moves 4 planned items to the backlog: …" or the sprint name) instead of "a later sprint" when no later sprint exists in Jira.
- Demo tab: "Make me the demo lead", "Clean demo data" and the demo mode switch appear as soon as the seed finishes, without a reload.
- Audit tab refreshes when it is opened and after decisions or demo actions, not only on Refresh.
- README: judge install steps name the "Get app" button, the Confluence tick box, the required "What do you need?" field and the exact button names, and note that Rovo agents and MCP need a site with Rovo.

## [1.0.0] - 2026-11-05

### Added
- Demo mode switch in the Demo tab (site admins or admins of every Accord demo project, checked on the server): while it is on, one person may approve a deal sheet for both teams. It is stored per installation, off by default, explained in the tab as evaluation-only, and every change is audited ("Demo mode turned on/off" in the Audit tab); an approval it allows is marked "demo mode: same approver" in the audit. "Clean demo data" keeps the switch as it is. The deal sheet still shows "Demo: same approver allowed" while it is on.
- README: installation steps for judges, privacy and security statement, troubleshooting, and the reason for every scope.

### Changed
- Demo mode relaxes dual control only for requests between two of Accord's own demo projects; requests that involve any other team always need a separate approver per team, also while demo mode is on. The Demo tab says so.
- When the demo mode check fails (for example storage or Jira unavailable), Accord keeps dual control and refuses the second approval with the usual message and audit entry.
- The Rovo/MCP `list-teams` action always requires a signed-in user.
- Pinned `prosemirror-view` 1.42.9 and `prosemirror-model` 1.25.12 through npm `overrides` (transitive dependencies of `@forge/bridge`/`@forge/react`, not part of the runtime bundle) to clear the high-severity `npm audit` finding.
- Forge app scaffolding (UI Kit, runtime `nodejs24.x`, TypeScript): manifest with a Jira issue panel, global page, Confluence byline, negotiation queue consumer, daily monitor, Forge SQL, the Rovo agents "Accord Team Delegate" and "Accord Broker", and six Rovo actions (not deployed yet; `app.id` stays a placeholder until `forge register`).
- Forge SQL schema for teams, charters, throughput, requests, negotiation rounds, options, approvals, contracts, dependency edges and the audit trail.
- Deterministic planner: realistic/pessimistic capacity from the last 6 sprints; options on time, on time with a shift (red lines are never moved), partial, later, and reject based on the charter's maximum share; at most 4 ranked options with one recommendation.
- Option explanations in neutral English where every number comes from the calculation trace, plus consequences for the requesting and providing teams.
- "Minimum part N days earlier" variation for negotiation rounds.
- Mobile/Payments demo scenario with simulated throughput history; the `evaluate-options` action uses this scenario for now.
- Jira data layer (Scrum boards, sprints, sprint issues, JQL search, bulk create) and Confluence data layer (spaces, v2 pages, labels) via `asApp`/`asUser`.
- Team charters: storage-format template generator (one h2 heading per field), parser and validator that returns the missing fields; results are stored in the `charters` table.
- Capacity and commitments: throughput samples from closed Jira sprints (or simulated history), commitments from the active and next sprint plus issues with a due date.
- Step-by-step, idempotent demo data generator: MOB/PAY projects with a Scrum board, an active and next sprint with issues, charter pages labelled `accord-charter`, and 6 simulated throughput sprints per team.
- Global page: Teams tab (charter status, capacity range, "Simulated history"/"Limited data" badges, "Create charter page" button) and Demo tab (seed with confirmation and per-step status); the Confluence byline shows "Charter valid" or the missing fields.
- Development-only diagnostic web trigger (`accord-dev-diag`); M0 spike results in `docs/spikes.md`.
- Dependency requests from the Jira issue panel (title, size, minimum part, needed-by date, cost class) start a two-round negotiation through the `accord-negotiation` queue: in round 1 the provider delegate (planner) and then the requester delegate (asks for the minimum part earlier when no option meets the need); in round 2 the broker ranks the options, marks a recommendation and comments on the source and provider issues. The consumer is idempotent with bounded retries; failures are recorded on the round before the status becomes `failed`.
- Deal sheet (modal) with options, consequences, a transcript where every number comes from the planner trace, and a preview of the Jira changes; both leads (charter approvers or team lead) approve the same option, identity comes from the Forge context, and a rejection needs a reason.
- Apply-contract after both approvals: deliverable issue in the provider project, "blocks" link to the source issue, shifted issues moved to their target sprint or the backlog, comments, contract, dependency edge and audit; idempotent when repeated.
- Global page: Inbox tab (requests waiting for your decision) and Contracts tab; Rovo actions use the same negotiation services.
- Diagnostic actions `create-request` and `request` in `accord-dev-diag` (development only).
- "Retry negotiation" button in the deal sheet for requests that are `failed` or stuck in `negotiating`/`approved` for more than 5 minutes (creator or leads of either team); "Still working — Refresh" message when polling ends.
- "Demo mode: same approver allowed" badge when `ACCORD_DEMO_ALLOW_SAME_APPROVER=true`.
- Diagnostic action `verify-blocks-link`; "Before production" section in the README.
- Daily contract monitor: projected date per active contract from the provider's sprint commitments and earlier contracts, `at-risk`/`on-track` status (once per change, idempotent), neutral comments mentioning the leads on the source and deliverable issues, and audit; runs per team through the `accord-monitor` queue and the "Run daily monitor now" button.
- "At risk" badge and a projected date column in the issue panel and the Contracts tab; cross-team dependency summary (FR-13).
- Audit tab: latest audit entries for the teams you can access, without raw account ids.
- Demo buttons "Add two critical bugs to Payments" and "Reset demo bugs" (idempotent, PAY project admins only).
- Seventh seed issue in the Payments active sprint so the "on time with shift" scenario appears.
- Rovo actions use real data (charters, capacity, requests, options, contracts) with input validation; the create-request action accepts `costClass`; the agent prompts forbid invented numbers, approving and guessing.
- Diagnostic actions `monitor`, `demo-bugs`, `actions`, `verify-sprint-move`, `audit`.
- Contract status `unknown` ("Not enough data") when the provider's capacity has no data or a pessimistic value of 0; no comment is posted.
- The monitor is scheduled for the provider team right after apply-contract, so a new contract gets a projected date immediately.
- `list-contracts` output includes `role` (`provider`/`requester`), `requesterTeamKey` and `providerTeamKey`.
- Rovo action `list-teams` (team key, name, project key) for both agents; the agent prompts require resolving team names through `list-teams`.
- Demo action "Make me the demo lead" (site admins or admins of the demo projects only): the caller becomes lead of Accord's demo projects and the only approver of the demo charters, then the charters are synced; idempotent.
- The demo seed uses the account that starts it from the UI as lead and approver; the diag seed accepts `?lead=<accountId>` or `ACCORD_DEV_OWNER_ACCOUNT_ID`. Diagnostic actions `demo-lead` and `user-search`.
- Rovo action output that mentions an issue, contract, request or charter includes an absolute `url` built from the site `baseUrl` (serverInfo, cached); both agent prompts may only link URLs from action output.
- Bounded polling (3 seconds × 20) in the Inbox/Contracts tabs, the issue panel and the deal sheet while a status is transitional (negotiating, approved, applying, contract not yet evaluated) or after approve/reject and demo actions, with a Refresh button as a fallback.
- Light refresh of the Inbox/Contracts tabs on the global page: every 12 seconds for up to 10 minutes after the last interaction (tab change, decision, demo action), and once more when a tab is selected; lists re-render only when the data changed. New requests from the agent appear right away with a "Negotiating" badge.
- Diagnostic action `actions` accepts `?titleIssue=<key>&title=…` to preview a request title without creating a request.
- Teams tab shows how many charter approvers were ignored for missing Jira permissions and an "Approvers changed" badge with the time of the last change.
- One date format for users: "Nov 29, 2026" (UTC, en-US) in the UI, deal sheet, planner explanations, Jira comments and the Audit tab; date inputs stay ISO.
- Automatic renegotiation (FR-14): when the monitor marks a contract At risk, Accord opens one renegotiation as the app (same teams, same planner and rounds, note with the projected finish), at most one open renegotiation per contract and at-risk change; approvals still need both leads. The applied renegotiation keeps the deliverable issue, moves its due date and marks the old contract "Superseded" (kept, no longer monitored). "Renegotiation" badge in the issue panel, Inbox and Contracts tab; "Superseded by the contract agreed …" link in the Contracts tab; Rovo `list-contracts` shows "Superseded".
- Escalation (FR-15): a rejected or failed request (including a rejected renegotiation) gets one neutral comment on the source issue that mentions each team's charter escalation contact, or the Jira project lead when the charter has none; audited as `escalated`. "Escalated" badge with the contact names in the issue panel, Inbox and Contracts tab.
- Demo charters created by the seed name the project lead as escalation contact.
- Request status `cancelled`: "Reset demo bugs" cancels the renegotiations of the provider that nobody decided yet (audited, nothing deleted).
- Rovo MCP tools (FR-18, `rovo:mcp` Preview): module `accord-mcp` exposes `list-teams`, `get-request`, `list-contracts` and `create-dependency-request` to Rovo Studio custom agents and external MCP clients, using the same handlers and the invoking user's permissions; there is no approve tool. Optional action inputs are described as "Omit if …". Setup steps in the README.
- Network tab (FR-17) on the global page: one card per team with its worst contract status and counts of active contracts, renegotiations and escalations, plus a table of requester → provider contracts with deliverable and source issue links, status, agreed and projected dates. Only contracts the user can see in the Contracts tab are included; superseded contracts are greyed out and do not count. Resolver `getDependencyMap`; diag action `dependency-map` (development only).
- Request suggestions from Jira links (FR-16): trigger `avi:jira:created:issuelink` records a "blocks" link between issues of two different Accord teams as one suggestion per issue pair (table `link_suggestions`, migration v019; repeated links add nothing). Links Accord creates itself and other link types are ignored, and no request is created automatically. The blocked issue's panel shows "Suggested request: this issue is blocked by …" only to users who can browse both issues, with "Create request" (form preset to the providing team; the new request marks the suggestion converted) and "Dismiss" (audited). Diag action `link-suggestion` (development only).
- The renegotiation deal sheet explains the contract it renegotiates, e.g. "Renegotiation of the contract for ACPAY-20: agreed Nov 29, 2026, now projected Dec 13, 2026 after 4 critical bugs", with dates from the replaced contract and the bug count from the monitor projection.
- "Clean demo data" button in the Demo tab (Jira admins / demo project admins only, checked on the server, with confirmation): deletes requests, contracts, renegotiations, escalations, link suggestions and notification markers between the Accord demo teams, moves `accord-demo-bug` bugs to the backlog, labels Accord-created deliverables `accord-archived` and moves them to Done (backlog when Done is not available), and removes only the "blocks" links Accord recorded. Issues are never deleted, foreign projects are never touched, and a repeated clean reports zeros. The audit log is kept with a `demo-cleaned` entry; the Audit tab shows only entries after the last clean. Comments and sprint moves are not restored. Diag action `clean-demo` (development only).

### Removed
- The development diagnostics web trigger `accord-dev-diag` (function `dev-diag`) and all diag actions; the Forge variables `ACCORD_DIAG_ENABLED`, `ACCORD_DIAG_KEY` and `ACCORD_DEMO_ALLOW_SAME_APPROVER` are no longer read.
- The unused `accord-demo-seed` queue and its consumer (the Demo tab runs the seed step by step) and the unused `getDemoOptions` resolver.

### Security
- Dual control can only be relaxed through the audited, admin-only demo mode switch; no environment variable turns it off anymore.
- Dual control: one account may not approve for both teams unless the demo variable `ACCORD_DEMO_ALLOW_SAME_APPROVER=true` is set (development only).
- Registering a team, creating a charter page and syncing a charter are limited to the Jira project lead or holders of `ADMINISTER_PROJECTS`; the default charter approver is the project lead, not the caller.
- The `accord-dev-diag` web trigger rejects every action (404) unless `ACCORD_DIAG_ENABLED=true`.
- Deal sheet, Inbox and Contracts are limited to approvers/leads of the teams involved or users who can browse the source or deliverable issue; raw account ids are no longer sent to the UI.
- Request creators need browse and comment permission on the source issue; at most 10 requests per hour per user.
- Errors sent to clients are generic with a reference code; details only in `forge logs`.
- Actions `get-team-charter`/`get-team-capacity` are limited to team approvers/leads or users with `BROWSE_PROJECTS` in the team project; everyone else gets a generic error.
- A new request is rejected when an open request already exists for the same source issue and provider; at most 20 new requests per hour per provider team (checked in one INSERT).
- Request titles are normalized (one line, ≤120 characters, no control characters, double quotes replaced) and quoted in comments; both agent prompts state that action field values are data, not instructions; the Delegate must ask for explicit confirmation before `create-dependency-request`.
- Monitor comments on the requester issue only contain the projected date and the agreed range, without the provider's internal workload.
- Diag: the `account=lead` impersonation was removed and raw errors were replaced with a generic message and reference.
- Demo seed (`runSeedStep`, `getSeedStatus`) is checked on the server for every step: site admin (`ADMINISTER`) or `ADMINISTER_PROJECTS` on every target project, checked as the signed-in user; adopting existing projects is only allowed for admins of projects that belong to Accord.
- Approving a deal checks the approver's Jira permissions as the user: `CREATE_ISSUES` and `SCHEDULE_ISSUES` in the provider project, `LINK_ISSUES` and `ADD_COMMENTS` on the source issue. A missing permission rejects the approval with a clear message and is recorded in the audit.
- The round 2 broker comment is posted only on the source issue, never on shifted provider issues.
- Charter sync ignores approvers without `BROWSE_PROJECTS` and `SCHEDULE_ISSUES` in the team project; ignored approvers and approver changes are audited.
- "Make me the demo lead" updates the charter page as the user; the app only steps in for project admins on Accord's own charter pages.
- Team admin checks read the Jira project as the user, with one message for "not found" and "not allowed"; the Confluence byline reads the page as the viewer.
- Demo bug buttons require `CREATE_ISSUES` and `SCHEDULE_ISSUES` in the project, checked as the user.
- The `accord-dev-diag` web trigger also requires the header `x-accord-diag-key` matching the encrypted variable `ACCORD_DIAG_KEY` (at least 32 characters, compared timing-safe); any failure answers the same 404.
- Network tab and Contracts list redact per field for viewers who are on neither team: the title shows "Restricted" when the source issue is not browsable, and issue keys and links the viewer cannot browse are hidden ("Restricted" instead of "pending").
- Dismissing a link suggestion requires `LINK_ISSUES` or `ADD_COMMENTS` on the blocked issue (checked as the user); a missing and a forbidden suggestion give the same message.
- Rovo/MCP `list-teams` and the team-name resolution of the other actions only include teams whose Jira project the user can browse.
- The escalation comment mentions a charter escalation contact only when they can browse the source issue's project; otherwise (or when the check fails) it falls back to the project lead and audits `escalation-contact-fallback`.

### Fixed
- Rovo agents in Rovo Home read the wrong database ("Team ACPAY is not registered") and every agent appeared twice: the Jira and Confluence installations were separate, each with its own Forge SQL and agent copy. The manifest now uses `app.compatibility` (Jira required, Confluence optional), so one installation per site is shared by Jira and Confluence.
- The default "Needed by" in the issue panel no longer shows 2/18/1993; it is now today (UTC) + 21 days.
- A request could get stuck in `negotiating` when the broker finished but the status transition was lost; round 2 now resumes the transition.
- Reject vs approve race: approvals are inserted only while the status is `awaiting-approval` (INSERT … SELECT), reject claims the status first, and the UI no longer accepts a false `rejected` status.
- Blocks link direction: the deliverable "blocks" the source issue, checked direction-aware (verified on a site).
- The audit trail is ordered by time (Forge SQL ids are not sequential).
- Duplicate deliverables after a crash: an intent is stored in SQL before create plus a JQL search pause; the contract option is taken from the stored contract.
- Key redaction uses word boundaries (PAY-1 does not match PAY-11) and also redacts `sources`.
- Orphaned requests are marked `failed` when the queue push fails.
- Accord comments at most once per issue and step (SQL marker).
- The Confluence "Accord charter" byline showed "Unknown SQL execution error": the byline now validates the charter page directly from the page body without Forge SQL (the Confluence installation's database is separate from Jira's), and resolver errors are logged to `forge logs`.
- Pushes to Forge queues (`accord-negotiation`, `accord-demo-seed`) always returned `400 Bad Request`: the `consumer` modules now use the `@forge/events` v2+ format (`function`, not `resolver`) and consumers read `event.body` from `AsyncEvent`.
- The issue panel request form lost characters when typing fast: it now uses the uncontrolled UI Kit `Form`/`useForm`; the project key field in the Teams tab is uncontrolled too.
- The approve button stayed active for a team that had already approved; now only teams that have not decided (or when both teams chose different options) can approve.
- The "Accord" title appeared twice on the global page.
- Monitor and Audit no longer use a contract list with `LIMIT 100`: queries per provider/request are unbounded, so the work ahead counts every contract.
- Monitor notifications use an atomic marker (`contract_notifications`, unique per contract + change sequence + issue) and compare with the last notification, so a retry after a crash still sends exactly one comment per change and issue; old markers from the audit are carried over by a migration.
- The Audit Details column shows the option name and date range instead of "approved option 4".
- The diag sprint move returns the issue to the backlog when it came from the backlog.
- Project permission checks in Audit run in parallel and are skipped for teams where the user is an approver.
- The first load of the global page on a new installation failed (`Failed to execute migration` v008–v010) because parallel resolvers ran DDL at the same time: migrations now run on one path per instance (memoized promise), migration conflicts are retried with backoff and jitter (4 attempts, cause logged), and they also run from the `avi:forge:installed:app`/`avi:forge:upgraded:app` triggers; resolvers still call `ensureSchema` as a fallback. A test ensures every migration is idempotent.
- The demo seed no longer collides with MOB/PAY projects owned by someone else: keys already used by non-Accord projects are skipped (`ACMOB`/`ACPAY`, then `ACMOB2` …), and so is the Confluence space `ACCORD` (`ACCORD2` …). Projects are recognized as Accord's through the `accord.demo` property or the `teams` table (names "Mobile"/"Payments"); spaces through the name "Accord team charters" or a registered team's charter page.
- The Audit tab Refresh button reloads and redraws the table, so new events appear without switching tabs.
- A renegotiation whose creation failed no longer blocks the contract: the claim is released (except when only the queue push failed), and a duplicate request id is reported as existing instead of an error.
- The monitor opens at most 2 renegotiations per run and provider (nearest agreed date first; the rest are deferred), and app-created requests no longer count towards the provider's request limit.
- A failed escalation comment no longer marks the request "Escalated": it is audited as `escalation-failed` and retried on the next monitor run.
- Creating a request from a suggestion converts only that suggestion, not every open suggestion of the same issue and provider.
- The escalation comment says "The deal sheet was rejected." when no rejection reason is stored.
- Renegotiation loop (FR-14): a renegotiation offered a single "On time" date that the monitor immediately judged at risk again, so every run opened a new renegotiation. Renegotiations now plan with the monitor's projection (open work of the active and next sprint plus the provider's other contracts, at pessimistic capacity): no option is earlier than that projection, a shift option moves counted work out of those sprints (never other contracts' deliverables), and the explanation names the work ahead.
- An applied renegotiated contract that is at risk on the same data it was agreed on is held (status saved, no comment, audit `renegotiation-held`); a new renegotiation opens only when its projection gets worse than the replaced contract's, or after it was on track again.
- At-risk notifications: one comment per issue says both that the contract is at risk and what happened to its renegotiation (opened, already open, or next run), instead of a separate renegotiation comment.
- The Inbox kept showing old data after a demo action: it now polls after Demo actions and decisions until the list changes, and while an at-risk contract still waits for its renegotiation.
- The Network tab counted every renegotiation ever opened ("7 renegotiations"): cards and rows now show open renegotiations, with the total in a tooltip.
- An open renegotiation stayed open after its contract was back on track: the monitor now cancels undecided renegotiations of that contract (audit `renegotiation-cancelled`, "Contract back on track", also when one lead already approved) and adds one sentence to the on-track comment only when the renegotiation had been announced.
- The Audit tab hid every event after a demo clean and showed an older "Demo data cleaned" entry: Forge SQL audit ids are not chronological, so the latest clean and the "since last clean" cut now use the entry time. The tab lists newest first, starting with the latest clean. Diag actions `audit-trail` and `comments` (development only).
- Accord comments piled up on demo issues across takes: "Clean demo data" now removes comments posted by the Accord app account (checked against `/myself`) on Accord demo issues it ever commented on, at most 120 per run ("N comments removed"; the summary asks to run it again when more are left). Comments by people are never removed. The dialog now says older audit events are hidden from the Audit tab but kept in storage.
- The contract comments on Jira use the deal sheet's words: "Created ACPAY-21 in ACPAY." or "Linked existing ACPAY-21 in ACPAY.".
- "Created ACPAY-18" was shown for an issue that already existed: the deal sheet preview, Jira comment, audit and Rovo output now say "Linked existing …" for reused deliverables and blocks links and "Created …" only for new ones.

### Changed
- `teamKey`/`providerTeamKey` in Rovo actions accept a key or a registered team name (case-insensitive) and resolve it to the Accord key; unknown or ambiguous keys/names are rejected with the list of valid teams (for example `PAY` owned by someone else on one-atlas).
- The "Add critical bugs to Payments" button computes the number of bugs (at most 8, label `accord-demo-bug` plus a charter red line) from the monitor projection of the nearest contract until it is really At risk, adds only the shortfall, then queues the monitor right away; reset moves the demo bugs to the backlog and queues the monitor again.
- Request titles are now optional (action and Delegate): without a title the source issue summary is used; the confirmation card still appears. Placeholder titles (empty, wrapped in brackets, or containing "summary of the source issue") are treated as empty; the `title` input description and the Delegate prompt forbid placeholder titles.
- The Demo tab, the critical bugs buttons and the diag use the project/space keys the seed actually uses (seed plan in `getSeedStatus`; the diag status shows `seedPlan` and pending migrations).
- Additional Jira/Confluence scopes for the Agile API, project creation, spaces and labels.
- Scope usage is documented (`docs/spikes.md`, README "Before production"); seed-only scopes stay until the demo is split out.
- Jira planning data is loaded once per round 1 job; Inbox/Contracts without N+1 queries and with the viewer filter applied before the limit.
- Queue retries: 5 attempts (Forge limit of 4 retries) with 10/20/40/80 second backoff.
- Migrations v012–v014: UNIQUE `dependency_edges.contract_id`, indexes on `requests.source_issue_key` and `contracts.deliverable_issue_key`.
- Project key validation in JQL, and `costClass` in Rovo actions accepts enum values only.
- Deal sheet cleanup: one recommended/agreed option card on top with the other options below, collapsible details ("Why these numbers", charter rules, Jira change preview) and transcript; per-team status ("Mobile lead: approved by you · Payments lead: decision pending"); once the contract is active, "Changes applied" shows links to the deliverable issue, the link, sprint moves and comments.
- Decision messages use the option name and date range instead of the internal option id.
- The issue panel updates its own status badge (bounded polling, refresh after submit/decision/closing the modal) with a Refresh button as a fallback.
- Contracts with no projection show "Not enough data" everywhere (was "Not enough capacity data" in the Contracts tab).
- Rovo action output carries display fields for agents: `dateRangeDisplay`, `neededByDisplay`, `agreedDisplay`, `projectedDisplay`, `startDateDisplay`/`endDateDisplay` ("Nov 29, 2026") and `statusDisplay` ("On track", "At risk", "Not enough data"); raw values are renamed to `*Iso` and `statusCode`. The Delegate and Broker prompts show dates and statuses as given in the `*Display` fields.
- Counts in UI text, Jira comments, planner explanations and transcripts agree with their noun ("1 issue", "1 sprint", "1 option") through a shared `plural` helper.
- A date span whose ends are the same day reads "on Nov 29, 2026" instead of "between Nov 29, 2026 and Nov 29, 2026".
- `create-dependency-request` (Rovo action and MCP tool) has a required boolean input `confirm`: without `confirm=true` it returns a preview (resolved teams, title, dates) and creates nothing; the Delegate prompt previews first and confirms only after the user agrees.
