#!/bin/bash
# Open CSP frame-ancestors + CORS on jm-saas-2 so the Tableau Spotter extension
# can embed the cluster. SSH to the private IP (admin@10.79.138.0), not the
# hostname. The ThoughtSpot iframe sits inside our chrome-extension panel, which
# sits inside the Tableau page, so BOTH origins must be in frame-ancestors.
set -euo pipefail
HOST="${1:-10.79.138.0}"
EXT_ORIGIN="${2:-chrome-extension://ncigojejibldglmgibdaceohpfmnfajk}"
TABLEAU_ORIGIN="https://prod-in-a.online.tableau.com"

echo "== applying on $HOST =="
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null admin@"$HOST" bash -s <<REMOTE
set -x
tscli csp add-override --source 'frame-ancestors' --url '$EXT_ORIGIN'
tscli csp add-override --source 'frame-ancestors' --url '$TABLEAU_ORIGIN'
echo ".*" | tscli --adv config set --key "/config/nginx/corshosts"
REMOTE

echo
echo "== verifying frame-ancestors now lists the extension origin =="
curl -sk -D - -o /dev/null --max-time 15 "https://$HOST/" 2>/dev/null \
  | grep -io "content-security-policy:.*" | tr ';' '\n' | grep -i 'frame-ancestors'
