import { describe, it, expect } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function listen(server: HttpServer): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

const companyTools = ['list_companies', 'search_companies', 'get_company', 'get_company_contacts',
  'create_company', 'update_company', 'delete_company', 'set_contact_company'];

describe('Companies over MCP transports', () => {
  for (const mode of ['stdio', 'http'] as const) {
    it(`${mode} registers Core companies without Enterprise and routes calls with safe mode`, async () => {
      const requests: string[] = [];
      const backend = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        expect(req.headers.api_access_token).toBe('test-token');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ payload: { id: 7, name: 'Example' } }));
      });
      const backendPort = await listen(backend);
      const env = {
        PATH: process.env.PATH!,
        CHATWOOT_BASE_URL: `http://127.0.0.1:${backendPort}`,
        CHATWOOT_ACCOUNT_ID: '1', CHATWOOT_API_TOKEN: 'test-token',
        MCP_MODE: mode, MCP_SAFE_MODE: 'true', MCP_ENABLE_ENTERPRISE: 'false',
        MCP_ENABLE_PUBLIC_API: 'false', MCP_ENABLE_PLATFORM_API: 'false', MCP_ENABLE_HELP_CENTER: 'false',
        AUTH_TOKEN: '', LOG_LEVEL: 'info', DOTENV_CONFIG_PATH: '/dev/null',
      };
      const client = new Client({ name: 'companies-test', version: '1.0.0' });
      let child: ChildProcess | undefined;
      try {
        if (mode === 'stdio') {
          await client.connect(new StdioClientTransport({
            command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'], env, stderr: 'pipe',
          }));
        } else {
          const reservation = createServer();
          const port = await listen(reservation);
          await new Promise<void>(resolve => reservation.close(() => resolve()));
          child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
            env: { ...env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'],
          });
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('HTTP startup timed out')), 10_000);
            child!.once('error', error => { clearTimeout(timeout); reject(error); });
            child!.once('exit', code => { clearTimeout(timeout); reject(new Error(`HTTP exited: ${code}`)); });
            child!.stderr!.on('data', data => {
              if (String(data).includes('HTTP server listening')) { clearTimeout(timeout); resolve(); }
            });
          });
          await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
        }
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(89);
        expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(companyTools));
        const result = await client.callTool({ name: 'get_company', arguments: { company_id: 7, account_id: 42 } });
        expect(result.isError).toBe(false);
        expect(requests).toEqual(['GET /api/v1/accounts/42/companies/7']);
        const blocked = await client.callTool({ name: 'delete_company', arguments: { company_id: 7 } });
        expect(blocked.isError).toBe(true);
        expect(requests).toHaveLength(1);
      } finally {
        await client.close();
        if (child && child.exitCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          await exited;
        }
        await new Promise<void>(resolve => backend.close(() => resolve()));
      }
    }, 15_000);
  }
});
