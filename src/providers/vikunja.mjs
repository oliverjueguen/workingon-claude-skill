import { Provider, ProviderError, DRY_RUN, dryIssue } from './base.mjs';
import { mdToHtml, htmlToText } from '../lib/md.mjs';

/**
 * Vikunja, self-hosted.
 *
 * Two things to remember: PUT creates and POST updates, the opposite of most
 * APIs, and rich text fields hold HTML because the editor is TipTap.
 */
export class VikunjaProvider extends Provider {
  static id = 'vikunja';
  static label = 'Vikunja';
  static blurb = 'Self-hosted, open source. Projects and tasks.';
  static containerNoun = 'project';
  static bodyFormat = 'html';

  static capabilities = {
    labels: true, createLabels: true, done: true, percent: true,
    priority: true, deleteIssue: true, deleteComment: true, moveContainer: true,
  };

  static credentialFields = [
    { key: 'url', label: 'Instance URL', placeholder: 'https://vikunja.example.com' },
    { key: 'token', label: 'API token', secret: true, placeholder: 'tk_...' },
  ];

  static tokenHelp = {
    url: 'https://vikunja.io/docs/api-documentation/',
    steps: [
      'Open your Vikunja instance and go to Settings > API Tokens.',
      'Create a token with these permissions: Projects (read all), Tasks (create, read all, update),',
      'Task comments (create, read all), Labels (read all, create) and Task labels (create).',
      'Copy the token that starts with tk_. It is shown only once.',
    ],
  };

  get apiRoot() {
    const base = String(this.credentials.url || '').replace(/\/+$/, '');
    return /\/api\/v\d+$/.test(base) ? base : `${base}/api/v1`;
  }

  get webRoot() {
    return this.apiRoot.replace(/\/api\/v\d+$/, '');
  }

  issueUrl(id) { return `${this.webRoot}/tasks/${id}`; }

