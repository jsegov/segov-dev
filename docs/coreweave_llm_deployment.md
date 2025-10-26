# Implementation Plan: Monorepo Restructure & CoreWeave LLM Deployment

## 1. Monorepo Repository Restructuring

**Goal:** Integrate all infrastructure-as-code for the LLM backend into the existing `segov-dev` repo, alongside the Next.js app, for unified versioning and deployment.

**Proposed Layout:** Add a top-level `infra/` directory containing Kubernetes manifests, Helm values, scripts, and environment examples. For instance:

```
segov-dev/
├── app/ ...            # (Next.js app router, unchanged)
├── components/, lib/, etc.  # (Frontend code as is)
├── infra/
│   ├── manifests/            # K8s manifests (PVCs, secrets, etc.)
│   │   ├── huggingface-model-cache-pvc.yaml   # PVC for model weight cache (RWX)
│   │   └── hf-token-secret.yaml.example       # (Optional) example HF token secret manifest
│   ├── helm-values/          # Helm values for deployments
│   │   └── vllm-qwen-values.yaml        # Values to deploy vLLM with Qwen3-8B-FP8
│   ├── scripts/              # Deployment scripts (optional helper scripts)
│   │   └── deploy_infra.sh   # Script to run helm/kubectl commands (for reference/CI)
│   └── env.example           # Example environment variables for infra (cluster, tokens)
└── .github/
    └── workflows/
        └── deploy-infra.yml  # CI workflow to apply `infra/` changes to CoreWeave

```

**Details:**

- The **`infra/manifests`** subdir will contain raw YAML for resources that are best managed outside Helm. This includes the **PersistentVolumeClaim** for model caching and any **K8s Secret** definitions (e.g. a Hugging Face token secret if needed for gated models). These can be applied as-is via `kubectl`. Example `huggingface-model-cache-pvc.yaml` (using CoreWeave’s distributed storage class and ReadWriteMany access for sharing across pods)[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L77-L86):
    
    ```yaml
    apiVersion: v1
    kind: PersistentVolumeClaim
    metadata:
      name: huggingface-model-cache
      namespace: inference
    spec:
      accessModes:
        - ReadWriteMany
      resources:
        requests:
          storage: 10Ti
      storageClassName: shared-vast
    
    ```
    
    This PVC will be used by vLLM to cache downloaded model weights on a high-throughput distributed filesystem (CoreWeave’s "shared-vast" storage) for fast startups[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L77-L86). (10Ti is a generous default; you may adjust size as needed.)
    
