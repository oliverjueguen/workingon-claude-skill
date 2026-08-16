/**
 * One mock server impersonating all five ticketing APIs.
 *
 * Each provider is routed by a path prefix so a single origin can stand in for
 * every one of them. It reproduces the parts that actually bite: Vikunja's
 * PUT-creates and page cap, Jira's v2 shape and transitions, Linear's raw
 * Authorization header, GitHub's owner/repo paths, and Trello's query auth.
 */
import http from 'node:http';
import path from 'node:path';

export const TOKENS = {
  vikunja: 'tk_testtoken123',
  jira: 'jira-token',
  linear: 'lin_api_testkey',
  github: 'ghp_testtoken',
  trello: { key: 'trello-key', token: 'trello-token' },
};

export function createMock() {
  const state = {
    vikunja: {
      projects: [
        { id: 1, title: 'Inbox', identifier: 'INB' },
        { id: 4, title: 'Demo', identifier: 'DEMO' },
        ...Array.from({ length: 120 }, (_, i) => ({ id: 200 + i, title: `Team ${i + 1}`, identifier: `T${i + 1}` })),
      ],
      tasks: [], comments: {}, labels: [{ id: 7, title: 'Claude', hex_color: 'ff8c00' }],
      nextTask: 100, nextLabel: 20, nextComment: 500,
    },
    jira: { issues: {}, comments: {}, next: 1 },
    linear: { issues: {}, comments: {}, labels: [{ id: 'lab1', name: 'Claude', color: '#ff8c00' }], next: 1 },
    github: { issues: {}, comments: {}, labels: { 'acme/app': [{ name: 'Claude', color: 'ff8c00' }] }, next: 1 },
    trello: { cards: {}, comments: {}, labels: [{ id: 'tl1', name: 'Claude', color: 'orange' }], next: 1 },
    requests: [],
  };

  const MAX_PER_PAGE = 50;
  const send = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const page = (res, url, items) => {
    const perPage = Math.min(Number(url.searchParams.get('per_page') || MAX_PER_PAGE) || MAX_PER_PAGE, MAX_PER_PAGE);
    const n = Math.max(1, Number(url.searchParams.get('page') || 1));
    return send(res, 200, items.slice((n - 1) * perPage, n * perPage), {
      'x-pagination-total-pages': String(Math.max(1, Math.ceil(items.length / perPage))),
    });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const p = url.pathname;
    state.requests.push({ method: req.method, path: p, auth: req.headers.authorization });

    if (p === '/__state') return send(res, 200, state);

    // --- Vikunja ----------------------------------------------------------
    if (p.startsWith('/api/v1')) {
      const vp = p.replace('/api/v1', '');
      const S = state.vikunja;
      if (vp === '/info') return send(res, 200, { version: 'v2.5.0-mock', max_items_per_page: MAX_PER_PAGE });
      if (req.headers.authorization !== `Bearer ${TOKENS.vikunja}`) {
        return send(res, 401, { code: 11, message: 'invalid token' });
      }
      if (vp === '/user') return send(res, 200, { id: 1, username: 'demo' });
      if (vp === '/projects' && req.method === 'GET') return page(res, url, S.projects);
      if (vp === '/labels' && req.method === 'GET') return page(res, url, S.labels);
      if (vp === '/labels' && req.method === 'PUT') {
        const label = { id: S.nextLabel++, title: body.title, hex_color: body.hex_color };
        S.labels.push(label); return send(res, 201, label);
      }
      let m;
      if ((m = vp.match(/^\/projects\/(\d+)\/tasks$/)) && req.method === 'PUT') {
        const projectId = Number(m[1]);
        const project = S.projects.find((x) => x.id === projectId);
        if (!project) return send(res, 404, { message: 'project does not exist' });
        const index = S.tasks.filter((t) => t.project_id === projectId).length + 1;
        const task = {
          id: S.nextTask++, project_id: projectId, index, identifier: `${project.identifier}-${index}`,
          title: body.title, description: body.description || '', done: false, labels: [], percent_done: 0,
        };
        S.tasks.push(task); return send(res, 201, task);
      }
      if (vp === '/tasks' && req.method === 'GET') {
        const s = (url.searchParams.get('s') || '').toLowerCase();
        const filter = url.searchParams.get('filter') || '';
        let list = S.tasks.slice();
        if (filter.includes('done = false')) list = list.filter((t) => !t.done);
        const pm = filter.match(/project = (\d+)/);
        if (pm) list = list.filter((t) => t.project_id === Number(pm[1]));
        if (s) list = list.filter((t) => `${t.title} ${t.description}`.toLowerCase().includes(s));
        return send(res, 200, list);
      }
      if ((m = vp.match(/^\/tasks\/(\d+)$/))) {
        const task = S.tasks.find((t) => t.id === Number(m[1]));
        if (!task) return send(res, 404, { message: 'task does not exist' });
        if (req.method === 'GET') return send(res, 200, task);
        if (req.method === 'POST') { Object.assign(task, body, { id: task.id }); return send(res, 200, task); }
        if (req.method === 'DELETE') {
          S.tasks = S.tasks.filter((t) => t.id !== task.id); return send(res, 200, { message: 'deleted' });
        }
      }
      if ((m = vp.match(/^\/tasks\/(\d+)\/comments$/))) {
        const id = Number(m[1]);
        S.comments[id] = S.comments[id] || [];
        if (req.method === 'PUT') {
          const c = { id: S.nextComment++, comment: body.comment, created: new Date().toISOString() };
          S.comments[id].push(c); return send(res, 201, c);
        }
        return send(res, 200, S.comments[id]);
      }
      if ((m = vp.match(/^\/tasks\/(\d+)\/comments\/(\d+)$/)) && req.method === 'DELETE') {
        const list = S.comments[Number(m[1])] || [];
        const i = list.findIndex((c) => c.id === Number(m[2]));
        if (i < 0) return send(res, 404, { message: 'comment does not exist' });
        list.splice(i, 1); return send(res, 200, { message: 'deleted' });
      }
      if ((m = vp.match(/^\/tasks\/(\d+)\/labels$/)) && req.method === 'PUT') {
        const task = S.tasks.find((t) => t.id === Number(m[1]));
        if (task.labels.some((l) => l.id === body.label_id)) return send(res, 400, { message: 'already exists' });
        task.labels.push(S.labels.find((l) => l.id === body.label_id));
        return send(res, 201, { label_id: body.label_id });
      }
      return send(res, 404, { message: `no vikunja route ${req.method} ${vp}` });
    }

    // --- Jira -------------------------------------------------------------
    if (p.startsWith('/rest/api/2')) {
      const jp = p.replace('/rest/api/2', '');
      const S = state.jira;
      const expected = `Basic ${Buffer.from(`demo@acme.com:${TOKENS.jira}`).toString('base64')}`;
      if (req.headers.authorization !== expected) return send(res, 401, { errorMessages: ['invalid credentials'] });

      if (jp === '/myself') return send(res, 200, { emailAddress: 'demo@acme.com', displayName: 'Demo' });
      if (jp.startsWith('/project/search')) {
        return send(res, 200, { isLast: true, values: [{ key: 'DEMO', name: 'Demo project' }, { key: 'OPS', name: 'Ops' }] });
      }
      if (jp.startsWith('/label')) return send(res, 200, { values: ['Claude', 'bug'] });
      if (jp === '/issue' && req.method === 'POST') {
        // v3 would demand ADF here; v2 must accept a plain string.
        if (typeof body.fields?.description === 'object') {
          return send(res, 400, { errors: { description: 'Operation value must be a string' } });
        }
        const key = `DEMO-${S.next++}`;
        S.issues[key] = {
          key,
          fields: {
            summary: body.fields.summary, description: body.fields.description || '',
            labels: body.fields.labels || [], project: { key: body.fields.project.key },
            status: { statusCategory: { key: 'new' } },
          },
        };
        return send(res, 201, { key });
      }
      let m;
      if ((m = jp.match(/^\/issue\/([\w-]+)$/))) {
        const issue = S.issues[m[1]];
        if (!issue) return send(res, 404, { errorMessages: ['Issue does not exist'] });
        if (req.method === 'GET') return send(res, 200, issue);
        if (req.method === 'PUT') { Object.assign(issue.fields, body.fields || {}); return send(res, 204, {}); }
        if (req.method === 'DELETE') { delete S.issues[m[1]]; return send(res, 204, {}); }
      }
      if ((m = jp.match(/^\/issue\/([\w-]+)\/transitions$/))) {
        if (req.method === 'GET') {
          return send(res, 200, { transitions: [
            { id: '11', name: 'To Do', to: { statusCategory: { key: 'new' } } },
            { id: '31', name: 'Done', to: { statusCategory: { key: 'done' } } },
          ] });
        }
        const issue = S.issues[m[1]];
        issue.fields.status = { statusCategory: { key: body.transition.id === '31' ? 'done' : 'new' } };
        return send(res, 204, {});
      }
      if ((m = jp.match(/^\/issue\/([\w-]+)\/comment$/))) {
        const key = m[1];
        S.comments[key] = S.comments[key] || [];
        if (req.method === 'POST') {
          const c = { id: String(S.comments[key].length + 1), body: body.body, created: new Date().toISOString() };
          S.comments[key].push(c); return send(res, 201, c);
        }
        return send(res, 200, { comments: S.comments[key] });
      }
      if ((m = jp.match(/^\/issue\/([\w-]+)\/comment\/(\w+)$/)) && req.method === 'DELETE') {
        S.comments[m[1]] = (S.comments[m[1]] || []).filter((c) => c.id !== m[2]);
        return send(res, 204, {});
      }
      if (jp.startsWith('/search')) {
        const jql = url.searchParams.get('jql') || '';
        let list = Object.values(S.issues);
        if (jql.includes('statusCategory != Done')) list = list.filter((i) => i.fields.status.statusCategory.key !== 'done');
        return send(res, 200, { issues: list });
      }
      return send(res, 404, { errorMessages: [`no jira route ${req.method} ${jp}`] });
    }

    // --- Linear -----------------------------------------------------------
    if (p === '/graphql') {
      const S = state.linear;
      // Raw key, never "Bearer ...". Rejecting the prefix is the point.
      if (req.headers.authorization !== TOKENS.linear) {
        return send(res, 200, { errors: [{ message: 'Authentication required' }] });
      }
      const q = body.query || '';
      const v = body.variables || {};
      if (q.includes('viewer')) return send(res, 200, { data: { viewer: { id: 'u1', name: 'Demo', email: 'demo@acme.com' } } });
      if (q.includes('teams(')) return send(res, 200, { data: { teams: { nodes: [{ id: 'team1', name: 'Engineering', key: 'ENG' }] } } });
      if (q.includes('issueLabels(')) return send(res, 200, { data: { issueLabels: { nodes: S.labels } } });
      if (q.includes('issueLabelCreate')) {
        const label = { id: `lab${S.labels.length + 1}`, name: v.input.name, color: v.input.color };
        S.labels.push(label); return send(res, 200, { data: { issueLabelCreate: { success: true, issueLabel: label } } });
      }
      if (q.includes('issueCreate')) {
        const id = `iss${S.next}`;
        const issue = {
          id, identifier: `ENG-${S.next++}`, title: v.input.title, url: `https://linear.app/demo/issue/${id}`,
          description: v.input.description || '', completedAt: null, state: { type: 'unstarted' },
          team: { id: v.input.teamId }, labels: { nodes: (v.input.labelIds || []).map((lid) => S.labels.find((l) => l.id === lid)).filter(Boolean) },
        };
        S.issues[id] = issue;
        return send(res, 200, { data: { issueCreate: { success: true, issue } } });
      }
      if (q.includes('team(id')) {
        return send(res, 200, { data: { team: { states: { nodes: [
          { id: 'st1', name: 'Todo', type: 'unstarted' }, { id: 'st2', name: 'Done', type: 'completed' },
        ] } } } });
      }
      if (q.includes('issueUpdate')) {
        const issue = S.issues[v.id];
        if (v.input.title !== undefined) issue.title = v.input.title;
        if (v.input.description !== undefined) issue.description = v.input.description;
        if (v.input.stateId === 'st2') { issue.completedAt = new Date().toISOString(); issue.state = { type: 'completed' }; }
        if (v.input.teamId) issue.team = { id: v.input.teamId };
        if (v.input.labelIds) issue.labels = { nodes: v.input.labelIds.map((lid) => S.labels.find((l) => l.id === lid)).filter(Boolean) };
        return send(res, 200, { data: { issueUpdate: { success: true, issue } } });
      }
      if (q.includes('commentDelete')) {
        for (const k of Object.keys(S.comments)) S.comments[k] = S.comments[k].filter((c) => c.id !== v.id);
        return send(res, 200, { data: { commentDelete: { success: true } } });
      }
      if (q.includes('issueDelete')) { delete S.issues[v.id]; return send(res, 200, { data: { issueDelete: { success: true } } }); }
      if (q.includes('commentCreate')) {
        const id = `c${Object.keys(S.comments).length + 1}`;
        S.comments[v.input.issueId] = [...(S.comments[v.input.issueId] || []), { id, createdAt: new Date().toISOString(), body: v.input.body }];
        return send(res, 200, { data: { commentCreate: { success: true, comment: { id } } } });
      }
      if (q.includes('comments {')) {
        return send(res, 200, { data: { issue: { comments: { nodes: S.comments[v.id] || [] } } } });
      }
      if (q.includes('issue(id')) {
        const issue = S.issues[v.id];
        return send(res, 200, { data: { issue: issue || null } });
      }
      if (q.includes('issues(')) {
        let list = Object.values(S.issues);
        if (v.filter?.completedAt?.null) list = list.filter((i) => !i.completedAt);
        return send(res, 200, { data: { issues: { nodes: list } } });
      }
      return send(res, 200, { errors: [{ message: `no linear op for ${q.slice(0, 40)}` }] });
    }

    // --- GitHub -----------------------------------------------------------
    if (p.startsWith('/gh')) {
      const gp = p.replace('/gh', '');
      const S = state.github;
      if (req.headers.authorization !== `Bearer ${TOKENS.github}`) return send(res, 401, { message: 'Bad credentials' });
      if (gp === '/user') return send(res, 200, { login: 'demo' });
      if (gp.startsWith('/user/repos')) {
        return send(res, 200, Number(url.searchParams.get('page') || 1) > 1 ? []
          : [{ full_name: 'acme/app', private: false, archived: false }, { full_name: 'acme/docs', private: true, archived: false }]);
      }
      let m;
      if ((m = gp.match(/^\/repos\/([^/]+\/[^/]+)\/labels$/))) {
        const repo = m[1];
        if (req.method === 'GET') return send(res, 200, S.labels[repo] || []);
        S.labels[repo] = [...(S.labels[repo] || []), { name: body.name, color: body.color }];
        return send(res, 201, { name: body.name, color: body.color });
      }
      if ((m = gp.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/))) {
        const repo = m[1];
        if (req.method === 'POST') {
          const number = S.next++;
          const issue = {
            number, title: body.title, body: body.body || '', state: 'open',
            labels: (body.labels || []).map((n) => ({ name: n })), html_url: `https://github.com/${repo}/issues/${number}`,
          };
          S.issues[`${repo}#${number}`] = issue;
          return send(res, 201, issue);
        }
        const wanted = url.searchParams.get('state') || 'open';
        const list = Object.entries(S.issues)
          .filter(([k]) => k.startsWith(`${repo}#`))
          .map(([, i]) => i)
          .filter((i) => wanted === 'all' || i.state === wanted);
        // A real repo also returns pull requests here.
        return send(res, 200, [...list, { number: 999, title: 'a pull request', pull_request: {}, labels: [], state: 'open' }]);
      }
      if ((m = gp.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/))) {
        const key = `${m[1]}#${m[2]}`;
        const issue = S.issues[key];
        if (!issue) return send(res, 404, { message: 'Not Found' });
        if (req.method === 'GET') return send(res, 200, issue);
        Object.assign(issue, body, { labels: body.labels ? body.labels.map((n) => ({ name: n })) : issue.labels });
        return send(res, 200, issue);
      }
      if ((m = gp.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/))) {
        const key = `${m[1]}#${m[2]}`;
        S.comments[key] = S.comments[key] || [];
        if (req.method === 'POST') {
          const c = { id: S.comments[key].length + 1, body: body.body, created_at: new Date().toISOString() };
          S.comments[key].push(c); return send(res, 201, c);
        }
        return send(res, 200, S.comments[key]);
      }
      if ((m = gp.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/)) && req.method === 'DELETE') {
        for (const key of Object.keys(S.comments)) {
          S.comments[key] = S.comments[key].filter((c) => String(c.id) !== m[2]);
        }
        return send(res, 204, {});
      }
      return send(res, 404, { message: `no github route ${req.method} ${gp}` });
    }

    // --- Trello -----------------------------------------------------------
    if (p.startsWith('/1/')) {
      const tp = p.replace('/1', '');
      const S = state.trello;
      // Trello authenticates with query parameters, not headers.
      if (url.searchParams.get('key') !== TOKENS.trello.key || url.searchParams.get('token') !== TOKENS.trello.token) {
        return send(res, 401, 'invalid key');
      }
      if (tp === '/members/me') return send(res, 200, { username: 'demo', fullName: 'Demo' });
      if (tp === '/members/me/boards') return send(res, 200, [{ id: 'board1', name: 'Work', closed: false }]);
      let m;
      if ((m = tp.match(/^\/boards\/(\w+)\/lists$/))) return send(res, 200, [{ id: 'list1', name: 'Inbox', closed: false }]);
      if ((m = tp.match(/^\/boards\/(\w+)\/labels$/))) return send(res, 200, S.labels);
      if ((m = tp.match(/^\/lists\/(\w+)$/))) return send(res, 200, { id: m[1], idBoard: 'board1' });
      if ((m = tp.match(/^\/lists\/(\w+)\/cards$/))) {
        return send(res, 200, Object.values(S.cards).filter((c) => c.idList === m[1]));
      }
      if (tp === '/labels' && req.method === 'POST') {
        const label = { id: `tl${S.labels.length + 1}`, name: url.searchParams.get('name'), color: url.searchParams.get('color') };
        S.labels.push(label); return send(res, 200, label);
      }
      if (tp === '/cards' && req.method === 'POST') {
        const id = `card${S.next}`;
        const card = {
          id, idShort: S.next++, name: url.searchParams.get('name'), desc: url.searchParams.get('desc') || '',
          closed: false, idList: url.searchParams.get('idList'), shortUrl: `https://trello.com/c/${id}`,
          labels: (url.searchParams.get('idLabels') || '').split(',').filter(Boolean).map((lid) => S.labels.find((l) => l.id === lid)).filter(Boolean),
        };
        S.cards[id] = card; return send(res, 200, card);
      }
      if ((m = tp.match(/^\/cards\/(\w+)$/))) {
        const card = S.cards[m[1]];
        if (!card) return send(res, 404, 'card not found');
        if (req.method === 'GET') return send(res, 200, card);
        if (req.method === 'PUT') {
          if (url.searchParams.get('name')) card.name = url.searchParams.get('name');
          if (url.searchParams.get('desc')) card.desc = url.searchParams.get('desc');
          if (url.searchParams.get('closed')) card.closed = url.searchParams.get('closed') === 'true';
          if (url.searchParams.get('idList')) card.idList = url.searchParams.get('idList');
          return send(res, 200, card);
        }
        if (req.method === 'DELETE') { delete S.cards[m[1]]; return send(res, 200, {}); }
      }
      if ((m = tp.match(/^\/cards\/(\w+)\/actions\/comments$/)) && req.method === 'POST') {
        const id = `act${Object.keys(S.comments).length + 1}`;
        S.comments[m[1]] = [...(S.comments[m[1]] || []), { id, date: new Date().toISOString(), data: { text: url.searchParams.get('text') } }];
        return send(res, 200, { id });
      }
      if ((m = tp.match(/^\/cards\/(\w+)\/actions$/))) return send(res, 200, S.comments[m[1]] || []);
      if ((m = tp.match(/^\/cards\/(\w+)\/actions\/(\w+)\/comments$/)) && req.method === 'DELETE') {
        S.comments[m[1]] = (S.comments[m[1]] || []).filter((c) => c.id !== m[2]);
        return send(res, 200, {});
      }
      return send(res, 404, `no trello route ${req.method} ${tp}`);
    }

    return send(res, 404, { message: `unknown route ${p}` });
  });

  return { server, state };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { server } = createMock();
  const port = Number(process.env.MOCK_PORT || 8799);
  server.listen(port, () => console.log(`mock ticketing APIs on http://127.0.0.1:${port}`));
}
