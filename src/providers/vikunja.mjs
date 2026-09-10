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
    // Columnas de kanban. `moveContainer` mueve entre PROYECTOS; esto mueve entre
    // columnas del mismo proyecto, que es otra cosa y se confunden con facilidad.
    buckets: true,
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

  /**
   * The kanban board of a project: its columns, and which one means "not started"
   * and which one means "finished".
   *
   * Buckets hang off a VIEW, not off the project, so the kanban view has to be
   * found first. It is found by `view_kind`, never by title or id: a board can be
   * renamed and the ids differ per project, so anything else breaks silently on the
   * next project.
   *
   * Returns null when the project has no kanban view, which is a normal state and
   * not an error: a list-only project simply has no columns to move things between.
   */
  async board(projectId) {
    const views = await this.request('GET', `/projects/${projectId}/views`);
    const kanban = (Array.isArray(views) ? views : []).find((v) => v.view_kind === 'kanban');
    if (!kanban) return null;

    // `/buckets` devuelve SOLO metadatos de las columnas. Su campo `count` viene a
    // cero y no trae `tasks`, aunque la columna este llena: en el tablero de
    // pruebas devolvia cero con cincuenta tareas dentro. Para saber que hay en cada
    // columna hay que usar `/views/{vista}/tasks`, que es lo que hace `boardTasks`.
    // Confundirlos hace creer que un tablero esta vacio cuando no lo esta.
    const buckets = await this.request('GET', `/projects/${projectId}/views/${kanban.id}/buckets`);
    return {
      viewId: kanban.id,
      // Vikunja marks these on the view itself. `doneBucketId` matters more than it
      // looks: when it is set, marking a task done moves it to that column on its
      // own, and moving it there marks it done. So closing a ticket needs no extra
      // call, and adding one would be a second write racing the first.
      defaultBucketId: kanban.default_bucket_id || null,
      doneBucketId: kanban.done_bucket_id || null,
      buckets: (Array.isArray(buckets) ? buckets : []).map((b) => ({
        id: b.id, title: b.title, limit: b.limit || 0,
      })),
    };
  }

  /**
   * The column that means "in progress".
   *
   * Vikunja names the first and the last column (`default_bucket_id` and
   * `done_bucket_id`) but has no notion of a middle one, so it has to be inferred.
   * The rule is deliberately narrow: whatever is neither the default nor the done
   * column, and ONLY when there is exactly one such column.
   *
   * With two or more it returns null instead of guessing. Guessing here would move
   * a ticket to a column the person did not choose, which is worse than doing
   * nothing: it looks like it worked.
   */
  static inProgressBucket(board) {
    if (!board) return null;
    const middle = board.buckets.filter(
      (b) => b.id !== board.defaultBucketId && b.id !== board.doneBucketId,
    );
    return middle.length === 1 ? middle[0] : null;
  }

  /**
   * The board with what is actually in it: each column and the tasks inside.
   *
   * This is the only endpoint that answers "which column is this task in". Neither
   * the task object (`bucket_id` comes back as 0) nor the bucket listing (`count`
   * comes back as 0) will tell you, which is a trap worth naming: both look like
   * valid answers and both are wrong.
   */
  async boardTasks(projectId, viewId) {
    const cols = await this.request('GET', `/projects/${projectId}/views/${viewId}/tasks`);
    return (Array.isArray(cols) ? cols : []).map((b) => ({
      id: b.id,
      title: b.title,
      count: b.count || 0,
      tasks: (Array.isArray(b.tasks) ? b.tasks : []).map((t) => ({
        id: String(t.id), title: t.title, done: Boolean(t.done),
      })),
    }));
  }

  /**
   * Which column a task sits in, or null when it is not on the board.
   *
   * Uses `expand=buckets` on the v2 API, which answers for one task instead of
   * making us read the whole board. On a board with a hundred cards that is 1,8 KB
   * against 176 KB, and this runs on every link.
   *
   * The v2 API lives alongside the v1 one this provider otherwise speaks, and the
   * same `tk_` token works on both. Mixing dialects is deliberate rather than
   * untidy: v1 is what the rest of this file is written against and works, and v2
   * is the only place this particular answer exists cheaply. Do not "unify" them
   * without checking each call, because the verbs differ (on v1 PUT creates; on v2
   * PUT replaces).
   */
  async bucketOf(taskId, projectId, viewId) {
    try {
      const v2 = this.apiRoot.replace(/\/api\/v1$/, '/api/v2');
      const task = await this.http('GET', `${v2}/tasks/${taskId}?expand=buckets`, {
        headers: {
          Authorization: `Bearer ${this.credentials.token}`,
          Accept: 'application/json',
        },
      });
      const here = (task?.buckets || []).find((b) => Number(b.project_view_id) === Number(viewId));
      if (here) return { id: here.id, title: here.title };
      // An empty `buckets` means the task really is on no board, so fall through
      // rather than reporting a column that is not there.
      if (Array.isArray(task?.buckets)) return null;
    } catch {
      // Older instances have no v2. Reading the whole board still works.
    }

    const cols = await this.boardTasks(projectId, viewId);
    const col = cols.find((c) => c.tasks.some((t) => t.id === String(taskId)));
    return col ? { id: col.id, title: col.title } : null;
  }

  /**
   * Moves a task into a column.
   *
   * Endpoint and body taken from the running instance's own OpenAPI document
   * (`/api/v1/docs.json`, Vikunja 2.5): POST to
   * `/projects/{project}/views/{view}/buckets/{bucket}/tasks` with a `models.TaskBucket`.
   * `project_view_id` plus `task_id` are a unique index, so repeating the same move
   * is harmless.
   */
  async moveToBucket(taskId, projectId, viewId, bucketId) {
    return this.request(
      'POST',
      `/projects/${projectId}/views/${viewId}/buckets/${bucketId}/tasks`,
      { task_id: Number(taskId), project_view_id: Number(viewId), bucket_id: Number(bucketId) },
      DRY_RUN,
    );
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