  request(method, path, body, simulate) {
    return this.http(method, `${this.apiRoot}${path}`, {
      headers: {
        Authorization: `Bearer ${this.credentials.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
      simulate,
    });
  }

  describeError(data, res) {
    const base = super.describeError(data, res);
    if (res.status === 401 || res.status === 403) {
      return `${base}. Check the token and, above all, that it has the required permissions ticked in Settings > API Tokens.`;
    }
    return base;
  }

  /**
   * Vikunja caps per_page at the instance maximum and silently truncates, so
   * an instance with hundreds of projects would otherwise look tiny.
   */
  async paginate(path, { perPage = 50, maxItems = 1000 } = {}) {
    const out = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= 40; page++) {
      const { data, headers } = await this.http('GET', `${this.apiRoot}${path}${sep}page=${page}&per_page=${perPage}`, {
        headers: { Authorization: `Bearer ${this.credentials.token}`, Accept: 'application/json' },
        raw: true,
      });
      const list = Array.isArray(data) ? data : [];
      out.push(...list);
      const totalPages = Number(headers.get('x-pagination-total-pages') || 0);
      if (!list.length || list.length < perPage) break;
      if (totalPages && page >= totalPages) break;
      if (out.length >= maxItems) break;
    }
    return out;
  }

  toIssue(task) {
    return {
      id: String(task.id),
      key: task.identifier || `#${task.id}`,
      title: task.title,
      done: Boolean(task.done),
      url: this.issueUrl(task.id),
      labels: (task.labels || []).map((l) => l.title),
      body: htmlToText(task.description),
      containerId: String(task.project_id ?? ''),
    };
  }

  async verify() {
    const info = await this.http('GET', `${this.apiRoot}/info`, { headers: { Accept: 'application/json' } });
    let account = '';
    try {
      const user = await this.request('GET', '/user');
      account = user?.username || '';
    } catch { /* tokens without the user scope still work */ }
    await this.request('GET', '/projects?per_page=1');
    return { ok: true, account, detail: `Vikunja ${info.version}` };
  }

  async listContainers() {
    const projects = await this.paginate('/projects');
    return projects.map((p) => ({ id: String(p.id), name: p.title, archived: Boolean(p.is_archived) }));
  }

  async listLabels() {
    const labels = await this.paginate('/labels');
    return labels.map((l) => ({ id: String(l.id), name: l.title, color: l.hex_color }));
  }

  async createLabel(name, color = '4e94d4') {
    const created = await this.request('PUT', '/labels', { title: name, hex_color: String(color).replace(/^#/, '') }, DRY_RUN);
    return { id: String(created.id ?? 0), name: created.title ?? name, color: created.hex_color };
  }

  /** Labels are read only on the task, so each one needs its own call. */
  async attachLabels(taskId, names, { allowCreate }) {
    if (!names.length) return { attached: [], missing: [] };
    const existing = await this.listLabels();
    const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l]));
    const attached = [];
    const missing = [];
    for (const name of names) {
      let label = byName.get(name.toLowerCase());
      if (!label) {
        if (!allowCreate) { missing.push(name); continue; }
        label = await this.createLabel(name);
      }
      try {
        await this.request('PUT', `/tasks/${taskId}/labels`, { label_id: Number(label.id) }, DRY_RUN);
        attached.push(label.name);
      } catch (err) {
        // Already attached. What matters is the final state of the task.
        if (err.status === 400 || err.status === 412) attached.push(label.name);
        else throw err;
      }
    }
    return { attached, missing };
  }

  async createIssue({ containerId, title, body, labels = [], priority, allowCreateLabels = false }) {
    const task = { title, description: body ? mdToHtml(body) : '' };
    if (priority) task.priority = priority;
    const created = await this.request('PUT', `/projects/${containerId}/tasks`, task, () => dryIssue(title));
    if (created.__dryRun) return { ...created, labelsMissing: labels };

    const { attached, missing } = await this.attachLabels(created.id, labels, { allowCreate: allowCreateLabels });
    return { ...this.toIssue(created), labels: attached, labelsMissing: missing };
  }

  async getIssue(id) {
    return this.toIssue(await this.request('GET', `/tasks/${id}`));
  }

  async updateIssue(id, patch) {
    const current = await this.request('GET', `/tasks/${id}`);
    const merged = { ...current, id: current.id };
    if (patch.title !== undefined) merged.title = patch.title;
    if (patch.body !== undefined) merged.description = mdToHtml(patch.body);
    if (patch.done !== undefined) merged.done = patch.done;
    if (patch.containerId !== undefined) merged.project_id = Number(patch.containerId);
    if (patch.percent !== undefined) merged.percent_done = patch.percent > 1 ? patch.percent / 100 : patch.percent;
    if (patch.priority !== undefined) merged.priority = patch.priority;
    // Server controlled, must not be echoed back.
    delete merged.done_at; delete merged.created; delete merged.updated; delete merged.identifier;

    const updated = await this.request('POST', `/tasks/${id}`, merged, () => ({ ...merged, __dryRun: true }));
    const issue = updated.__dryRun ? { ...this.toIssue(current), __dryRun: true } : this.toIssue(updated);

    if (patch.labels?.length) {
      const { attached, missing } = await this.attachLabels(id, patch.labels, { allowCreate: patch.allowCreateLabels });
      issue.labels = attached;
      issue.labelsMissing = missing;
    }
    return issue;
  }

  async deleteIssue(id) {
    return this.request('DELETE', `/tasks/${id}`, undefined, DRY_RUN);
  }

  async searchIssues({ query, containerId, openOnly = true, limit = 25 }) {
    const params = new URLSearchParams();
    if (query) params.set('s', query);
    const filters = [];
    if (openOnly) filters.push('done = false');
    if (containerId) filters.push(`project = ${containerId}`);
    if (filters.length) params.set('filter', filters.join(' && '));
    params.set('per_page', String(limit));
    params.set('sort_by', 'updated');
    params.set('order_by', 'desc');
    const res = await this.request('GET', `/tasks?${params.toString()}`);
    return (Array.isArray(res) ? res : []).map((t) => this.toIssue(t));
  }

  async addComment(id, body) {
    const created = await this.request('PUT', `/tasks/${id}/comments`, { comment: mdToHtml(body) }, DRY_RUN);
    return { id: String(created.id ?? 0), __dryRun: created.__dryRun };
  }

  async listComments(id) {
    const list = await this.request('GET', `/tasks/${id}/comments`);
    return (list || []).map((c) => ({ id: String(c.id), createdAt: c.created, body: htmlToText(c.comment) }));
  }

  async deleteComment(issueId, commentId) {
    return this.request('DELETE', `/tasks/${issueId}/comments/${commentId}`, undefined, DRY_RUN);
  }
}

export default VikunjaProvider;
