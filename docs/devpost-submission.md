# Accord — Devpost submission text (Codegeist 2026)

Paste each section into the matching Devpost field.

## Project name

Accord

## Tagline (≤200 characters)

Accord turns cross-team dependency requests in Jira into negotiated, monitored contracts, using real sprint capacity and team charters from Confluence.

## Elevator pitch

Cross-team dependencies are usually settled in meetings and chat, then forgotten until a sprint slips. Accord moves that negotiation into Jira. Each team writes a charter in Confluence (priorities, red lines, shiftable work, maximum share for other teams). A deterministic planner computes delivery options from real sprint throughput and commitments. Rovo agents explain and argue over those numbers but never invent them. Both team leads approve a deal sheet, and only then does Accord change Jira: a deliverable in the provider's sprint, a "blocks" link and a comment. A daily monitor watches the contract and reopens negotiation when it is at risk.

## Category and bonus prize

- **Category:** Apps for Software Teams
- **Bonus prize:** Best Agents - Rovo/Assignable agents. Accord ships two `rovo:agent` modules (Accord Team Delegate, Accord Broker) and seven reusable Rovo actions (`action` modules) that other agents can call as tools.
- **Also relevant:** Best app with Atlassian MCP. Accord ships one `rovo:mcp` module (`accord-mcp`) with four tools: `list-teams`, `get-request`, `list-contracts`, `create-dependency-request`. There is deliberately no approve tool.
- Not targeted: Best apps with Teamwork Graph integration (see "What's next"), Best Marketplace published app (Accord is not listed on the Marketplace).

## Inspiration

Every team lead knows the pattern: "Can you build the refund API before our release?" is asked in a hallway, half-agreed in Slack, and nobody checks whether the provider team actually has room. The provider's own priorities, red lines and capacity never enter the conversation, so the dependency slips and both sides blame each other.

We wanted to give that conversation what Codegeist asks for: context. Real sprint capacity from Jira, written team rules from Confluence, and a neutral broker that shows consequences for both teams. Then a binding, visible contract that is monitored instead of forgotten.

## What it does

- **Team charters in Confluence.** Each team writes a charter page (priorities, red lines, shiftable work, maximum external share, response time, approvers). A Confluence byline item checks whether a page is a valid Accord charter.
- **Request from a Jira issue.** From the Accord issue panel (or a Rovo agent) a team asks another team for work, with size (S/M/L), needed-by date and cost of delay. Accord can also suggest a request when someone links two issues of different Accord teams with "is blocked by".
- **Deterministic planner.** Capacity comes from the last 6 sprints (realistic = median, pessimistic = second lowest). Options: on time, on time with shifting (cheapest shiftable work first, red lines never touched), partial, later, reject. At most four options, the first is recommended. Every number comes from the data; the LLM never invents one.
- **Two-round negotiation** through an async queue, producing a deal sheet with a recommendation and alternatives.
- **Dual approval, then contract.** Both team leads approve the same option in the Accord UI. Only then does Accord create the deliverable issue in the provider's sprint, link it with "Blocks", move shifted work and comment. No agent, action or MCP tool can approve.
- **Daily monitor and automatic renegotiation.** A scheduled trigger projects every contract at pessimistic throughput. When a contract turns At risk, Accord opens a renegotiation and a deal sheet appears in the Inbox.
- **Rovo agents.** Accord Team Delegate represents one team using only its charter and planner numbers. Accord Broker presents the deal sheet neutrally. Both are bound to the planner's output.
- **MCP tools** for Rovo Studio custom agents and external MCP clients, running as the invoking user.
- **Audit trail and network map.** Every decision, Jira change, monitor result and demo mode change is logged; a network map shows who depends on whom.
- **Per-viewer masking.** Users without browse permission on a team's project see the team as "restricted" with aggregate capacity only.
- **Demo tooling.** "Seed demo data" creates two demo teams (Mobile and Payments) with boards, sprints, issues, charters and throughput history. "Clean demo data" removes them and restores shifted issues so the demo can be repeated. An admin-only, audited demo mode lets one person approve for both demo teams.

