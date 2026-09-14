#!/usr/bin/env bash
# Sends every sample payload to the production webhook URLs.
# Publish both workflows first. Override the host with N8N_URL=...
#
#   bash samples/test-webhooks.sh
set -euo pipefail

N8N_URL="${N8N_URL:-http://localhost:5678}"
cd "$(dirname "$0")"

post() {
  echo
  echo "=== $1 -> $2"
  curl -s -w "\nHTTP %{http_code}\n" -X POST "$N8N_URL/webhook/$1" \
    -H "Content-Type: application/json" --data @"$2"
}

# Workflow 1: AI lead qualification
post lead-qualification lead-hot.json          # expect 200, tier "hot"
post lead-qualification lead-warm.json         # expect 200, tier "warm"
post lead-qualification lead-cold-renter.json  # expect 200, score <= 15, tier "cold"
post lead-qualification lead-invalid.json      # expect 400 with details

# Workflow 2: missed call follow-up (SMS preview email arrives after the 2 minute wait)
post missed-call missed-call.json              # expect 202 with followup_id
