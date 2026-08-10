variable "project_id" {
  description = "Dedicated GCP project ID for Geo Home. The project and billing link must already exist."
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run, Artifact Registry, and Cloud Build."
  type        = string
  default     = "asia-northeast1"
}

variable "service_name" {
  description = "Cloud Run service name."
  type        = string
  default     = "geo-home-mcp"
}

variable "artifact_repository_id" {
  description = "Artifact Registry Docker repository ID."
  type        = string
  default     = "geo-home"
}

variable "bucket_name" {
  description = "Globally unique GCS bucket name; empty defaults to <project_id>-geo-home."
  type        = string
  default     = ""
}

variable "public_tiles" {
  description = "Allow unauthenticated PMTiles object reads from browsers."
  type        = bool
  default     = true
}

variable "cors_origins" {
  description = "Browser origins allowed to read PMTiles. Replace * with deployed application origins in production."
  type        = list(string)
  default     = ["*"]
}

variable "land_price_object" {
  description = "Normalized land-price JSON object name. Empty uses bundled demo data."
  type        = string
  default     = ""
}

variable "pmtiles_object" {
  description = "PMTiles object name. Empty disables the PMTiles layer."
  type        = string
  default     = ""
}

variable "pmtiles_source_layer" {
  description = "Vector source-layer name inside the PMTiles archive."
  type        = string
  default     = "land-price"
}

variable "basemap_style_url" {
  description = "MapLibre basemap style URL."
  type        = string
  default     = "https://tiles.openfreemap.org/styles/bright"
}

variable "google_maps_secret_id" {
  description = "Existing Secret Manager secret ID containing the Google Routes API key. Empty uses demo estimates."
  type        = string
  default     = ""
}

variable "bootstrap_image" {
  description = "Safe image used only until the first Cloud Build deployment."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}
