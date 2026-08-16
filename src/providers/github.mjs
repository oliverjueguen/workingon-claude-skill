import { Provider, DRY_RUN, dryIssue } from './base.mjs';

/**
 * GitHub Issues.
 *
 * A container is a repository, written "owner/repo". Issue ids carry the repo
 * with them ("owner/repo#12") because every endpoint needs both and the plain
 * number is only unique inside one repository.
 */
export class GitHubProvider extends Provider {
  static id = 'github';
  static label = 'GitHub Issues';
  static blurb = 'Issues on your repositories.';
  static containerNoun = 'repository';
  static bodyFormat = 'markdown';

  static capabilities = {
    labels: true, createLabels: true, done: true, percent: false, priority: false,
    // Issues cannot be deleted through the REST API, only closed.
    deleteIssue: false,
    deleteComment: true,
    // Transferring an issue between repositories is not a plain field update.
    moveContainer: false,
  };

  static credentialFields = [
    { key: 'token', label: 'Personal access token', secret: true, placeholder: 'github_pat_... or ghp_...' },
  ];

  static tokenHelp = {
    url: 'https://github.com/settings/personal-access-tokens',
    steps: [
      'Go to github.com/settings/personal-access-tokens and create a fine-grained token.',
      'Give it access to the repositories you want tickets in.',
      'Under Repository permissions set Issues to "Read and write" and Metadata to "Read-only".',
      'Copy the token. It is shown only once.',
    ],
  };

  static API = 'https://api.github.com';
  static API_VERSION = '2022-11-28';

  get apiBase() { return this.credentials.apiBase || GitHubProvider.API; }

