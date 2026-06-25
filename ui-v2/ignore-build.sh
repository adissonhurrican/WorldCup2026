#!/usr/bin/env bash
# Netlify build-ignore — runs at the start of every deploy from the Netlify base dir (ui-v2).
# Netlify semantics: EXIT 0 => SKIP (cancel) the build; NON-ZERO => proceed with the build.
#
# Goal: a push that changed ONLY auto-generated DATA files (app-data / squads / weather JSON) must NOT
# rebuild — that data is served fresh from GitHub raw (see ui-v2/src/lib/appData.js + config.js), so a
# rebuild would be wasted (this is the ~95% build-usage cut that fixes the account-credit freeze). Any
# CODE/content change (ui-v2 src, vite/config, functions, other public assets, this script, netlify.toml…)
# STILL builds so UI updates deploy normally.
#
# Logic: build (exit non-zero) iff at least one NON-data file changed since the last successful deploy
# ($CACHED_COMMIT_REF). `git diff --quiet ... <pathspecs>` exits 0 when there is NO change in the
# non-excluded paths (=> only data changed => skip) and 1 when a non-excluded path changed (=> build).
#
# 1-BUILD/DAY FLOOR: because data-only commits skip, the Netlify-BUNDLED app-data (the fallback used when a
# user's GitHub-raw fetch is throttled) would otherwise freeze at the last CODE deploy and grow arbitrarily
# stale. To bound that, we ALSO build once when the last successful deploy is >24h old — refreshing the
# bundled floor so a throttled shared-IP user never sees data older than ~1 day. Still ~95% fewer builds.

cd .. || exit 1   # base dir (ui-v2) -> repo root; if cd fails, fail safe = build

# No baseline (first deploy / cleared cache / shallow-clone miss) -> build (never skip blindly).
if [ -z "$CACHED_COMMIT_REF" ]; then
  exit 1
fi

# 1-build/day floor: if the last deployed commit (a proxy for the last build time) is >24h old, BUILD to
# refresh the bundled fallback — even for a data-only commit. %ct = commit unix time (UTC); date +%s = now.
last=$(git show -s --format=%ct "$CACHED_COMMIT_REF" 2>/dev/null || echo 0)
now=$(date +%s)
if [ "$last" -gt 0 ] && [ "$((now - last))" -gt 86400 ]; then
  exit 1   # >24h since last deploy -> refresh the floor
fi

# Compare last-deployed commit -> commit being built. Exclude the auto-committed data files.
git diff --quiet "$CACHED_COMMIT_REF" "${COMMIT_REF:-HEAD}" -- . \
  ':(exclude)data/exports/app-data.json' \
  ':(exclude)ui-v2/public/app-data.json' \
  ':(exclude)data/exports/squads.json' \
  ':(exclude)ui-v2/public/squads.json' \
  ':(exclude)data/exports/weather.json' \
  ':(exclude)ui-v2/public/weather.json'
status=$?

# git diff failed to evaluate (e.g. a ref missing in a shallow clone) -> build (fail safe, never skip).
if [ "$status" -gt 1 ]; then
  exit 1
fi
# status 0 = only data changed => SKIP build (exit 0); status 1 = code changed => BUILD (exit 1).
exit "$status"
