/**
 * GCP Workload Identity Federation helper functions for Vercel BFF.
 * 
 * This module provides functions to:
 * 1. Get Vercel OIDC token
 * 2. Exchange OIDC token for Google access token via STS
 * 3. Mint Google ID token for Cloud Run service
 * 4. Make authenticated requests to Cloud Run
 */

const STS_URL = 'https://sts.googleapis.com/v1/token'
const IAM_CREDENTIALS_URL = 'https://iamcredentials.googleapis.com/v1'

/**
 * Get the Vercel OIDC token from the runtime environment.
 * 
 * Uses @vercel/oidc if available, otherwise falls back to reading
 * from request headers (x-vercel-oidc-token) or environment variables.
 * 
 * @param opts - Optional object with headers to check for token
 */
export async function getVercelOidcToken(opts?: { headers?: Headers }): Promise<string> {
  // Try 1: @vercel/oidc package
  try {
    const { getToken } = await import('@vercel/oidc')
    const token = await getToken()
    if (token && token.trim().length > 0) {
      return token
    }
  } catch (error) {
    // Continue to fallbacks
  }

  // Try 2: Request header (how Vercel injects token in serverless functions)
  if (opts?.headers) {
    const headerToken = opts.headers.get('x-vercel-oidc-token') || 
                       opts.headers.get('X-Vercel-Oidc-Token')
    if (headerToken && headerToken.trim().length > 0) {
      return headerToken
    }
  }

  // Try 3: Environment variable (for local dev or builds)
  const envToken = process.env.VERCEL_OIDC_TOKEN
  if (envToken && envToken.trim().length > 0) {
    return envToken
  }
  
  throw new Error(
    'Could not retrieve Vercel OIDC token. Ensure OIDC is enabled in Vercel project settings.'
  )
}

export interface WifConfig {
  projectNumber: string
  poolId: string
  providerId: string
}

/**
 * Exchange Vercel OIDC token for a Google access token via STS.
 * 
 * @param vercelOidc - The Vercel-issued OIDC token
 * @param cfg - WIF configuration (project number, pool ID, provider ID)
 * @returns Google access token
 */
export async function exchangeOidcForAccessToken(
  vercelOidc: string,
  cfg: WifConfig
): Promise<string> {
  const audience = `//iam.googleapis.com/projects/${cfg.projectNumber}/locations/global/workloadIdentityPools/${cfg.poolId}/providers/${cfg.providerId}`
  
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    audience,
    scope: 'https://www.googleapis.com/auth/iam',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    subject_token: vercelOidc,
  })

  const response = await fetch(STS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `STS exchange failed: ${response.status} ${response.statusText}. ${errorText}`
    )
  }

  const json = (await response.json()) as { access_token: string }
  if (!json.access_token) {
    throw new Error('STS exchange did not return access_token')
  }

  return json.access_token
}

/**
 * Mint a Google ID token for a specific audience (Cloud Run service URL).
 * 
 * @param accessToken - Google access token from STS exchange
 * @param serviceAccountEmail - Service account email to impersonate
 * @param audience - Cloud Run service URL (must match exactly)
 * @returns Google ID token
 */
export async function mintIdToken(
  accessToken: string,
  serviceAccountEmail: string,
  audience: string
): Promise<string> {
  const url = `${IAM_CREDENTIALS_URL}/projects/-/serviceAccounts/${encodeURIComponent(serviceAccountEmail)}:generateIdToken`
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      audience,
      includeEmail: true,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `generateIdToken failed: ${response.status} ${response.statusText}. ${errorText}`
    )
  }

  const json = (await response.json()) as { token: string }
  if (!json.token) {
    throw new Error('generateIdToken did not return token')
  }

  return json.token
}

/**
 * Fetch from Cloud Run with an ID token in the Authorization header.
 * 
 * @param input - Request URL or Request object
 * @param init - Request init options with idToken property
 * @returns Response from Cloud Run
 */
export async function fetchCloudRun(
  input: RequestInfo | URL,
  init: RequestInit & { idToken: string }
): Promise<Response> {
  const { idToken, ...restInit } = init
  const headers = new Headers(restInit.headers || {})
  
  // Set Authorization header with ID token
  headers.set('Authorization', `Bearer ${idToken}`)
  
  // Ensure Content-Type is set if body is provided
  if (restInit.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  return fetch(input, {
    ...restInit,
    headers,
  })
}

/**
 * Complete flow: Get OIDC token → Exchange for access token → Mint ID token.
 * 
 * This is a convenience function that combines all steps.
 * 
 * @param cfg - WIF configuration and service account details
 * @param opts - Optional object with headers to pass for OIDC token retrieval
 * @returns Google ID token ready to use with Cloud Run
 */
export async function getCloudRunIdToken(
  cfg: {
    projectNumber: string
    poolId: string
    providerId: string
    serviceAccountEmail: string
    audience: string
  },
  opts?: { headers?: Headers }
): Promise<string> {
  const vercelOidc = await getVercelOidcToken(opts)
  const accessToken = await exchangeOidcForAccessToken(vercelOidc, {
    projectNumber: cfg.projectNumber,
    poolId: cfg.poolId,
    providerId: cfg.providerId,
  })
  const idToken = await mintIdToken(
    accessToken,
    cfg.serviceAccountEmail,
    cfg.audience
  )
  return idToken
}

