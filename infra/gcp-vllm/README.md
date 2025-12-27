# vLLM Cloud Run GPU Deployment

This directory contains the infrastructure and deployment scripts for running vLLM on Google Cloud Run with NVIDIA L4 GPU support.

## Architecture

- **Service**: Cloud Run with GPU (NVIDIA L4)
- **Region**: us-east4 (Cloud Run GPU available)
- **Model**: Qwen/Qwen3-8B
- **Scaling**: Scale-to-zero (pay only when active)
- **Cost**: ~$0.67/hour when active, $0 when idle

## Directory Structure

- `Dockerfile`: vLLM container image with Qwen3-8B
- `cloudrun-vllm.yaml`: Cloud Run service configuration with GPU
- `deploy-cloudrun.sh`: Main deployment script
- `deprovision-vm.sh`: Script to remove old VM infrastructure
- `middleware/`: Optional middleware for model abstraction (legacy)
- `GITHUB_VARIABLES.md`: Guide for updating GitHub variables

## Deployment

### Prerequisites

1. GCP project with billing enabled
2. Required APIs enabled (run `cd ../.. && cd infra && ./setup.sh`)
3. Hugging Face token for model access

### Deploy vLLM

```bash
# Set HF_TOKEN environment variable
export HF_TOKEN=your_hugging_face_token

# Deploy to Cloud Run with GPU
./deploy-cloudrun.sh
```

The script will:
1. Create/verify HF_TOKEN in Secret Manager
2. Build vLLM container image
3. Deploy to Cloud Run with L4 GPU in us-east4
4. Configure IAM for service account access
5. Output the service URL

### Get Service URL

```bash
gcloud run services describe vllm-inference \
  --region=us-east4 \
  --project=segov-dev-model \
  --format='value(status.url)'
```

Use this URL + `/v1` as your `OPENAI_BASE_URL`.

## Configuration

### Environment Variables

Override defaults by setting environment variables before deployment:

- `PROJECT_ID` (default: `segov-dev-model`)
- `REGION` (default: `us-east4`)
- `SERVICE_NAME` (default: `vllm-inference`)
- `MODEL_ID` (default: `Qwen/Qwen3-8B`)

Example:
```bash
export MODEL_ID="meta-llama/Llama-3.1-8B"
./deploy-cloudrun.sh
```

### Scaling Configuration

Edit `cloudrun-vllm.yaml` to adjust scaling:

```yaml
annotations:
  autoscaling.knative.dev/minScale: '0'  # Scale to zero when idle
  autoscaling.knative.dev/maxScale: '1'  # Max concurrent instances
```

- `minScale: 0` - Scale to zero (cost-optimized, ~30-60s cold start)
- `minScale: 1` - Always warm (faster responses, ~$16/day)

## Cold Start Optimization

Cloud Run GPU cold starts involve:
- Instance startup: ~5 seconds
- Model loading: ~30-60 seconds for Qwen3-8B

**Mitigation strategies:**
1. Set `minScale: 1` during peak hours
2. Use Cloud Scheduler to warm up before expected traffic
3. Implement request queuing in your application

## Testing

Test the vLLM endpoint:

```bash
SERVICE_URL=$(gcloud run services describe vllm-inference \
  --region=us-east4 \
  --project=segov-dev-model \
  --format='value(status.url)')

curl -X POST "${SERVICE_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  -d '{
    "model": "Qwen/Qwen3-8B",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 50
  }'
```

## Migration from VM

If migrating from the old VM-based setup:

1. Deploy the new Cloud Run GPU service
2. Update `OPENAI_BASE_URL` to the Cloud Run URL
3. Run the deprovisioning script:

```bash
./deprovision-vm.sh
```

This will remove:
- VM instance
- Firewall rules
- VPC connector and NAT
- Static IP (optional)

See `GITHUB_VARIABLES.md` for GitHub variables to update/remove.

## Monitoring

View logs:
```bash
gcloud run services logs read vllm-inference \
  --region=us-east4 \
  --project=segov-dev-model \
  --limit=50
```

View metrics:
```bash
gcloud run services describe vllm-inference \
  --region=us-east4 \
  --project=segov-dev-model
```

## Troubleshooting

### Cold starts too slow
- Set `minScale: 1` in `cloudrun-vllm.yaml`
- Use a smaller model
- Implement client-side loading indicators

### Out of memory
- Reduce `--max-model-len` in Dockerfile
- Reduce `--gpu-memory-utilization` in Dockerfile
- Use a model with fewer parameters

### Authentication errors
- Ensure service account has `roles/run.invoker`
- Verify Secret Manager access for HF_TOKEN
- Check IAM bindings: `gcloud run services get-iam-policy vllm-inference --region=us-east4`

## Cost Optimization

**Current setup (scale-to-zero):**
- Active: ~$0.67/hour
- Idle: $0/hour
- Estimated monthly (2hr/day usage): ~$40

**Always-on (minScale: 1):**
- 24/7: ~$480/month
- Business hours only (8hr/day): ~$160/month

Use Cloud Scheduler to adjust `minScale` based on expected traffic patterns.
