import { Provider, DRY_RUN, dryIssue } from './base.mjs';
import { mdToJira, jiraToText } from '../lib/md.mjs';

/**
 * Jira Cloud.
 *
 * Deliberately REST v2, not v3. The v3 API rejects a plain string description
 * and demands Atlassian Document Format, a nested JSON tree, while v2 still
 * accepts wiki markup and stays supported. For short ticket bodies the JSON
 * tree buys nothing and costs a lot of fragility.
 */
export class JiraProvider extends Provider {
  static id = 'jira';
  static label = 'Jira';
  static blurb = 'Atlassian Jira Cloud. Projects and issues.';
  static containerNoun = 'project';
  static bodyFormat = 'jira';

  static capabilities = {
    labels: true, createLabels: true, done: true, percent: false,
    priority: false, deleteIssue: true, deleteComment: true, moveContainer: false,
  };

  static credentialFields = [
    { key: 'site', label: 'Site URL', placeholder: 'https://yourcompany.atlassian.net' },
    { key: 'email', label: 'Account email', placeholder: 'you@company.com' },
    { key: 'token', label: 'API token', secret: true },
    { key: 'issueType', label: 'Issue type for new tickets', optional: true, placeholder: 'Task' },
  ];

  static tokenHelp = {
    url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    steps: [
      'Go to id.atlassian.com/manage-profile/security/api-tokens.',
      'Click "Create API token", give it a label and copy the value.',
      'The token pairs with your account email, so both are needed below.',
      'It inherits your own permissions: it can see whatever you can see.',
    ],
  };

  get apiRoot() {
    return `${String(this.credentials.site || '').replace(/\/+$/, '')}/rest/api/2`;
  }

  get issueType() { return this.credentials.issueType || 'Task'; }

  issueUrl(key) {
    return `${String(this.credentials.site || '').replace(/\/+$/, '')}/browse/${key}`;
  }

  request(method, path, body, simulate) {
    const auth = Buffer.from(`${this.credentials.email}:${this.credentials.token}`).toString('base64');
    return this.http(method, `${this.apiRoot}${path}`, {
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      simulate,
    });
  }

  describeError(data, res) {
    if (data && Array.isArray(data.errorMessages) && data.errorMessages.length) return data.errorMessages.join('; ');
    if (data && data.errors && Object.keys(data.errors).length) {
      return Object.entries(data.errors).map(([k, v]) => `${k}: ${v}`).join('; ');
    }
    return super.describeError(data, res);
  }

  toIssue(raw) {
    const fields = raw.fields || {};
    return {
      id: raw.key,
      key: raw.key,
      title: fields.summary || '',
      done: String(fields.status?.statusCategory?.key || '').toLowerCase() === 'done',
      url: this.issueUrl(raw.key),
      labels: fields.labels || [],
      body: jiraToText(fields.description || ''),
      containerId: fields.project?.key || '',
    };
  }

  async verify() {
    const me = await this.request('GET', '/myself');
    return { ok: true, account: me.emailAddress || me.displayName || '', detail: 'Jira Cloud REST v2' };
  }

  async listContainers() {
    const out = [];
    for (let startAt = 0; startAt < 2000; startAt += 50) {
      const page = await this.request('GET', `/project/search?maxResults=50&startAt=${startAt}`);
      out.push(...(page.values || []).map((p) => ({
        id: p.key, name: `${p.name} (${p.key})`, archived: Boolean(p.archived),
      })));
      if (page.isLast || !(page.values || []).length) break;
    }
    return out;
  }

  /** Jira labels are free-form strings on the issue, there is nothing to create. */
  async listLabels() {
    const res = await this.request('GET', '/label?maxResults=200');
    return (res.values || []).map((name) => ({ id: name, name }));
  }

  async createLabel(name) { return { id: name, name }; }

