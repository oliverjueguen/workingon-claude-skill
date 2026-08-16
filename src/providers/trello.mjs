import { Provider, DRY_RUN, dryIssue } from './base.mjs';

/**
 * Trello.
 *
 * A container is a list, not a board: cards live in lists, so that is the level
 * a ticket has to be filed at. Lists are shown grouped by board when picking.
 *
 * Trello has no notion of "done". The closest equivalent is archiving the card,
 * so that is what closing maps to. Label colours come from a fixed palette,
 * not hex.
 */
export class TrelloProvider extends Provider {
  static id = 'trello';
  static label = 'Trello';
  static blurb = 'Boards, lists and cards.';
  static containerNoun = 'list';
  static bodyFormat = 'markdown';

  static capabilities = {
    labels: true, createLabels: true, done: true, percent: false, priority: false,
    deleteIssue: true, deleteComment: true, moveContainer: true,
  };

  static credentialFields = [
    { key: 'key', label: 'API key', placeholder: 'from trello.com/power-ups/admin' },
    { key: 'token', label: 'API token', secret: true },
  ];

  static tokenHelp = {
    url: 'https://trello.com/power-ups/admin',
    steps: [
      'Go to trello.com/power-ups/admin and create a Power-Up, any name will do.',
      'Open its "API key" tab and copy the key.',
      'Next to the key, click "Token" and authorise. Copy the token that appears.',
      'Both values are needed: the key identifies the app, the token identifies you.',
    ],
  };

  static API = 'https://api.trello.com/1';
  /** Trello only accepts these label colours. */
  static COLORS = ['green', 'yellow', 'orange', 'red', 'purple', 'blue', 'sky', 'lime', 'pink', 'black'];

  auth(params = {}) {
    return new URLSearchParams({ ...params, key: this.credentials.key, token: this.credentials.token }).toString();
  }

  get apiBase() { return this.credentials.apiBase || TrelloProvider.API; }

  request(method, path, params = {}, simulate) {
    return this.http(method, `${this.apiBase}${path}?${this.auth(params)}`, {
      headers: { Accept: 'application/json' },
      simulate,
    });
  }

  toIssue(card, listId) {
    return {
      id: card.id,
      key: card.idShort ? `#${card.idShort}` : card.id.slice(-6),
      title: card.name || '',
      done: Boolean(card.closed),
      url: card.shortUrl || card.url || '',
      labels: (card.labels || []).map((l) => l.name).filter(Boolean),
      body: card.desc || '',
      containerId: card.idList || listId || '',
    };
  }

  async verify() {
    const me = await this.request('GET', '/members/me', { fields: 'username,fullName' });
    return { ok: true, account: me.username || me.fullName || '', detail: 'Trello REST' };
  }

  /** Lists across every board, labelled with their board so they can be told apart. */
  async listContainers() {
    const boards = await this.request('GET', '/members/me/boards', { fields: 'name,closed', filter: 'open' });
    const out = [];
    for (const board of boards || []) {
      const lists = await this.request('GET', `/boards/${board.id}/lists`, { fields: 'name,closed' });
      for (const list of lists || []) {
        out.push({ id: list.id, name: `${board.name} / ${list.name}`, group: board.name, archived: Boolean(list.closed) });
      }
    }
    return out;
  }

  async boardIdForList(listId) {
    const list = await this.request('GET', `/lists/${listId}`, { fields: 'idBoard' });
    return list.idBoard;
  }

  async listLabels(containerId) {
    if (!containerId) return [];
    const boardId = await this.boardIdForList(containerId);
    const labels = await this.request('GET', `/boards/${boardId}/labels`, { fields: 'name,color' });
    return (labels || []).filter((l) => l.name).map((l) => ({ id: l.id, name: l.name, color: l.color }));
  }

