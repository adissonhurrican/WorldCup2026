# In-Tournament Loop Cron Runbook

Project ID: `ahcfrgxczbgdvrqmbisw`

## Supervised Activation

The staged cron entry is `ops/cron/wc2026-in-tournament-loop-supervised.cron`.

It runs every 10 minutes and calls:

```bash
node scripts/worldcup/live/run-supervised-loop-cron.mjs
```

The wrapper no-ops until `2026-06-11T19:00:00Z`, then runs:

```bash
npx.cmd tsx scripts/worldcup/live/in-tournament-loop-runner.ts --mode supervised
```

The cron entry is supervised and deliberately does not pass `--go`. In supervised mode the loop can ingest, gate, regenerate, and sanity-check, but publication remains held for a human-reviewed `--go`.

## Manual Publish During Supervised Rollout

After reviewing a clean supervised run, publish with:

```powershell
npx.cmd tsx scripts/worldcup/live/in-tournament-loop-runner.ts --mode supervised --go
```

## Flip To Unattended

After roughly 3-4 clean finished-match cycles, and after re-checking the connected handoffs in `docs/in-tournament-loop-live-chain-verification-2026-06-04.md`, change the cron wrapper invocation to:

```bash
node scripts/worldcup/live/run-supervised-loop-cron.mjs --mode unattended
```

Keep the activation guard and lock behavior in place. Do not add `--go` to cron; unattended mode should own its publish decision after the sanity gate.
