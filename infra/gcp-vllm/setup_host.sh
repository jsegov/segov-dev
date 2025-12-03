#!/bin/bash
# setup_host.sh
# Execute this on the GCP VM instance after SSH login.

set -e

echo "[INFO] Starting Host Initialization..."

# 1. System Updates
sudo apt-get update && sudo apt-get upgrade -y

# 2. Verify NVIDIA Driver Status
if command -v nvidia-smi &> /dev/null; then
    echo "[INFO] NVIDIA drivers detected:"
    nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv
else
    echo " NVIDIA drivers not found! Check base image."
    exit 1
fi

# 3. Configure Docker for NVIDIA Runtime
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# 4. Create Persistent Model Cache Directory
mkdir -p ~/hf_cache
sudo chmod 777 ~/hf_cache

echo "[INFO] Host Setup Complete. Ready for vLLM container."
