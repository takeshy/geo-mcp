terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "6.50.0"
    }
  }
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# API Keys requires an explicit quota project with user ADC credentials.
provider "google" {
  alias                 = "api_keys"
  project               = var.project_id
  billing_project       = var.project_id
  user_project_override = true
}
