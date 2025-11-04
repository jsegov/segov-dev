#!/bin/bash
# Script to retrieve GitHub Actions secrets values

set -e

PROJECT_ID=${PROJECT_ID:-"segov-dev-model"}
POOL_ID="vercel-pool"
PROVIDER_ID="vercel-oidc"

echo "=========================================="
echo "GitHub Actions Secrets Values"
echo "=========================================="
echo ""

# Get project number
echo "1. Getting GCP project number..."
PROJECT_NUMBER=$(gcloud projects describe ${PROJECT_ID} --format='value(projectNumber)')
echo "   PROJECT_NUMBER: ${PROJECT_NUMBER}"
echo ""

# Construct WIF_PROVIDER
WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
echo "2. WIF_PROVIDER (GitHub Secret):"
echo "   ${WIF_PROVIDER}"
echo ""

# Check if WIF pool exists
echo "3. Verifying WIF pool exists..."
if gcloud iam workload-identity-pools describe ${POOL_ID} \
    --location="global" \
    --project=${PROJECT_ID} &>/dev/null; then
    echo "   ✓ WIF pool '${POOL_ID}' exists"
else
    echo "   ✗ WIF pool '${POOL_ID}' does not exist"
    echo "   Run: cd infra && ./setup.sh"
    exit 1
fi

# Check if WIF provider exists
echo "4. Verifying WIF provider exists..."
if gcloud iam workload-identity-pools providers describe ${PROVIDER_ID} \
    --location="global" \
    --workload-identity-pool=${POOL_ID} \
    --project=${PROJECT_ID} &>/dev/null; then
    echo "   ✓ WIF provider '${PROVIDER_ID}' exists"
else
    echo "   ✗ WIF provider '${PROVIDER_ID}' does not exist"
    echo "   Run: cd infra && ./setup.sh"
    exit 1
fi
echo ""

# Check for GitHub Actions service account
echo "5. Checking for GitHub Actions service account..."
echo "   You need to create a service account for GitHub Actions deployment."
echo "   This is different from the Cloud Run service account (mcp-sa)."
echo ""
echo "   Create it with:"
echo "   gcloud iam service-accounts create github-actions-sa \\"
echo "     --display-name=\"GitHub Actions Deployment\" \\"
echo "     --project=${PROJECT_ID}"
echo ""
echo "   Then grant it the required roles:"
echo "   gcloud projects add-iam-policy-binding ${PROJECT_ID} \\"
echo "     --member=\"serviceAccount:github-actions-sa@${PROJECT_ID}.iam.gserviceaccount.com\" \\"
echo "     --role=\"roles/artifactregistry.writer\""
echo ""
echo "   gcloud projects add-iam-policy-binding ${PROJECT_ID} \\"
echo "     --member=\"serviceAccount:github-actions-sa@${PROJECT_ID}.iam.gserviceaccount.com\" \\"
echo "     --role=\"roles/run.admin\""
echo ""
echo "   gcloud projects add-iam-policy-binding ${PROJECT_ID} \\"
echo "     --member=\"serviceAccount:github-actions-sa@${PROJECT_ID}.iam.gserviceaccount.com\" \\"
echo "     --role=\"roles/iam.serviceAccountUser\""
echo ""
echo "   WIF_SERVICE_ACCOUNT (GitHub Secret):"
echo "   github-actions-sa@${PROJECT_ID}.iam.gserviceaccount.com"
echo ""

# Check if GitHub Actions service account exists
GITHUB_SA="github-actions-sa@${PROJECT_ID}.iam.gserviceaccount.com"
if gcloud iam service-accounts describe ${GITHUB_SA} --project=${PROJECT_ID} &>/dev/null 2>&1; then
    echo "   ✓ Service account '${GITHUB_SA}' exists"
    
    # Check WIF binding
    echo ""
    echo "6. Checking WIF binding on service account..."
    if gcloud iam service-accounts get-iam-policy ${GITHUB_SA} \
        --project=${PROJECT_ID} \
        --flatten="bindings[].members" \
        --filter="bindings.role:roles/iam.workloadIdentityUser" \
        --format="value(bindings.members)" | grep -q "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"; then
        echo "   ✓ WIF binding exists"
    else
        echo "   ✗ WIF binding missing"
        echo ""
        echo "   Add it with:"
        echo "   gcloud iam service-accounts add-iam-policy-binding ${GITHUB_SA} \\"
        echo "     --project=${PROJECT_ID} \\"
        echo "     --role=\"roles/iam.workloadIdentityUser\" \\"
        echo "     --member=\"principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/*\""
    fi
else
    echo "   ✗ Service account '${GITHUB_SA}' does not exist"
fi

echo ""
echo "=========================================="
echo "Summary - Add to GitHub Secrets"
echo "=========================================="
echo ""
echo "Go to: GitHub Repo → Settings → Secrets and variables → Actions"
echo "Environment: prod"
echo ""
echo "Add these secrets:"
echo ""
echo "Name: WIF_PROVIDER"
echo "Value: ${WIF_PROVIDER}"
echo ""
if gcloud iam service-accounts describe ${GITHUB_SA} --project=${PROJECT_ID} &>/dev/null 2>&1; then
    echo "Name: WIF_SERVICE_ACCOUNT"
    echo "Value: ${GITHUB_SA}"
else
    echo "Name: WIF_SERVICE_ACCOUNT"
    echo "Value: github-actions-sa@${PROJECT_ID}.iam.gserviceaccount.com"
    echo "       (Create this service account first)"
fi
echo ""

