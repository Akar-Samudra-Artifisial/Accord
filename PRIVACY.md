# Accord privacy policy

Last updated: November 5, 2026

Accord is a Forge app for Jira and Confluence Cloud, published by Akar Samudra Artifisial. This policy explains what
data Accord processes and where it is kept.

## What Accord stores

- Atlassian account IDs of the people who create requests, approve or reject options, and are named as approvers or
  escalation contacts in a team charter.
- Display names of those people, used to label audit events and escalation notices.
- Work data needed to run Accord: team names, Jira project and issue keys, issue titles, sprint capacity figures,
  deal sheets, contracts, monitor results and the audit trail.

Accord does not collect email addresses, passwords, API tokens or any data from outside your Atlassian site.

## Where the data lives

All Accord data is stored in the app's Forge SQL database, which Atlassian hosts for each installation. Accord has no
servers of its own and declares no egress permissions, so it cannot send data to any service outside Atlassian.

Language models are used only through Atlassian Rovo. Rovo agents call Accord actions that return data the invoking
user is allowed to see; Accord itself sends nothing to any other AI provider.

## How the data is used

Data is used only to provide Accord's features inside your site: planning options, negotiation, approvals, contract
monitoring, notifications in Jira and the audit trail. We do not sell, share or analyse the data for any other
purpose, and we have no access to it outside the Atlassian platform.

## Access

Accord shows each person only the requests, contracts and issues they can already browse in Jira. Write actions check
the Jira permissions of the signed-in user.

## Retention and deletion

Data stays in your installation's Forge SQL database while Accord is installed. An admin can remove demo data at any
time with "Clean demo data" in the Demo tab. When Accord is uninstalled, Atlassian deletes the app's stored data
according to the Forge data retention rules. Comments and issues that Accord created in Jira remain in Jira like any
other content and can be deleted there.

## Personal data requests

To ask a question or request deletion of data, open an issue at
https://github.com/Akar-Samudra-Artifisial/Accord/issues.

## Changes

Changes to this policy are published in this file in the public repository.
