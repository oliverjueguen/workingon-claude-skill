import { VikunjaProvider } from './vikunja.mjs';
import { JiraProvider } from './jira.mjs';
import { LinearProvider } from './linear.mjs';
import { GitHubProvider } from './github.mjs';
import { TrelloProvider } from './trello.mjs';

/** Ordered by how likely someone is to be using it. */
export const PROVIDERS = [
  JiraProvider,
  LinearProvider,
  GitHubProvider,
  TrelloProvider,
  VikunjaProvider,
];

export const PROVIDER_IDS = PROVIDERS.map((P) => P.id);

export function getProviderClass(id) {
  const found = PROVIDERS.find((P) => P.id === String(id || '').toLowerCase());
  if (!found) {
    throw new Error(`Unknown ticketing tool "${id}". Available: ${PROVIDER_IDS.join(', ')}.`);
  }
  return found;
}

/**
 * Build a ready to use provider from the stored configuration.
 * @param {object} cfg Full config object.
 * @param {{dryRun?: boolean, onSimulate?: Function, providerId?: string}} [options]
 */
export function createProvider(cfg, options = {}) {
  const id = options.providerId || cfg.provider;
  if (!id) throw new Error('No ticketing tool configured yet. Run `workingon setup` to pick one.');

  const ProviderClass = getProviderClass(id);
  const credentials = (cfg.providers || {})[ProviderClass.id] || {};
  const provider = new ProviderClass(credentials, {
    dryRun: options.dryRun ?? Boolean(cfg.dryRun),
    onSimulate: options.onSimulate,
  });

  const missing = provider.missingCredentials();
  if (missing.length) {
    throw new Error(
      `${ProviderClass.label} is missing ${missing.join(' and ')}. Run \`workingon setup --step 1\` to fill it in.`,
    );
  }
  return provider;
}

/** Short table used by the setup wizard and by `providers`. */
export function describeProviders() {
  return PROVIDERS.map((P) => ({
    id: P.id,
    label: P.label,
    blurb: P.blurb,
    containerNoun: P.containerNoun,
    credentials: P.credentialFields.map((f) => f.key),
  }));
}
