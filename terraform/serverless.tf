# Immutable snapshots shared by scale-to-zero services and the weekly update job.
resource "google_storage_bucket" "snapshots" {
  name                        = "${var.project_id}-snapshots"
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
}
resource "google_storage_bucket_iam_member" "snapshots_reader" {
  bucket = google_storage_bucket.snapshots.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_service_account" "updater" {
  account_id   = "geo-home-updater"
  display_name = "Geo Home snapshot builder"
}
resource "google_storage_bucket_iam_member" "snapshots_writer" {
  bucket = google_storage_bucket.snapshots.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.updater.email}"
}

variable "snapshot_release" {
  type        = string
  description = "Immutable release prefix. Promote only after all graphs and POIs pass checks."
  default     = ""
  validation {
    condition     = var.snapshot_release == "" || can(regex("^releases/[A-Za-z0-9_-]+$", var.snapshot_release))
    error_message = "Use a release prefix without dots or traversal components."
  }
}
variable "serverless_image_tag" {
  type    = string
  default = "0b26d96e-1c6b-439e-8a4e-0a4ddc77fd17"
}
data "google_storage_bucket_object_content" "current_snapshot" {
  count  = var.snapshot_release == "" ? 1 : 0
  bucket = google_storage_bucket.snapshots.name
  name   = "current.json"
}
locals {
  active_release      = var.snapshot_release != "" ? var.snapshot_release : jsondecode(data.google_storage_bucket_object_content.current_snapshot[0].content).release
  serverless_registry = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repository_id}"
}
resource "google_cloud_run_v2_service" "router" {
  for_each            = toset(["car", "foot", "bike"])
  name                = "geo-osrm-${each.key}"
  location            = var.region
  deletion_protection = false
  # HTTPS endpoint reachable by MCP, but requires IAM authentication.
  ingress = "INGRESS_TRAFFIC_ALL"
  template {
    service_account                  = google_service_account.runtime.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    timeout                          = "300s"
    max_instance_request_concurrency = 1
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    volumes {
      name = "graph"
      gcs {
        bucket    = google_storage_bucket.snapshots.name
        read_only = true
      }
    }
    containers {
      image   = "${local.serverless_registry}/osrm:${var.serverless_image_tag}"
      command = ["osrm-routed"]
      args    = ["--algorithm", "mld", "--port", "8080", "--threads", "1", "/snapshots/${local.active_release}/osrm/${each.key}/map.osrm"]
      ports { container_port = 8080 }
      resources {
        limits            = { cpu = "1", memory = "4Gi" }
        cpu_idle          = true
        startup_cpu_boost = false
      }
      volume_mounts {
        name       = "graph"
        mount_path = "/snapshots"
      }
      startup_probe {
        tcp_socket { port = 8080 }
        period_seconds    = 5
        timeout_seconds   = 5
        failure_threshold = 48
      }
    }
  }
  lifecycle { ignore_changes = [client, client_version, scaling] }
  depends_on = [google_storage_bucket_iam_member.snapshots_reader]
}
resource "google_cloud_run_v2_service_iam_member" "router_invoker" {
  for_each = google_cloud_run_v2_service.router
  project  = var.project_id
  location = var.region
  name     = each.value.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

# The updater can deploy only the four existing services, using the runtime identity.
resource "google_cloud_run_v2_service_iam_member" "updater_router" {
  for_each = google_cloud_run_v2_service.router
  project  = var.project_id
  location = var.region
  name     = each.value.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.updater.email}"
}
resource "google_cloud_run_v2_service_iam_member" "updater_app" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.app[0].name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.updater.email}"
}
resource "google_service_account_iam_member" "updater_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.updater.email}"
}
resource "google_project_iam_member" "updater_operations" {
  project = var.project_id
  role    = "roles/run.viewer"
  member  = "serviceAccount:${google_service_account.updater.email}"
}
resource "google_artifact_registry_repository_iam_member" "updater_images" {
  location   = var.region
  repository = google_artifact_registry_repository.app.repository_id
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.updater.email}"
}
variable "update_image_tag" {
  type    = string
  default = "0cc3f961-de1c-4d47-af08-afdd7851b5a2"
}
resource "google_cloud_run_v2_job" "update" {
  name                = "geo-osm-update"
  location            = var.region
  deletion_protection = false
  template {
    task_count  = 1
    parallelism = 1
    template {
      service_account = google_service_account.updater.email
      max_retries     = 0
      timeout         = "14400s"
      containers {
        image = "${local.serverless_registry}/geo-update:${var.update_image_tag != "" ? var.update_image_tag : var.serverless_image_tag}"
        resources { limits = { cpu = "8", memory = "32Gi" } }
        dynamic "env" {
          for_each = {
            GCP_PROJECT_ID  = var.project_id
            GCP_REGION      = var.region
            SNAPSHOT_BUCKET = google_storage_bucket.snapshots.name
            MCP_SERVICE     = var.service_name
          }
          content {
            name  = env.key
            value = env.value
          }
        }
      }
    }
  }
  depends_on = [google_cloud_run_v2_service_iam_member.updater_app, google_cloud_run_v2_service_iam_member.updater_router, google_project_iam_member.updater_operations]
}
# Remain paused until the complete update has been measured against the budget.
variable "enable_weekly_update" {
  type    = bool
  default = false
}
resource "google_project_service" "scheduler" {
  service            = "cloudscheduler.googleapis.com"
  disable_on_destroy = false
}
resource "google_service_account" "scheduler" {
  account_id   = "geo-home-scheduler"
  display_name = "Geo Home weekly update trigger"
}
resource "google_cloud_run_v2_job_iam_member" "scheduler" {
  location = var.region
  name     = google_cloud_run_v2_job.update.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}
resource "google_cloud_scheduler_job" "update" {
  name      = "geo-osm-weekly"
  region    = var.region
  schedule  = "0 3 * * 0"
  time_zone = "Asia/Tokyo"
  paused    = !var.enable_weekly_update
  http_target {
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.update.name}:run"
    http_method = "POST"
    oauth_token { service_account_email = google_service_account.scheduler.email }
  }
  depends_on = [google_project_service.scheduler, google_cloud_run_v2_job_iam_member.scheduler]
}

# Created with the account that already owns takeshy.work, then imported here.
resource "google_cloud_run_domain_mapping" "geo" {
  location = var.region
  name     = var.domain
  metadata { namespace = var.project_id }
  spec { route_name = var.service_name }
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [spec[0].certificate_mode]
  }
}
