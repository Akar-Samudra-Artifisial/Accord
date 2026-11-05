# Accord — Demo Video Script and Shot List (Codegeist 2026)

Status: **draft for approval, do not record yet.**
Language: English. Target length: **4:38** (hard limit from the rules: under 5:00; judges are not required to watch past 3:00, so the core demo is finished by 3:15).
Recording site: `https://one-atlas-vyyd.atlassian.net` (dev 5.45.0, same code as production 2.3.0). Projects ACMOB (Mobile) and ACPAY (Payments), Confluence space ACCORD.
Category: Apps for Software Teams. Bonus: Best Agents - Rovo/Assignable agents, Best app with Atlassian MCP.

Rules reminder (from `docs/codegeist2026-info.md` §5, official page): public YouTube upload, under 5 minutes, shows the app running, no copyrighted music or brands without permission. No music track is used here: voice-over only.

## 1. Timing structure

| Seg | Name | Time | Length | VO words |
| --- | --- | --- | --- | --- |
| A | Hook and problem | 0:00–0:28 | 0:28 | 64 (137 wpm) |
| B | Solution: charter and capacity | 0:28–0:58 | 0:30 | 66 (132 wpm) |
| C | Core demo: request, negotiation, deal sheet | 0:58–1:50 | 0:52 | 95 (110 wpm) |
| D | Approval and contract in Jira | 1:50–2:25 | 0:35 | 57 (98 wpm) |
| E | Monitor and automatic renegotiation | 2:25–3:15 | 0:50 | 93 (112 wpm) |
| F | Rovo agents and MCP | 3:15–4:00 | 0:45 | 87 (116 wpm) |
| G | Trust, security, audit | 4:00–4:23 | 0:23 | 53 (138 wpm) |
| H | Close and call to action | 4:23–4:38 | 0:15 | 34 (136 wpm) |
| | **Total** | **4:38** | | **549** |

Buffer: 22 seconds under the 5:00 limit. About 20 seconds of real waiting (negotiation ~10–15 s, renegotiation ~9–15 s, Rovo replies) is cut with jump cuts, so the voice-over pace is a little above the on-screen action and averages 118 words per minute.

## 2. Shot list and voice-over

Conventions: "Click" means a real click on the labelled element. Overlay = burned-in text added in editing. All URLs are on `https://one-atlas-vyyd.atlassian.net`.

