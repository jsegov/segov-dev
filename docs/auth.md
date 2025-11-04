Awesome—here’s a tight, practical, high-level implementation plan for the **Vercel BFF + Google Workload Identity Federation (WIF)** pattern.

---

# 0) What you’re building

Browser → **Vercel API route (BFF)** → **Cloud Run (auth required)**

* The BFF exchanges a short-lived **Vercel-issued OIDC token** for **short-lived Google creds** via **WIF**, then mints a **Google **ID token** with the **Cloud Run service URL** as `aud`, and calls Cloud Run with `Authorization: Bearer <ID_TOKEN>`. ([Vercel][1])

---

# 1) Configure Cloud Run (secure target)

1. Deploy or update your service with **authentication required** (not public).
2. Note the **auto-generated Cloud Run URL** (the one ending in `run.app`). You’ll use this as the **audience** when minting ID tokens (custom domains won’t work for the `aud` check).
3. Grant `roles/run.invoker` to a **service account** you’ll bind to WIF. ([Google Cloud Documentation][2])

---

# 2) Set up Workload Identity Federation in GCP

1. **Create an Identity Pool** and **OIDC Provider** that trusts Vercel’s OIDC issuer.
2. Configure **attribute mapping & conditions** (e.g., map `assertion.sub` → `google.subject`; optionally restrict by Vercel project/branch).
3. **Create/choose a Service Account** and **allow federation**: grant the pool **Service Account Token Creator** on that SA (so subjects from this pool can exchange for short-lived creds).
4. Record: `PROJECT_NUMBER`, `POOL_ID`, `PROVIDER_ID`, `SERVICE_ACCOUNT_EMAIL`. ([Google Cloud Documentation][3])

> References with step-by-step screens/CLI: Google IAM WIF overview & “with other providers” guides. ([Google Cloud Documentation][4])

---

# 3) Prepare Vercel (BFF runtime + OIDC)

1. Use a **Vercel Serverless Function** (Node.js runtime). (Edge can work, but the Node google-auth libraries are simpler here.)
2. Enable **OIDC Federation** in Vercel for your project and grab the **OIDC token from Vercel at runtime**.
3. Add the Vercel → GCP values (`PROJECT_NUMBER`, `POOL_ID`, `PROVIDER_ID`, `SERVICE_ACCOUNT_EMAIL`, `GCP_PROJECT_ID`, `CLOUD_RUN_URL`) as **Vercel env vars**.
4. (Optional) Use Vercel’s helper lib `@vercel/oidc` to retrieve the Vercel OIDC token during the request. ([Vercel][1])

> Vercel docs: OIDC federation + GCP walkthrough (has concrete steps & env naming). ([Vercel][5])

---

# 4) Exchange → Mint ID token → Call Cloud Run (BFF code flow)

**At request time in your Vercel API route:**

1. **Get Vercel OIDC token** from the environment/headers via `@vercel/oidc` (or raw header).
2. **Exchange** it using Google’s **STS external account flow** (WIF) to obtain short-lived Google credentials bound to the **service account** you configured.
3. With those creds, **mint a Google **ID token** whose `aud` = **Cloud Run URL**.
4. **Call Cloud Run** with `Authorization: Bearer <ID_TOKEN>` (or `X-Serverless-Authorization` if preferred). Handle non-200s, retries, and timeouts. ([Google Cloud Documentation][3])

> Notes & samples: Cloud Run service-to-service auth + ID token usage; the header is checked server-side. ([Google Cloud Documentation][2])

---

# 5) IAM & least privilege

* On the **Cloud Run service**, keep `ingress` public internet but **require authentication** (or put behind LB later).
* On the **service account** you’re impersonating via WIF:

  * Grant only `roles/run.invoker` (and any other minimal roles your app truly needs).
  * Do **not** create or store JSON keys. WIF keeps it keyless. ([Google Cloud Documentation][4])

---

# 6) Local dev & testing

* To test Cloud Run auth locally:

  * Use `gcloud auth print-identity-token` with `--audiences=<CLOUD_RUN_URL>` and curl the service, or run the language sample that fetches an ID token.
  * For local BFF testing, you can **impersonate** the same service account to mimic prod behavior. ([Google Cloud][6])

---

# 7) Observability & hardening

* **Log correlation**: forward a request ID from BFF → Cloud Run.
* **Auth failures**: watch for `401/403` caused by wrong audience, missing `run.invoker`, or exchanging **access tokens** instead of **ID tokens** (easy mistake). ([Stack Overflow][7])
* **Rate limit** at the BFF to protect Cloud Run.
* **Rotate** permissions via IAM; no key rotation needed with WIF.
* **Remember**: the `aud` must be the **Cloud Run URL**, not a custom domain. ([Stack Overflow][8])

---

# 8) Rollout plan (sane defaults)

1. Turn on auth requirement on Cloud Run; verify curl with an ID token works. ([Google Cloud Documentation][2])
2. Stand up WIF pool+provider; bind to service account; grant `run.invoker`. ([Google Cloud Documentation][3])
3. Deploy minimal Vercel API route that: gets Vercel OIDC → exchanges via WIF → mints ID token (`aud`=Cloud Run URL) → fetches Cloud Run. ([Vercel][5])
4. Wire your frontend to call the **Vercel API route** (never Cloud Run directly).
5. Add caching/validation/rate limits in BFF; add alarms on 401/403/5xx.

---

## Common pitfalls checklist

* ❌ Using OAuth **access tokens** to call Cloud Run instead of **OIDC ID tokens**.
* ❌ Setting `aud` to a **custom domain** instead of the **Cloud Run URL**.
* ❌ Forgetting `roles/run.invoker` on the target Cloud Run service for the **impersonated service account**.
* ❌ Shipping long-lived **service account keys** to Vercel (don’t; use WIF). ([Google Cloud Documentation][2])

---

If you want, I can drop in a **minimal Node (Vercel API route) snippet** that performs the OIDC→WIF exchange and hits Cloud Run, along with the `gcloud` commands to create the pool/provider and bindings.

[1]: https://vercel.com/docs/oidc?utm_source=chatgpt.com "OpenID Connect (OIDC) Federation"
[2]: https://docs.cloud.google.com/run/docs/authenticating/service-to-service?utm_source=chatgpt.com "Authenticating service-to-service | Cloud Run"
[3]: https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers?utm_source=chatgpt.com "Configure Workload Identity Federation with other ..."
[4]: https://docs.cloud.google.com/iam/docs/workload-identity-federation?utm_source=chatgpt.com "Workload Identity Federation - IAM"
[5]: https://vercel.com/docs/oidc/gcp?utm_source=chatgpt.com "Connect to Google Cloud Platform (GCP)"
[6]: https://cloud.google.com/run/docs/samples/cloudrun-service-to-service-auth?utm_source=chatgpt.com "Authenticate service-to-service requests | Cloud Run"
[7]: https://stackoverflow.com/questions/77592354/invoking-google-cloud-run-service-using-workload-identity-federation?utm_source=chatgpt.com "Invoking Google Cloud Run service using Workload ..."
[8]: https://stackoverflow.com/questions/58683365/google-cloud-run-authentication-service-to-service?utm_source=chatgpt.com "Google Cloud Run Authentication Service-to-Service"
