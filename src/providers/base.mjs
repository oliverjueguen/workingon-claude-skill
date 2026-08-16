/**
 * Provider interface.
 *
 * Every ticketing tool is reduced to the same handful of operations. The words
 * differ per tool (Jira has projects, GitHub has repositories, Trello has
 * lists, Linear has teams) so the generic term used here is "container".
 *
 * A provider only has to be honest about what it cannot do: declare the
 * capability as false and the rest of the system routes around it instead of
 * failing.
 */

export class ProviderError extends Error {
  constructor(message, { status, provider, path } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
    this.path = path;
  }
}

/**
 * @typedef {Object} Container A project, board list, repository or team.
 * @property {string} id
 * @property {string} name
 * @property {boolean} [archived]
 * @property {string} [group] Parent grouping, shown to help pick one.
 *
 * @typedef {Object} Issue
 * @property {string} id      Identifier used for later calls.
 * @property {string} key     Human reference, such as PROJ-12 or #45.
 * @property {string} title
 * @property {boolean} done
 * @property {string} url
 * @property {string[]} labels
 *
 * @typedef {Object} Comment
 * @property {string} id
 * @property {string} createdAt
 * @property {string} body
 */

export class Provider {
  /** Stable key used in config and on the command line. */
  static id = 'base';
  /** Name shown to people. */
  static label = 'Base';
  /** One line shown in the setup wizard. */
  static blurb = '';
  /** What this tool calls a container, used to word prompts. */
  static containerNoun = 'project';
  /** `markdown` or `html`. Bodies are authored in markdown and converted. */
  static bodyFormat = 'markdown';

  static capabilities = {
    labels: true,
    createLabels: true,
    done: true,
    percent: false,
    priority: false,
    deleteIssue: true,
    deleteComment: true,
    moveContainer: true,
  };

  /**
   * Credentials the setup wizard asks for, in order.
   * @type {Array<{key: string, label: string, secret?: boolean, placeholder?: string, optional?: boolean}>}
   */
  static credentialFields = [];

  /** Where to get a token, shown verbatim during setup. */
  static tokenHelp = { url: '', steps: [] };

  constructor(credentials = {}, options = {}) {
    this.credentials = credentials;
    this.dryRun = Boolean(options.dryRun);
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.onSimulate = options.onSimulate;
  }

  get providerId() { return this.constructor.id; }

  /** Which credential fields are missing. Empty means ready to use. */
  missingCredentials() {
    return this.constructor.credentialFields
      .filter((f) => !f.optional && !String(this.credentials[f.key] || '').trim())
      .map((f) => f.key);
  }

  // --- transport ----------------------------------------------------------

  /**
   * Single choke point for HTTP. Handles the timeout, decodes the body, turns
   * failures into a ProviderError with a message worth reading, and short
   * circuits writes when running in dry run.
   */
  async http(method, url, { headers = {}, body, simulate, raw = false } = {}) {
    if (this.dryRun && method !== 'GET' && simulate !== undefined) {
      this.onSimulate?.({ provider: this.providerId, method, url, body });
      return typeof simulate === 'function' ? simulate() : simulate;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new ProviderError(`Timed out after ${this.timeoutMs}ms: ${method} ${url}`, { provider: this.providerId, path: url });
      }
      throw new ProviderError(`Could not reach ${new URL(url).host}: ${err.message}`, { provider: this.providerId, path: url });
    }
    clearTimeout(timer);

    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }

    if (!res.ok) {
      throw new ProviderError(
        `${method} ${new URL(url).pathname} returned ${res.status}: ${this.describeError(data, res)}`,
        { status: res.status, provider: this.providerId, path: url },
      );
    }
    return raw ? { data, headers: res.headers } : data;
  }

  /** Pull the useful part out of an error body. Overridden where it helps. */
  describeError(data, res) {
    if (!data) return res.statusText;
    if (typeof data === 'string') return data.slice(0, 200);
    return data.message || data.error || JSON.stringify(data).slice(0, 200);
  }

  // --- operations ---------------------------------------------------------
  /* eslint-disable no-unused-vars */

  /** @returns {Promise<{ok: boolean, account: string, detail?: string}>} */
  async verify() { throw new ProviderError('verify not implemented'); }

  /** @returns {Promise<Container[]>} */
  async listContainers() { throw new ProviderError('listContainers not implemented'); }

  /** @returns {Promise<Array<{id: string, name: string, color?: string}>>} */
  async listLabels(containerId) { return []; }

  async createLabel(name, color, containerId) {
    throw new ProviderError(`${this.constructor.label} cannot create labels`);
  }

  /** @returns {Promise<Issue>} */
  async createIssue({ containerId, title, body, labels, priority }) {
    throw new ProviderError('createIssue not implemented');
  }

  /** @returns {Promise<Issue>} */
  async getIssue(id) { throw new ProviderError('getIssue not implemented'); }

  /** @param {{title?: string, body?: string, done?: boolean, containerId?: string, labels?: string[], percent?: number, priority?: number}} patch */
  async updateIssue(id, patch) { throw new ProviderError('updateIssue not implemented'); }

  async deleteIssue(id) { throw new ProviderError(`${this.constructor.label} cannot delete issues through the API`); }

  /** @returns {Promise<Issue[]>} */
  async searchIssues({ query, containerId, openOnly = true, limit = 25 }) { return []; }

  async addComment(id, body) { throw new ProviderError('addComment not implemented'); }

  /** @returns {Promise<Comment[]>} */
  async listComments(id) { return []; }

  async deleteComment(issueId, commentId) {
    throw new ProviderError(`${this.constructor.label} cannot delete comments through the API`);
  }

  /* eslint-enable no-unused-vars */
}

/** Marker returned by write calls that were simulated rather than sent. */
export const DRY_RUN = { __dryRun: true };

export const dryIssue = (title = '') => ({
  id: '0', key: 'DRY-RUN', title, done: false, url: '', labels: [], __dryRun: true,
});
