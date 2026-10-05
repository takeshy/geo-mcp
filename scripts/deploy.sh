#!/usr/bin/env bash
# Builds an immutable MCP image and deploys it to the shared VM.
set -euo pipefail
GEO_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$GEO_REPO_ROOT"
GEO_PROJECT_ID="$(terraform -chdir=terraform output -raw project_id)"
GEO_BUILD_SA="$(terraform -chdir=terraform output -raw cloud_build_service_account_email)"
npm run typecheck
npm test
python3 -m unittest discover -s test -p update_job_test.py
# Production MCP now runs on the shared VM. Map updates remain manual.
gcloud builds submit --project="$GEO_PROJECT_ID" --config=cloudbuild-vm.yaml --service-account="projects/$GEO_PROJECT_ID/serviceAccounts/$GEO_BUILD_SA" .
