#!/usr/bin/env bash
set -euo pipefail

GEO_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GEO_TERRAFORM_DIR="$GEO_REPO_ROOT/terraform"

if ! GEO_TF_PROJECT_ID="$(terraform -chdir="$GEO_TERRAFORM_DIR" output -raw project_id 2>/dev/null)"; then
  echo "Terraform state is not initialized or applied. Run:" >&2
  echo "  cp terraform/terraform.tfvars.example terraform/terraform.tfvars" >&2
  echo "  terraform -chdir=terraform init" >&2
  echo "  terraform -chdir=terraform apply" >&2
  exit 1
fi

GEO_PROJECT_ID="${GEO_PROJECT_ID:-$GEO_TF_PROJECT_ID}"
GEO_REGION="${GEO_REGION:-$(terraform -chdir="$GEO_TERRAFORM_DIR" output -raw region)}"
GEO_SERVICE="${GEO_SERVICE:-geo-home-mcp}"
GEO_REPOSITORY="$(terraform -chdir="$GEO_TERRAFORM_DIR" output -raw artifact_repository_id)"
GEO_BUILD_SA="$(terraform -chdir="$GEO_TERRAFORM_DIR" output -raw cloud_build_service_account_email)"

if ! gcloud run services describe "$GEO_SERVICE" \
  --project="$GEO_PROJECT_ID" \
  --region="$GEO_REGION" \
  --format='value(status.url)' >/dev/null 2>&1; then
  echo "Cloud Run service '$GEO_SERVICE' does not exist. Provision it first:" >&2
  echo "  terraform -chdir=$GEO_REPO_ROOT/terraform/environments/prod apply" >&2
  exit 1
fi

gcloud builds submit "$GEO_REPO_ROOT" \
  --project="$GEO_PROJECT_ID" \
  --region="$GEO_REGION" \
  --config="$GEO_REPO_ROOT/cloudbuild.yaml" \
  --service-account="projects/$GEO_PROJECT_ID/serviceAccounts/$GEO_BUILD_SA" \
  --substitutions="_REGION=$GEO_REGION,_REPO=$GEO_REPOSITORY,_SERVICE=$GEO_SERVICE" \
  "$@"

GEO_SERVICE_URL="$(gcloud run services describe "$GEO_SERVICE" \
  --project="$GEO_PROJECT_ID" \
  --region="$GEO_REGION" \
  --format='value(status.url)')"

if GEO_NODE_BIN="$(command -v node 2>/dev/null)"; then
  "$GEO_NODE_BIN" "$GEO_REPO_ROOT/scripts/configure-plugin-url.mjs" "${GEO_SERVICE_URL}/mcp"
else
  echo "Warning: node is not on PATH; configure Plugin manifests manually:" >&2
  echo "  node scripts/configure-plugin-url.mjs ${GEO_SERVICE_URL}/mcp" >&2
fi

echo "Deployed: ${GEO_SERVICE_URL}"
echo "Health:   ${GEO_SERVICE_URL}/health"
echo "Map:      ${GEO_SERVICE_URL}/map"
echo "MCP:      ${GEO_SERVICE_URL}/mcp"
echo "Commit the updated mcp.json files before installing the Agent Plugin from GitHub."
