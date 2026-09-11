import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import type { ClientRequest } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface HealthOptions { ca: Buffer; serverName: string; bearerToken: string; port?: number }

/** Local readiness only: no provider calls, redirects, diagnostics or credential output. */
export function checkHealth({ ca, serverName, bearerToken, port = 8444 }: HealthOptions): Promise<boolean> {
  return new Promise((done) => {
    let req: ClientRequest | undefined; let settled = false;
    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); req?.destroy(); done(healthy);
    };
    // Absolute budget includes TLS negotiation and continuously arriving bytes.
    const timer = setTimeout(() => finish(false), 2000);
    try {
      if (!serverName || !bearerToken || bearerToken.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(bearerToken)) {
        finish(false); return;
      }
      req = request({ host: '127.0.0.1', port, servername: serverName, ca, rejectUnauthorized: true,
        method: 'GET', path: '/v1/health', agent: false, maxHeaderSize: 4096,
        headers: { Authorization: `Bearer ${bearerToken}`, Connection: 'close' } }, (res) => {
        res.on('error', () => finish(false)); res.on('aborted', () => finish(false));
        if (res.statusCode !== 200) { finish(false); return; }
        let size = 0; const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024) finish(false); else chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          try {
            const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            finish(body !== null && typeof body === 'object' && !Array.isArray(body) && 'status' in body && body.status === 'ok');
          } catch { finish(false); }
        });
      });
      req.on('error', () => finish(false)); req.end();
    } catch { finish(false); }
  });
}

async function runCli(): Promise<number> {
  try {
    const namespace = process.env.POD_NAMESPACE;
    const bearerToken = process.env.ORKA_OUTBOUND_BEARER_TOKEN;
    if (process.argv.length !== 2 || !namespace || namespace.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(namespace) || !bearerToken) return 1;
    return await checkHealth({ ca: readFileSync('/etc/adapter-ca/ca.crt'),
      serverName: `teams-adapter.${namespace}.svc`, bearerToken }) ? 0 : 1;
  } catch { return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli();
}