| # | Time | Screen / URL | Actions | Voice-over (verbatim) | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | 0:00–0:12 | ACMOB Scrum board: `/jira/software/projects/ACMOB/boards` (open from Projects → ACMOB → Board) | Slow pan over the active sprint. Cursor rests on ACMOB-1 "Holiday theme for the home screen" (the issue used in shot 5). | VO1: Most delays do not happen inside one team. They happen between teams. Mobile needs a refund API from Payments, and the request becomes a ticket, a chat thread, and a promise nobody tracks. | Overlay: "Accord — Apps for Software Teams". Light zoom-in, no cursor movement after 4 s. |
| 2 | 0:12–0:28 | Same board, then Jira global page Apps → Accord (Teams tab) in a quick cross-fade | None, or a single click on Apps → Accord at 0:25. | VO2: Nobody checks whether Payments has the capacity, what would slip, or what the delay costs. Today's tools show dependencies. Accord settles them. It turns a request into a negotiated, monitored contract. | Overlay at 0:20: "Negotiate. Approve. Monitor." Only ACMOB/ACPAY visible. The Teams tab is a table (one row per team), not cards. |
| 3 | 0:28–0:42 | Confluence: space ACCORD, charter page of Payments (open from the "Open charter" link in the Teams tab or Confluence → Spaces → ACCORD) | Scroll slowly from the title to the headings: priorities, red lines, shiftable work, maximum share for other teams. Click the byline "Accord charter (Development)" so that it shows "Charter valid", and stop there. | VO3: Each team writes a charter in Confluence. Priorities, red lines, work that can shift, and the maximum share of capacity other teams may ask for. The byline confirms the charter is valid. | The byline reads "Accord charter (Development)" until clicked; "Charter valid" shows only after the click. Zoom 125% on it for 3 s. Overlay: "Charter = the team's rules". |
| 4 | 0:42–0:58 | Jira → Apps → Accord → **Teams** tab | Point at the Mobile row (capacity 6–6.5) and the Payments row (capacity 9–10), then at the "Simulated history" badge. | VO4: The Teams tab reads capacity from sprint data. Each team shows a range, not a promise. The history is labelled simulated, because this is a demo site, and everything that follows runs for real. | Overlay: "Capacity from sprint data". Keep the badge readable (zoom 125%). The Teams tab is a table, not cards. |
| 5 | 0:58–1:12 | Open the chosen ACMOB issue (`/browse/ACMOB-1`, "Holiday theme for the home screen", blocked by ACPAY-3) | Click "View app actions" → click "Accord" (panel title "Accord DEV"). About 2 s later the panel shows the card "Suggested request: this issue is blocked by ACPAY-3 (Payments)." (hold about 5 s). Click "Create request"; the form opens with Payments preselected under "Team to ask". Type "Refund API" in "What do you need?". Set "Needed by". Set size. | VO5: Accord already sees that this Mobile issue is blocked by a Payments issue, and suggests a request. I create it, asking for a refund API with a size and the date we need it by. | Zoom 125% on the card for 5 s, then on the form. Prepare the date in the checklist so typing is quick. The card appears about 2 s after the panel opens, and only if the link was created after Accord was installed (see checklist). The "DEV"/"(development)" labels stay visible on purpose (see risks). |
| 6 | 1:12–1:30 | Same issue panel | Click "Send request". Panel shows Negotiating. **Jump cut** (cut ~10–15 s) to the moment the panel shows "Awaiting approval" (real time up to about 20 s). Briefly show the new Jira comment on the Mobile issue (Activity, about 2 s): "…is ready with 2 options. Recommended delivery: …". | VO6: Two negotiation rounds run in the background, one agent for each team. That takes about fifteen seconds, so I skip ahead. Nothing is contracted yet. Only a comment on the Mobile issue announces the options. | Overlay during the cut: "Real time ≈ 20 s (cut)". Do not cut inside a click. The comment is posted when the deal sheet is ready; no deliverable or Blocks link exists yet. |
| 7 | 1:30–1:50 | Same issue panel | The deal sheet is already open inline in the panel after "Awaiting approval"; if it is collapsed, click "Open deal sheet" ("Hide deal sheet" is the open state). Slowly scroll over the options (up to four; expected "On time with a shift", "Later date", "Decline"). Stop on the recommended option and click "Show details" to reveal "Why these numbers". | VO7: The deal sheet offers up to four options, each with Why these numbers. Every figure comes from a deterministic planner. The agents only quote it. | Zoom 125% on "Why these numbers" (behind "Show details"). Hold 3 s on the recommended option. |
| 8 | 1:50–2:08 | Same deal sheet | Click "Approve as Mobile lead", then "Approve as Payments lead" on the recommended option. The contract turns On track about 12 s later (cut). Point at the badge "Demo: same approver allowed". | VO8: Both leads must approve the same option. Today one person plays both roles, so demo mode is on, and the badge says so. In production, two different leads approve, and agents can never approve. | Overlay: "Demo mode: one person approves both sides. Production: two leads." Keep the badge in frame 4 s. |
| 9 | 2:08–2:25 | ACPAY deliverable (`/browse/ACPAY-<new>`, the number changes on every take, opened from the link on the source issue), back to the ACMOB issue, then Accord → **Contracts** tab | Show the new ACPAY deliverable (created only after both approvals) and the "Blocks" link on the ACMOB issue. Open Contracts tab, point at status On track and the projected date. | VO9: Only after both approvals does Accord create the deliverable in Payments, link it with Blocks, and record a contract with a projected date. | Cut the ~12 s wait after the second approval. Three quick cuts, about 5 s each. Overlay: "Deliverable + Blocks link + contract". |
| 10 | 2:25–2:38 | Accord → **Demo** tab | Click "Add critical bugs to Payments". The tab shows "Added 8 critical bugs…". | VO10: Now the real world gets in the way. A daily monitor compares each contract with the provider's actual workload. I add critical bugs to Payments, and the monitor runs. | Overlay: "Demo control: simulates a bad week". Zoom 125% on the button. |
| 11 | 2:38–2:55 | Accord → **Contracts** tab, then **Inbox** tab | **Jump cut** (real time: At risk after about 14 s, renegotiation entry after about 17 s) until the contract shows At risk. Click Inbox, show the renegotiation entry. | VO11: Within seconds the contract turns At risk, and Accord opens a renegotiation by itself. The team that asked hears about it early, not after the deadline has passed. | Overlay during the cut: "Real time ≈ 15 s (cut)". Do not cut inside a click. |
| 12 | 2:55–3:15 | Inbox → renegotiation deal sheet (opens as a modal here) | **Jump cut** over the wait until the renegotiation is "Awaiting approval" (about 25 s after the bugs). Show the two options "On time with a shift" and "Later date". Click approve for both sides on the recommended option, **jump cut** about 10 s, then go to Contracts tab: old contract Superseded, new contract On track. | VO12: The new deal sheet offers on time with a shift, or a later date. I approve it. The old contract is marked superseded, the new one is on track, and every step stays on the record. | Hold 3 s on the Superseded and On track statuses side by side. Overlay during the cuts: "Real time ≈ 25 s and ≈ 10 s (cut)". |
| 13 | 3:15–3:35 | Rovo chat ("Ask Rovo" in the top bar) → "Change agent" → "Accord Team Delegate" | Ask: "How much capacity does Payments have next sprint?" Wait for the answer (cut if slow). Then ask: "Approve the deal for me." Show the refusal. Real time: capacity answer about 16 s, refusal about 4 s. | VO13: In Rovo, the Accord Team Delegate quotes the same planner. It can create a request, but only after I confirm. And when I ask it to approve, it refuses. Approval belongs to people. | Jump cut over the wait. Overlay: "Agents explain and propose. People decide." The chat must be empty before the take. |
| 14 | 3:35–3:50 | Rovo chat → "Change agent" → "Accord Broker" | Ask: "What do we owe other teams this sprint?" Show the answer with real Jira links. Hover one link. The answer takes about 15 s. | VO14: The Accord Broker answers a question every lead asks. What do we owe other teams this sprint? The answer lists real contracts, with links to the real issues. | Jump cut over the wait. Use a new chat for the Broker. **Before the take, verify that the issue keys in the answer are clickable links** (the prompt is being fixed to write keys as links). The provider filter was verified in the dry-run and is now stated explicitly in the prompt. |
| 15 | 3:50–4:00 | Rovo Studio: Create agent → "Start from blank" → Tools → Add tools → Connected apps → Accord | Show the Accord app and its four tools as named on screen: "Create dependency request (development)", "Get dependency request (development)", "List contracts (development)", "List teams (development)". Do not publish the agent. | VO15: Accord also exposes four tools over MCP, so any agent can list teams, read requests and contracts, or create a request. There is no approve tool. | Zoom 125% on the tool list. "Start from blank" creates a draft "Untitled Agent" automatically: **delete that draft after the take.** |
| 16 | 4:00–4:11 | Accord → **Audit** tab | Scroll the newest events: request, approvals, Jira changes, monitor result, demo mode. The "By" column shows "You" or "Accord app". | VO16: Every decision, Jira change and monitor result lands in the audit trail. A rejected request is escalated to the escalation contact. | Overlay: "Audit trail". Zoom 125%. The tab shows no raw account ids. |
| 17 | 4:11–4:23 | Accord → **Network** tab | Show the dependency map for 4 s (verified in the dry-run). Then cut to a plain slide: "Forge · Forge SQL · no egress · UI and agent actions run as the signed-in user; background checks run as the app". | VO17: The Network tab maps who depends on whom. Data stays in Forge SQL, with no calls outside Atlassian. UI and agent actions run with your permissions; background checks run as the app. | Plain slide in the last 5 s. Do not show the manifest or any code. |
| 18 | 4:23–4:38 | Title card (dark, no music) | Show the logo/name, the installation link (short form or QR) and the repo URL. Hold 5 s on the final frame. | VO18: Accord. Dependencies between teams, negotiated with data, approved by people, and monitored every day. Built on Forge, with Rovo and MCP. Install it from the link in the description. The source is on GitHub. | Overlay: install link and `github.com/Akar-Samudra-Artifisial/Accord`. Check that the link in the description is the same as in the README. |

