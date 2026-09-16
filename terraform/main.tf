locals {
  required_apis = toset([
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "iam.googleapis.com",
    "run.googleapis.com",
    "storage.googleapis.com",
    "compute.googleapis.com",
    "iap.googleapis.com",
    "oslogin.googleapis.com",
  ])
  cloud_build_roles = toset([
    "roles/artifactregistry.writer",
    "roles/cloudbuild.builds.builder",
    "roles/logging.logWriter",
    "roles/run.admin",
    "roles/storage.objectAdmin",
  ])
}

resource "google_project_service" "required" {
  for_each = local.required_apis

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "app" {
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_repository_id
  format        = "DOCKER"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "geo-home-run"
  display_name = "Geo Home Runtime"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "cloud_build" {
  project      = var.project_id
  account_id   = "geo-home-build"
  display_name = "Geo Home Cloud Build"

  depends_on = [google_project_service.required]
}

resource "google_project_iam_member" "cloud_build" {
  for_each = local.cloud_build_roles

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

resource "google_service_account_iam_member" "cloud_build_uses_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.cloud_build.email}"
}

resource "google_cloud_run_v2_service" "app" {
  count               = 1
  project             = var.project_id
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.runtime.email
    timeout                          = "300s"
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = 4
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    containers {
      image = "${local.serverless_registry}/geo-home-mcp:${var.serverless_image_tag}"
      ports { container_port = 8080 }
      resources {
        limits            = { memory = "1Gi", cpu = "1" }
        cpu_idle          = true
        startup_cpu_boost = false
      }
      dynamic "env" {
        for_each = {
          GCP_PROJECT_ID             = var.project_id
          LOCAL_COVERAGE_FILE        = "/app/config/coverage.json"
          PLACES_SNAPSHOT_URI        = "gs://${google_storage_bucket.snapshots.name}/${local.active_release}/places.sqlite"
          LOCAL_OSRM_CAR_URL         = google_cloud_run_v2_service.router["car"].uri
          LOCAL_OSRM_FOOT_URL        = google_cloud_run_v2_service.router["foot"].uri
          LOCAL_OSRM_BIKE_URL        = google_cloud_run_v2_service.router["bike"].uri
          LOCAL_OSRM_AUTH            = "true"
          EXTERNAL_FALLBACK_ENABLED  = "true"
          EXTERNAL_FALLBACK_ON_EMPTY = "false"
          EXTERNAL_FALLBACK_ON_ERROR = "false"
        }
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name  = "MCP_API_KEY"
        value = var.mcp_api_key
      }
      startup_probe {
        http_get { path = "/healthz" }
        period_seconds    = 5
        timeout_seconds   = 5
        failure_threshold = 48
      }
    }
  }

  lifecycle {
    ignore_changes = [
      client,
      client_version,
      scaling,
    ]
  }

  depends_on = [
    google_artifact_registry_repository.app,
    google_storage_bucket_iam_member.snapshots_reader,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = 1
  project  = var.project_id
  name     = google_cloud_run_v2_service.app[0].name
  location = google_cloud_run_v2_service.app[0].location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Preserve existing Cloud Run resource identities during the migration.
moved {
  from = google_cloud_run_v2_service.app
  to   = google_cloud_run_v2_service.app[0]
}
moved {
  from = google_cloud_run_v2_service_iam_member.public
  to   = google_cloud_run_v2_service_iam_member.public[0]
}
