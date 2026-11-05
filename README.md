# Accord

Accord turns cross-team dependency requests in Jira into negotiated, monitored contracts.
Each team writes a charter in Confluence (priorities, red lines, shiftable work, maximum share for other teams).
A deterministic planner computes delivery options from sprint throughput and commitments; Rovo agents
(Team Delegate and Broker) only explain and argue over those numbers. Both team leads approve a deal sheet
before anything changes in Jira. Built on Atlassian Forge for Codegeist 2026.

See `Accord — Product Requirements Document (Codegeist 2026).md` for the full product spec.

## Structure

```
manifest.yml            Forge modules: issue panel, global page, Confluence byline, two queue consumers
                        (`accord-negotiation`, `accord-monitor`), lifecycle and issue-link triggers, daily
                        scheduled trigger, Forge SQL, two Rovo agents, seven Rovo actions, one rovo:mcp
                        module (four tools)
src/index.ts            Function handler exports
src/planner/            Pure, deterministic planner (no @forge imports): capacity, cost, options, explain
src/sql/migrations.ts   Forge SQL schema (append-only migrations)
src/resolvers/          UI Kit resolvers
src/frontend/           UI Kit entry points: panel.tsx, home.tsx, byline.tsx
src/actions/            Rovo action handlers
src/negotiation/        Negotiation rounds, deal sheet and contracts (`accord-negotiation` queue consumer)
src/monitor/            Daily contract monitor (`accord-monitor` queue consumer)
src/demo/               Demo scenario, seed data and step-by-step demo seed (MOB/PAY)
src/jira/, src/confluence/  Jira Agile/REST and Confluence v2 clients; charter template/parser/validator
src/capacity/           Pure throughput and commitment aggregation
src/teams/              Team/charter/throughput repository (Forge SQL) and team service
test/                   Vitest unit tests
```

## Development

```bash
nvm use 24            # Forge CLI requires Node 24 (see .nvmrc)
npm install
npm test              # planner unit tests
npm run typecheck
forge register        # once: replaces the placeholder app.id in manifest.yml
npm run lint          # forge lint (needs a registered app id)
forge deploy
forge install         # pick a Jira + Confluence developer site
```

`manifest.yml` ships with the placeholder `ari:cloud:ecosystem::app/TODO-run-forge-register`; run
`forge register` before `forge lint`, `forge deploy`, or `forge install`.

## Install (judges)

Accord is not listed on the Atlassian Marketplace; it is shared through an installation link.

1. Open `https://developer.atlassian.com/console/install/b3ad0126-cc44-4b56-94d0-dc7e24ba391e?signature=AYABeEzpn10ES%2BvwhSBA%2F0lumlcAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucB16xqcgBTJ17T2WzStjig1wAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDIKuKRhRHteE%2FM0yGQIBEIA7sGAs%2FjU2V9pLehLfFmp75JkkS8QjzzKbMEocHevSIXoLf5y9OFs15%2FWb7QOkpGpTms4wRCKD%2BzktEWcAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgHOl2%2BujS7bCC2zsF0pO%2BmSAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMObBebcRNq2X6dmJ1AgEQgDvcHXd12PAE0kcwi0uSA9v7%2FwpA9gGodjCRt0NixJRE7Rum%2BYYNbbP0fJJcuwcTFjrHltzigbbmC22TiwAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAXJgo%2FG0vdBIyuefQR%2FPtpoAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAyfoVPZhZ7YNNaDrf8CARCAO31pwjwQFkc40y03jpUjUC5Zrv2e3fxER%2BKddXUtDtQpLkdIa4QdwHOxu3drCE5KFpLWtX0xaeCxM7p%2FAgAAAAAMAAAQAAAAAAAAAAAAAAAAAEnPVDGf9zgCKn19Mf2ffsn%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADKPPDke6dH04WYzAka4pG9ghgogTNv1J7bkeOdSGFf6jIqhyWWqfh1ZNSGMge4B3yoQlELulCZCNIc0yMJoYJoEpmE%3D&product=jira&product=confluence`, click "Get app", pick your Jira site and also tick **Confluence** for the same
   site (it is not ticked by default; the charter pages live in Confluence), then approve the requested permissions.
   You need to be a Jira site admin for the demo steps below.
