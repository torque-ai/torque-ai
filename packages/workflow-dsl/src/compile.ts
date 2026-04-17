export interface SubmitToTorqueOptions {
  torqueBaseUrl: string;
  fetcher?: typeof fetch;
}

// Optional helper that posts a built workflow to a TORQUE endpoint.
export async function submitToTorque(spec: unknown, { torqueBaseUrl, fetcher = fetch }: SubmitToTorqueOptions) {
  const res = await fetcher(`${torqueBaseUrl.replace(/\/+$/, '')}/api/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  });

  if (!res.ok) {
    throw new Error(`submit failed: HTTP ${res.status}`);
  }

  return res.json();
}
