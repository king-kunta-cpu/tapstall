#!/usr/bin/env python3
import os
import requests
import json

# Whop API keys come from the environment. They were hard-coded here once, in a public repository,
# which handed anybody who read it full read access to this company's products, plans and payments.
# Never put one back in a file: a key belongs in GitHub Actions secrets or a local .env, nowhere else.
ACCOUNT_KEY = os.environ.get("WHOP_ACCOUNT_KEY", "").strip()
APP_KEY = os.environ.get("WHOP_APP_KEY", "").strip()
if not ACCOUNT_KEY:
    raise SystemExit("WHOP_ACCOUNT_KEY is not set — export it, or set the repo secret. "
                     "Refusing to run with an empty key.")
COMPANY_ID = "biz_dUYhC6sMZONDgB"
ACCOUNT_ID = "account_id_from_whop_dashboard" # Owner to provide or fetch
APP_ID = "app_65JU1MvfiLXdxh"

API_BASE = "https://api.whop.com/api/v1"

def get_headers(key_type="account"):
    key = ACCOUNT_KEY if key_type == "account" else APP_KEY
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json"
    }

# 1. Create New Free Plan (Product: prod_LVj8BSXeiCjTm)
# Note: Whop API for plan creation is usually /api/v1/product/plan/create
# Handover says: "Create new plans; never edit old ones."
def create_free_plan():
    url = f"{API_BASE}/product/plan/create"
    payload = {
        "product_id": "prod_LVj8BSXeiCjTm",
        "name": "App Access (Free)",
        "price": 0,
        "currency": "USD",
        "billing_interval": "monthly",
        "commission_percent": 50, # First payment
        "commission_percent_after": 30, # Subsequent
        "description": "Free access to Tapstall App. Up to 30 orders/month. Line on slips: Tapstall.\n\nFAQ:\nWho is behind this? Jacaranda Labs, Bulawayo. Messages in this store are read and answered by a person.\nPostal address: Jacaranda Labs, P.O. Box 900, Bulawayo, Zimbabwe.",
        "max_uses": 30
    }
    headers = get_headers("account")
    response = requests.post(url, headers=headers, json=payload)
    print("Create Free Plan Response:", response.status_code, response.text)

# 2. Update whop-sites repo (gen_sites.py & deploy)
# Note: This requires Node >= 22.12 and whop-sites repo access.
def update_whop_sites():
    print("Updating whop-sites repo (gen_sites.py, npx whop apps deploy)...")
    # Implementation would involve cloning king-kunta-cpu/whop-sites and running commands
    # For now, we document the steps in the deployment script.

if __name__ == "__main__":
    create_free_plan()
    update_whop_sites()