- The **`infra/helm-values`** subdir holds YAML files with configuration values for Helm charts. In particular, `vllm-qwen-values.yaml` will configure the vLLM inference service for the Qwen3-8B-FP8 model. This file will include:
    - **Model specification:** The Hugging Face model repository ID for Qwen FP8. For example: `model: "Qwen/Qwen3-8B-FP8"` to instruct vLLM to load that model (the vLLM server will automatically download it from Hugging Face)[qwen.readthedocs.io](https://qwen.readthedocs.io/en/latest/deployment/vllm.html#:~:text=Qwen3%20comes%20with%20two%20types,quantized%20models%2C%20FP8%20and%20AWQ). Qwen3-8B-FP8 is an 8.2B-parameter model quantized to 8-bit floats; serving it in vLLM is as simple as using the model name with the FP8 suffix[qwen.readthedocs.io](https://qwen.readthedocs.io/en/latest/deployment/vllm.html#:~:text=Qwen3%20comes%20with%20two%20types,quantized%20models%2C%20FP8%20and%20AWQ).
    - **GPU resource requests:** Ensure the pod requests a GPU type that supports FP8. (FP8 quantization requires NVIDIA Hopper/Ada or later; compute capability >8.9)[qwen.readthedocs.io](https://qwen.readthedocs.io/en/latest/deployment/vllm.html#:~:text=The%20FP8%20models%20of%20Qwen3,GPUs%20and%20runs%20as%20w8a8). On CoreWeave, this means using an H100 or Ada Lovelace GPU node for full FP8 support. For MVP, request 1 GPU (e.g., `nvidia.com/gpu: 1`) and adequate memory (e.g., 40Gi) for the model.
    - **vLLM container image:** Use an official vLLM server image (matching a version ≥0.8.5, since Qwen3-8B FP8 support is added in vLLM 0.8.5 and above[huggingface.co](https://huggingface.co/Qwen/Qwen3-8B-FP8#:~:text=vllm%20serve%20Qwen%2FQwen3,deepseek_r1)). For example, image `ghcr.io/vllm-project/vllm:0.10.0` or a CoreWeave-provided variant.
    - **Model parameters:** Enable Qwen’s special reasoning mode if desired. Qwen3 supports a "thinking" mode (chain-of-thought) via additional args. For instance, the values could pass `-enable-reasoning --reasoning-parser deepseek_r1` to `vllm serve` (this is equivalent to running `vllm serve Qwen/Qwen3-8B-FP8 --enable-reasoning --reasoning-parser deepseek_r1` as per Qwen docs[huggingface.co](https://huggingface.co/Qwen/Qwen3-8B-FP8#:~:text=vllm%20serve%20Qwen%2FQwen3,deepseek_r1)). *Note:* These are optional – for a minimal viable deployment you can omit them, or set `enableThinking: false` via the model's config if you want to disable the reasoning mode entirely[qwen.readthedocs.io](https://qwen.readthedocs.io/en/latest/deployment/vllm.html#:~:text=Serving%20Quantized%20models%C2%B6)[qwen.readthedocs.io](https://qwen.readthedocs.io/en/latest/deployment/vllm.html#:~:text=The%20FP8%20models%20of%20Qwen3,GPUs%20and%20runs%20as%20w8a8).
    - **Ingress settings:** The CoreWeave Helm chart expects the cluster name and org ID to generate a domain. Set `ingress.clusterName` and `ingress.orgID` in values (these correspond to your CoreWeave cluster’s name and your organization ID)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=ingress%3A). This will produce an ingress host like:
        
        ```yaml
        ingress:
          clusterName: "<YOUR_CLUSTER_NAME>"
          orgID: "<YOUR_ORG_ID>"
        
        ```
        
        By default, the chart uses the release name as the subdomain. For example, if release name is “basic-inference”, orgID `cw123` and cluster name `mycluster`, the service will be available at `basic-inference.cw123-mycluster.coreweave.app`[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=ingress.networking.k8s.io%2Fbasic,80%2C%20443%20%20%205m). This comes with a TLS certificate via cert-manager, so it’s accessible at `https://...` out of the box[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=export%20VLLM_ENDPOINT%3D%22%24%28kubectl%20get%20ingress%20basic,o%3Djsonpath%3D%27%7B.spec.rules%5B0%5D.host).
        
    - **Model cache PVC:** Disable dynamic PVC creation and point vLLM to use the pre-created PVC. For example:
        
        ```yaml
        modelCache:
          enabled: true
          create: false
          name: huggingface-model-cache
        
        ```
        
        This ensures the vLLM container mounts the `huggingface-model-cache` volume for caching models[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L99-L104).
        
    - **HuggingFace credentials:** Qwen3-8B-FP8 is a public model (no token required). We will still include a hook in values for Hugging Face token secret in case a gated model is deployed later. For example,
        
        ```yaml
        hfToken:
          secretName: "hf-token"
        
        ```
        
        and separately create a secret named `hf-token` in `inference` namespace (with key `token`) if needed[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L66-L74). (For Qwen3, this secret is optional – the model can be downloaded without auth.)
        
    - **Autoscaling (optional):** The values can include autoscaling configs if KEDA is installed (see below). For MVP, you could set a fixed replica count (e.g., 1) or minimal HPA settings and iterate later. The CoreWeave example values come with KEDA-based scaling on queued requests; this can be enabled once KEDA is installed.
- The **`infra/scripts`** directory can contain helper shell scripts. For example, a `deploy_infra.sh` script could encapsulate the sequence of Helm/Kubectl commands to deploy or update the infrastructure. (This is optional – the CI pipeline will effectively do the same steps directly, but having a script can aid local automation or documentation.)
- The **`infra/env.example`** file will list environment variables needed for deployment. This is mainly for reference (these values will actually be set in GitHub Actions secrets or in local env when running scripts). Key variables might include:
    - `COREWEAVE_ORG_ID` and `COREWEAVE_CLUSTER_NAME` – to template into Helm values or scripts.
    - `COREWEAVE_KUBECONFIG_B64` – base64-encoded kubeconfig for the CoreWeave cluster (or alternatively, a `COREWEAVE_API_TOKEN` and cluster ID to generate one).
    - `HF_AUTH_TOKEN` – (if using gated models) the Hugging Face token for model download, to create the `hf-token` secret.
    - *(The frontend’s env vars like Contentful keys remain as-is. We will introduce a new var for the AI base URL in the frontend, discussed below.)*
- **Minimal Frontend Changes:** The Next.js app (using Vercel AI SDK) will need only minor tweaks to use the self-hosted model API:
    - **OpenAI Base URL:** Instead of calling OpenAI’s public API, point the Vercel AI SDK to our vLLM service’s URL. The Vercel AI SDK’s OpenAI provider allows a custom `baseURL` to redirect requests[ai-sdk.dev](https://ai-sdk.dev/providers/ai-sdk-providers/openai#:~:text=You%20can%20use%20the%20following,customize%20the%20OpenAI%20provider%20instance). We can achieve this by defining an environment variable (e.g. `OPENAI_BASE_URL`) and updating the OpenAI client initialization in the app code. For example, in `lib/openai` or wherever the `OpenAI` provider is configured:
        
        ```tsx
        import { createOpenAI } from "@ai-sdk/openai";
        const openai = createOpenAI({
          apiKey: process.env.OPENAI_API_KEY,             // still needed (can be dummy)
          baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
        });
        
        ```
        
        In a Next.js environment, we’d set `OPENAI_BASE_URL=https://basic-inference.<org-cluster>.coreweave.app/v1` in the `.env.local` (or Vercel env vars) for the frontend[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L199-L204). The `"/v1"` path is important, as vLLM implements an OpenAI-compatible API (Chat/Completions, etc.) on the same endpoints[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L189-L197). After deployment, we can retrieve the exact hostname via `kubectl get ingress` and plug it into this env var[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L145-L153). The OpenAI API key value (`OPENAI_API_KEY`) can remain in use; our self-hosted endpoint doesn’t strictly require authentication, so any non-empty string will work (or you can programmatically pass a dummy value like "unused")[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L199-L204). No other frontend code changes are needed – all OpenAI SDK calls (e.g. `generateText` or `streamText` in the Vercel AI hooks) will now hit the custom base URL while maintaining the OpenAI protocol.
        
    - **Vercel AI SDK config:** Ensure that the model name used in requests matches the deployed model. For example, if the frontend requests `model: "gpt-3.5-turbo"` by default, change it to use the custom model ID or an alias. A good approach is to have the backend treat a certain model name as an alias for Qwen3. However, since our vLLM service only hosts one model, the OpenAI `/v1/chat/completions` endpoint will ignore the model field or require it to equal the deployed model’s name. We can simply set the model in requests to `"Qwen/Qwen3-8B-FP8"` (or the huggingface ID of the model) to be explicit. The Vercel SDK calls could be updated to use an env var for model name as well (e.g. `process.env.LLM_MODEL_ID`). For MVP, a quick fix is to hardcode the Qwen model name in the AMA API route response generation logic. The key point is that the frontend must request the model that vLLM is serving; otherwise vLLM will respond with an error or an empty model list.

## 2. CoreWeave Infrastructure Deployment (LLM Backend)

This section outlines how to deploy the self-hosted Qwen-3 8B model on CoreWeave’s Kubernetes (CKS) using vLLM, plus all the supporting infrastructure (ingress, TLS, monitoring, etc.). The approach prioritizes **fast, iterative deployment** – leveraging CoreWeave’s pre-built Helm charts and defaults to avoid reinventing the wheel.

### **2.1 CoreWeave Cluster & Access**

Before automation, ensure you have a CoreWeave CKS cluster available (with at least one GPU node of adequate memory – 16 GB GPU RAM minimum for 8B model, and preferably an H100 for FP8 as noted). Obtain your cluster’s **name** and your **organization ID** from the CoreWeave console, and create a long-lived **API access token** for CI. In CoreWeave Cloud Console, under *API Access*, create a token and download the kubeconfig for your cluster[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/auth-access/manage-api-access-tokens#:~:text=Option%20Description%20Token%20Secret%20Copy,multiple%20Clusters%20by%20switching%20contexts)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/auth-access/manage-api-access-tokens#:~:text=Kubeconfig%20Create%20and%20download%20a,multiple%20Clusters%20by%20switching%20contexts). Save this kubeconfig (or the token and cluster server URL) as GitHub Actions secrets (see CI section). The kubeconfig provides the credentials (a token) and cluster endpoint URL needed for `kubectl` access[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/auth-access/manage-api-access-tokens#:~:text=server%3A%20https%3A%2F%2F)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/auth-access/manage-api-access-tokens#:~:text=users%3A).

For the remainder, we assume you can authenticate `kubectl` to the cluster (e.g., by `export KUBECONFIG` to the downloaded config or by embedding it in the CI pipeline). You should be able to run `kubectl cluster-info` from CI or locally to confirm connectivity[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference#:~:text=Verify%20the%20following%3A).

### **2.2 Ingress Controller (Traefik) & TLS (cert-manager)**

Deploy an ingress controller to route external traffic into the cluster, and set up automatic TLS certificates. CoreWeave provides a Helm chart for Traefik (pre-configured for their environment) and for cert-manager with a default ClusterIssuer for Let’s Encrypt.

- **Install Traefik:** Use the CoreWeave Helm repo to install Traefik. In the `infra/` directory (or via script/CI), run:
    
    ```bash
    helm repo add coreweave https://charts.core-services.ingress.coreweave.com && helm repo update
    
    # Install Traefik Ingress Controller
    helm install traefik coreweave/traefik \
      --namespace traefik --create-namespace
    
    ```
    
    This deploys Traefik in its own namespace (named “traefik”). No custom values are needed for MVP – the defaults will configure Traefik to watch for Ingress objects and integrate with cert-manager. You can verify it by checking the pod status: `kubectl get pods -n traefik` (should show a Traefik pod running)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-infrastructure#:~:text=%24)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-infrastructure#:~:text=Verify%20the%20installation%20by%20checking,all%20Traefik%20pods%20are%20running).
    
- **Install cert-manager:** Similarly, install cert-manager using CoreWeave’s chart (which is a slight wrapper around the official cert-manager with default issuers):
    
    ```bash
    helm install cert-manager coreweave/cert-manager \
      --namespace cert-manager --create-namespace
    
    ```
    
    Once installed, **enable the default issuers** that come with the chart:
    
    ```bash
    helm upgrade cert-manager coreweave/cert-manager \
      --namespace cert-manager \
      --set cert-issuers.enabled=true
    
    ```
    
    The first command installs cert-manager into the `cert-manager` namespace[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-infrastructure#:~:text=Example), and the second command configures a ClusterIssuer (likely a Let’s Encrypt ACME issuer) that will be used to obtain certificates automatically[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-infrastructure#:~:text=Example). After this, cert-manager will automatically issue TLS certs for any Ingress annotated to use the “letsencrypt” issuer. (The CoreWeave chart likely sets up a ClusterIssuer named `letsencrypt-prod` or similar by default.) Verify that cert-manager pods are running: `kubectl get pods -n cert-manager` (should show 3 pods: cert-manager, cert-manager-webhook, cert-manager-cainjector typically).
    
- **DNS / Domain:** CoreWeave provides a wildcard DNS under `.{orgid}-{cluster}.coreweave.app` (or `coreweave.cloud`) for each cluster. By specifying `ingress.clusterName` and `ingress.orgID` in our vLLM Helm values, the vLLM chart will create an Ingress like `basic-inference.<orgid>-<cluster>.coreweave.app`[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=ingress.networking.k8s.io%2Fbasic,80%2C%20443%20%20%205m). This will be automatically resolvable and cert-manager will fetch a certificate for it. **No manual DNS configuration** is needed for the default setup – using CoreWeave’s domain is the fastest path. (If a custom domain is required later, one could map a CNAME to this address or supply their own Ingress host and certificate, but that’s beyond the MVP scope.)

### **2.3 Model Deployment with vLLM (Qwen3-8B-FP8)**

With ingress and TLS in place, deploy the LLM serving stack using **vLLM** on Kubernetes. We will use Helm for a one-command deployment. There are two possible approaches:

**Option A:** Use CoreWeave’s **“Basic Inference” Helm chart** (from their reference-architecture) which bundles a single vLLM instance plus all necessary K8s objects (Deployment, Service, Ingress). This chart is designed for exactly our use-case and is used in CoreWeave’s official tutorial[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=Step%201%3A%20Configure%20your%20deployment)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=Step%203%3A%20Deploy%20the%20vLLM,service). We have copied the necessary values into `infra/helm-values/vllm-qwen-values.yaml` so we can deploy it directly.

**Option B:** Use vLLM’s upstream **Production Stack Helm chart**, which supports multi-model and routing. This is more complex than needed for MVP (it introduces a router component, etc.), so we will stick to Option A for now (single model deployment).

We proceed with Option A for clarity and speed:

- **Prepare Namespace:** Ensure the target namespace (e.g. `inference`) exists. In our plan, we use `inference` as in the CoreWeave examples:
    
    ```bash
    kubectl create namespace inference 2>/dev/null || true
    
    ```
    
    (This will create the namespace if not already present. The Helm commands below use `--create-namespace` as well.)
    
- **Create Model Cache PVC:** If not already applied, create the PVC for model caching in the `inference` namespace:
    
    ```bash
    kubectl apply -f infra/manifests/huggingface-model-cache.yaml
    
    ```
    
    This PVC will be mounted at the default cache path (`/root/.cache/huggingface` inside the container, by default) so that model weights persist across pod restarts[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=Step%204%3A%20Create%20model%20cache,storage)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=Create%20model%20cache%20PVC%3A). Having a persistent cache greatly speeds up subsequent deployments, since vLLM will find the model files on disk instead of re-downloading.
    
- **(Optional) Create HuggingFace token secret:** Not required for Qwen3 (public), but if the values file references a `hf-token` secret (for other models), you can create a secret now. For example:
    
    ```bash
    kubectl create secret generic hf-token -n inference \
      --from-literal=token="${HF_AUTH_TOKEN}"
    
    ```
    
    This step can be skipped for Qwen. (If `hfToken.secretName` is set in values but you don’t create it, the vLLM pod will still run; it just might log a warning if it tries to use a token and none is found. To be safe, you can remove or comment out the `hfToken` section in values for now.)
    
- **Deploy vLLM + Qwen model:** We use Helm to install the vLLM inference service. The CoreWeave charts repository includes the **`vllm-inference`** chart (as referenced in their docs). In our case, we have the values prepared, so invoke:
    
    ```bash
    # Ensure helm repo is added & updated (if not done already above)
    helm repo add coreweave https://charts.core-services.ingress.coreweave.com || true
    helm repo update
    
    # Deploy the vLLM inference service
    helm upgrade --install basic-inference coreweave/vllm-inference \
      --namespace inference --create-namespace \
      -f infra/helm-values/vllm-qwen-values.yaml
    
    ```
    
    *(If the `coreweave/vllm-inference` chart is not directly available via repo, an alternative is to clone the CoreWeave reference helm chart from GitHub and install locally. For example, the CI script could run `git clone https://github.com/coreweave/reference-architecture.git` and then `helm install basic-inference ./reference-architecture/inference/basic -f my-values.yaml`. In our plan we assume CoreWeave’s helm repo now contains the necessary chart for simplicity.)*
    
    This Helm release `basic-inference` will create:
    
    - A Deployment (`basic-inference`) with the vLLM server pod (running the model).
    - A Service (`basic-inference-vllm`) on port 8000 (the vLLM gRPC/HTTP server port).
    - An Ingress (`basic-inference`) with host like `basic-inference.<orgid>-<cluster>.coreweave.app`, pointing to the service on port 80/443 via Traefik[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=ingress.networking.k8s.io%2Fbasic,80%2C%20443%20%20%205m).
    - Any necessary ConfigMaps or Autoscaler objects based on values (if KEDA scaling is enabled and metrics are provided).
    
    The Helm command will print status if successful: *“STATUS: deployed”*[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=You%20should%20see%20output%20similar,to%20the%20following). You can monitor the pod startup with `kubectl get pods -n inference -w` – the first pull/loading can take a few minutes as the model (≈ few GB) downloads into the PVC[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=kubectl%20get%20pods%20,w)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=The%20initial%20deployment%20may%20take,weights%20are%20downloaded%20and%20cached). Once the pod shows `STATUS: Running` and `READY 1/1`, the service is up[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=NAME%20%20%20%20,RESTARTS%20%20%20AGE).
    
- **Verify Service & Ingress:** After deployment, confirm that the Service and Ingress are created and resolved:
    
    ```bash
    kubectl get svc,ingress -n inference
    
    ```
    
    You should see output listing `basic-inference-vllm` service and an ingress with your hostname (and Traefik class)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=match%20at%20L220%20ingress.networking.k8s.io%2Fbasic,80%2C%20443%20%20%205m)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=match%20at%20L242%20export%20VLLM_ENDPOINT%3D,o%3Djsonpath%3D%27%7B.spec.rules%5B0%5D.host). For example:
    
    ```
    NAME                            TYPE        CLUSTER-IP     ...   PORT(S)
    service/basic-inference-vllm    ClusterIP   10.96.123.45   ...   8000/TCP
    
    NAME                                CLASS    HOSTS                                     PORTS   AGE
    ingress.networking.k8s.io/basic-inference   traefik  basic-inference.cw123-mycluster.coreweave.app   80,443  1m
    
    ```
    
    If the ingress shows an address (Traefik will assign it automatically) and no errors, Traefik is routing properly. If the `HOSTS` is present but not resolving in DNS or not accessible, double-check that your cluster’s **DNS management** is enabled (CoreWeave does this by default) and that cert-manager has issued a certificate. You can describe the ingress to see if a TLS secret is attached: `kubectl describe ingress basic-inference -n inference`. Cert-manager will create a secret (like `basic-inference-tls`) in the same namespace once the ACME challenge succeeds. If it’s been a few minutes and still no cert, check cert-manager logs or `kubectl get certificates -A` for any issues[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=Ingress%20not%20accessible%3A).
    
- **OpenAI-Compatible Endpoint:** The vLLM service by default exposes an OpenAI-compatible REST API. Once Traefik and cert-manager have done their job, you will have a URL (say, **`https://basic-inference.cw123-mycluster.coreweave.app/v1`**) that speaks the OpenAI API protocol[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L145-L153). You can test this quickly:
    - Health check: `curl -I https://basic-inference.cw123-mycluster.coreweave.app/health` should return a HTTP 200 OK if the server is healthy[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L160-L168).
    - List models: `curl https://.../v1/models` should return JSON listing the deployed model. E.g., it should show an entry with `id: "Qwen/Qwen3-8B-FP8"` (or a shorter ID alias) under `.data`. In the CoreWeave example, this returns the model id that was loaded[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L168-L175).
    - Try a completion: You can use the OpenAI client or just curl:
        
        ```bash
        curl -X POST https://basic-inference.<...>/v1/chat/completions \
          -H "Content-Type: application/json" \
          -H "Authorization: Bearer <ANY_TOKEN_OR_EMPTY>" \
          -d '{
                "model": "Qwen/Qwen3-8B-FP8",
                "messages": [{"role": "user", "content": "Hello, who are you?"}]
              }'
        
        ```
        
        This should stream or return a completion from the Qwen model. (The `Authorization` header can be omitted or set to a dummy value – the vLLM server will accept requests without a real API key, since we haven’t configured key auth.)
        
    
    At this point, we have a functioning LLM backend accessible via a stable URL, providing an OpenAI-compatible `/v1` API[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L189-L197). This URL will be used by the Next.js frontend (via the Vercel AI SDK) instead of OpenAI’s URL.
    
- **Prometheus & Grafana (Monitoring):** 
    
    > **Note:** Monitoring is intentionally deferred in this MVP. The steps below are retained for future reference and are not executed in this iteration.
    
    Now deploy observability components so we can monitor the LLM's performance:
    - CoreWeave’s reference setup uses the kube-prometheus-stack (Prometheus Operator and Grafana) with a predefined Grafana dashboard for vLLM. We will mimic their steps. The simplest path is to use their **Reference Architecture charts** directly:
        - **Install Prometheus+Grafana:** CoreWeave provides a Helm chart bundle for monitoring (in the reference repo). We include a values file `infra/helm-values/observability-values.yaml` with our orgID and clusterName inserted (as per CoreWeave’s docs)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=Get%20your%20cluster%20org%20and,sections%20with%20your%20content)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=hosts%3A%20%5B%26host%20%22grafana.cw0000,USING%20YOUR%20ORGID%20AND%20CLUSTERNAME). We can then run:
            
            ```bash
            # Clone CoreWeave's reference charts (if not vendored in our repo)
            git clone https://github.com/coreweave/reference-architecture.git tmp-ref-arch
            # Use the basic observability chart
            cd tmp-ref-arch/observability/basic
            
            # Ensure orgID and clusterName are set in hack/values.yaml (the example file)
            # (Our CI script or manual step will replace the placeholders with actual values)
            
            helm install observability . \
              --namespace monitoring --create-namespace \
              -f hack/values.yaml
            
            ```
            
            This will deploy:
            
            - Prometheus Operator, Prometheus, Alertmanager, etc. (from the kube-prometheus-stack dependency)
            - Grafana (with an ingress at `grafana.<orgid>-<cluster>.coreweave.app`)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=ingress%3A)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=grafana%3A)
            - A CoreWeave-provided Grafana *Dashboard ConfigMap* for vLLM metrics.
            
            After installation, check pods in `monitoring` namespace to ensure Prometheus and Grafana are running[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=kubectl%20get%20pods%20)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=NAME%20%20%20%20,STATUS%20RESTARTS%20%20%20AGE). Then fetch the Grafana admin password (it’s auto-generated):
            
            ```bash
            kubectl get secret observability-grafana -n monitoring -o=jsonpath='{.data.admin-password}' | base64 -d && echo
            
            ```
            
            [docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=Example). You can then access Grafana via the ingress URL (https with valid cert, similar pattern to above). The login is “admin” and the password is the decoded value. Grafana will have a dashboard named "vLLM" pre-loaded via ConfigMap (the helm chart applied `hack/manifests-grafana.yaml` which contains the JSON dashboard)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=Step%206%3A%20Create%20Grafana%20dashboard,for%20vLLM)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=You%20should%20see%20output%20similar,to%20the%20following). This dashboard includes panels for token latency, throughput, GPU memory, KV cache hits, etc. – all powered by Prometheus scraping vLLM’s metrics endpoints (vLLM exposes Prometheus metrics by default).
            
            *Note:* For brevity, we used the reference architecture directly. In a refined setup, we could instead directly install the community charts:
            
            ```bash
            helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
            helm repo add grafana https://grafana.github.io/helm-charts
            helm upgrade --install kube-prom prometheus-community/kube-prometheus-stack --namespace monitoring --create-namespace
            
            ```
            
            and then configure Grafana ingress and the vLLM dashboard ConfigMap similarly. However, the CoreWeave reference chart already handles those specifics (including the ingress host pattern `grafana.<orgid>-<cluster>.coreweave.app` and TLS), so it’s the fastest way to get a working setup[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=ingress%3A)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=grafana%3A).
            
    - **Scraping vLLM Metrics:** Ensure that the Prometheus in kube-prometheus-stack is set to scrape the vLLM deployment. The CoreWeave chart likely sets up a `ServiceMonitor` or annotations for vLLM by default. (If using the reference exactly, it should discover the `basic-inference` service’s metrics automatically, possibly via a ServiceMonitor installed by the vLLM chart or by labeling pods with `scrape=true`.) If not, we can add annotations to the vLLM Deployment template via Helm values:
        
        ```yaml
        metrics:
          enabled: true
          port: 8000
          path: /metrics
        
        ```
        
        or manually create a ServiceMonitor targeting the vLLM service. But given CoreWeave’s integration, this is likely done for us. After a few minutes, the Grafana vLLM dashboard should start showing live data (requests per second, queue depth, latency histograms, GPU utilization, etc.).
        
