#!/usr/bin/env bash
# Builds immutable images, reviews an infrastructure plan, then updates Cloud Run.
set -euo pipefail
GEO_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$GEO_REPO_ROOT"
GEO_PROJECT_ID="$(terraform -chdir=terraform output -raw project_id)"
GEO_BUILD_SA="$(terraform -chdir=terraform output -raw cloud_build_service_account_email)"
npm run typecheck
npm test
python3 -m unittest discover -s test -p update_job_test.py
GEO_BUILD_ID="$(gcloud builds submit --project="$GEO_PROJECT_ID" --config=cloudbuild-serverless.yaml --service-account="projects/$GEO_PROJECT_ID/serviceAccounts/$GEO_BUILD_SA" --format='value(id)' .)"
# GCS current.json supplies the last successfully published dataset release.
terraform -chdir=terraform plan -var="serverless_image_tag=$GEO_BUILD_ID" -var="update_image_tag=$GEO_BUILD_ID" -out=/tmp/geo-home-deploy.tfplan
terraform -chdir=terraform apply /tmp/geo-home-deploy.tfplan
# Persist the image version so later Terraform operations do not roll it back.
python3 - "$GEO_BUILD_ID" <<'PY'
import json, sys
from pathlib import Path
Path('terraform/deployed.auto.tfvars.json').write_text(json.dumps({'serverless_image_tag':sys.argv[1], 'update_image_tag':sys.argv[1]})+'\n')
PY
