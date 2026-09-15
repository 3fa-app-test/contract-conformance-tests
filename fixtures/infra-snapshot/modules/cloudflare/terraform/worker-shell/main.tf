terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.24.0, < 6.0.0"
    }
  }
}

variable "enabled" {
  type    = bool
  default = false
}

variable "account_id" {
  type      = string
  sensitive = true
  default   = ""
  validation {
    condition     = var.account_id == "" || can(regex("^[0-9a-fA-F]{32}$", var.account_id))
    error_message = "account_id must be empty or a 32-character hexadecimal Cloudflare account ID."
  }
}

variable "worker_name" {
  type = string
  validation {
    condition     = length(var.worker_name) >= 1 && length(var.worker_name) <= 63 && can(regex("^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$", var.worker_name))
    error_message = "worker_name must be 1-63 lowercase alphanumeric/dash characters."
  }
}

variable "workers_dev" {
  type    = bool
  default = false
}

variable "preview_urls" {
  type    = bool
  default = false
}

variable "tags" {
  type    = set(string)
  default = []
}

resource "cloudflare_worker" "this" {
  count      = var.enabled ? 1 : 0
  account_id = var.account_id
  name       = var.worker_name
  tags       = var.tags

  observability = {
    enabled            = true
    head_sampling_rate = 1
  }
  subdomain = {
    enabled          = var.workers_dev
    previews_enabled = var.preview_urls
  }

  lifecycle {
    precondition {
      condition     = var.account_id != ""
      error_message = "account_id must be set when enabled=true."
    }
  }
}

output "worker_id" {
  value = try(cloudflare_worker.this[0].id, null)
}
