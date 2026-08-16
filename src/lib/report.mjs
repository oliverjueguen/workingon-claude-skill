/**
 * Mechanical ticket text.
 *
 * Only used by the silent write style, where no model is in the loop. With
 * nudge, Claude writes far better copy, so this stays deliberately factual:
 * what was asked, what was touched, what was run.
 */

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 3).trimEnd()}...` : String(s));

const stripNoise = (s) => String(s)
  .replace(/\s+/g, ' ')
  .replace(/^(please|hey|ok|can you|could you)[,\s]+/i, '')
  .trim();

/**
 * @param {object} opts
 * @param {boolean} [opts.prefixProject] Prepend "[folder]". Only worth it when
 *   the ticket lands in a catch all destination shared by several folders.
 */
export function mechanicalTitle(summary, ctx, { prefixProject = false } = {}) {
  const first = summary.unsynced.prompts[0]?.text || summary.total?.prompts?.[0]?.text || '';
  let title = stripNoise(first);

  if (!title) title = stripNoise(summary.unsynced.commits[0]?.message || '');
  if (!title) {
    const files = summary.unsynced.files.slice(0, 2).map((f) => f.file.split('/').pop());
    title = files.length ? `Changes in ${files.join(', ')}` : 'Work with Claude Code';
  }

  const sentence = title.split(/(?<=[.?!])\s/)[0] || title;
  const clipped = clip(sentence, 80);
  const prefix = prefixProject && ctx?.project ? `[${ctx.project}] ` : '';
  return prefix + clipped.charAt(0).toUpperCase() + clipped.slice(1);
}

/** Files summarised on one line rather than listed. */
function filesLine(files) {
  if (!files.length) return '';
  const shown = files.slice(0, 3).map((f) => `\`${f.file.split('/').pop()}\``).join(', ');
  const rest = files.length - 3;
  return `- ${files.length} file${files.length === 1 ? '' : 's'}: ${shown}${rest > 0 ? ` and ${rest} more` : ''}`;
}

/**
 * A ticket is a reminder, not minutes. Everything left out here is still in the
 * code and in the git history, which is where people actually look.
 */
export function mechanicalBody(summary, ctx, { kind = 'create', limit = 600 } = {}) {
  const u = summary.unsynced;
  const lines = [];

  if (kind === 'create') {
    const first = u.prompts[0]?.text;
    if (first) lines.push(clip(first, 200), '');
  }

  const files = filesLine(u.files);
  if (files) lines.push(files);

  for (const c of u.commits.slice(0, 3)) {
    lines.push(`- commit \`${c.sha || '?'}\` ${clip(c.message || '', 70)}`);
  }
  if (u.commits.length > 3) lines.push(`- and ${u.commits.length - 3} more commits`);

  if (!lines.length) return 'No details recorded.';
  return clip(lines.join('\n').trim(), limit);
}
