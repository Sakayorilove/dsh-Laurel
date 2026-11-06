# Public source rules

This repository is intended for public distribution. Keep code, public documentation, licensed assets and synthetic test fixtures here.

- Read the applicable untracked `AGENTS.local.md` for machine-specific source and private-material paths. Never commit that overlay.
- Store conversation transcripts, private handoffs, original screenshots/logs, personal reference material, account configuration and rollback details outside this repository. Public docs may contain general decisions, relative paths and synthetic examples.
- Do not copy private inputs into tests or use them as demonstration assets. Review licensing before adding any asset.
- Preserve concurrent changes. Each session writes its own private handoff and evidence files.
- Run `pnpm run privacy:setup` after a new clone. Before release, run `pnpm run privacy:release`; incomplete scans and unreviewed medium/high findings block release. Do not silence failures with broad allowlists or skip hooks.
- Native hooks and CI are additional checks, not access controls. CI runs after upload; local pre-push checks must pass before uploading.
- Current public tree excludes private research modules. Existing published history is a separate review boundary; do not rewrite it or claim old public copies have been withdrawn.