## 3. Voice-over, complete

Pace: short sentences. Overall about 118 words per minute, with 130–150 in the dense segments; this leaves room for the jump cuts and for pauses on the screen. Word counts are computed from the VO lines above.

**Segment A** (64 words)

1. (33 words) Most delays do not happen inside one team. They happen between teams. Mobile needs a refund API from Payments, and the request becomes a ticket, a chat thread, and a promise nobody tracks.

2. (31 words) Nobody checks whether Payments has the capacity, what would slip, or what the delay costs. Today's tools show dependencies. Accord settles them. It turns a request into a negotiated, monitored contract.

**Segment B** (66 words)

3. (32 words) Each team writes a charter in Confluence. Priorities, red lines, work that can shift, and the maximum share of capacity other teams may ask for. The byline confirms the charter is valid.

4. (34 words) The Teams tab reads capacity from sprint data. Each team shows a range, not a promise. The history is labelled simulated, because this is a demo site, and everything that follows runs for real.

**Segment C** (95 words)

5. (35 words) Accord already sees that this Mobile issue is blocked by a Payments issue, and suggests a request. I create it, asking for a refund API with a size and the date we need it by.

6. (35 words) Two negotiation rounds run in the background, one agent for each team. That takes about fifteen seconds, so I skip ahead. Nothing is contracted yet. Only a comment on the Mobile issue announces the options.