  request(method, path, body, simulate) {
    return this.http(method, `${this.apiBase}${path}`, {
      headers: {
        Authorization: `Bearer ${this.credentials.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GitHubProvider.API_VERSION,
        'Content-Type': 'application/json',
        'User-Agent': 'workingon',
      },
      body,
      simulate,
    });
  }

  describeError(data, res) {
    if (data?.message && Array.isArray(data.errors)) {
      return `${data.message} (${data.errors.map((e) => e.message || e.code).join(', ')})`;
    }
    if (res.status === 403 && data?.message?.includes('rate limit')) return 'rate limit exceeded';
    return super.describeError(data, res);
  }

  /** "owner/repo#12" carries everything later calls need. */
  static parseId(id) {
    const m = String(id).match(/^(.+?)#(\d+)$/);
    if (!m) throw new Error(`Not a GitHub issue id: ${id}. Expected owner/repo#number.`);
    return { repo: m[1], number: Number(m[2]) };
  }

  toIssue(raw, repo) {
    return {
      id: `${repo}#${raw.number}`,
      key: `${repo}#${raw.number}`,
      title: raw.title || '',
      done: raw.state === 'closed',
      url: raw.html_url,
      labels: (raw.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
      body: raw.body || '',
      containerId: repo,
    };
  }

  async verify() {
    const me = await this.request('GET', '/user');
    return { ok: true, account: me.login, detail: 'GitHub REST' };
  }

  async listContainers() {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const repos = await this.request('GET', `/user/repos?per_page=100&sort=updated&page=${page}`);
      if (!Array.isArray(repos) || !repos.length) break;
      out.push(...repos.map((r) => ({
        id: r.full_name,
        name: r.full_name + (r.private ? ' (private)' : ''),
        archived: Boolean(r.archived),
      })));
      if (repos.length < 100) break;
    }
    return out;
  }

  async listLabels(containerId) {
    if (!containerId) return [];
    const labels = await this.request('GET', `/repos/${containerId}/labels?per_page=100`);
    return (labels || []).map((l) => ({ id: l.name, name: l.name, color: l.color }));
  }

  async createLabel(name, color = 'ff8c00', containerId) {
    const created = await this.request('POST', `/repos/${containerId}/labels`, {
      name, color: String(color).replace(/^#/, ''),
    }, () => ({ name, color, __dryRun: true }));
    return { id: created.name ?? name, name: created.name ?? name, color: created.color };
  }

  /** Labels are per repository, so missing ones are only created on request. */
  async resolveLabels(containerId, names, { allowCreate }) {
    if (!names.length) return { attached: [], missing: [] };
    const existing = await this.listLabels(containerId);
    const have = new Set(existing.map((l) => l.name.toLowerCase()));
    const attached = [];
    const missing = [];
    for (const name of names) {
      if (have.has(name.toLowerCase())) { attached.push(name); continue; }
      if (!allowCreate) { missing.push(name); continue; }
      await this.createLabel(name, 'ff8c00', containerId);
      attached.push(name);
    }
    return { attached, missing };
  }

  async createIssue({ containerId, title, body, labels = [], allowCreateLabels = false }) {
    const { attached, missing } = await this.resolveLabels(containerId, labels, { allowCreate: allowCreateLabels });
    const created = await this.request('POST', `/repos/${containerId}/issues`, {
      title, ...(body ? { body } : {}), ...(attached.length ? { labels: attached } : {}),
    }, () => dryIssue(title));
    if (created.__dryRun) return { ...created, labelsMissing: missing };
    return { ...this.toIssue(created, containerId), labels: attached, labelsMissing: missing };
  }

  async getIssue(id) {
    const { repo, number } = GitHubProvider.parseId(id);
    return this.toIssue(await this.request('GET', `/repos/${repo}/issues/${number}`), repo);
  }

  async updateIssue(id, patch) {
    const { repo, number } = GitHubProvider.parseId(id);
    const payload = {};
    if (patch.title !== undefined) payload.title = patch.title;
    if (patch.body !== undefined) payload.body = patch.body;
    if (patch.done !== undefined) payload.state = patch.done ? 'closed' : 'open';

    let attached = [];
    let missing = [];
    if (patch.labels?.length) {
      ({ attached, missing } = await this.resolveLabels(repo, patch.labels, { allowCreate: patch.allowCreateLabels }));
      if (attached.length) payload.labels = attached;
    }
    if (!Object.keys(payload).length) return this.getIssue(id);

    const updated = await this.request('PATCH', `/repos/${repo}/issues/${number}`, payload, () => ({ __dryRun: true }));
    if (updated.__dryRun) return { ...dryIssue(patch.title || ''), id, key: id };
    return { ...this.toIssue(updated, repo), labelsMissing: missing };
  }

  async searchIssues({ query, containerId, openOnly = true, limit = 25 }) {
    if (!containerId) return [];
    const params = new URLSearchParams({
      state: openOnly ? 'open' : 'all', per_page: String(limit), sort: 'updated', direction: 'desc',
    });
    const list = await this.request('GET', `/repos/${containerId}/issues?${params.toString()}`);
    return (Array.isArray(list) ? list : [])
      // The issues endpoint also returns pull requests, which are not tickets.
      .filter((i) => !i.pull_request)
      .filter((i) => !query || `${i.title} ${i.body || ''}`.toLowerCase().includes(String(query).toLowerCase()))
      .map((i) => this.toIssue(i, containerId));
  }

  async addComment(id, body) {
    const { repo, number } = GitHubProvider.parseId(id);
    const created = await this.request('POST', `/repos/${repo}/issues/${number}/comments`, { body }, DRY_RUN);
    return { id: String(created.id ?? 0), __dryRun: created.__dryRun };
  }

  async listComments(id) {
    const { repo, number } = GitHubProvider.parseId(id);
    const list = await this.request('GET', `/repos/${repo}/issues/${number}/comments?per_page=100`);
    return (list || []).map((c) => ({ id: String(c.id), createdAt: c.created_at, body: c.body || '' }));
  }

  async deleteComment(issueId, commentId) {
    const { repo } = GitHubProvider.parseId(issueId);
    return this.request('DELETE', `/repos/${repo}/issues/comments/${commentId}`, undefined, DRY_RUN);
  }
}

export default GitHubProvider;