  /**
   * Writing an unknown string still adds it to the instance-wide label pool
   * everyone autocompletes from, so unknown labels are dropped unless creating
   * them was explicitly allowed.
   */
  async splitLabels(labels, allowCreate) {
    if (!labels.length) return { use: [], missing: [] };
    // Jira labels cannot contain spaces.
    const wanted = labels.map((l) => l.replace(/\s+/g, '-'));
    if (allowCreate) return { use: wanted, missing: [] };
    let known = new Set();
    try {
      known = new Set((await this.listLabels()).map((l) => l.name.toLowerCase()));
    } catch {
      return { use: [], missing: wanted };
    }
    return {
      use: wanted.filter((l) => known.has(l.toLowerCase())),
      missing: wanted.filter((l) => !known.has(l.toLowerCase())),
    };
  }

  async createIssue({ containerId, title, body, labels = [], allowCreateLabels = false }) {
    const { use, missing } = await this.splitLabels(labels, allowCreateLabels);
    const payload = {
      fields: {
        project: { key: containerId },
        summary: title,
        issuetype: { name: this.issueType },
        ...(body ? { description: mdToJira(body) } : {}),
        ...(use.length ? { labels: use } : {}),
      },
    };
    const created = await this.request('POST', '/issue', payload, () => dryIssue(title));
    if (created.__dryRun) return { ...created, labelsMissing: missing };
    return {
      id: created.key, key: created.key, title, done: false,
      url: this.issueUrl(created.key), labels: use, labelsMissing: missing,
    };
  }

  async getIssue(id) {
    return this.toIssue(await this.request('GET', `/issue/${id}`));
  }

  async updateIssue(id, patch) {
    const fields = {};
    if (patch.title !== undefined) fields.summary = patch.title;
    if (patch.body !== undefined) fields.description = mdToJira(patch.body);

    let missing = [];
    if (patch.labels?.length) {
      const split = await this.splitLabels(patch.labels, patch.allowCreateLabels);
      missing = split.missing;
      if (split.use.length) fields.labels = split.use;
    }

    if (Object.keys(fields).length) {
      await this.request('PUT', `/issue/${id}`, { fields }, DRY_RUN);
    }
    if (patch.done !== undefined) await this.transition(id, patch.done);
    if (this.dryRun) return { ...dryIssue(patch.title || ''), id, key: id, labelsMissing: missing };
    return { ...(await this.getIssue(id)), labelsMissing: missing };
  }

  /** Closing an issue in Jira means finding a workflow transition, not setting a field. */
  async transition(id, done) {
    const { transitions = [] } = await this.request('GET', `/issue/${id}/transitions`);
    const wanted = transitions.find((t) => {
      const category = String(t.to?.statusCategory?.key || '').toLowerCase();
      return done ? category === 'done' : category === 'new' || category === 'indeterminate';
    });
    if (!wanted) return;
    await this.request('POST', `/issue/${id}/transitions`, { transition: { id: wanted.id } }, DRY_RUN);
  }

  async deleteIssue(id) {
    return this.request('DELETE', `/issue/${id}`, undefined, DRY_RUN);
  }

  async searchIssues({ query, containerId, openOnly = true, limit = 25 }) {
    const clauses = [];
    if (containerId) clauses.push(`project = "${containerId}"`);
    if (openOnly) clauses.push('statusCategory != Done');
    if (query) clauses.push(`text ~ "${String(query).replace(/"/g, '\\"')}"`);
    const jql = `${clauses.join(' AND ') || 'order by updated desc'}${clauses.length ? ' order by updated desc' : ''}`;
    const res = await this.request('GET', `/search?jql=${encodeURIComponent(jql)}&maxResults=${limit}`);
    return (res.issues || []).map((i) => this.toIssue(i));
  }

  async addComment(id, body) {
    const created = await this.request('POST', `/issue/${id}/comment`, { body: mdToJira(body) }, DRY_RUN);
    return { id: String(created.id ?? 0), __dryRun: created.__dryRun };
  }

  async listComments(id) {
    const res = await this.request('GET', `/issue/${id}/comment`);
    return (res.comments || []).map((c) => ({ id: String(c.id), createdAt: c.created, body: jiraToText(c.body) }));
  }

  async deleteComment(issueId, commentId) {
    return this.request('DELETE', `/issue/${issueId}/comment/${commentId}`, undefined, DRY_RUN);
  }
}

export default JiraProvider;