7. (25 words) The deal sheet offers up to four options, each with Why these numbers. Every figure comes from a deterministic planner. The agents only quote it.

**Segment D** (57 words)

8. (34 words) Both leads must approve the same option. Today one person plays both roles, so demo mode is on, and the badge says so. In production, two different leads approve, and agents can never approve.

9. (23 words) Only after both approvals does Accord create the deliverable in Payments, link it with Blocks, and record a contract with a projected date.

**Segment E** (93 words)

10. (29 words) Now the real world gets in the way. A daily monitor compares each contract with the provider's actual workload. I add critical bugs to Payments, and the monitor runs.

11. (28 words) Within seconds the contract turns At risk, and Accord opens a renegotiation by itself. The team that asked hears about it early, not after the deadline has passed.

12. (36 words) The new deal sheet offers on time with a shift, or a later date. I approve it. The old contract is marked superseded, the new one is on track, and every step stays on the record.

**Segment F** (87 words)

13. (33 words) In Rovo, the Accord Team Delegate quotes the same planner. It can create a request, but only after I confirm. And when I ask it to approve, it refuses. Approval belongs to people.

14. (28 words) The Accord Broker answers a question every lead asks. What do we owe other teams this sprint? The answer lists real contracts, with links to the real issues.

15. (26 words) Accord also exposes four tools over MCP, so any agent can list teams, read requests and contracts, or create a request. There is no approve tool.

**Segment G** (53 words)

16. (21 words) Every decision, Jira change and monitor result lands in the audit trail. A rejected request is escalated to the escalation contact.

17. (32 words) The Network tab maps who depends on whom. Data stays in Forge SQL, with no calls outside Atlassian. UI and agent actions run with your permissions; background checks run as the app.

**Segment H** (34 words)

18. (34 words) Accord. Dependencies between teams, negotiated with data, approved by people, and monitored every day. Built on Forge, with Rovo and MCP. Install it from the link in the description. The source is on GitHub.


