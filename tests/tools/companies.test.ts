import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { ChatwootClient } from '../../src/api/client.js';
import { handleToolCall } from '../../src/tools/handlers.js';
import { tools } from '../../src/tools/definitions.js';

const BASE = 'https://test.chatwoot.com';
const company = { id: 7, name: 'Example', domain: 'example.com' };
const detail = { payload: company };
const page = { meta: { total_count: 51, page: 2 }, payload: [company] };
const contacts = { meta: { total_count: 26, page: 2 }, payload: [{ id: 9, company_id: 7 }] };
const cases = [
  { name: 'list_companies', args: { page: 2, sort: '-contacts_count' }, method: 'get', path: '/companies', query: { page: 2, sort: '-contacts_count' }, response: page },
  { name: 'search_companies', args: { query: 'Example', page: 2, sort: '-domain' }, method: 'get', path: '/companies/search', query: { q: 'Example', page: 2, sort: '-domain' }, response: page },
  { name: 'get_company', args: { company_id: 7 }, method: 'get', path: '/companies/7', response: detail },
  { name: 'get_company_contacts', args: { company_id: 7, page: 2 }, method: 'get', path: '/companies/7/contacts', query: { page: 2 }, response: contacts },
  { name: 'create_company', args: { name: 'Example', domain: 'example.com', description: 'Support', additional_attributes: { social_profiles: { linkedin: 'https://linkedin.com/company/example' } }, custom_attributes: { tier: 'gold' } }, method: 'post', path: '/companies', body: { company: { name: 'Example', domain: 'example.com', description: 'Support', additional_attributes: { social_profiles: { linkedin: 'https://linkedin.com/company/example' } }, custom_attributes: { tier: 'gold' } } }, response: detail },
  { name: 'update_company', args: { company_id: 7, description: null }, method: 'patch', path: '/companies/7', body: { company: { description: null } }, response: detail },
  { name: 'delete_company', args: { company_id: 7 }, method: 'delete', path: '/companies/7', response: '' },
  { name: 'set_contact_company', args: { contact_id: 9, company_id: 7 }, method: 'patch', path: '/contacts/9', body: { company_id: 7 }, response: { payload: { contact: { id: 9, company_id: 7 } } } },
  { name: 'set_contact_company', args: { contact_id: 9, company_id: null }, method: 'patch', path: '/contacts/9', body: { company_id: null }, response: { payload: { contact: { id: 9, company_id: null } } } },
] as const;

function scope(account = 1) {
  return nock(`${BASE}/api/v1/accounts/${account}`, { reqheaders: { api_access_token: 'test-token' } });
}
function available(account = 1) {
  scope(account).get('/companies').query({ page: 1, sort: 'name' }).reply(200, { meta: { total_count: 0, page: 1 }, payload: [] });
}
function content(result: Awaited<ReturnType<typeof handleToolCall>>) {
  return (result.content[0] as { text: string }).text;
}

