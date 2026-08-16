import fs from 'node:fs';
import path from 'node:path';

/**
 * Optional SpecKit (https://speckit.org) awareness.
 *
 * SpecKit projects keep their artifacts under `specs/<NNN-feature>/` with
 * `spec.md`, `plan.md` and `tasks.md`. When they exist we can name tickets after
 * the feature instead of guessing from the prompt, and reference task ids.
 * Everything here degrades silently on a non SpecKit repo.
 */

/**
 * @param {string} cwd
 * @param {object} [opts]
 * @param {string} [opts.branch] Current git branch. SpecKit names the branch
 *   after the feature, so it beats every other signal when it matches.
 */
export function detectSpecKit(cwd, { branch = '' } = {}) {
  const root = findRoot(cwd);
  if (!root) return null;

  const specsDir = path.join(root, 'specs');
  let features = [];
  try {
    features = fs.readdirSync(specsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = path.join(specsDir, d.name);
        let mtime = 0;
        for (const f of ['tasks.md', 'plan.md', 'spec.md']) {
          try { mtime = Math.max(mtime, fs.statSync(path.join(dir, f)).mtimeMs); } catch { /* absent */ }
        }
        const openTasks = readOpenTasks(dir);
        const ordinal = Number((d.name.match(/^(\d+)/) || [])[1] || 0);
        return { name: d.name, dir: dir.replace(/\\/g, '/'), mtime, openTasks, ordinal };
      })
      .filter((f) => f.mtime > 0);
  } catch { /* no specs dir */ }

  if (!features.length) return null;

  const active = pickActive(features, branch);
  return {
    root: root.replace(/\\/g, '/'),
    activeFeature: active.name,
    featureDir: active.dir,
    title: readSpecTitle(active.dir),
    openTasks: active.openTasks,
  };
}

function pickActive(features, branch) {
  // 1. The branch names the feature. This is the only reliable signal.
  const slug = String(branch).split('/').pop().toLowerCase();
  if (slug) {
    const exact = features.find((f) => f.name.toLowerCase() === slug);
    if (exact) return exact;
    const partial = features.find((f) => slug.startsWith(f.name.toLowerCase()) || f.name.toLowerCase().startsWith(slug));
    if (partial) return partial;
  }

  // 2. Otherwise a feature with work left beats a finished one, then most
  //    recently touched, then the highest ordinal. Never a coin flip.
  return features.slice().sort((a, b) => {
    const pending = (b.openTasks.length > 0) - (a.openTasks.length > 0);
    if (pending) return pending;
    if (b.mtime !== a.mtime) return b.mtime - a.mtime;
    return b.ordinal - a.ordinal;
  })[0];
}

function findRoot(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.specify')) || fs.existsSync(path.join(dir, 'specs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readSpecTitle(featureDir) {
  for (const f of ['spec.md', 'plan.md']) {
    try {
      const text = fs.readFileSync(path.join(featureDir, f), 'utf8');
      const m = text.match(/^#\s+(.+)$/m);
      if (m) return m[1].trim();
    } catch { /* absent */ }
  }
  return '';
}

/** Pull unchecked checklist items out of tasks.md, keeping any T### ids. */
function readOpenTasks(featureDir, limit = 15) {
  try {
    const text = fs.readFileSync(path.join(featureDir, 'tasks.md'), 'utf8');
    return text.split('\n')
      .map((line) => line.match(/^\s*[-*]\s+\[\s\]\s+(.*)$/))
      .filter(Boolean)
      .map((m) => {
        const body = m[1].trim();
        const id = body.match(/^\*{0,2}(T\d{3,})\*{0,2}/);
        return { id: id ? id[1] : '', text: body.replace(/^\*{0,2}T\d{3,}\*{0,2}\s*/, '') };
      })
      .slice(0, limit);
  } catch {
    return [];
  }
}