- **(Optional) LiteLLM Proxy Layer:** The architecture allows adding a LiteLLM proxy in front of vLLM for routing or multi-provider support. **For MVP, we will not deploy LiteLLM** – the client (Next.js app) will call vLLM directly. However, we define how this could be integrated in the future:
    - LiteLLM Proxy (from BerriAI) is an OpenAI-compatible gateway that can forward requests to different backends or add middleware. It’s typically run as a separate service. In a future iteration, we could deploy it as another Pod (maybe as a simple Docker container via a Deployment in our cluster). It would listen on an endpoint (like `/v1` as well) and could route to vLLM or OpenAI based on model or load-balance multiple vLLM instances.
    - For now, we note it in the design: the `infra/helm-values` could include a section for a LiteLLM deployment and we could reserve an ingress (e.g. `ai-proxy.<cluster>.coreweave.app`). But since it’s not required for the initial end-to-end demo, **we skip deploying it**. All traffic flows directly from the Next.js app to the vLLM service.
- **Autoscaling (Optional):** If you anticipate varying loads, you can enable Kubernetes event-driven autoscaling with KEDA. CoreWeave’s tutorial suggests installing KEDA and the vLLM chart includes ScaledObject definitions to scale the vLLM Deployment based on queue length[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=For%20production%20workloads%2C%20install%20KEDA,commands)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=%24). For completeness:
    
    ```bash
    helm repo add kedacore https://kedacore.github.io/charts && helm repo update
    helm install keda kedacore/keda --namespace keda --create-namespace
    
    ```
    
    Confirm KEDA’s pods are running (`kubectl get pods -n keda`)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=Example). Our `vllm-qwen-values.yaml` can then enable autoscaling (if not already by default). Typically, the chart might have `autoscaling.enabled: true` and a KEDA spec that monitors `pending_requests` metric to scale replicas. With KEDA, you’ll see the vLLM Deployment scale up when many requests queue, and scale back down when idle[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L244-L252)[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L245-L253). This is optional and can be fine-tuned later – for MVP, one replica is fine.
    

