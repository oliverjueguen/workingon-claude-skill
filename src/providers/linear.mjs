import { Provider, dryIssue } from './base.mjs';

/**
 * Linear, over GraphQL.
 *
 * The personal API key goes in the Authorization header raw. Prefixing it with
 * "Bearer" fails authentication, which is the single most common mistake with
 * this API. OAuth tokens are the ones that take the Bearer prefix.
 */
export class LinearProvider extends Provider {
  static id = 'linear';
  static label = 'Linear';
  static blurb = 'Fast issue tracker. Teams and issues.';
  static containerNoun = 'team';
  static bodyFormat = 'markdown';

  static capabilities = {
    labels: true, createLabels: true, done: true, percent: false,
    priority: true, deleteIssue: true, deleteComment: true, moveContainer: true,
  };

  static credentialFields = [
    { key: 'token', label: 'Personal API key', secret: true, placeholder: 'lin_api_...' },
  ];

  static tokenHelp = {
    url: 'https://linear.app/settings/account/security',
    steps: [
      'In Linear, open Settings > Security & access > Personal API keys.',
      'Create a key and copy it. It starts with lin_api_.',
      'The key carries your own access, and it does not expire on its own.',
    ],
  };

  static ENDPOINT = 'https://api.linear.app/graphql';

  /** @param {string} query @param {object} variables */
  get endpoint() { return this.credentials.endpoint || LinearProvider.ENDPOINT; }

  async gql(query, variables = {}, simulate) {
    const data = await this.http('POST', this.endpoint, {
      // Raw key, no Bearer prefix. See the class comment.
      headers: { Authorization: this.credentials.token, 'Content-Type': 'application/json' },
      body: { query, variables },
      simulate,
    });
    if (data?.__dryRun) return data;
    if (data?.errors?.length) {
      throw new Error(`Linear: ${data.errors.map((e) => e.message).join('; ')}`);
    }
    return data?.data;
  }

  /** Mutations are the only writes, so dry run intercepts at this level. */
  async mutate(query, variables, simulate) {
    if (this.dryRun) {
      this.onSimulate?.({ provider: this.providerId, method: 'POST', url: this.endpoint, body: { query, variables } });
      return typeof simulate === 'function' ? simulate() : simulate;
    }
    return this.gql(query, variables);
  }

  toIssue(issue) {
    return {
      id: issue.id,
      key: issue.identifier || issue.id,
      title: issue.title || '',
      done: Boolean(issue.completedAt) || String(issue.state?.type || '') === 'completed',
      url: issue.url || '',
      labels: (issue.labels?.nodes || []).map((l) => l.name),
      body: issue.description || '',
      containerId: issue.team?.id || '',
    };
  }

  async verify() {
    const data = await this.gql('query { viewer { id name email } }');
    return { ok: true, account: data?.viewer?.email || data?.viewer?.name || '', detail: 'Linear GraphQL' };
  }

  async listContainers() {
    const data = await this.gql('query { teams(first: 100) { nodes { id name key } } }');
    return (data?.teams?.nodes || []).map((t) => ({ id: t.id, name: `${t.name} (${t.key})` }));
  }

  async listLabels() {
    const data = await this.gql('query { issueLabels(first: 200) { nodes { id name color } } }');
    return (data?.issueLabels?.nodes || []).map((l) => ({ id: l.id, name: l.name, color: l.color }));
  }

  async createLabel(name, color = '#ff8c00', containerId) {
    const data = await this.mutate(
      'mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name color } } }',
      { input: { name, color: color.startsWith('#') ? color : `#${color}`, ...(containerId ? { teamId: containerId } : {}) } },
      () => ({ issueLabelCreate: { issueLabel: { id: '0', name, color } } }),
    );
    const label = data?.issueLabelCreate?.issueLabel;
    return { id: label?.id ?? '0', name: label?.name ?? name, color: label?.color };
  }

