/**
 * Agent Hub Mock Server — Lane 9/app
 *
 * Local in-process HTTP server that returns deterministic v3 board snapshots
 * for the Agent Hub plugin e2e tests. Bind to a random port; tests import
 * `startAgentHubMockServer()` and receive the base URL.
 *
 * Endpoints:
 *   GET /api/v1/me           — user profile
 *   GET /api/v1/me/feed      — approval requests feed
 *   GET /api/v1/work-board   — my-work v3 board snapshot
 *   GET /api/v1/team-board   — team-board v3 snapshot
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Deterministic fixture data
// ---------------------------------------------------------------------------

const ME_FIXTURE = {
  id: 'user-e2e-001',
  displayName: 'E2E Test User',
  email: 'e2e@lvisai.test',
  avatarUrl: null,
};

const FEED_FIXTURE = {
  approvalRequests: [
    {
      approvalId: 'appr-001',
      toolName: 'send_email',
      args: { to: 'boss@example.com', subject: 'Weekly report' },
      reason: 'Agent wants to send a weekly report email',
      source: 'plugin',
      sourcePluginId: 'com.lge.agent-hub',
      requestedAt: '2026-05-03T09:00:00Z',
    },
    {
      approvalId: 'appr-002',
      toolName: 'calendar_create_event',
      args: { title: 'Team Sync', startAt: '2026-05-06T10:00:00Z' },
      reason: 'Agent wants to create a calendar event',
      source: 'plugin',
      sourcePluginId: 'com.lge.agent-hub',
      requestedAt: '2026-05-03T09:15:00Z',
    },
  ],
};

const WORK_BOARD_FIXTURE = {
  version: '3',
  snapshotAt: '2026-05-03T09:00:00Z',
  llmBriefing: {
    summary: 'You have 2 pending approval requests and 3 tasks due this week.',
    generatedAt: '2026-05-03T09:00:00Z',
  },
  weekly: [
    { id: 'task-w1', title: 'Q2 Review', dueDate: '2026-05-08', status: 'in-progress', priority: 'P0' },
    { id: 'task-w2', title: 'Plugin release notes', dueDate: '2026-05-09', status: 'todo', priority: 'P1' },
  ],
  today: [
    { id: 'evt-1', title: 'Morning standup', startAt: '2026-05-03T09:30:00Z', endAt: '2026-05-03T09:45:00Z' },
    { id: 'evt-2', title: 'Architecture review', startAt: '2026-05-03T14:00:00Z', endAt: '2026-05-03T15:00:00Z' },
  ],
  myBoard: [
    { id: 'task-b1', title: 'Fix approval bridge', status: 'in-progress', priority: 'P0' },
    { id: 'task-b2', title: 'Write e2e tests', status: 'in-progress', priority: 'P1' },
    { id: 'task-b3', title: 'Update plugin manifest', status: 'done', priority: 'P1' },
  ],
};

const TEAM_BOARD_FIXTURE = {
  version: '3',
  snapshotAt: '2026-05-03T09:00:00Z',
  kpi: {
    incoming: 12,
    updated: 8,
    declined: 1,
    ranking: 3,
  },
  members: [
    { id: 'mem-1', displayName: 'Alice', riskLevel: 0 },
    { id: 'mem-2', displayName: 'Bob', riskLevel: 1 },
    { id: 'mem-3', displayName: 'Carol', riskLevel: 0 },
  ],
  teamSchedule: [
    {
      id: 'ts-1',
      title: 'Sprint planning',
      startAt: '2026-05-05T10:00:00Z',
      attendees: ['mem-1', 'mem-2', 'mem-3'],
    },
  ],
  teamSummary: {
    wins: 'Shipped approval bridge. All unit tests green.',
    risks: 'Lane 6 UI still in-flight; e2e may see placeholder panel.',
  },
  teamBoard: [
    { id: 'tb-1', title: 'Agent Hub v0.2.0 release', status: 'in-progress', priority: 'P0' },
    { id: 'tb-2', title: 'Marketplace publish', status: 'todo', priority: 'P1' },
  ],
};

// ---------------------------------------------------------------------------
// Server implementation
// ---------------------------------------------------------------------------

export interface AgentHubMockServer {
  baseUrl: string;
  close(): Promise<void>;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

function router(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    res.end();
    return;
  }

  if (url === '/api/v1/me' && req.method === 'GET') {
    return writeJson(res, 200, ME_FIXTURE);
  }
  if (url === '/api/v1/me/feed' && req.method === 'GET') {
    return writeJson(res, 200, FEED_FIXTURE);
  }
  if (url === '/api/v1/work-board' && req.method === 'GET') {
    return writeJson(res, 200, WORK_BOARD_FIXTURE);
  }
  if (url === '/api/v1/team-board' && req.method === 'GET') {
    return writeJson(res, 200, TEAM_BOARD_FIXTURE);
  }

  writeJson(res, 404, { error: 'not-found', path: url });
}

/**
 * Starts the mock server on a random available port.
 * Returns a handle with the base URL and a close() method.
 */
export async function startAgentHubMockServer(): Promise<AgentHubMockServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(router);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
    server.once('error', reject);
  });
}
