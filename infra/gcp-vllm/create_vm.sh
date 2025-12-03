#!/bin/bash
# create_vm.sh
# Creates a g2-standard-12 instance with NVIDIA L4 GPU

# Default values
PROJECT_ID=${PROJECT_ID:-"segov-dev-model"}
ZONE=${ZONE:-"us-east1-b"}
INSTANCE_NAME=${INSTANCE_NAME:-"qwen3-inference-node"}

if gcloud compute instances describe $INSTANCE_NAME \
    --project=$PROJECT_ID \
    --zone=$ZONE &>/dev/null; then
    echo "VM instance $INSTANCE_NAME already exists in project $PROJECT_ID, zone $ZONE. Skipping creation."
    exit 0
fi

echo "Creating VM instance: $INSTANCE_NAME in project: $PROJECT_ID, zone: $ZONE"

gcloud compute instances create $INSTANCE_NAME \
    --project=$PROJECT_ID \
    --zone=$ZONE \
    --machine-type=g2-standard-12 \
    --network-interface=network-tier=PREMIUM,stack-type=IPV4_ONLY,subnet=default \
    --maintenance-policy=TERMINATE \
    --provisioning-model=STANDARD \
    --service-account=default \
    --scopes=https://www.googleapis.com/auth/cloud-platform \
    --accelerator=count=1,type=nvidia-l4 \
    --create-disk=auto-delete=yes,boot=yes,device-name=$INSTANCE_NAME,image-family=pytorch-2-4-gpu-debian-11,image-project=ml-images,mode=rw,size=100,type=projects/$PROJECT_ID/zones/$ZONE/diskTypes/pd-balanced \
    --labels=goog-ec-src=vm_add-gcloud \
    --reservation-affinity=any \
    --tags=vllm-server

echo "VM creation command executed."
