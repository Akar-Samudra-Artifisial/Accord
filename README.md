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
                        daily scheduled trigger, Forge SQL, two Rovo agents, six Rovo actions
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
