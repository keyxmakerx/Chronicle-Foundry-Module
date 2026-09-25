Fixes #<issue>
<!-- One plain line per issue, exactly "Fixes #123" (no bold, no colon), so GitHub closes it on merge. No issue: "Fixes: none". -->
**Security implication:** <one line; can be "none — pure refactor / CSS / docs">
**Consumer-verified:** <file:line citation of Chronicle-side wire surface this PR consumes; "n/a" otherwise>
**Foundry compatibility:** <verified against Foundry v12 / v13 / v14 — list which; "n/a" if not Foundry-runtime-touching>
**Mockup:** <path/to/mockups/file.html if UI-touching; "n/a" otherwise>

## What this changes

<2-3 sentence summary. Active voice. Focus on the WHY not the WHAT.>

## Why

<Link the issue. Cite a decision or a tenet if one decided the approach.>

## Test plan

- [ ] `node --test tools/test-*.mjs` passes locally
- [ ] `node tools/check-package-descriptor.mjs` passes (if descriptor changed)
- [ ] Manual verification in Foundry: launch a world; load the module; exercise the change
- [ ] If UI-touching: verified in Foundry's Electron runtime; mockup behavior matches; reduced-motion respected
- [ ] CI passes

## Tenet self-check

- [ ] T-B1 security: signed-URL handling, auth-token consumption, API trust boundary reviewed (or n/a)
- [ ] T-B2 plugin isolation: this module IS the foundry-vtt plugin half; changes stay within it
- [ ] T-B3 production UI: any UI change has transition + loading + error states; reduced-motion respected
- [ ] T-B4 dual-audience docs: any `.ai.md` or `docs/*` change serves both humans and AI sessions

## Stop-and-flag

If during review you find a tenet violation the author missed, flag explicitly citing the tenet by number.
