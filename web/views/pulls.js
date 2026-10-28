// Pull requests page: the open pull requests in the repositories of the Caliope projects (GitHub and
// Azure DevOps), with a session to review or merge one.
import { h, clear, relativeTime } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import * as actions from '../lib/actions.js';
import { toastError } from './dialogs.js';

export function mountPullRequests(container) {
  let destroyed = false;
  const content = h('div');
  const refreshButton = h('button', { class: 'btn small', type: 'button', onClick: load }, h('span', { html: icon('refresh-cw', 14) }), 'Refresh');
  const page = h(
    'div',
    { class: 'page' },
    h(
      'div',
      { class: 'page-inner' },
      h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Pull requests'), refreshButton),
      h('p', { class: 'lead' }, 'Open pull requests in the repositories of your trusted projects, on GitHub and Azure DevOps. Caliope reads them with the git sign-in already on your PC.'),
      content,
    ),
  );
  container.append(h('div', { class: 'view' }, page));

  async function load() {
    refreshButton.disabled = true;
    clear(content).append(h('div', { class: 'faint' }, 'Loading…'));
    try {
      const result = await api.get('/api/pull-requests');
      if (!destroyed) render(result);
    } catch (error) {
      clear(content);
      toastError(error);
    } finally {
      refreshButton.disabled = false;
    }
  }

  function render({ repositories, hidden }) {
    clear(content);
    if (repositories.length === 0) content.append(h('div', { class: 'card faint' }, 'None of your trusted projects has a GitHub or Azure DevOps repository as its origin.'));
    for (const repository of repositories) content.append(repositoryCard(repository));
    if (hidden > 0) content.append(h('p', { class: 'faint', style: { fontSize: '13px', marginTop: '14px' } }, `${hidden} ${hidden === 1 ? 'project is' : 'projects are'} left out because ${hidden === 1 ? 'it is' : 'they are'} not trusted or the folder is gone. Trust a project on its page to see its pull requests.`));
  }

  function repositoryCard(repository) {
    const listUrl = repository.webUrl ? `${repository.webUrl}/${repository.provider === 'github' ? 'pulls' : 'pullrequests'}` : null;
    const card = h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'row' },
        h('strong', { class: 'grow ellipsis' }, repository.repository || repository.name),
        h('button', { class: 'btn ghost small', type: 'button', title: repository.folder, onClick: () => actions.openProject(repository.folder) }, h('span', { html: icon('folder', 13) }), repository.name),
        listUrl ? h('a', { class: 'btn ghost small', href: listUrl }, h('span', { html: icon('external-link', 13) }), repository.provider === 'github' ? 'GitHub' : 'Azure DevOps') : null,
      ),
    );
    if (repository.error) {
      card.append(h('div', { class: 'callout warn', style: { marginTop: '10px' } }, h('span', { html: icon('info', 15) }), repository.error));
    } else if (repository.pullRequests.length === 0) {
      card.append(h('div', { class: 'faint', style: { marginTop: '8px' } }, 'No open pull requests.'));
    } else {
      for (const pull of repository.pullRequests) card.append(pullRow(repository, pull));
    }
    return card;
  }

  function pullRow(repository, pull) {
    const details = [`${pull.source} → ${pull.target}`, pull.author, relativeTime(pull.updatedAt)].filter(Boolean).join(' · ');
    const row = h(
      'div',
      { class: 'pull-row' },
      h('span', { class: 'faint', html: icon('git-pull-request', 15) }),
      h(
        'div',
        { class: 'grow', style: { minWidth: 0 } },
        h('div', { class: 'ellipsis' }, h('a', { href: pull.url }, `#${pull.number} ${pull.title}`), pull.draft ? h('span', { class: 'chip', style: { marginLeft: '8px' } }, 'Draft') : null),
        h('div', { class: 'faint ellipsis', style: { fontSize: '12.5px' } }, details),
      ),
      h('button', { class: 'btn small', type: 'button', title: 'Start a session that reviews this pull request', onClick: () => startSession(repository, pull, 'review') }, 'Review'),
      h('button', { class: 'btn small', type: 'button', title: 'Start a session that merges it. You confirm the merge first', onClick: () => startSession(repository, pull, 'merge') }, 'Merge…'),
    );
    return row;
  }

  /** A new session in the project that reviews or merges the pull request; merging always asks first. */
  async function startSession(repository, pull, kind) {
    const host = repository.provider === 'github' ? 'GitHub' : 'Azure DevOps';
    const which = `${host} pull request #${pull.number} "${pull.title}" (${pull.source} → ${pull.target}): ${pull.url}`;
    const text =
      kind === 'review'
        ? `Review ${which}. Fetch both branches with git and read the changes against ${pull.target}. Don't check out the branch, change files or post comments. Report bugs, risks and missing tests, the most serious first.`
        : `Merge ${which} with the merge_pull_request tool.`;
    try {
      await actions.createSession({ cwd: repository.folder });
      await actions.sendMessage(text);
    } catch (error) {
      toastError(error);
    }
  }

  load();
  return {
    destroy() {
      destroyed = true;
    },
  };
}