  /** Hex is not accepted, so anything unknown lands on the nearest sane default. */
  static toTrelloColor(color) {
    const value = String(color || '').replace(/^#/, '').toLowerCase();
    if (TrelloProvider.COLORS.includes(value)) return value;
    if (/^(ff8c00|ffa500|e8590c|fd7e14)$/.test(value)) return 'orange';
    return 'orange';
  }

  async createLabel(name, color, containerId) {
    const boardId = await this.boardIdForList(containerId);
    const created = await this.request('POST', '/labels', {
      name, color: TrelloProvider.toTrelloColor(color), idBoard: boardId,
    }, () => ({ id: '0', name, __dryRun: true }));
    return { id: created.id ?? '0', name: created.name ?? name, color: created.color };
  }

  async resolveLabelIds(containerId, names, { allowCreate }) {
    if (!names.length) return { ids: [], attached: [], missing: [] };
    const existing = await this.listLabels(containerId);
    const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l]));
    const ids = [];
    const attached = [];
    const missing = [];
    for (const name of names) {
      let label = byName.get(name.toLowerCase());
      if (!label) {
        if (!allowCreate) { missing.push(name); continue; }
        label = await this.createLabel(name, 'orange', containerId);
      }
      ids.push(label.id);
      attached.push(label.name);
    }
    return { ids, attached, missing };
  }

  async createIssue({ containerId, title, body, labels = [], allowCreateLabels = false }) {
    const { ids, attached, missing } = await this.resolveLabelIds(containerId, labels, { allowCreate: allowCreateLabels });
    const created = await this.request('POST', '/cards', {
      idList: containerId, name: title, ...(body ? { desc: body } : {}), ...(ids.length ? { idLabels: ids.join(',') } : {}),
    }, () => dryIssue(title));
    if (created.__dryRun) return { ...created, labelsMissing: missing };
    return { ...this.toIssue(created, containerId), labels: attached, labelsMissing: missing };
  }

  async getIssue(id) {
    return this.toIssue(await this.request('GET', `/cards/${id}`));
  }

  async updateIssue(id, patch) {
    const params = {};
    if (patch.title !== undefined) params.name = patch.title;
    if (patch.body !== undefined) params.desc = patch.body;
    // Archiving is the closest thing Trello has to closing.
    if (patch.done !== undefined) params.closed = String(Boolean(patch.done));
    if (patch.containerId !== undefined) params.idList = patch.containerId;

    let attached = [];
    let missing = [];
    if (patch.labels?.length) {
      const listId = patch.containerId || (await this.getIssue(id)).containerId;
      const resolved = await this.resolveLabelIds(listId, patch.labels, { allowCreate: patch.allowCreateLabels });
      attached = resolved.attached;
      missing = resolved.missing;
      if (resolved.ids.length) params.idLabels = resolved.ids.join(',');
    }
    if (!Object.keys(params).length) return this.getIssue(id);

    const updated = await this.request('PUT', `/cards/${id}`, params, () => ({ __dryRun: true }));
    if (updated.__dryRun) return { ...dryIssue(patch.title || ''), id, key: id };
    return { ...this.toIssue(updated), labels: attached.length ? attached : this.toIssue(updated).labels, labelsMissing: missing };
  }

  async deleteIssue(id) {
    return this.request('DELETE', `/cards/${id}`, {}, DRY_RUN);
  }

  async searchIssues({ query, containerId, openOnly = true, limit = 25 }) {
    if (!containerId) return [];
    const cards = await this.request('GET', `/lists/${containerId}/cards`, {
      fields: 'name,desc,closed,shortUrl,idShort,idList,labels',
    });
    return (cards || [])
      .filter((c) => (openOnly ? !c.closed : true))
      .filter((c) => !query || `${c.name} ${c.desc || ''}`.toLowerCase().includes(String(query).toLowerCase()))
      .slice(0, limit)
      .map((c) => this.toIssue(c, containerId));
  }

  async addComment(id, body) {
    const created = await this.request('POST', `/cards/${id}/actions/comments`, { text: body }, DRY_RUN);
    return { id: String(created.id ?? 0), __dryRun: created.__dryRun };
  }

  async listComments(id) {
    const actions = await this.request('GET', `/cards/${id}/actions`, { filter: 'commentCard' });
    return (actions || []).map((a) => ({ id: a.id, createdAt: a.date, body: a.data?.text || '' }));
  }

  async deleteComment(issueId, commentId) {
    return this.request('DELETE', `/cards/${issueId}/actions/${commentId}/comments`, {}, DRY_RUN);
  }
}

export default TrelloProvider;
