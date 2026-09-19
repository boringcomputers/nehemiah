#!/usr/bin/env bash
#
# deploy-web.sh - Deploy apps/web (boringcomputers.com) to Cloudflare Workers.
#
# Default: push main. The "Deploy web" GitHub Actions workflow then runs
# `alchemy deploy --stage prod` from apps/web (apps/web/alchemy.run.ts), which
# builds the SvelteKit app, uploads the Worker, and reconciles the edge
# resources (custom domain, origin tunnel, DNS, analytics, R2).
#
#   infra/latitude/deploy-web.sh          # push main; CI deploys
#   infra/latitude/deploy-web.sh --local  # deploy prod from this machine
#
# --local needs a Cloudflare profile (`npx alchemy profile edit --add Cloudflare`
# inside apps/web) and shares state with CI through the Cloudflare state store,
# so mixing the two is safe. See docs/cloudflare.md.
#
set -euo pipefail

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

if [[ "${1:-}" == "--local" ]]; then
  cd "$ROOT/apps/web"
  exec npm run deploy -- --stage prod
fi

git -C "$ROOT" push origin main
echo "Pushed. The 'Deploy web' workflow is deploying boringcomputers.com."
echo "Watch: https://github.com/boringcomputers/nehemiah/actions/workflows/deploy-web.yml"
