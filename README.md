# Accord

Accord turns cross-team dependency requests in Jira into negotiated, monitored contracts.
Each team writes a charter in Confluence (priorities, red lines, shiftable work, maximum share for other teams).
A deterministic planner computes delivery options from sprint throughput and commitments; Rovo agents
(Team Delegate and Broker) only explain and argue over those numbers. Both team leads approve a deal sheet
before anything changes in Jira. Built on Atlassian Forge for Codegeist 2026.

See `Accord — Product Requirements Document (Codegeist 2026).md` for the full product spec.

## Structure

```
manifest.yml            Forge modules: issue panel, global page, Confluence byline, queue consumer,
                        daily scheduled trigger, Forge SQL, two Rovo agents, seven Rovo actions,
                        one rovo:mcp module (four tools)
src/index.ts            Function handler exports
src/planner/            Pure, deterministic planner (no @forge imports): capacity, cost, options, explain
src/sql/migrations.ts   Forge SQL schema (append-only migrations)
src/resolvers/          UI Kit resolvers
src/frontend/           UI Kit entry points: panel.tsx, home.tsx, byline.tsx
src/actions/            Rovo action handlers
src/negotiation/        Queue consumer for negotiation rounds
src/monitor/            Daily contract monitor
src/demo/               Demo scenario, seed data and step-by-step demo seed (MOB/PAY)
src/jira/, src/confluence/  Jira Agile/REST and Confluence v2 clients; charter template/parser/validator
src/capacity/           Pure throughput and commitment aggregation
src/teams/              Team/charter/throughput repository (Forge SQL) and team service
src/diag/               Development-only diagnostics web trigger (remove before production)
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

## Before production

- Remove the `accord-dev-diag` web trigger, its `dev-diag` function from `manifest.yml`, and `src/diag/` (planned
  for M7). The web trigger URL is public; until removal it answers 404 unless `ACCORD_DIAG_ENABLED=true` and the
  request sends the header `x-accord-diag-key` matching the encrypted variable `ACCORD_DIAG_KEY` (compared
  timing-safe).
- Unset the development-only variables: `forge variables unset -e <env> ACCORD_DIAG_ENABLED`,
  `forge variables unset -e <env> ACCORD_DIAG_KEY` and
  `forge variables unset -e <env> ACCORD_DEMO_ALLOW_SAME_APPROVER`. Never set `ACCORD_DEMO_ALLOW_SAME_APPROVER` in
  staging or production: without it, one account cannot approve for both teams (dual control).
- Remove the seed-only scopes `manage:jira-project` and `manage:jira-configuration` (and `write:space:confluence`
  if charter spaces are created beforehand) together with `src/demo/`; see "Scope usage" in `docs/spikes.md`.
  `write:board-scope:jira-software` stays (backlog moves during apply-contract). Run `forge install --upgrade`
  after changing scopes.

Development only: `forge variables set -e development ACCORD_DIAG_ENABLED true`,
`forge variables set --encrypt -e development ACCORD_DIAG_KEY "$(openssl rand -hex 32)"` (at least 32 characters;
the development value is in the password manager, never in the repo) and
`forge variables set -e development ACCORD_DEMO_ALLOW_SAME_APPROVER true` (single-account demo; the deal sheet shows
"Demo mode: same approver allowed").

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
- Options: on time, on time with shifting (cheapest shiftable work first, red lines never touched), partial, later, reject.
- Sorted by meets-need, then shift cost, then latest date; at most 4; the first is recommended.
- Every number in an explanation comes from the option's trace values.

## Milestones

- [x] M0 — Scaffolding, deployed to `development`; spikes in `docs/spikes.md` (queue push from web trigger still fails)
- [x] M1 — Deterministic planner with unit tests
- [x] M2 (data layer) — Jira/Confluence clients, charters (template, parser, validator, byline), capacity and
      commitments, demo seed (MOB/PAY), Teams and Demo tabs
- [ ] M2 (rest) — Requests, negotiation rounds, deal sheet
- [ ] M3 — Approvals, contracts in Jira, daily monitor, Teamwork Graph
- [ ] M4 — Demo data generator, polish, submission