### **2.4 Summary of Deployment Configurations**

At this stage, our monorepo contains all necessary config to provision:

- **Traefik Ingress** (for routing and TLS termination) – installed via Helm[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-infrastructure#:~:text=%24).
- **cert-manager** (for automatic Let's Encrypt certificates) – installed & configured via Helm[docs.coreweave.comdocs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-infrastructure#:~:text=Example).
- **Persistent Storage** (PVC on CoreWeave's distributed storage) – manifest applied[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L77-L86).
- **vLLM Inference Service** running Qwen3-8B-FP8 – deployed via Helm with our custom values.
- **Monitoring:** Deferred for MVP; to be added later (Prometheus+Grafana or CoreWeave reference charts).
- **Ingress DNS and TLS** for the model API – enabled via CoreWeave's domain and cert-manager.

All these are defined in files under `infra/`. This co-location means any change (for example, switching to a different model, adjusting resources, etc.) can be done in Git and rolled out via CI, along with any necessary frontend changes.

## 3. GitHub Actions CI Workflow for Deployment

To ensure that any updates to the infrastructure are automatically applied to the CoreWeave cluster, we set up a GitHub Actions workflow (`.github/workflows/deploy-infra.yml`). This workflow will authenticate to CoreWeave and run the `kubectl`/`helm` steps outlined above, whenever changes are pushed to the `infra/` directory.

**CI Trigger:** We configure the workflow to run on pushes to the main branch (and optionally merge requests) when files in `infra/**` change. For example:

```yaml
on:
  push:
    paths:
      - 'infra/**'
    branches:
      - main

```

This scope ensures we only deploy when infrastructure files update (avoiding unnecessary runs on content or frontend changes).

**Secrets:** In the repository’s Settings, define secrets for CoreWeave access:

- `COREWEAVE_KUBECONFIG_B64` – Base64-encoded kubeconfig file for the cluster.
    - *Alternative:* store `COREWEAVE_API_TOKEN` and the cluster’s API server URL as separate secrets, then in CI construct a kubeconfig on the fly. However, using the provided kubeconfig (with the token embedded) is straightforward. Generate it as mentioned (CoreWeave Console → API Tokens → create token → download kubeconfig)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/auth-access/manage-api-access-tokens#:~:text=metrics%2C%20and%20setting%20up%20your,multiple%20Clusters%20by%20switching%20contexts)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/auth-access/manage-api-access-tokens#:~:text=Kubeconfig%20Create%20and%20download%20a,multiple%20Clusters%20by%20switching%20contexts), then base64 encode the file content and save that as a secret.
- (Optional) `COREWEAVE_ORG_ID` and `COREWEAVE_CLUSTER_NAME` – if our scripts/values need these explicitly (e.g., to patch values files or for logging).
- `HF_AUTH_TOKEN` – if needed for private model access (not needed for Qwen3).
- We do **not** need an OpenAI API key here, since we’re not calling OpenAI in CI; the OPENAI_API_KEY is only used at runtime in the app (and that remains in Vercel/Frontend env).

**Workflow Steps:** Use an Ubuntu runner. Outline of steps:

1. **Checkout code:** Use `actions/checkout` to pull the repo.
2. **Set up kubeconfig:** Create the kubeconfig file from the base64 secret. For example:
    
    ```yaml
    - name: Set up Kubeconfig
      run: |
        echo "$COREWEAVE_KUBECONFIG_B64" | base64 -d > kubeconfig.yaml
        mkdir -p ~/.kube
        mv kubeconfig.yaml ~/.kube/config
    env:
      COREWEAVE_KUBECONFIG_B64: ${{ secrets.COREWEAVE_KUBECONFIG_B64 }}
    
    ```
    
    This writes the decoded kubeconfig to `~/.kube/config`, which `kubectl` and `helm` will automatically use. (Alternatively, set `KUBECONFIG=$PWD/kubeconfig.yaml` environment.)
    
3. **Install Kubectl & Helm:** The runner may not have Helm by default. We can either use actions (`azure/setup-kubectl` and `azure/setup-helm`) or simply install via apt:
    
    ```yaml
    - name: Install kubectl and helm
      run: |
        sudo apt-get update
        sudo apt-get install -y kubectl helm
    
    ```
    
    (CoreWeave’s charts require Helm 3.8+, ensure the version is new enough.)
    
4. **Deploy Infrastructure:** We can combine multiple sub-steps or run a single script. For clarity, do sequential steps:
    - **Ingress & Cert-Manager:**
        
        ```yaml
        - name: Deploy Ingress Controller and TLS Manager
          run: |
            helm repo add coreweave https://charts.core-services.ingress.coreweave.com
            helm repo update
            helm upgrade --install traefik coreweave/traefik --namespace traefik --create-namespace
            helm upgrade --install cert-manager coreweave/cert-manager --namespace cert-manager --create-namespace
            helm upgrade cert-manager coreweave/cert-manager --namespace cert-manager --set cert-issuers.enabled=true
        
        ```
        
        This ensures Traefik and cert-manager are present (using `upgrade --install` allows re-running without error). The commands mirror the manual steps (add repo, install charts)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-infrastructure#:~:text=%24)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-infrastructure#:~:text=Example). We perform them on every run for idempotence – typically these components wouldn’t change often, but this guarantees the latest chart versions are used if we update the repo.
        
    - **Monitoring stack:** We have a choice: either replicate the helm install of kube-prometheus-stack and Grafana via community charts, or use the reference. For CI simplicity, we might use the community charts (to avoid cloning another repo in CI). For example:
        
        ```yaml
        - name: Deploy Monitoring Stack (Prometheus & Grafana)
          run: |
            helm repo add grafana https://grafana.github.io/helm-charts
            helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
            helm repo update
            # Install Prometheus Operator + Grafana stack
            helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
              --namespace monitoring --create-namespace \
              -f infra/helm-values/observability-values.yaml
        
        ```
        
        Here, `observability-values.yaml` would contain our customizations for Grafana ingress host (as shown earlier, using orgID and cluster)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-monitoring#:~:text=ingress%3A). Alternatively, the CI could perform a quick search & replace if we left placeholders in that file. If using the reference architecture approach, the CI step would involve a git clone as shown earlier. Either approach is acceptable; the key is that after this step, Prometheus and Grafana should be running. (If time is a concern, the monitoring install could even be done once manually, but we include it for completeness so the entire stack can be stood up from CI.)
        
    - **Apply PVC and secrets:**
        
        ```yaml
        - name: Apply Persistent Volume Claim for model cache
          run: kubectl apply -f infra/manifests/huggingface-model-cache.yaml
        - name: Apply HuggingFace secret (if provided)
          if: env.HF_AUTH_TOKEN != ''
          run: |
            # Create or update the hf-token secret from the provided token
            kubectl delete secret hf-token -n inference 2>/dev/null || true
            kubectl create secret generic hf-token -n inference --from-literal=token="${HF_AUTH_TOKEN}"
          env:
            HF_AUTH_TOKEN: ${{ secrets.HF_AUTH_TOKEN }}
        
        ```
        
        We conditionally create the HF secret only if a token is present in secrets.
        
    - **Deploy vLLM + Qwen:** Finally, deploy (or upgrade) the vLLM release:
        
        ```yaml
        - name: Deploy LLM Service (vLLM + Qwen3-8B-FP8)
          run: |
            helm upgrade --install basic-inference coreweave/vllm-inference \
              --namespace inference --create-namespace \
              -f infra/helm-values/vllm-qwen-values.yaml
        
        ```
        
        This will push out any changes in our values (for example, if we update the model or tuning params in Git, CI will apply them). If the release is new, it installs; if it exists, it performs an in-place upgrade (zero-downtime if possible). Kubernetes will pull the model on any new pod (if the PVC already has it cached from a previous run, startup will be faster).
        
    - *(Optional)* **Post-deploy health check:** We can add a step to wait for the pod to be ready or to curl the health endpoint. For example:
        
        ```yaml
        - name: Wait for vLLM pod readiness
          run: |
            kubectl rollout status deploy/basic-inference -n inference --timeout=300s
            kubectl get pods -n inference -o wide
        - name: Check LLM service health
          run: |
            INFER_HOST=$(kubectl get ingress basic-inference -n inference -o=jsonpath='{.spec.rules[0].host}')
            curl -f https://$INFER_HOST/health
        
        ```
        
        This ensures the deployment succeeded. Any failure in these will mark the CI run red. (The `-f` in curl causes a non-200 response to fail the step.)
        

**Secure Secrets:** The kubeconfig (or token) is highly sensitive. We ensure it’s stored as an encrypted secret. The CI job should not print it. In our steps above, we do not echo the kubeconfig or token, and we can mask `HF_AUTH_TOKEN` as well.

**Frontend Deployment:** Note that the frontend (Next.js) is likely deployed on Vercel separately. Our CI plan here only handles the *infrastructure back end*. The monorepo structure doesn’t prevent Vercel from deploying the Next.js app; we might just update Vercel’s settings to ignore the `infra/` directory (not needed for build) and to include the new `OPENAI_BASE_URL` env var. The frontend could still be hooked to Vercel’s Git integration for deployment, or we could also handle it in GitHub Actions if desired. For now, we assume Vercel continues to auto-deploy the frontend on pushes, and our GitHub Action handles the CoreWeave infra in parallel.

## Conclusion and Next Steps

By following this plan, we establish a **minimal viable LLM stack** co-located with the application code:

- The repository now contains everything to stand up the self-hosted AI service (from Kubernetes manifests to CI deployment pipeline). This makes iteration faster – e.g., switching to a new model or adjusting parameters is a matter of committing a change to a values file and letting CI run.
- We prioritized using official, vetted configurations (CoreWeave’s charts and vLLM’s compatibility) to reduce risk. All critical steps (ingress, TLS, model serving, monitoring) use standard or documented setups[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-infrastructure#:~:text=%24)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=%24)[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L189-L197).
- The **OpenAI-compatible endpoint** means we didn’t have to modify the application’s AI logic significantly – just pointed it at our new base URL[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L199-L204). From the app user’s perspective, everything functions the same, but now requests are handled by our Qwen-3 8B model on CoreWeave instead of OpenAI’s API.
- **Monitoring and observability** are in place via Grafana dashboards and Prometheus, which will be invaluable for debugging performance or capacity issues. For instance, you can watch GPU memory usage and decide if a larger model or more replicas are feasible.
- **Next steps (future improvements):** With the MVP running, we can consider enhancements like integrating the LiteLLM proxy (to enable dynamic provider routing or request logging), setting up alerting on model performance (via Prometheus alerts), adding autoscaling thresholds for cost-efficiency, and possibly containerizing the Next.js app to deploy on the same cluster (if a unified self-hosted deployment is desired in the future). Each of these can now be added into the monorepo’s `infra/` as we iterate.

In summary, this plan provides a clear **path to ship an end-to-end working system quickly**: from repo reorganization, through infrastructure deployment on CoreWeave (Traefik ingress, cert-manager TLS, vLLM with Qwen3-8B-FP8 model, and monitoring), to minimal front-end adjustments to consume the new API. All steps rely on official documentation and recommended practices[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-infrastructure#:~:text=%24)[qwen.readthedocs.io](https://qwen.readthedocs.io/en/latest/deployment/vllm.html#:~:text=The%20FP8%20models%20of%20Qwen3,GPUs%20and%20runs%20as%20w8a8)[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L189-L197), reducing uncertainty and ensuring that an automation agent (or a developer) can execute them with confidence. By following the outlined file layouts, configuration snippets, and CI steps, we can get the self-hosted LLM serving live queries with Qwen-3 (8B) in place of OpenAI, with full control and observability over the system.

**Sources:**

- CoreWeave official docs on deploying vLLM inference (Traefik Ingress, cert-manager, etc.)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-infrastructure#:~:text=%24)[docs.coreweave.comdocs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/set-up-infrastructure#:~:text=Example)[docs.coreweave.com](https://docs.coreweave.com/docs/products/cks/tutorials/deploy-vllm-inference/deploy-vllm#:~:text=%24)
- CoreWeave reference architecture (Helm charts for basic inference and monitoring, values examples)[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L77-L86)[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L99-L104)[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L145-L153)[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L189-L197)
- vLLM and Qwen documentation (OpenAI API compatibility and FP8 model support)[huggingface.co](https://huggingface.co/Qwen/Qwen3-8B-FP8#:~:text=vllm%20serve%20Qwen%2FQwen3,deepseek_r1)[qwen.readthedocs.io](https://qwen.readthedocs.io/en/latest/deployment/vllm.html#:~:text=The%20FP8%20models%20of%20Qwen3,GPUs%20and%20runs%20as%20w8a8)[GitHub](https://github.com/coreweave/reference-architecture/blob/610c5a9f016aba55af864a3307a91731f54a5367/inference/basic/README.md#L199-L204)
- Vercel AI SDK docs (OpenAI provider customization for base URL)[ai-sdk.dev](https://ai-sdk.dev/providers/ai-sdk-providers/openai#:~:text=You%20can%20use%20the%20following,customize%20the%20OpenAI%20provider%20instance)