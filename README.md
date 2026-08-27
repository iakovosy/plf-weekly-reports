# PLF Reports Portal

Static site for the Philippou Law Firm Reports Portal, deployed on Vercel at
https://plf-weekly-reports.vercel.app

## Pages

| File | Page |
|---|---|
| `index.html` | Corporate Department Weekly Report (staff form) |
| `sales.html` | Sales Department Weekly Report (staff form) |
| `general.html` | Weekly Workload Check-in (firm-wide staff form) |
| `admin.html` | Reports Portal console (passcode-protected) |

## How deploys work

This repo is connected to the Vercel project `plf-weekly-reports`.
Every push to `main` deploys the whole site atomically. To change the site,
commit here — never deploy files to Vercel by hand, because a manual deploy
replaces ALL pages and anything missing from the payload is deleted.

To roll back: Vercel → Deployments → promote a previous deployment, or
`git revert` the bad commit and push.

## Backend

Forms and the console talk to Supabase (project `mmtzrsfnucwgjcixbzqa`):
Postgres RPCs + edge functions (weekly report emails, HubSpot reports).
The edge-function sources are managed in Supabase, not in this repo.
