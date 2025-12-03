#!/bin/bash
# setup_static_egress.sh
# Sets up VPC connector and Cloud NAT for Cloud Run static outbound IP
# This enables Cloud Run to egress through a reserved static IP address

set -e

PROJECT_ID=${PROJECT_ID:-"segov-dev-model"}
REGION=${REGION:-"us-east1"}
NETWORK=${NETWORK:-"default"}
SUBNET_NAME=${SUBNET_NAME:-"cloudrun-egress-subnet"}
SUBNET_RANGE=${SUBNET_RANGE:-"10.8.0.0/28"}
CONNECTOR_NAME=${CONNECTOR_NAME:-"cloudrun-connector"}
ROUTER_NAME=${ROUTER_NAME:-"cloudrun-router"}
NAT_NAME=${NAT_NAME:-"cloudrun-nat"}
STATIC_IP_NAME=${STATIC_IP_NAME:-"segov-dev-static-ip-east1"}

echo "Setting up Cloud Run static outbound IP infrastructure..."
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo ""

# Step 1: Enable required APIs
echo "1. Enabling Serverless VPC Access API..."
gcloud services enable vpcaccess.googleapis.com \
  --project=${PROJECT_ID} || echo "API may already be enabled"

# Step 2: Create subnet for VPC connector (idempotent)
echo ""
echo "2. Creating subnet for VPC connector..."
if gcloud compute networks subnets describe ${SUBNET_NAME} \
    --network=${NETWORK} \
    --region=${REGION} \
    --project=${PROJECT_ID} &>/dev/null; then
    echo "   Subnet ${SUBNET_NAME} already exists, skipping creation."
else
    echo "   Creating subnet ${SUBNET_NAME} with range ${SUBNET_RANGE}..."
    gcloud compute networks subnets create ${SUBNET_NAME} \
      --network=${NETWORK} \
      --region=${REGION} \
      --range=${SUBNET_RANGE} \
      --project=${PROJECT_ID}
    echo "   Subnet created successfully."
fi

# Step 3: Create Serverless VPC Access Connector (idempotent)
echo ""
echo "3. Creating Serverless VPC Access Connector..."
if gcloud compute networks vpc-access connectors describe ${CONNECTOR_NAME} \
    --region=${REGION} \
    --project=${PROJECT_ID} &>/dev/null; then
    echo "   Connector ${CONNECTOR_NAME} already exists, skipping creation."
else
    echo "   Creating connector ${CONNECTOR_NAME}..."
    gcloud compute networks vpc-access connectors create ${CONNECTOR_NAME} \
      --region=${REGION} \
      --subnet=${SUBNET_NAME} \
      --subnet-project=${PROJECT_ID} \
      --project=${PROJECT_ID}
    echo "   Connector created successfully. This may take a few minutes..."
    echo "   Waiting for connector to be ready..."
    
    # Wait for connector to be ready (max 10 minutes)
    max_attempts=60
    attempt=0
    while [ $attempt -lt $max_attempts ]; do
        STATE=$(gcloud compute networks vpc-access connectors describe ${CONNECTOR_NAME} \
            --region=${REGION} \
            --project=${PROJECT_ID} \
            --format='value(state)' 2>/dev/null || echo "UNKNOWN")
        
        if [ "$STATE" = "READY" ]; then
            echo "   Connector is ready."
            break
        fi
        
        attempt=$((attempt + 1))
        echo "   Connector state: ${STATE} (attempt $attempt/$max_attempts)"
        sleep 10
    done
    
    if [ "$STATE" != "READY" ]; then
        echo "   Warning: Connector may still be provisioning. Check status manually."
    fi
fi

# Step 4: Create Cloud Router (idempotent)
echo ""
echo "4. Creating Cloud Router..."
if gcloud compute routers describe ${ROUTER_NAME} \
    --region=${REGION} \
    --project=${PROJECT_ID} &>/dev/null; then
    echo "   Router ${ROUTER_NAME} already exists, skipping creation."
else
    echo "   Creating router ${ROUTER_NAME}..."
    gcloud compute routers create ${ROUTER_NAME} \
      --network=${NETWORK} \
      --region=${REGION} \
      --project=${PROJECT_ID}
    echo "   Router created successfully."
fi

# Step 5: Create Cloud NAT with static IP (idempotent)
echo ""
echo "5. Creating Cloud NAT with static IP..."
if gcloud compute routers nats describe ${NAT_NAME} \
    --router=${ROUTER_NAME} \
    --region=${REGION} \
    --project=${PROJECT_ID} &>/dev/null; then
    echo "   NAT ${NAT_NAME} already exists, skipping creation."
else
    echo "   Creating NAT ${NAT_NAME} with static IP ${STATIC_IP_NAME}..."
    
    # Verify static IP exists
    if ! gcloud compute addresses describe ${STATIC_IP_NAME} \
        --region=${REGION} \
        --project=${PROJECT_ID} &>/dev/null; then
        echo "   Error: Static IP ${STATIC_IP_NAME} not found in region ${REGION}"
        echo "   Please create it first with:"
        echo "   gcloud compute addresses create ${STATIC_IP_NAME} --region=${REGION} --project=${PROJECT_ID}"
        exit 1
    fi
    
    gcloud compute routers nats create ${NAT_NAME} \
      --router=${ROUTER_NAME} \
      --region=${REGION} \
      --nat-custom-subnet-ip-ranges=${SUBNET_NAME} \
      --nat-external-ip-pool=${STATIC_IP_NAME} \
      --project=${PROJECT_ID}
    echo "   NAT created successfully."
fi

# Get static IP address
STATIC_IP=$(gcloud compute addresses describe ${STATIC_IP_NAME} \
    --region=${REGION} \
    --project=${PROJECT_ID} \
    --format='value(address)')

echo ""
echo "=========================================="
echo "Static Egress Setup Complete!"
echo "=========================================="
echo ""
echo "Infrastructure created:"
echo "  Subnet: ${SUBNET_NAME} (${SUBNET_RANGE})"
echo "  VPC Connector: ${CONNECTOR_NAME}"
echo "  Cloud Router: ${ROUTER_NAME}"
echo "  Cloud NAT: ${NAT_NAME}"
echo "  Static IP: ${STATIC_IP_NAME} (${STATIC_IP})"
echo ""
echo "Next steps:"
echo "1. Update Cloud Run service to use the VPC connector:"
echo "   Add these annotations to cloudrun.yaml:"
echo "   - run.googleapis.com/vpc-access-connector: projects/${PROJECT_ID}/locations/${REGION}/connectors/${CONNECTOR_NAME}"
echo "   - run.googleapis.com/vpc-access-egress: all-traffic"
echo ""
echo "2. Set GitHub variable PORTFOLIO_BACKEND_IP=${STATIC_IP}/32"
echo ""
echo "3. Redeploy Cloud Run service: cd backend && ../infra/backend/deploy.sh"
echo ""