2. Open the Accord global page: Jira → Apps → Accord.
3. Demo tab → "Seed demo data" → confirm with "Seed demo data". Accord creates two demo teams, Mobile and Payments
   (keys MOB/PAY, or free alternatives such as ACMOB/ACPAY when those keys are taken), with Scrum boards, sprints,
   issues, charter pages in Confluence and simulated throughput history. Wait until every step shows Done; the demo
   controls below appear without a reload.
4. Demo tab → "Make me the demo lead": you become the lead of both demo projects and the only approver of both
   charters.
5. Demo tab → turn on the demo mode switch ("Allow the same approver for both teams"). Without it, Accord enforces
   dual control and a second person must approve for the other team. Demo mode applies only to requests between the
   two demo projects; requests involving any other team always keep dual control.
6. Open a Mobile issue → View app actions → Accord → "New request with Accord". Pick Payments under "Team to ask", fill in the
   required "What do you need?" (for example "Refund API") and "Needed by", optionally size and cost of delay, then
   "Send request". Accord negotiates in two rounds; the deal sheet is usually ready within a few seconds.
7. "Open deal sheet" and click "Approve as Mobile lead" and "Approve as Payments lead" on the recommended option.
   Accord creates the deliverable issue in Payments, links it to the source issue and moves shifted work; the contract
   appears in the Contracts tab as On track.
8. Demo tab → "Add critical bugs to Payments": the monitor runs, the contract turns At risk and Accord opens a
   renegotiation (Inbox tab); approve the new deal sheet the same way, or use "Reset demo bugs" to move the bugs to
   the backlog and bring the contract back On track.
9. Rovo: open Rovo chat and pick "Accord Team Delegate" or "Accord Broker" (for example "What do we owe other
   teams this sprint?"). MCP: Rovo Studio → Create agent → Tools → Add tools → Connected apps → Accord (see below).
   Rovo agents and MCP need a site with Rovo; the rest works without it.
10. Turn demo mode off again when you are done, or use "Clean demo data" to start over (the clean keeps demo mode as
    it is).

## Privacy and security

- All Accord data (teams, charters, requests, deal sheets, contracts, audit trail) is stored in the app's own Forge
  SQL database inside Atlassian's platform. Accord makes no calls to services outside Atlassian (no egress
  permissions).
- Accord has no LLM of its own: language models are used only through Rovo agents, which call Accord actions that
  return planner numbers. Every number comes from the deterministic planner.
- Dual control: both teams must approve the same option in the Accord UI before anything changes in Jira; no agent,
  action or MCP tool can approve. One person may approve for both teams only while an admin has turned on demo mode
  (off by default), and only for requests between Accord's own demo projects.
- Identity always comes from the Forge invocation context; write actions check Jira permissions of the signed-in
  user, and Rovo actions and MCP tools run as the invoking user.
- Every decision, Jira change, monitor result and demo mode change is written to the audit trail (Audit tab, without
  raw account ids).

## Troubleshooting

- "Seed demo data" is disabled: only a Jira site admin (or an admin of every target project) can seed.
- A seed step failed: run "Seed demo data" again; it only adds what is missing.
- "Dual control: you already approved for the other team": demo mode is off, or the request involves a team that is
  not an Accord demo project; an admin can turn demo mode on in the Demo tab.
- The deal sheet stays at "Negotiating": wait a minute and refresh; after 5 minutes the deal sheet offers
  "Retry negotiation".
- "You cannot approve for …": Accord applies the contract on your behalf, so you need the listed Jira permissions on
  that project.
- Contract shows "Not enough data": the provider team has no throughput history yet.
- Accord agents or tools are missing in Rovo: Rovo must be enabled on the site; MCP tools for external clients must
  be enabled by an admin under Connected apps.

## Permissions (scopes)

The scope list is unchanged since the first installation, so updates never need an upgrade by the site admin.

