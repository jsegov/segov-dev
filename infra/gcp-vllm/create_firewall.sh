#!/bin/bash
# create_firewall.sh
# Creates firewall rules for vLLM ingress

PROJECT_ID=${PROJECT_ID:-"segov-dev-model"}
# Replace with your actual frontend/backend IP or range
# For development/testing, you might want to be more permissive or use IAP
PORTFOLIO_BACKEND_IP=${PORTFOLIO_BACKEND_IP:-"0.0.0.0/0"} 

echo "Creating firewall rule allow-vllm-ingress in project: $PROJECT_ID"

gcloud compute firewall-rules create allow-vllm-ingress \
    --project=$PROJECT_ID \
    --direction=INGRESS \
    --priority=1000 \
    --network=default \
    --action=ALLOW \
    --rules=tcp:8000 \
    --source-ranges=$PORTFOLIO_BACKEND_IP \
    --target-tags=vllm-server

echo "Firewall rule creation command executed."
