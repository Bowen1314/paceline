#!/usr/bin/env bash
# Store the PayPal sandbox credentials in .env without them appearing on screen,
# in shell history, or in any chat. Re-run any time to replace them.
# Usage: scripts/set-paypal-secrets.sh
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || cp .env.example .env
chmod 600 .env

read -rsp "Sandbox Client ID (input hidden): " CID; echo
read -rsp "Sandbox Secret (input hidden): " SEC; echo
read -rp  "Sandbox personal (buyer) account email: " BUYER
read -rsp "Webhook ID (press Enter to skip for now): " WHID; echo

CID="$CID" SEC="$SEC" BUYER="$BUYER" WHID="$WHID" python3 - <<'PY'
import os, re
path = ".env"
text = open(path).read()
def put(name, value):
    global text
    line = f"{name}={value}"
    if re.search(rf"^{name}=.*$", text, flags=re.M):
        text = re.sub(rf"^{name}=.*$", lambda _: line, text, flags=re.M)
    else:
        text += ("" if text.endswith("\n") else "\n") + line + "\n"
put("PAYPAL_CLIENT_ID", os.environ["CID"].strip())
put("PAYPAL_CLIENT_SECRET", os.environ["SEC"].strip())
put("PACELINE_SANDBOX_BUYER_EMAIL", os.environ["BUYER"].strip())
if os.environ["WHID"].strip():
    put("PAYPAL_WEBHOOK_ID", os.environ["WHID"].strip())
open(path, "w").write(text)
for name in ("PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PACELINE_SANDBOX_BUYER_EMAIL"):
    m = re.search(rf"^{name}=(.*)$", text, flags=re.M)
    print(f"{name}: {len(m.group(1)) if m else 0} chars")
PY
echo "Saved to .env (mode 600). PACELINE_PAYPAL_MODE is unchanged; Claude switches it to sandbox after a check."
