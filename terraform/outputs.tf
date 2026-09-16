output "project_id" {
  description = "Dedicated Geo Home GCP project ID."
  value       = var.project_id
}

output "region" {
  description = "Deployment region."
  value       = var.region
}

output "cloud_run_url" {
  description = "Geo Home Cloud Run URL."
  value       = try(google_cloud_run_v2_service.app[0].uri, null)
}

output "mcp_url" {
  description = "Streamable HTTP MCP endpoint."
  value       = var.domain != "" ? "https://${var.domain}/mcp" : "${google_cloud_run_v2_service.app[0].uri}/mcp"
}

output "snapshot_bucket" {
  description = "Private immutable OSM snapshot bucket."
  value       = google_storage_bucket.snapshots.name
}

output "artifact_repository_id" {
  description = "Artifact Registry repository ID."
  value       = google_artifact_registry_repository.app.repository_id
}

output "cloud_build_service_account_email" {
  description = "Dedicated service account used by gcloud builds submit."
  value       = google_service_account.cloud_build.email
}

output "mcp_api_key" {
  description = "Bearer token MCP clients must send. Read with: terraform output -raw mcp_api_key"
  value       = var.mcp_api_key
  sensitive   = true
}

output "snapshot_release" { value = local.active_release }