  async resolveLabelIds(names, { allowCreate, containerId }) {
    if (!names.length) return { ids: [], attached: [], missing: [] };
    const existing = await this.listLabels();
    const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l]));
    const ids = [];
    const attached = [];
    const missing = [];
    for (const name of names) {
      let label = byName.get(name.toLowerCase());
      if (!label) {
        if (!allowCreate) { missing.push(name); continue; }
        label = await this.createLabel(name, '#ff8c00', containerId);
      }
      ids.push(label.id);
      attached.push(label.name);
    }
    return { ids, attached, missing };
  }

  async createIssue({ containerId, title, body, labels = [], priority, allowCreateLabels = false }) {
    const { ids, attached, missing } = await this.resolveLabelIds(labels, { allowCreate: allowCreateLabels, containerId });
    const input = { teamId: containerId, title, ...(body ? { description: body } : {}) };
    if (ids.length) input.labelIds = ids;
    if (priority) input.priority = priority;

    const data = await this.mutate(
      `mutation($input: IssueCreateInput!) {
         issueCreate(input: $input) { success issue { id identifier title url } }
       }`,
      { input },
      () => ({ issueCreate: { issue: null } }),
    );
    const issue = data?.issueCreate?.issue;
    if (!issue) return { ...dryIssue(title), labelsMissing: missing };
    return {
      id: issue.id, key: issue.identifier, title: issue.title, done: false,
      url: issue.url, labels: attached, labelsMissing: missing,
    };
  }

  static ISSUE_FIELDS = `id identifier title url description completedAt
    state { type } team { id } labels { nodes { name } }`;

  async getIssue(id) {
    const data = await this.gql(`query($id: String!) { issue(id: $id) { ${LinearProvider.ISSUE_FIELDS} } }`, { id });
    if (!data?.issue) throw new Error(`Linear: issue ${id} not found`);
    return this.toIssue(data.issue);
  }

  /** Closing an issue means moving it to a state of type "completed". */
  async completedStateId(teamId) {
    const data = await this.gql(
      'query($id: String!) { team(id: $id) { states { nodes { id name type } } } }', { id: teamId },
    );
    const nodes = data?.team?.states?.nodes || [];
    return nodes.find((s) => s.type === 'completed')?.id
      || nodes.find((s) => s.type === 'started')?.id
      || null;
  }

  async updateIssue(id, patch) {
    const input = {};
    if (patch.title !== undefined) input.title = patch.title;
    if (patch.body !== undefined) input.description = patch.body;
    if (patch.containerId !== undefined) input.teamId = patch.containerId;
    if (patch.priority !== undefined) input.priority = patch.priority;

    let attached = [];
    let missing = [];
    if (patch.labels?.length) {
      const teamId = patch.containerId || (await this.getIssue(id)).containerId;
      ({ ids: input.labelIds, attached, missing } = await this.resolveLabelIds(patch.labels, {
        allowCreate: patch.allowCreateLabels, containerId: teamId,
      }));
    }
    if (patch.done !== undefined) {
      const teamId = patch.containerId || (await this.getIssue(id)).containerId;
      const stateId = patch.done ? await this.completedStateId(teamId) : null;
      if (stateId) input.stateId = stateId;
    }

    const data = await this.mutate(
      `mutation($id: String!, $input: IssueUpdateInput!) {
         issueUpdate(id: $id, input: $input) { success issue { ${LinearProvider.ISSUE_FIELDS} } }
       }`,
      { id, input },
      () => ({ issueUpdate: { issue: null } }),
    );
    const issue = data?.issueUpdate?.issue;
    if (!issue) return { ...dryIssue(patch.title || ''), id, key: id };
    return { ...this.toIssue(issue), labels: attached.length ? attached : this.toIssue(issue).labels, labelsMissing: missing };
  }

  async deleteIssue(id) {
    return this.mutate('mutation($id: String!) { issueDelete(id: $id) { success } }', { id }, { __dryRun: true });
  }

  async searchIssues({ query, containerId, openOnly = true, limit = 25 }) {
    const filter = {};
    if (containerId) filter.team = { id: { eq: containerId } };
    if (openOnly) filter.completedAt = { null: true };
    if (query) filter.title = { containsIgnoreCase: query };
    const data = await this.gql(
      `query($filter: IssueFilter, $first: Int!) {
         issues(filter: $filter, first: $first, orderBy: updatedAt) { nodes { ${LinearProvider.ISSUE_FIELDS} } }
       }`,
      { filter, first: limit },
    );
    return (data?.issues?.nodes || []).map((i) => this.toIssue(i));
  }

  async addComment(id, body) {
    const data = await this.mutate(
      'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }',
      { input: { issueId: id, body } },
      { __dryRun: true },
    );
    return { id: data?.commentCreate?.comment?.id ?? '0', __dryRun: data?.__dryRun };
  }

  async listComments(id) {
    const data = await this.gql(
      'query($id: String!) { issue(id: $id) { comments { nodes { id createdAt body } } } }', { id },
    );
    return (data?.issue?.comments?.nodes || []).map((c) => ({ id: c.id, createdAt: c.createdAt, body: c.body }));
  }

  async deleteComment(issueId, commentId) {
    return this.mutate('mutation($id: String!) { commentDelete(id: $id) { success } }', { id: commentId }, { __dryRun: true });
  }
}

export default LinearProvider;
