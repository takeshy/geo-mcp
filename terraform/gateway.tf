resource "google_service_account" "gateway" {
  count        = var.enable_gateway ? 1 : 0
  account_id   = "geo-home-gateway"
  display_name = "Geo MCP API Gateway backend caller"
}

resource "google_cloud_run_v2_service_iam_member" "gateway_invoker" {
  count    = var.enable_gateway ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.app[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway[0].email}"
}

resource "google_api_gateway_api" "mcp" {
  count        = 1
  provider     = google-beta
  api_id       = "geo-mcp"
  display_name = "Geo MCP"
  depends_on   = [google_project_service.required]
}

resource "google_project_service" "gateway_managed" {
  count              = 1
  service            = google_api_gateway_api.mcp[0].managed_service
  disable_on_destroy = false
  # The managed service becomes consumable only after its first config exists.
  depends_on = [google_api_gateway_api_config.mcp]
}

resource "google_apikeys_key" "mcp" {
  provider     = google.api_keys
  name         = "geo-mcp-client"
  display_name = "Geo MCP client key"
  restrictions {
    api_targets {
      service = google_api_gateway_api.mcp[0].managed_service
    }
  }
  depends_on = [google_project_service.gateway_managed]
}

locals {
  gateway_openapi = jsonencode({
    swagger          = "2.0"
    info             = { title = "Geo MCP", version = "1.0.0" }
    schemes          = ["https"]
    produces         = ["application/json"]
    "x-google-allow" = "configured"
    "x-google-backend" = {
      # Use the existing domain mapping while the direct run.app URLs stay disabled.
      address          = "https://${google_cloud_run_domain_mapping.geo.name}"
      jwt_audience     = "https://${var.domain}"
      path_translation = "APPEND_PATH_TO_ADDRESS"
      deadline         = 300.0
    }
    securityDefinitions = {
      api_key = { type = "apiKey", name = "x-api-key", in = "header" }
    }
    security = [{ api_key = [] }]
    paths = {
      "/mcp" = {
        for method in ["get", "post", "delete"] : method => {
          operationId = "mcp_${method}"
          responses   = { "200" = { description = "MCP response" } }
        }
      }
    }
  })
}

resource "google_api_gateway_api_config" "mcp" {
  count         = var.enable_gateway ? 1 : 0
  provider      = google-beta
  api           = google_api_gateway_api.mcp[0].api_id
  api_config_id = "mcp-${substr(sha256(local.gateway_openapi), 0, 16)}"
  gateway_config {
    backend_config {
      google_service_account = google_service_account.gateway[0].email
    }
  }
  openapi_documents {
    document {
      path     = "openapi.json"
      contents = base64encode(local.gateway_openapi)
    }
  }
  lifecycle { create_before_destroy = true }
}

resource "google_api_gateway_gateway" "mcp" {
  count        = var.enable_gateway ? 1 : 0
  provider     = google-beta
  gateway_id   = "geo-mcp"
  display_name = "Geo MCP"
  region       = var.region
  api_config   = google_api_gateway_api_config.mcp[0].id
  depends_on   = [google_cloud_run_v2_service_iam_member.gateway_invoker]
}

output "gateway_url" {
  value       = var.enable_gateway ? "https://${google_api_gateway_gateway.mcp[0].default_hostname}/mcp" : "https://${var.domain}/mcp"
  description = "Public MCP entry point. Send the dedicated Google API key in X-API-Key."
}

output "gateway_api_key" {
  value       = google_apikeys_key.mcp.key_string
  sensitive   = true
  description = "Dedicated Google API key. Read locally with terraform output -raw gateway_api_key."
}

variable "enable_gateway" {
  description = "Keep the legacy API Gateway; production directly uses the HTTPS load balancer."
  type        = bool
  default     = true
}

moved {
  from = google_service_account.gateway
  to   = google_service_account.gateway[0]
}

moved {
  from = google_cloud_run_v2_service_iam_member.gateway_invoker
  to   = google_cloud_run_v2_service_iam_member.gateway_invoker[0]
}

moved {
  from = google_api_gateway_api.mcp
  to   = google_api_gateway_api.mcp[0]
}

moved {
  from = google_project_service.gateway_managed
  to   = google_project_service.gateway_managed[0]
}

moved {
  from = google_api_gateway_api_config.mcp
  to   = google_api_gateway_api_config.mcp[0]
}

moved {
  from = google_api_gateway_gateway.mcp
  to   = google_api_gateway_gateway.mcp[0]
}
