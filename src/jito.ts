export class JitoBundle {
  constructor(private readonly txs: ReadonlyArray<Uint8Array>) {}

  async send(): Promise<string> {
    const priorityRpc = process.env.RPC_PRIORITY;
    if (!priorityRpc) {
      throw new Error('Missing required environment variable: RPC_PRIORITY');
    }

    const endpoint = this.normalizeBundleEndpoint(priorityRpc);
    const authKey = process.env.JITO_AUTH_KEY;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authKey ? { 'x-jito-auth': authKey } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [this.txs.map((tx) => Buffer.from(tx).toString('base64')), { encoding: 'base64' }],
      }),
    });

    const bundleIdHeader = response.headers.get('x-bundle-id') ?? undefined;
    const payload = (await response.json()) as {
      result?: string;
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Jito request failed with status ${response.status}`);
    }

    if (payload.error) {
      throw new Error(payload.error.message ?? 'Jito rejected the bundle');
    }

    const bundleId = payload.result ?? bundleIdHeader;
    if (!bundleId) {
      throw new Error('Jito response did not include a bundle id');
    }

    return bundleId;
  }

  private normalizeBundleEndpoint(endpoint: string): string {
    const trimmed = endpoint.trim().replace(/\/+$/, '');

    if (trimmed.endsWith('/api/v1/bundles')) {
      return trimmed;
    }

    return `${trimmed}/api/v1/bundles`;
  }
}
