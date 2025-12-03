#!/bin/bash
# create_firewall.sh
# Creates firewall rules for vLLM ingress

PROJECT_ID=${PROJECT_ID:-"segov-dev-model"}
PORTFOLIO_BACKEND_IP=${PORTFOLIO_BACKEND_IP:-"0.0.0.0/0"} 

if gcloud compute firewall-rules describe allow-vllm-ingress \
    --project=$PROJECT_ID &>/dev/null; then
    echo "Firewall rule allow-vllm-ingress already exists in project $PROJECT_ID. Skipping creation."
    exit 0
fi

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
