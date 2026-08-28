# Pre-refactor edge function sources

Exact copies of the edge functions as they were deployed before the
`_shared/` refactor, captured on 2026-08-28.

Why this exists: Supabase's API only returns a function's *current* source,
and these functions were never in version control. Without this folder there
would be no way back if a migrated version misbehaves.

To roll one back, redeploy the file here under the matching function name
with `verify_jwt: false` and entrypoint `index.ts`.

Delete this folder once every function has been migrated and has run
successfully on its real schedule at least once.