## 4. Pre-recording checklist

- [ ] Browser: Chrome/Edge, a clean profile or guest window; no bookmarks bar, no personal extensions, no personal tabs. Window 1920x1080 (check with a resolution overlay), browser zoom 125% for forms, 100% for lists; reset zoom before each segment.
- [ ] OS: Do Not Disturb on, Slack/Mail/Messages quit, no notification previews, screen recorder set to 1920x1080 at 30 fps, system sound off, microphone tested in a quiet room (voice-over may be recorded after the screen capture).
- [ ] Tabs open, in this order and nothing else: (1) ACMOB board, (2) ACMOB-1, (3) Confluence ACCORD charter page of Payments, (4) Accord global page, (5) Rovo chat (empty), (6) Rovo Studio. **No tab from MOB/PAY (owned by another party), no other project, no admin pages with other sites.**
- [ ] Demo data: Accord → Demo tab → "Clean demo data" → "Seed demo data" → wait until every step shows Done → "Make me the demo lead" (Bayu is lead and approver of both teams).
- [ ] Demo mode ON (switch "Allow the same approver for both teams"); the badge "Demo: same approver allowed" must be visible on the deal sheet.
- [ ] Suggested request card: "Clean demo data" removes the card, so **delete and recreate the link ACMOB-1 "is blocked by" ACPAY-3** before the take (Jira: Link issue → "is blocked by"). Accord only suggests from links created after it was installed, only between two Accord teams, never from links it created itself. Open the panel and confirm the card "Suggested request: this issue is blocked by ACPAY-3 (Payments)." (it appears about 2 s after the panel opens) with "Create request" enabled (it is disabled when Payments has no valid charter). Do not click Dismiss. Redo this after every "Clean demo data".
- [ ] The issue for the request is `ACMOB-1` "Holiday theme for the home screen" (blocked by ACPAY-3). Prepare the values: team to ask Payments, "Refund API", needed-by date, size.
- [ ] Do a dry run of segments C–E on the same data, then run "Clean demo data", seed again and recreate the is-blocked-by link so the real take starts fresh (the contract list and audit trail must not contain dry-run entries).
- [ ] Rovo chat: delete old conversations, open a new chat per agent. Confirm in advance that both agents appear in the selector and that Rovo is enabled for the site.
- [ ] Confirm that the charter byline shows "Charter valid" for both teams after a click (before the click it reads "Accord charter (Development)"), and that the Teams table shows capacity for both (Mobile 6–6.5, Payments 9–10).
- [ ] ACPAY sprint positions must match the seed: Sprint 41 = ACPAY-1..7, Sprint 42 = ACPAY-8..12; the demo bugs ACPAY-14–17 and 22–25 are in the backlog. "Clean demo data" does not move back the issues that an "On time with a shift" option moved, so restore them by hand after every take (and dry-run). Click "Reset demo bugs" before the take as well, otherwise the "On time with a shift" option may be missing.
- [ ] Broker prompt fixed and deployed; in the dry-run the answer lists the issue keys as clickable links.
- [ ] After the take: delete the draft "Untitled Agent" in Rovo Studio.
- [ ] Check the screen for private data: email addresses, account ids, notifications, other site names. Account avatar may show; the Bayu display name is fine.
- [ ] Confirm the installation link and the repo URL (the README link is the source) and the YouTube description text before recording the last card.
- [ ] Export: MP4, 1920x1080, under 5:00, no music, upload as public on YouTube.

## 5. Risks during the take and plan B

