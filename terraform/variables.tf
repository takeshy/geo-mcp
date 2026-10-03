variable "project_id" {
  description = "Dedicated GCP project ID for Geo Home. The project and billing link must already exist."
  type        = string
}

variable "region" {
  description = "GCP region for Geo Home infrastructure."
  type        = string
  default     = "asia-northeast1"
}

variable "service_name" {
  description = "Geo Home Cloud Run service name."
  type        = string
  default     = "geo-home-mcp"
}

variable "artifact_repository_id" {
  description = "Artifact Registry Docker repository ID."
  type        = string
  default     = "geo-home"
}

variable "mcp_api_key" {
  description = "Shared bearer token every MCP client must send as Authorization: Bearer <key>. Empty leaves /mcp open."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.mcp_api_key == "" || length(var.mcp_api_key) >= 32
    error_message = "mcp_api_key must be empty or at least 32 characters (for example: openssl rand -hex 32)."
  }
}

variable "domain" {
  description = "Existing Cloud Run domain mapping used for authenticated Gateway backend calls."
  type        = string
  default     = ""
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$", var.domain))
    error_message = "Set the existing backend hostname without a scheme, path or port."
  }
}

variable "allow_direct_mcp_access" {
  description = "Temporary migration option. Keep false so clients must use API Gateway."
  type        = bool
  default     = false
}