## How we built it

- **Platform:** Atlassian Forge, UI Kit (React/TypeScript), Node 24 runtime.
- **Modules:** `jira:issuePanel`, `jira:globalPage`, `confluence:contentBylineItem`, two queue `consumer`s (negotiation, monitor), `trigger`s (lifecycle, issue link created), a daily `scheduledTrigger`, Forge SQL (MySQL), two `rovo:agent`, seven Rovo `action` modules, one `rovo:mcp` with four tools.
- **Data:** all state (teams, charters, requests, deal sheets, contracts, audit trail, dependency edges) lives in Forge SQL on Atlassian's platform. No egress permissions and no external services.
- **Planner:** a pure TypeScript module with no `@forge` imports, unit-tested in isolation. The Rovo agents get only planner numbers via actions, and their prompts forbid estimating or rounding.
- **Identity and permissions:** identity always comes from the Forge invocation context. UI and agent actions run as the user (`asUser`), so Jira permissions apply. Background work (monitor, queue consumers) runs as the app (`asApp`).
- **Quality:** 335 unit and integration tests pass (Vitest).
- **Distribution:** production version 2.8.0, shared through an installation link ("Sharing with anyone").

## Challenges we ran into

- **Planner and monitor disagreed.** On fresh seed data a brand-new contract was immediately At risk with only one option, because the planner and the monitor used different queue models. We made the planner use the monitor's projection, so a new contract starts On track, and locked it with tests.
- **UI Kit Modal in the issue panel.** The first click on a Modal inside the issue panel did not behave reliably. We replaced it with an inline deal sheet.
- **404 from `mypermissions`.** For users without browse permission Jira returns 404, which we first treated as an error. It now means "restricted": the team is shown with aggregate numbers only, and project keys are masked per viewer.
- **Agents guessed contract direction.** Rovo agents inferred who delivers to whom from wording. Actions now return deterministic `direction` and `directionDisplay` fields and the prompts require copying them verbatim.
- **Repeatable demo.** Seeding is easy; cleaning is not. "Clean demo data" must also restore issues that Accord shifted between sprints, otherwise the demo cannot be run twice.

## Accomplishments that we're proud of

- A negotiation where **no number is generated by a language model**: agents explain, the planner decides.
- Real dual control. Nothing changes in Jira until both leads approve, and no agent or MCP tool can approve.
- A full loop that keeps going after approval: contract, daily monitor, At-risk detection, renegotiation.
- Zero egress, with all data in Forge SQL inside Atlassian's platform.
- A non-trivial, tested system (335 tests) that is installed in production and runs end to end on a free developer site.
- Rovo-specific features are optional: everything except the agents and MCP works on a site without Rovo.

## What we learned

- Forge UI Kit, queues and scheduled triggers are enough for a real asynchronous workflow if state lives in Forge SQL and handlers are idempotent.
- With agents, the safest design is to take decisions and arithmetic away from the model and give it only verbatim, display-ready fields.
- Permission edge cases (404 for "no browse", `asUser` vs `asApp`) decide whether an app is safe in a real organisation.
- Demo data deserves as much design as features: seeding, cleaning and a bounded demo mode make an app testable by judges.

## What's next

- **Teamwork Graph (FR-13) is not done yet.** Today dependency edges are stored only in a Forge SQL fallback table (`dependency_edges`). Accord does not write to or read from the Teamwork Graph yet. Next step: publish contracts and dependencies to the Teamwork Graph and read cross-product context (goals, people, decisions) from it for the planner and the network map. We are not claiming the Teamwork Graph bonus.
- Marketplace listing and a security review.
- More planner inputs (release dates, multi-team chains) and richer charters.
- Notifications for approvers in Jira and Confluence.

## Built with (tags)