| Risk | Plan B |
| --- | --- |
| Deal sheet takes longer than 20 s (shot 6) | Keep waiting, cut the wait. If it still shows Negotiating after 5 minutes, use "Retry negotiation". Do not talk over the wait; the cut covers it. |
| The first deal sheet has only 1 option | Do "Clean demo data", seed again and ask with a shorter "Needed by" date (a short-notice request gives "on time with a shift" plus "later"). The first dry-run showed only "Later date" + "Decline" because ACPAY issues had been moved: restore the seed positions (see checklist) and click "Reset demo bugs". Change VO7 to "one to four options" only if it cannot be avoided. |
| Renegotiation has only "Later date" | Use "Reset demo bugs" (Demo tab), then add the bugs again. If it persists, record the shot with one option and change VO12 to: "The new deal sheet offers a later date. I approve it." |
| Renegotiation does not appear within about 30 s | Refresh the Inbox tab and the Contracts tab. The monitor can also be triggered again by "Add critical bugs". Cut longer, but never fake the result. |
| "Open deal sheet" does not respond on the first click, or the deal sheet is already open | The deal sheet normally opens inline by itself; the button only shows when it is collapsed. Click once more after the panel is quiet; the panel refreshes in the background. Cut the double click. |
| Rovo agent is slow or times out | Cut the wait. Retry in a new chat once. If still failing, record the agent with another prepared question ("What capacity does Payments have?") and mention the problem to the approver; do not use fabricated output. |
| Rovo Studio / Connected apps does not list the Accord tools | Reload the page. If the site hides them, show the tools in the README MCP section instead and change VO15 accordingly (say "the README lists them"). Ask for approval before changing the story. |
| "Dual control: you already approved" error | Demo mode is off or the request involves a non-demo team. Turn demo mode on in the Demo tab, and confirm the request is between ACMOB and ACPAY. |
| Broker answer shows issue keys as plain text, not links | The prompt fix may not be deployed. Re-run in a new chat; if keys stay plain text, change VO14 only after approval (drop "with links to the real issues"). |
| "DEV" / "(development)" labels visible on screen (panel title "Accord DEV", tool names, byline) | Decision: left as it is. Add to the YouTube description: "Recorded on a development installation; the code is the same as in production." Do not change the voice-over for this. |
| Suggested request card does not appear | The link must be created after install and between ACMOB and ACPAY issues. Create it again, refresh the panel. If still missing, record shot 5 with "New request with Accord" and drop the card sentence from VO5. |
| MOB/PAY (other party) appears on screen | Stop, discard the take, and close the tab. Never blur in post as the only protection; re-record. |
| Total over 4:40 in the edit | Cut shot 15 first (MCP, can be a 5 s still), then shot 17, then trim shot 3. The core (shots 5–12) ends by about 3:15. |

## 6. Judging criteria mapping

| Criterion (20% each) | Where it is answered |
| --- | --- |
| Technological Implementation | Shots 6–9 (Forge queues, Forge SQL, Jira and Confluence changes done as the user), 10–12 (daily monitor, automatic renegotiation), 13–15 (two Rovo agents, MCP tools), 17 (no egress, permissions). |
| Design | Shots 5–9 (one flow from issue panel to contract), 12 (deal sheet inline and in Inbox), 16–17 (audit, network map). A complete product, not a proof of concept. |
| Potential Impact | Shots 1–2 (real problem: delays between teams, specific audience: team leads), 8 and 12 (people decide, early warning), 14 (the Broker's answer for leads). |
| Innovation/Idea | Shot 5 (Accord suggests a request from a Jira "is blocked by" link; it never creates one on its own), shots 2 and 7 (existing tools show dependencies; Accord negotiates and monitors them with deterministic numbers), 11–12 (living contract). |
| Presentation | The whole structure: problem in 28 s, end-to-end demo from request to renegotiation, core finished by 3:15, honest demo-mode disclosure in shot 8, clear call to action in shot 18. |

Bonus mapping: Best Agents - Rovo/Assignable agents = shots 13–14; Best app with Atlassian MCP = shot 15. Teamwork Graph is not claimed in this video (the implementation falls back to SQL).

## 7. Claims not to make

- No Teamwork Graph integration (FR-13 is a SQL fallback only).
- No claim that an LLM computes numbers; no claim that agents approve.
- No claim of Marketplace listing (shared by installation link only).
- Do not call the throughput history real: it is labelled "Simulated history"; what happens during the demo (request, negotiation, contract, monitor) is real.
