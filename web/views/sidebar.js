// Sidebar: new session, search, session history (by date or project), budget and account.
import { h, clear, basename, relativeTime, formatCost, formatCredits, debounce, onNextFrame, projectFolder } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { state, on, emit, runtimeOf, savePreference, loadPreference } from '../lib/store.js';
import * as actions from '../lib/actions.js';
import { openMenu, openModal, toastError } from './dialogs.js';

export function mountSidebar(container) {
  let searchResults = [];
  let monthSpend = null;
  let frame = null;

  const searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Search sessions', 'aria-label': 'Search sessions' });
  searchInput.value = state.sidebar.query;
  const listElement = h('nav', { class: 'session-list' });
  const tabsElement = h('div', { class: 'list-tabs' });
  const budgetElement = h('div');
  const accountElement = h('div', { class: 'account-row' });

  const top = h(
    'div',
    { class: 'sidebar-top' },
    h('div', { class: 'brand', title: 'Caliope' }, h('img', { src: '/icon.svg', alt: '' }), h('span', { class: 'brand-name' }, 'caliope.')),
    h('button', { class: 'btn ghost small icon-only', title: 'New session (Ctrl+N)', 'aria-label': 'New session', html: icon('square-pen', 17), onClick: () => actions.showView('new') }),
    h('button', { class: 'btn ghost small icon-only', title: 'Hide sidebar (Ctrl+B)', 'aria-label': 'Hide sidebar', html: icon('panel-left', 17), onClick: () => emit('sidebar:toggle') }),
  );
  const searchBox = h('div', { class: 'search-box' }, h('span', { html: icon('search', 14) }), searchInput);
  const pullsButton = h('button', { class: 'btn ghost small nav-item', type: 'button', onClick: () => actions.showView('pulls') }, h('span', { html: icon('git-pull-request', 15) }), 'Pull requests');
  const full = h('div', { class: 'sidebar-full' }, top, h('div', { class: 'sidebar-actions' }, searchBox, pullsButton), tabsElement, listElement, h('div', { class: 'sidebar-bottom' }, budgetElement, accountElement));
  // Collapsed, the sidebar stays as a narrow rail of icons, so it can always be brought back.
  const waitingBadge = h('span', { class: 'rail-badge', hidden: true });
  const expandButton = railButton('panel-left', 'Show sidebar (Ctrl+B)', () => emit('sidebar:toggle'), waitingBadge);
  const rail = h(
    'div',
    { class: 'sidebar-rail' },
    expandButton,
    railButton('square-pen', 'New session (Ctrl+N)', () => actions.showView('new')),
    railButton('search', 'Search sessions (Ctrl+K)', () => {
      emit('sidebar:toggle');
      emit('sidebar:search');
    }),
    railButton('layers', 'Projects', () => {
      emit('sidebar:toggle');
      setTab('projects');
    }),
    railButton('git-pull-request', 'Pull requests', () => actions.showView('pulls')),
    h('span', { class: 'grow' }),
    railButton('chart-column', 'Spending', () => actions.showView('usage')),
    railButton('settings', 'Settings', () => actions.showView('settings')),
  );
  container.append(full, rail);
  let savedProjects = [];
  // Project groups the user folded, by folder in lower case.
  const collapsedProjects = new Set(loadPreference('collapsedProjects', []));

  function railButton(iconName, label, onClick, badge = null) {
    const button = h('button', { class: 'btn ghost icon-only rail-button', type: 'button', title: label, 'aria-label': label, onClick }, h('span', { html: icon(iconName, 18) }), badge);
    return button;
  }

  /** On the rail, the expand button shows how many sessions wait for an answer. */
  function renderRail() {
    const waiting = [...state.runtimes.values()].filter((runtime) => runtime.waiting).length;
    waitingBadge.hidden = waiting === 0;
    waitingBadge.textContent = String(waiting);
    expandButton.title = waiting ? `Show sidebar (Ctrl+B): ${waiting} ${waiting === 1 ? 'session needs' : 'sessions need'} you` : 'Show sidebar (Ctrl+B)';
  }

  const runSearch = debounce(async (query) => {
    if (query.trim().length < 2) {
      searchResults = [];
      scheduleRender();
      return;
    }
    try {
      const result = await api.get(`/api/search?q=${encodeURIComponent(query)}`);
      if (searchInput.value === query) {
        searchResults = result.results;
        scheduleRender();
      }
    } catch {
      searchResults = [];
    }
  }, 250);

  searchInput.addEventListener('input', () => {
    state.sidebar.query = searchInput.value;
    scheduleRender();
    runSearch(searchInput.value);
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      searchInput.value = '';
      state.sidebar.query = '';
      searchResults = [];
      scheduleRender();
      searchInput.blur();
    }
    if (event.key === 'Enter') {
      const first = listElement.querySelector('.session-item');
      first?.click();
    }
  });

  function scheduleRender() {
    if (frame) return;
    frame = onNextFrame(() => {
      frame = null;
      renderTabs();
      renderList();
      renderRail();
    });
  }

  function renderTabs() {
    clear(tabsElement);
    const archivedCount = [...state.sessions.values()].filter((meta) => meta.archived).length;
    const tabs = h(
      'div',
      { class: 'segmented' },
      h('button', { class: state.sidebar.tab === 'active' ? 'active' : '', onClick: () => setTab('active') }, 'Sessions'),
      h('button', { class: state.sidebar.tab === 'projects' ? 'active' : '', onClick: () => setTab('projects') }, 'Projects'),
      h('button', { class: state.sidebar.tab === 'archived' ? 'active' : '', onClick: () => setTab('archived') }, `Archived${archivedCount ? ` (${archivedCount})` : ''}`),
    );
    if (state.sidebar.tab === 'projects') {
      tabsElement.append(tabs, h('span', { class: 'grow' }), h('button', { class: 'btn ghost small icon-only', title: 'New project', 'aria-label': 'New project', html: icon('folder-plus', 16), onClick: openNewProjectDialog }));
      return;
    }
    const groupButton = h('button', {
      class: 'btn ghost small',
      title: 'Group sessions',
      onClick: (event) =>
        openMenu(event.currentTarget, [
          { section: 'Group by' },
          { label: 'Date', icon: 'history', checked: state.sidebar.group === 'date', onSelect: () => setGroup('date') },
          { label: 'Project folder', icon: 'folder', checked: state.sidebar.group === 'project', onSelect: () => setGroup('project') },
        ]),
    });
    groupButton.append(h('span', { html: icon(state.sidebar.group === 'date' ? 'history' : 'folder', 14) }), h('span', { html: icon('chevron-down', 12) }));
    tabsElement.append(tabs, h('span', { class: 'grow' }), groupButton);
  }

  function setTab(tab) {
    state.sidebar.tab = tab;
    scheduleRender();
  }

  function setGroup(group) {
    state.sidebar.group = group;
    savePreference('sidebarGroup', group);
    scheduleRender();
  }

  function renderProjects() {
    const query = state.sidebar.query.trim().toLowerCase();
    // Projects: the ones created here, plus every folder a session ran in.
    const byFolder = new Map();
    for (const project of savedProjects) {
      byFolder.set(project.folder.toLowerCase(), { folder: project.folder, name: project.name, sessions: 0, nanoAiu: 0, lastActivity: project.updatedAt || '' });
    }
    for (const meta of state.sessions.values()) {
      const folder = projectFolder(meta);
      const key = folder.toLowerCase();
      const entry = byFolder.get(key) || { folder, name: null, sessions: 0, nanoAiu: 0, lastActivity: '' };
      if (!meta.archived) entry.sessions++;
      entry.nanoAiu += meta.usage?.nanoAiu || 0;
      if (meta.updatedAt > entry.lastActivity) entry.lastActivity = meta.updatedAt;
      byFolder.set(key, entry);
    }
    const projects = [...byFolder.values()].filter((project) => !query || `${project.name || ''} ${project.folder}`.toLowerCase().includes(query)).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    if (projects.length === 0) {
      listElement.append(
        h(
          'div',
          { class: 'faint', style: { padding: '16px 10px', fontSize: '13px' } },
          'No projects yet. ',
          h('button', { class: 'btn small', style: { marginTop: '8px' }, onClick: openNewProjectDialog }, h('span', { html: icon('folder-plus', 14) }), 'New project'),
        ),
      );
      return;
    }
    for (const project of projects) {
      const active = state.view === 'project' && state.projectFolder?.toLowerCase() === project.folder.toLowerCase();
      listElement.append(
        h(
          'div',
          { class: `session-item${active ? ' active' : ''}`, role: 'button', tabindex: '0', title: project.folder, onClick: () => actions.openProject(project.folder) },
          h('span', { class: 'status', html: icon('folder', 14) }),
          h(
            'div',
            { class: 'body' },
            h('div', { class: 'title' }, project.name || basename(project.folder)),
            h('div', { class: 'sub' }, h('span', {}, `${project.sessions} session${project.sessions === 1 ? '' : 's'}`), project.lastActivity ? h('span', {}, `· ${relativeTime(project.lastActivity)}`) : null, h('span', { class: 'cost' }, formatCost(project.nanoAiu, state.settings?.costUnit))),
          ),
        ),
      );
    }
  }

  function renderList() {
    clear(listElement);
    if (state.sidebar.tab === 'projects') {
      renderProjects();
      return;
    }
    const query = state.sidebar.query.trim().toLowerCase();
    const archived = state.sidebar.tab === 'archived';
    let metas = [...state.sessions.values()].filter((meta) => Boolean(meta.archived) === archived);
    if (query) metas = metas.filter((meta) => `${meta.title} ${meta.cwd}`.toLowerCase().includes(query));
    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    if (metas.length === 0 && !query) {
      listElement.append(h('div', { class: 'faint', style: { padding: '16px 10px', fontSize: '13px' } }, archived ? 'No archived sessions.' : 'No sessions yet. Start one with the pen icon above (Ctrl+N).'));
    }
    const groups = [];
    if (!archived && !query) {
      const pinned = metas.filter((meta) => meta.pinned);
      if (pinned.length) groups.push(['Pinned', pinned, 'pin']);
      metas = metas.filter((meta) => !meta.pinned);
    }
    if (state.sidebar.group === 'project') {
      const byFolder = new Map();
      for (const meta of metas) {
        const folder = projectFolder(meta);
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder).push(meta);
      }
      for (const [folder, list] of byFolder) groups.push([basename(folder), list, 'folder', folder]);
    } else {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const day = 24 * 3600 * 1000;
      const buckets = [
        ['Today', startOfToday.getTime()],
        ['Yesterday', startOfToday.getTime() - day],
        ['Previous 7 days', startOfToday.getTime() - 7 * day],
        ['Previous 30 days', startOfToday.getTime() - 30 * day],
        ['Older', -Infinity],
      ];
      const grouped = new Map(buckets.map(([label]) => [label, []]));
      for (const meta of metas) {
        const time = new Date(meta.updatedAt).getTime();
        const bucket = buckets.find(([, start]) => time >= start);
        grouped.get(bucket[0]).push(meta);
      }
      for (const [label, list] of grouped) if (list.length) groups.push([label, list]);
    }
    for (const [label, list, iconName, folder] of groups) {
      if (folder) {
        listElement.append(projectGroup(folder, label, list));
        continue;
      }
      listElement.append(h('div', { class: 'group-label' }, iconName ? h('span', { html: icon(iconName, 12) }) : null, h('span', { class: 'ellipsis' }, label)));
      for (const meta of list) listElement.append(sessionItem(meta));
    }
    if (query && searchResults.length) {
      const shown = new Set(metas.map((meta) => meta.id));
      const extra = searchResults.filter((result) => !shown.has(result.id) && state.sessions.has(result.id));
      if (extra.length) {
        listElement.append(h('div', { class: 'group-label' }, h('span', { html: icon('text-search', 12) }), 'Found in conversations'));
        for (const result of extra) listElement.append(sessionItem(state.sessions.get(result.id), result.snippet));
      }
    }
    if (query && metas.length === 0 && searchResults.length === 0) {
      listElement.append(h('div', { class: 'faint', style: { padding: '16px 10px', fontSize: '13px' } }, 'No matching sessions.'));
    }
  }

  /**
   * A project's sessions under a header that folds them open and closed.
   * - The header's + starts a new session in the project, and the gear opens the project page.
   */
  function projectGroup(folder, label, sessions) {
    const key = folder.toLowerCase();
    const collapsed = collapsedProjects.has(key) && !state.sidebar.query.trim();
    const toggle = () => {
      if (collapsedProjects.has(key)) collapsedProjects.delete(key);
      else collapsedProjects.add(key);
      savePreference('collapsedProjects', [...collapsedProjects]);
      scheduleRender();
    };
    const button = (iconName, title, onClick) =>
      h('button', {
        class: 'btn ghost small icon-only',
        type: 'button',
        title,
        'aria-label': title,
        html: icon(iconName, 14),
        onClick: (event) => {
          event.stopPropagation();
          onClick();
        },
      });
    const header = h(
      'div',
      {
        class: 'group-label project-group',
        role: 'button',
        tabindex: '0',
        title: folder,
        'aria-expanded': String(!collapsed),
        onClick: toggle,
        onKeydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        },
      },
      h('span', { html: icon(collapsed ? 'chevron-right' : 'chevron-down', 12) }),
      h('span', { class: 'ellipsis grow' }, label),
      collapsed ? h('span', { class: 'count' }, String(sessions.length)) : null,
      h('span', { class: 'hover-actions' }, button('plus', 'New session in this project', () => actions.newSessionIn(folder)), button('settings', 'Project page', () => actions.openProject(folder))),
    );
    const group = h('div', {}, header, collapsed ? null : sessions.map((meta) => sessionItem(meta, null, false)));
    return group;
  }

  /** One session in the list. `showFolder` false: under its project's header, which names the folder already. */
  function sessionItem(meta, snippet = null, showFolder = true) {
    const runtime = runtimeOf(meta.id);
    let status;
    if (runtime.waiting) status = h('span', { class: 'status-dot waiting', title: 'Waiting for you' });
    else if (runtime.state === 'running') status = h('span', { class: 'spin', title: 'Working', html: icon('loader-circle', 13) });
    else if (meta.unread && state.activeId !== meta.id) status = h('span', { class: 'status-dot unread', title: 'New activity' });
    else status = h('span', { class: 'status-dot' });
    const usage = meta.usage || {};
    const cost = usage.requests ? formatCost(usage.nanoAiu, state.settings?.costUnit, { unpriced: usage.unpricedRequests || 0 }) : '';
    const more = h('button', {
      class: 'btn ghost small icon-only',
      title: 'More',
      html: icon('ellipsis', 14),
      onClick: (event) => {
        event.stopPropagation();
        openMenu(event.currentTarget, [
          { label: 'Rename', icon: 'square-pen', onSelect: () => actions.renameSession(meta.id) },
          { label: meta.pinned ? 'Unpin' : 'Pin to top', icon: meta.pinned ? 'pin-off' : 'pin', onSelect: () => actions.togglePin(meta.id) },
          { label: 'Fork into a new session', icon: 'git-fork', onSelect: () => actions.forkSession(meta.id) },
          { label: 'Export as Markdown', icon: 'download', onSelect: () => actions.exportSession(meta.id) },
          { label: 'Open folder in Explorer', icon: 'folder-open', onSelect: () => actions.openPath(meta.cwd) },
          'separator',
          { label: meta.archived ? 'Restore from archive' : 'Archive', icon: meta.archived ? 'archive-restore' : 'archive', onSelect: () => actions.toggleArchive(meta.id) },
          { label: 'Delete', icon: 'trash-2', danger: true, onSelect: () => actions.deleteSession(meta.id) },
        ]);
      },
    });
    const item = h(
      'div',
      {
        class: `session-item${state.activeId === meta.id ? ' active' : ''}${meta.unread && state.activeId !== meta.id ? ' unread' : ''}`,
        role: 'button',
        tabindex: '0',
        title: `${meta.title}\n${meta.cwd}`,
        onClick: () => actions.openSession(meta.id),
        onKeydown: (event) => {
          if (event.key === 'Enter') actions.openSession(meta.id);
        },
      },
      h('span', { class: 'status' }, status),
      h(
        'div',
        { class: 'body' },
        h('div', { class: 'title' }, meta.title),
        h('div', { class: 'sub' }, meta.schedule ? h('span', { title: `Scheduled task "${meta.schedule.name}"`, html: icon('history', 12) }) : null, showFolder ? h('span', { class: 'ellipsis' }, basename(projectFolder(meta))) : null, showFolder ? h('span', {}, '·') : null, h('span', {}, relativeTime(meta.updatedAt)), cost ? h('span', { class: 'cost' }, cost) : null),
        snippet ? h('div', { class: 'search-hit' }, `…${snippet}…`) : null,
      ),
      h('div', { class: 'hover-actions' }, more),
    );
    return item;
  }

  function renderBudget() {
    clear(budgetElement);
    const unit = state.settings?.costUnit || 'usd';
    const { allowance, error } = state.allowance || {};
    // The allowance counts all Copilot use of the account (github.com, editors, Copilot CLI). The last line only Caliope's.
    const widget = h('button', { class: 'budget-widget', title: 'Your Copilot allowance counts all your Copilot use: github.com, editors, Copilot CLI and Caliope. "This month in Caliope" counts only this app.', onClick: () => actions.showView('usage') });
    if (allowance && allowance.hasQuota && !allowance.unlimited && allowance.entitlement) {
      const used = allowance.used ?? Math.max(0, allowance.entitlement - (allowance.remaining ?? 0));
      const percentUsed = Math.min(100, Math.max(0, (used / allowance.entitlement) * 100));
      const credits = allowance.tokenBased !== false;
      const amount = (value) => (credits ? formatCredits(value, unit) : `${Math.round(value)} requests`);
      const meterClass = percentUsed >= 100 ? 'meter over' : percentUsed >= 80 ? 'meter warn' : 'meter';
      widget.append(
        h('div', { class: 'line' }, h('span', { class: 'muted' }, 'Copilot allowance'), h('span', {}, `${amount(allowance.remaining)} left`)),
        h('div', { class: meterClass }, h('div', { style: { width: `${percentUsed}%` } })),
        h('div', { class: 'line faint' }, h('span', {}, `${amount(used)} of ${amount(allowance.entitlement)} used`), h('span', {}, allowance.resetDate ? `resets ${new Date(allowance.resetDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '')),
      );
    } else if (allowance?.unlimited) {
      widget.append(h('div', { class: 'line' }, h('span', { class: 'muted' }, 'Copilot allowance'), h('span', {}, 'Unlimited')));
    } else {
      widget.append(h('div', { class: 'line' }, h('span', { class: 'muted' }, 'Copilot allowance'), h('span', { class: 'faint', title: error || '' }, state.auth?.signedIn ? 'Not available' : 'Sign in')));
    }
    widget.append(h('div', { class: 'line', style: { marginTop: '4px' } }, h('span', { class: 'muted' }, 'This month in Caliope'), h('span', {}, monthSpend ? formatCost(monthSpend.nanoAiu, unit, { unpriced: monthSpend.unpricedRequests }) : '—')));
    budgetElement.append(widget);
  }

  const loadMonthSpend = debounce(async () => {
    try {
      const summary = await api.get('/api/usage?period=month');
      monthSpend = summary.total;
      renderBudget();
    } catch {
      // The widget shows a dash.
    }
  }, 1500);

  function renderAccount() {
    clear(accountElement);
    // A copy unzipped by hand updates by unzipping the new version. The install line would add a second copy.
    if (state.update?.available && state.update.installed) accountElement.append(h('button', { class: 'btn small primary', title: 'A newer version of Caliope is available', onClick: () => actions.installUpdate() }, h('span', { html: icon('download', 14) }), `Update to ${state.update.latest}`));
    else if (state.update?.available) accountElement.append(h('a', { class: 'btn small primary', href: state.update.downloadUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Download the new zip and unzip it to a new folder' }, h('span', { html: icon('download', 14) }), `Get ${state.update.latest}`));
    const auth = state.auth;
    if (auth?.signedIn) {
      accountElement.append(h('span', { html: icon('user', 14), class: 'faint' }), h('span', { class: 'ellipsis grow', title: `Signed in with ${auth.kind === 'token' ? 'a personal access token' : 'GitHub'}` }, auth.login || 'Signed in'));
    } else {
      accountElement.append(h('button', { class: 'btn small primary grow', onClick: () => actions.showView('signin') }, h('span', { html: icon('key-round', 14) }), 'Sign in to Copilot'));
    }
    accountElement.append(
      h('button', { class: 'btn ghost small icon-only', title: 'Spending and allowance', html: icon('chart-column', 15), onClick: () => actions.showView('usage') }),
      h('button', { class: 'btn ghost small icon-only', title: 'Settings', html: icon('settings', 15), onClick: () => actions.showView('settings') }),
    );
  }

  async function loadSavedProjects() {
    try {
      savedProjects = (await api.get('/api/projects')).projects;
      scheduleRender();
    } catch {
      // The list still shows folders that have sessions.
    }
  }

  /** New project: a name and a folder (an existing one, or a new path that gets created). */
  function openNewProjectDialog() {
    const nameInput = h('input', { class: 'input', placeholder: 'For example: Billing service', autofocus: true });
    const folderInput = h('input', { class: 'input mono', placeholder: '' });
    const parent = state.settings?.recentFolders?.[0] ? state.settings.recentFolders[0].replace(/[\\/][^\\/]+$/, '') : `${state.boot.home}\\Projects`;
    const suggestion = () => `${parent}\\${(nameInput.value.trim() || 'my-project').replace(/[<>:"/\\|?*]+/g, '-')}`;
    const updatePlaceholder = () => {
      folderInput.placeholder = suggestion();
    };
    nameInput.addEventListener('input', updatePlaceholder);
    updatePlaceholder();
    const browse = h('button', {
      class: 'btn',
      type: 'button',
      onClick: async () => {
        try {
          const result = await api.post('/api/pick-folder', { initial: folderInput.value || parent });
          if (result.path) {
            folderInput.value = result.path;
            if (!nameInput.value.trim()) nameInput.value = basename(result.path);
          }
        } catch (error) {
          toastError(error);
        }
      },
    }, h('span', { html: icon('folder-open', 14) }), 'Browse…');
    const create = async (close) => {
      const folder = folderInput.value.trim() || suggestion();
      try {
        const result = await api.post('/api/projects', { folder, name: nameInput.value.trim(), create: true });
        close();
        await loadSavedProjects();
        actions.openProject(result.project.folder);
      } catch (error) {
        toastError(error);
      }
    };
    const dialog = openModal({
      title: 'New project',
      body: h(
        'div',
        { class: 'stack' },
        h('label', { class: 'stack', style: { gap: '4px' } }, h('span', { class: 'muted' }, 'Name'), nameInput),
        h('label', { class: 'stack', style: { gap: '4px' } }, h('span', { class: 'muted' }, 'Folder'), h('div', { class: 'row' }, folderInput, browse)),
        h('div', { class: 'faint', style: { fontSize: '12.5px' } }, 'Pick an existing folder, or type a new path and Caliope creates the folder. Leave it empty to use the suggested path.'),
      ),
      footer: (close) => [h('button', { class: 'btn', onClick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', onClick: () => create(close) }, 'Create project')],
    });
    for (const input of [nameInput, folderInput]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') create(dialog.close);
      });
    }
  }

  on('sessions', scheduleRender);
  on('runtime', scheduleRender);
  on('view', () => {
    pullsButton.classList.toggle('active', state.view === 'pulls');
    scheduleRender();
  });
  on('projects', loadSavedProjects);
  loadSavedProjects();
  on('allowance', renderBudget);
  on('update', renderAccount);
  on('settings', () => {
    renderBudget();
    scheduleRender();
  });
  on('usage', loadMonthSpend);
  on('auth', () => {
    renderAccount();
    renderBudget();
  });
  on('sidebar:search', () => {
    searchInput.focus();
    searchInput.select();
  });

  scheduleRender();
  renderBudget();
  renderAccount();
  loadMonthSpend();
  setInterval(scheduleRender, 60000);
}
