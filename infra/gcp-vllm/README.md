# vLLM GCP Deployment

This directory contains the infrastructure and deployment scripts for running vLLM on Google Cloud Platform (GCP) with an NVIDIA L4 GPU.

## Directory Structure

- `create_vm.sh`: Provisions the G2 instance.
- `create_firewall.sh`: Configures firewall rules.
- `setup_host.sh`: Initializes the host VM (drivers, Docker, cache).
- `deploy_model.sh`: Deploys the vLLM Docker container.
- `middleware/`: Contains the Python middleware for model abstraction.

## Deployment Steps

1.  **Provision Infrastructure**:
    ```bash
    ./create_vm.sh
    ./create_firewall.sh
    ```

2.  **Setup Host**:
    SSH into the created VM and run:
    ```bash
    # Copy setup_host.sh to VM first
    ./setup_host.sh
    ```

3.  **Deploy Model**:
    On the VM, run:
    ```bash
    ./deploy_model.sh <HUGGING_FACE_TOKEN>
    ```

4.  **Run Middleware**:
    The middleware can be deployed as a separate service (e.g., Cloud Run) or run locally for testing.
    ```bash
    cd middleware
    pip install -r requirements.txt
    uvicorn main:app --reload
    ```

## Configuration

- **Model**: Default is `Qwen/Qwen3-8B`. To change, pass the model ID to `deploy_model.sh`.
- **Middleware**: Configure `VLLM_API_URL` and `DEFAULT_MODEL` environment variables.
