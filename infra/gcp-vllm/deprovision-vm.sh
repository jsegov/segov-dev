#!/bin/bash
# deprovision-vm.sh
# Removes the old VM-based vLLM infrastructure

set -e

PROJECT_ID=${PROJECT_ID:-"segov-dev-model"}
REGION=${REGION:-"us-east1"}
ZONE=${ZONE:-"us-east1-b"}
INSTANCE_NAME=${INSTANCE_NAME:-"qwen3-inference-node"}
SUBNET_NAME=${SUBNET_NAME:-"cloudrun-egress-subnet"}
CONNECTOR_NAME=${CONNECTOR_NAME:-"cloudrun-connector"}
ROUTER_NAME=${ROUTER_NAME:-"cloudrun-router"}
NAT_NAME=${NAT_NAME:-"cloudrun-nat"}
STATIC_IP_NAME=${STATIC_IP_NAME:-"segov-dev-static-ip-east1"}

echo "=========================================="
echo "Deprovisioning VM Infrastructure"
echo "=========================================="
echo "Project: ${PROJECT_ID}"
echo ""
echo "WARNING: This will delete:"
echo "  - VM instance: ${INSTANCE_NAME}"
echo "  - Firewall rule: allow-vllm-ingress"
echo "  - Cloud NAT: ${NAT_NAME}"
echo "  - Cloud Router: ${ROUTER_NAME}"
echo "  - VPC Connector: ${CONNECTOR_NAME}"
echo "  - Subnet: ${SUBNET_NAME}"
echo "  - Static IP: ${STATIC_IP_NAME}"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

# Delete VM instance
echo ""
echo "1. Deleting VM instance..."
if gcloud compute instances describe ${INSTANCE_NAME} \
    --project=${PROJECT_ID} \
    --zone=${ZONE} &>/dev/null; then
    gcloud compute instances delete ${INSTANCE_NAME} \
        --project=${PROJECT_ID} \
        --zone=${ZONE} \
        --quiet
    echo "   VM instance deleted."
else
    echo "   VM instance not found (may already be deleted)."
fi

# Delete firewall rule
echo ""
echo "2. Deleting firewall rule..."
if gcloud compute firewall-rules describe allow-vllm-ingress \
    --project=${PROJECT_ID} &>/dev/null; then
    gcloud compute firewall-rules delete allow-vllm-ingress \
        --project=${PROJECT_ID} \
        --quiet
    echo "   Firewall rule deleted."
else
    echo "   Firewall rule not found (may already be deleted)."
fi

# Delete Cloud NAT
echo ""
echo "3. Deleting Cloud NAT..."
if gcloud compute routers nats describe ${NAT_NAME} \
    --router=${ROUTER_NAME} \
    --region=${REGION} \
    --project=${PROJECT_ID} &>/dev/null; then
    gcloud compute routers nats delete ${NAT_NAME} \
        --router=${ROUTER_NAME} \
        --region=${REGION} \
        --project=${PROJECT_ID} \
        --quiet
    echo "   Cloud NAT deleted."
else
    echo "   Cloud NAT not found (may already be deleted)."
fi

# Delete Cloud Router
echo ""
echo "4. Deleting Cloud Router..."
if gcloud compute routers describe ${ROUTER_NAME} \
    --region=${REGION} \
    --project=${PROJECT_ID} &>/dev/null; then
    gcloud compute routers delete ${ROUTER_NAME} \
        --region=${REGION} \
        --project=${PROJECT_ID} \
        --quiet
    echo "   Cloud Router deleted."
else
    echo "   Cloud Router not found (may already be deleted)."
fi

# Delete VPC Connector
echo ""
echo "5. Deleting VPC Connector..."
if gcloud compute networks vpc-access connectors describe ${CONNECTOR_NAME} \
    --region=${REGION} \
    --project=${PROJECT_ID} &>/dev/null; then
    gcloud compute networks vpc-access connectors delete ${CONNECTOR_NAME} \
        --region=${REGION} \
        --project=${PROJECT_ID} \
        --quiet
    echo "   VPC Connector deleted (this may take a few minutes)."
else
    echo "   VPC Connector not found (may already be deleted)."
fi

# Delete Subnet
echo ""
echo "6. Deleting subnet..."
if gcloud compute networks subnets describe ${SUBNET_NAME} \
    --region=${REGION} \
    --project=${PROJECT_ID} &>/dev/null; then
    gcloud compute networks subnets delete ${SUBNET_NAME} \
        --region=${REGION} \
        --project=${PROJECT_ID} \
        --quiet
    echo "   Subnet deleted."
else
    echo "   Subnet not found (may already be deleted)."
fi

# Optionally delete static IP
echo ""
echo "7. Static IP ${STATIC_IP_NAME}..."
if gcloud compute addresses describe ${STATIC_IP_NAME} \
    --region=${REGION} \
    --project=${PROJECT_ID} &>/dev/null; then
    read -p "   Delete static IP ${STATIC_IP_NAME}? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        gcloud compute addresses delete ${STATIC_IP_NAME} \
            --region=${REGION} \
            --project=${PROJECT_ID} \
            --quiet
        echo "   Static IP deleted."
    else
        echo "   Static IP preserved (can be used for other services)."
    fi
else
    echo "   Static IP not found (may already be deleted)."
fi

echo ""
echo "=========================================="
echo "Deprovisioning Complete!"
echo "=========================================="
echo ""
echo "Old VM infrastructure has been removed."
echo "Your new Cloud Run GPU vLLM service is ready to use."
echo ""