| Scope | Why Accord needs it |
| --- | --- |
| `read:jira-work` | Read issues, projects, comments and issue links (issue panel, commitments, monitor) |
| `write:jira-work` | Create deliverable issues, "blocks" links, comments and due dates when a contract is applied; demo issues and bugs |
| `read:jira-user` | Approver names and project leads; permission checks |
| `read:sprint:jira-software` | Sprint throughput and commitments for the planner and monitor |
| `write:sprint:jira-software` | Move shifted work into its target sprint; demo sprints |
| `read:board-scope:jira-software` | Find each team's Scrum board |
| `write:board-scope:jira-software` | Move shifted work and reset demo bugs to the backlog |
| `read:issue-details:jira`, `read:jql:jira` | JQL searches for commitments, labels and demo data |
| `read:project:jira` | Project metadata and leads |
| `manage:jira-project` | Demo: project properties that mark Accord's demo projects and "Make me the demo lead" |
| `manage:jira-configuration` | Demo: create the demo projects |
| `read:page:confluence`, `write:page:confluence` | Read, validate and create team charter pages |
| `read:space:confluence`, `write:space:confluence` | Find or create the space for charter pages |
| `read:label:confluence`, `write:label:confluence` | The `accord-charter` label on charter pages |
| `storage:app` | Forge app storage; kept so the scope list stays unchanged (Accord data lives in Forge SQL) |

## Before production

- [x] Removed the development diagnostics web trigger (`accord-dev-diag`, `src/diag/`) and the unused
      `accord-demo-seed` queue (1.0.0).
- [x] Replaced the environment variable for a single-account demo with the per-installation demo mode switch
      (Demo tab, admins only, off by default, audited). No Forge variables are needed.
- [x] Scopes unchanged, so existing installations need no upgrade.
- [x] Deployed to production and created the installation link (see "Install (judges)").

## Accord tools over MCP (`rovo:mcp`, Preview)

The `accord-mcp` module exposes four existing actions as tools: `list-teams`, `get-request`, `list-contracts` and
`create-dependency-request`. They use the same handlers as the Rovo agents and run as the invoking user, so a user
only sees what they may see in Jira. There is no approve tool: deal sheets are approved only in the Accord UI.

- Rovo Studio custom agent: Ask Rovo → agent selector → Create agent → skip to manual step → Tools → Add tools →
  Connected apps → Accord → pick the tools → Add → Publish.
- External MCP client (Claude, Cursor, …): a site or org admin first enables the tools in Atlassian Administration →
  Apps → Sites → _your site_ → Connected apps → Accord → Tools (off by default, set per site). Then add
  `https://mcp.atlassian.com/forge/b3ad0126-cc44-4b56-94d0-dc7e24ba391e` as a remote HTTP MCP server, for example
  `claude mcp add --transport http accord https://mcp.atlassian.com/forge/b3ad0126-cc44-4b56-94d0-dc7e24ba391e`.
  Connecting opens an OAuth consent screen where the user picks the site.

## Planner rules (summary)

- Capacity from the last 6 sprints: realistic = median, pessimistic = second lowest; fewer than 4 sprints is flagged as limited data.
- Size S/M/L = 1/3/6 issues. Cost of delay weights: fixed-date 3, standard 2, intangible 1.
- Per sprint, room for other teams = min(pessimistic − committed, floor(max share × pessimistic)).
- No option is earlier than the contract monitor projects it: all open work of the active and next sprint plus the
  provider's other open contracts come first, at pessimistic throughput. So a new contract starts On track. A shift
  may move shiftable work of the active or next sprint out of that window to bring the date forward.
- Options: on time, on time with shifting (cheapest shiftable work first, red lines never touched), partial, later, reject.
- Sorted by meets-need, then shift cost, then latest date; at most 4; the first is recommended.
- Every number in an explanation comes from the option's trace values.

## Milestones

- [x] M0 — Scaffolding, deployed to `development`; spikes in `docs/spikes.md`
- [x] M1 — Deterministic planner with unit tests
- [x] M2 — Jira/Confluence clients, charters (template, parser, validator, byline), capacity and commitments,
      demo seed, Teams and Demo tabs
- [x] M3 — Requests, two-round negotiation, deal sheet, approvals and contracts in Jira
- [x] M4 — Contract monitor, Rovo actions with real data, demo polish
- [x] M5 — User permission checks and English copy
- [x] M6 — Renegotiation, escalation, request suggestions from Jira links, MCP tools, network map, clean demo data
- [x] M7 — Production preparation (1.0.0): diagnostics and unused queue removed, demo mode switch, install guide
- [x] Production deploy and installation link
- [ ] Judge-path fixes from the fresh-site test (new contracts on track, at least two options); in development,
      production deploy pending approval
