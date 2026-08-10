locals {
  bucket_name = var.bucket_name != "" ? var.bucket_name : "${var.project_id}-geo-home"
  required_apis = toset([
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "iam.googleapis.com",
    "run.googleapis.com",
    "storage.googleapis.com",
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
  display_name = "Geo Home Cloud Run"

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

resource "google_storage_bucket" "data" {
  project                     = var.project_id
  name                        = local.bucket_name
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  force_destroy               = false

  cors {
    origin          = var.cors_origins
    method          = ["GET", "HEAD"]
    response_header = ["Content-Type", "Range", "Content-Range", "Accept-Ranges", "ETag"]
    max_age_seconds = 3600
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket_iam_member" "runtime_reader" {
  bucket = google_storage_bucket.data.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_bucket_iam_member" "public_reader" {
  count = var.public_tiles ? 1 : 0

  bucket = google_storage_bucket.data.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_cloud_run_v2_service" "app" {
  project             = var.project_id
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.runtime.email
    timeout                          = "60s"
    max_instance_request_concurrency = 40

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = var.bootstrap_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          memory = "512Mi"
          cpu    = "1"
        }
        cpu_idle = true
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }

      env {
        name  = "BASEMAP_STYLE_URL"
        value = var.basemap_style_url
      }

      env {
        name  = "PMTILES_SOURCE_LAYER"
        value = var.pmtiles_source_layer
      }

      dynamic "env" {
        for_each = var.land_price_object != "" ? [var.land_price_object] : []
        content {
          name  = "LAND_PRICE_DATA_PATH"
          value = "gs://${google_storage_bucket.data.name}/${env.value}"
        }
      }

      dynamic "env" {
        for_each = var.pmtiles_object != "" ? [var.pmtiles_object] : []
        content {
          name  = "PMTILES_URL"
          value = "https://storage.googleapis.com/${google_storage_bucket.data.name}/${env.value}"
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
        initial_delay_seconds = 2
        period_seconds        = 5
        failure_threshold     = 6
      }
    }
  }

  lifecycle {
    ignore_changes = [
      client,
      client_version,
      scaling,
      template[0].containers[0].image,
    ]
  }

  depends_on = [
    google_artifact_registry_repository.app,
    google_storage_bucket_iam_member.runtime_reader,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = var.project_id
  name     = google_cloud_run_v2_service.app.name
  location = google_cloud_run_v2_service.app.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
