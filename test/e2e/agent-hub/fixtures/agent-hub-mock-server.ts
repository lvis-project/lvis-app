/**
 * Local HTTP mock backend for agent-hub v3 E2E tests.
 *
 * Returns v3 board snapshots for /api/v1/me, /me/feed, /work-board.
 * Supports an optional "fail mode" that forces one region to return 500,
 * which triggers the S5PartialSync banner in the plugin UI.
 *
 * Usage:
 *   const server = await AgentHubMockServer.start();
 *   // ... run tests ...
 *   await server.stop();
 *
 *   // Force region failure:
 *   const server = await AgentHubMockServer.start({ failRegion: 'ap-northeast-2' });
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface MockServerOptions {
  /** Port to listen on. Defaults to 0 (OS assigns a random port). */
  port?: number;
  /**
   * If set, requests for this region will return HTTP 500.
   * This triggers the S5PartialSync partial-sync error banner in the plugin.
   */
  failRegion?: string;
}

export interface MockServer {
  readonly baseUrl: string;
  readonly port: number;
  stop(): Promise<void>;
}

/** Minimal v3 agent/approval row shape */
interface ApprovalRow {
  id: string;
  title: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  region: string;
}

/** Minimal v3 board row shape */
interface WorkBoardRow {
  id: string;
  title: string;
  assignee: string;
  dueDate: string;
  priority: 'high' | 'medium' | 'low';
  region: string;
}

/** Six-region snapshot used by default */
const REGIONS = [
  'us-east-1',
  'us-west-2',
  'eu-west-1',
  'eu-central-1',
  'ap-northeast-2',
  'ap-southeast-1',
];

function buildApprovalRows(failRegion?: string): ApprovalRow[] {
  return REGIONS.filter((r) => r !== failRegion).map((region, i) => ({
    id: `approval-${i + 1}`,
    title: `E2E Approval Task ${i + 1}`,
    status: 'pending',
    requestedAt: new Date(Date.now() - i * 3_600_000).toISOString(),
    region,
  }));
}

function buildWorkBoardRows(failRegion?: string): WorkBoardRow[] {
  return REGIONS.filter((r) => r !== failRegion).map((region, i) => ({
    id: `task-${i + 1}`,
    title: `E2E Work Item ${i + 1}`,
    assignee: 'e2e-user',
    dueDate: new Date(Date.now() + (i + 1) * 86_400_000).toISOString().slice(0, 10),
    priority: (['high', 'medium', 'low'] as const)[i % 3],
    region,
  }));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  failRegion?: string,
): void {
  const url = req.url ?? '/';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' });
    res.end();
    return;
  }

  // /api/v1/me — current user profile
  if (url === '/api/v1/me' || url === '/me') {
    json(res, 200, {
      id: 'e2e-user',
      name: 'E2E Test User',
      email: 'e2e@lvis-test.local',
      avatarUrl: null,
    });
    return;
  }

  // /me/feed — activity feed
  if (url === '/me/feed') {
    json(res, 200, {
      items: buildApprovalRows(failRegion).map((a) => ({
        type: 'approval_request',
        payload: a,
      })),
    });
    return;
  }

  // /work-board — board snapshot (마이워크 + 팀보드)
  if (url === '/work-board' || url.startsWith('/work-board?')) {
    const params = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
    const region = params.get('region');

    // Simulate region failure for partial-sync test
    if (failRegion && region === failRegion) {
      json(res, 500, { error: 'region_unavailable', region });
      return;
    }

    json(res, 200, {
      approvals: buildApprovalRows(failRegion),
      myWork: buildWorkBoardRows(failRegion),
      partialFailures: failRegion
        ? [{ region: failRegion, error: 'region_unavailable' }]
        : [],
      syncedAt: new Date().toISOString(),
    });
    return;
  }

  // /approvals/:id — single approval detail + confirm endpoint
  const approvalConfirmMatch = url.match(/^\/approvals\/([^/]+)\/confirm$/);
  if (approvalConfirmMatch && req.method === 'POST') {
    json(res, 200, {
      id: approvalConfirmMatch[1],
      status: 'approved',
      confirmedAt: new Date().toISOString(),
    });
    return;
  }

  // /config — plugin config round-trip (used by bridge.config tests)
  if (url === '/config') {
    if (req.method === 'GET') {
      json(res, 200, { refreshInterval: 30, boardMode: 'my-work' });
      return;
    }
    if (req.method === 'PUT' || req.method === 'PATCH') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          json(res, 200, { ok: true, saved: parsed });
        } catch {
          json(res, 400, { error: 'invalid_json' });
        }
      });
      return;
    }
  }

  // Fallback 404
  json(res, 404, { error: 'not_found', path: url });
}

export class AgentHubMockServer implements MockServer {
  private readonly server: http.Server;
  readonly baseUrl: string;
  readonly port: number;

  private constructor(server: http.Server, port: number) {
    this.server = server;
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  static async start(options: MockServerOptions = {}): Promise<AgentHubMockServer> {
    const { port = 0, failRegion } = options;

    const server = http.createServer((req, res) =>
      handleRequest(req, res, failRegion),
    );

    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('AgentHubMockServer: unexpected address type');
    }

    return new AgentHubMockServer(server, addr.port);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