Atlassian Forge, Forge UI Kit, Forge SQL, Forge Queues (Events API), Forge Scheduled Triggers, Jira, Jira Software (Agile REST), Confluence, Rovo Agents, Rovo Actions, Rovo MCP (`rovo:mcp`), TypeScript, React, Node.js 24, MySQL, Vitest

## Links

- **Demo video (4:15, English, subtitles):** https://www.youtube.com/watch?v=lsFtYI2pAAQ
- **Public repository:** https://github.com/Akar-Samudra-Artifisial/Accord
- **Install link (Jira + Confluence, shared via "Sharing with anyone", not Marketplace):** https://developer.atlassian.com/console/install/b3ad0126-cc44-4b56-94d0-dc7e24ba391e?signature=AYABeEzpn10ES%2BvwhSBA%2F0lumlcAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucB16xqcgBTJ17T2WzStjig1wAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDIKuKRhRHteE%2FM0yGQIBEIA7sGAs%2FjU2V9pLehLfFmp75JkkS8QjzzKbMEocHevSIXoLf5y9OFs15%2FWb7QOkpGpTms4wRCKD%2BzktEWcAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgHOl2%2BujS7bCC2zsF0pO%2BmSAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMObBebcRNq2X6dmJ1AgEQgDvcHXd12PAE0kcwi0uSA9v7%2FwpA9gGodjCRt0NixJRE7Rum%2BYYNbbP0fJJcuwcTFjrHltzigbbmC22TiwAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAXJgo%2FG0vdBIyuefQR%2FPtpoAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAyfoVPZhZ7YNNaDrf8CARCAO31pwjwQFkc40y03jpUjUC5Zrv2e3fxER%2BKddXUtDtQpLkdIa4QdwHOxu3drCE5KFpLWtX0xaeCxM7p%2FAgAAAAAMAAAQAAAAAAAAAAAAAAAAAEnPVDGf9zgCKn19Mf2ffsn%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADKPPDke6dH04WYzAka4pG9ghgogTNv1J7bkeOdSGFf6jIqhyWWqfh1ZNSGMge4B3yoQlELulCZCNIc0yMJoYJoEpmE%3D&product=jira&product=confluence
- **Version:** 2.8.0 (production)

## Technology requirement explanation

Accord is built on Atlassian Forge (UI Kit, Forge SQL, Queues, Scheduled Triggers, Rovo agents/actions/MCP) and integrates with Jira (issue panel, global page, Jira Software sprints, issue links), Confluence (charter pages, byline) and Rovo. It runs on Atlassian (Runs on Atlassian eligible), with no egress permissions.

## Try it (judges)

Full steps, scopes and troubleshooting are in the README ("Install (judges)"). Short version:

1. Open the install link, pick your Jira site and also tick **Confluence** for the same site, then approve the permissions. You need to be a site admin.
2. Jira → Apps → Accord → Demo tab → **Seed demo data**; wait until all steps are Done.
3. Demo tab → **Make me the demo lead**, then turn on the **demo mode** switch (lets one person approve for both demo teams).
4. Open a Mobile issue → View app actions → Accord → **New request with Accord** → ask Payments (for example "Refund API") → Send request.
5. **Open deal sheet** → approve as Mobile lead and as Payments lead. The contract appears in the Contracts tab as On track.
6. Demo tab → **Add critical bugs to Payments**: the contract turns At risk and a renegotiation opens in the Inbox.
7. Rovo (only on a site with Rovo): chat with "Accord Team Delegate" or "Accord Broker", for example "What do we owe other teams this sprint?". MCP tools: Rovo Studio → Create agent → Tools → Add tools → Connected apps → Accord.
8. Turn demo mode off or use **Clean demo data** to start over.

Without Rovo (a free developer site) everything except the agents and MCP still works.

## Notes for the form

- Rovo agents and MCP need a site with Rovo; the rest works without it.
- Teamwork Graph integration (FR-13) is a Forge SQL fallback only (see "What's next").
