# Infrastructure Configuration

This directory contains deployment configurations for Cloud Run services.

## Structure

```
infra/
├── backend/
│   ├── Dockerfile          # Backend service Dockerfile
│   └── deploy.sh          # Backend deployment script
├── frontend/
│   ├── Dockerfile         # Frontend service Dockerfile
│   └── deploy.sh          # Frontend deployment script
├── setup.sh               # GCP infrastructure setup script
└── README.md             # This file
```

## Prerequisites

1. Google Cloud SDK (`gcloud`) installed and configured
2. Authenticated with `gcloud auth login`
3. Project ID set: `gcloud config set project YOUR_PROJECT_ID`

## Setup

Run the setup script to enable APIs and create necessary resources:

```bash
chmod +x setup.sh
./setup.sh
```

Or manually set environment variables:

```bash
export PROJECT_ID=your-project-id
export REGION=us-central1
./setup.sh
```

This script will:
- Enable required GCP APIs (Vertex AI, Cloud Run, Storage, Pub/Sub, Eventarc)
- Create a service account for the MCP backend
- Grant necessary IAM roles
- Create a secret for the RAG corpus name

## Deployment

### Backend Deployment

1. Ensure you have created a Vertex AI RAG corpus and have its resource name
2. Update the `RAG_CORPUS_NAME` secret:

```bash
echo "projects/YOUR_PROJECT_ID/locations/us-central1/ragCorpora/YOUR_CORPUS_ID" | \
  gcloud secrets versions add RAG_CORPUS_NAME --data-file=-
```

3. Deploy the backend:

```bash
cd backend
chmod +x ../infra/backend/deploy.sh
../infra/backend/deploy.sh
```

Or with custom values:

```bash
PROJECT_ID=your-project-id REGION=us-central1 SERVICE_NAME=mcp-backend ../infra/backend/deploy.sh
```

### Frontend Deployment

```bash
cd frontend
chmod +x ../infra/frontend/deploy.sh
../infra/frontend/deploy.sh
```

## Environment Variables

### Backend

The backend requires these environment variables (set via Cloud Run secrets/env vars):

- `PROJECT_ID`: Your GCP project ID
- `LOCATION`: Vertex AI region (e.g., `us-central1`)
- `RAG_CORPUS_NAME`: Full resource name of the RAG corpus (stored as secret)

### Frontend

The frontend uses environment variables from `.env.local` (configured via Cloud Run or build-time env vars).

## Service Account Permissions

The MCP backend service account requires:

- `roles/aiplatform.user`: Access Vertex AI APIs
- `roles/storage.objectViewer`: Read from GCS buckets
- `roles/run.invoker`: Invoke Cloud Run services (if needed)

## Optional: Pub/Sub Auto-Ingest Setup

To enable automatic ingestion on GCS object creation:

1. Create a Pub/Sub topic:

```bash
gcloud pubsub topics create gcs-upload-notifications --project ${PROJECT_ID}
```

2. Configure GCS bucket notifications:

```bash
gsutil notification create \
  -t gcs-upload-notifications \
  -f json \
  -e OBJECT_FINALIZE \
  gs://your-bucket-name
```

3. Create an Eventarc trigger to invoke the backend:

```bash
gcloud eventarc triggers create trigger-gcs-ingest \
  --location=${REGION} \
  --destination-run-service=mcp-backend \
  --destination-run-region=${REGION} \
  --event-filters="type=google.cloud.storage.object.v1.finalized" \
  --event-filters="bucket=your-bucket-name" \
  --service-account=${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com
```

## Troubleshooting

- **Build failures**: Ensure Cloud Build API is enabled
- **Permission errors**: Verify service account has correct IAM roles
- **Deployment timeouts**: Increase `--timeout` value or check resource limits
- **Secret not found**: Ensure `RAG_CORPUS_NAME` secret exists and is accessible