describe('Core companies', () => {
  let client: ChatwootClient;
  let previousSafeMode: string | undefined;
  beforeEach(() => {
    previousSafeMode = process.env.MCP_SAFE_MODE;
    delete process.env.MCP_SAFE_MODE;
    nock.disableNetConnect();
    client = new ChatwootClient({ baseUrl: BASE, accountId: 1, apiToken: 'test-token' });
  });
  afterEach(() => {
    const pending = nock.pendingMocks();
    nock.cleanAll();
    nock.enableNetConnect();
    if (previousSafeMode === undefined) delete process.env.MCP_SAFE_MODE;
    else process.env.MCP_SAFE_MODE = previousSafeMode;
    expect(pending).toEqual([]);
  });

  for (const safe of ['false', 'true']) {
    for (const override of [undefined, 42]) {
      for (const test of cases) {
        it(`${test.name} ${JSON.stringify(test.args)} safe=${safe}, account=${override ?? 'default'}`, async () => {
          process.env.MCP_SAFE_MODE = safe;
          if (safe === 'true' && test.name === 'delete_company') {
            const result = await handleToolCall(client, test.name, { ...test.args, account_id: override });
            expect(result.isError).toBe(true);
            expect(content(result)).toContain('Blocked by MCP_SAFE_MODE');
            return;
          }
          const account = override ?? 1;
          if (test.name === 'set_contact_company') available(account);
          const request = scope(account).intercept(test.path, test.method.toUpperCase(), 'body' in test ? test.body : undefined);
          if ('query' in test) request.query(test.query);
          request.reply(200, test.response);
          const result = await handleToolCall(client, test.name, { ...test.args, account_id: override });
          expect(result.isError).toBe(false);
          if (test.name === 'delete_company') expect(content(result)).toContain('scheduled');
          else expect(JSON.parse(content(result))).toEqual(test.response);
        });
      }
    }
  }

  it('preserves omitted nested attributes and explicit nulls with an account-scoped read before PATCH', async () => {
    scope(42).get('/companies/7').reply(200, { payload: { ...company,
      additional_attributes: { city: 'Rome', social_profiles: { twitter: 'https://x.com/example', linkedin: 'https://linkedin.com/old' } },
      custom_attributes: { tier: 'gold', region: 'EU', nested: { a: 1, b: 2 } },
    } });
    scope(42).patch('/companies/7', { company: {
      domain: null,
      additional_attributes: { city: 'Rome', social_profiles: { twitter: 'https://x.com/example', linkedin: 'https://linkedin.com/new' } },
      custom_attributes: { tier: null, region: 'EU', nested: { a: 3, b: 2 } },
    } }).reply(200, detail);
    const result = await handleToolCall(client, 'update_company', { account_id: 42, company_id: 7, domain: null,
      additional_attributes: { social_profiles: { linkedin: 'https://linkedin.com/new' } },
      custom_attributes: { tier: null, nested: { a: 3 } },
    });
    expect(result.isError).toBe(false);
  });

  it('forwards only supported fields, excluding routing parameters and legacy company_name', async () => {
    scope().patch('/companies/7', { company: { name: 'Renamed' } }).reply(200, detail);
    const result = await handleToolCall(client, 'update_company', { company_id: 7, name: 'Renamed', description: undefined, avatar_url: 'bad', company_name: 'legacy' });
    expect(result.isError).toBe(false);
  });

  it('uses the native contacts endpoint across successive pages, preserving server metadata', async () => {
    for (const pageNumber of [1, 2, 3]) {
      const response = { meta: { page: pageNumber, total_count: 26 }, payload: pageNumber < 3 ? [{ id: pageNumber, company_id: 7 }] : [] };
      scope().get('/companies/7/contacts').query({ page: pageNumber }).reply(200, response);
      expect(await client.getCompanyContacts(7, pageNumber)).toEqual(response);
    }
  });

  it('uses default pagination and sorting for company lists and searches', async () => {
    scope().get('/companies').query({ page: 1, sort: 'name' }).reply(200, page);
    scope().get('/companies/search').query({ q: 'example.com', page: 1, sort: 'name' }).reply(200, page);
    expect(await client.listCompanies()).toEqual(page);
    expect(await client.searchCompanies('example.com')).toEqual(page);
  });

  it('supports account override without a configured default account', async () => {
    const noDefault = new ChatwootClient({ baseUrl: BASE, apiToken: 'test-token' });
    scope(42).get('/companies/7').reply(200, detail);
    expect(await noDefault.getCompany(7, 42)).toEqual(detail);
  });

  for (const [status, message] of [[403, 'Companies are not enabled for this account'], [403, 'Not authorized'], [404, 'Not Found'], [422, 'Domain is invalid']] as const) {
    it(`returns standard API errors: ${status} ${message}`, async () => {
      scope().get('/companies/7').reply(status, { error: message });
      const result = await handleToolCall(client, 'get_company', { company_id: 7 });
      expect(result.isError).toBe(true);
      expect(content(result)).toBe(`Chatwoot API Error (${status}): ${message}`);
    });
  }

  for (const companyId of [7, null]) {
    for (const status of [403, 404]) {
      it(`does not PATCH contact when companies is unavailable (${status}), company_id=${companyId}`, async () => {
        scope(42).get('/companies').query({ page: 1, sort: 'name' }).reply(status, { error: 'Companies unavailable' });
        const result = await handleToolCall(client, 'set_contact_company', { contact_id: 9, company_id: companyId, account_id: 42 });
        expect(result.isError).toBe(true);
        expect(content(result)).toBe(`Chatwoot API Error (${status}): Companies unavailable`);
      });
    }
  }

  it('does not treat omitted company_id as null', async () => {
    const result = await handleToolCall(client, 'set_contact_company', { contact_id: 9 });
    expect(result.isError).toBe(true);
    expect(content(result)).toContain('company_id is required');
  });

  for (const status of [403, 404]) {
    it(`preserves contact assignment API errors (${status})`, async () => {
      available();
      scope().patch('/contacts/9', { company_id: 7 }).reply(status, { message: 'Contact or company inaccessible' });
      const result = await handleToolCall(client, 'set_contact_company', { contact_id: 9, company_id: 7 });
      expect(result.isError).toBe(true);
      expect(content(result)).toBe(`Chatwoot API Error (${status}): Contact or company inaccessible`);
    });
  }

  it('does not write if reading attributes fails', async () => {
    scope().get('/companies/7').reply(404, { error: 'Not Found' });
    const result = await handleToolCall(client, 'update_company', { company_id: 7, additional_attributes: { city: 'Rome' } });
    expect(result.isError).toBe(true);
  });

  it('exposes eight Core tools and a required nullable company_id only for assignment', () => {
    const names = [...new Set(cases.map(test => test.name))];
    expect(names).toHaveLength(8);
    for (const name of names) expect(tools.find(tool => tool.name === name)).toBeDefined();
    const assignment = tools.find(tool => tool.name === 'set_contact_company')!;
    expect(assignment.inputSchema.required).toEqual(['contact_id', 'company_id']);
    expect(assignment.inputSchema.properties?.company_id).toMatchObject({ type: ['integer', 'null'] });
  });
});
