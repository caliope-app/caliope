// The cards above the message box when the agent waits for the user: a permission, a question, or a plan to review.
import { h, clear } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { renderMarkdown } from '../lib/markdown.js';
import { state, modelById } from '../lib/store.js';
import * as actions from '../lib/actions.js';
import { MODES } from './composer.js';
import { renderDiff } from './diff-view.js';
import { toast } from './dialogs.js';

/** The card for what the agent waits for (the runtime's `waiting`). */
export function approvalCard(waiting) {
  if (waiting.kind === 'question') return questionPrompt(waiting);
  if (waiting.kind === 'plan') return planPrompt(waiting);
  return permissionPrompt(waiting);
}

/**
 * Answer the waiting card with the keyboard: 1 allows and 3 denies a permission, 1 to 9 pick a question's option.
 * - A bare digit answers only when no text field has focus, so typing "1." in the message box never approves anything.
 * - With Alt (Alt+1, Alt+3) a digit of the top row answers from any field, the message box too. Its key code names the
 *   digit, also on AZERTY keyboards. Numpad digits never answer with Alt: they type a character, as Alt+130 types é.
 */
export function answerByKey(event, waiting) {
  if (!waiting || event.ctrlKey || event.metaKey) return;
  const tag = document.activeElement?.tagName;
  const inTextField = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || document.activeElement?.isContentEditable;
  if (inTextField && !event.altKey) return;
  const digit = event.altKey ? /^Digit([1-9])$/.exec(event.code)?.[1] : event.key;
  if (waiting.kind === 'permission') {
    // A merge takes a click on the card, with the method and branch choice shown there.
    if (digit === '1' && waiting.request !== 'merge') {
      event.preventDefault();
      actions.respond(waiting.id, { decision: 'allow' });
    } else if (digit === '3') {
      event.preventDefault();
      actions.respond(waiting.id, { decision: 'deny' });
    }
  } else if (waiting.kind === 'question' && /^[1-9]$/.test(digit) && waiting.options?.[Number(digit) - 1]) {
    event.preventDefault();
    actions.respond(waiting.id, { answer: waiting.options[Number(digit) - 1] });
  }
}

function permissionPrompt(waiting) {
  const feedback = h('input', { class: 'input', placeholder: 'Or tell the agent what to do instead, then press Enter', 'aria-label': 'Tell the agent what to do instead' });
  const deny = () => actions.respond(waiting.id, { decision: 'deny', feedback: feedback.value });
  feedback.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && feedback.value.trim()) deny();
  });
  const bodyElement = h('div', { class: 'approval-body' });
  if (waiting.agent) bodyElement.append(h('div', { class: 'callout info' }, h('span', { html: icon('sparkles', 15) }), `Asked by the subagent "${waiting.agent}"`));
  let title;
  let allowLabel = 'Allow';
  let alwaysButton;
  // Options the user sets on the card itself, sent with "allow" (the merge method).
  let choices = () => ({});
  if (waiting.request === 'edit') {
    title = `Allow ${waiting.tool === 'write_file' ? (waiting.preview?.created ? 'creating' : 'overwriting') : 'this edit to'} ${waiting.path}?`;
    if (waiting.outside) bodyElement.append(h('div', { class: 'callout warn' }, h('span', { html: icon('triangle-alert', 15) }), 'This file is outside the project folder.'));
    if (waiting.reason) bodyElement.append(h('div', { class: 'callout info' }, h('span', { html: icon('shield-check', 15) }), `Auto mode asks you: ${waiting.reason}`));
    if (waiting.warning) bodyElement.append(h('div', { class: 'callout warn' }, h('span', { html: icon('shield-alert', 15) }), waiting.warning));
    bodyElement.append(renderDiff(waiting.preview, { emptyText: 'No line changes.' }));
    alwaysButton = h('button', { class: 'btn', onClick: () => actions.respond(waiting.id, { decision: 'allow_session' }) }, 'Allow all edits (switch to auto-accept)');
  } else if (waiting.request === 'command') {
    title = 'Run this command?';
    allowLabel = 'Run';
    if (waiting.warning) bodyElement.append(h('div', { class: 'callout warn' }, h('span', { html: icon('shield-alert', 15) }), waiting.warning));
    if (waiting.reason) bodyElement.append(h('div', { class: 'callout info' }, h('span', { html: icon('shield-check', 15) }), `Auto mode asks you: ${waiting.reason}`));
    if (waiting.description) bodyElement.append(h('div', { class: 'muted' }, waiting.description));
    bodyElement.append(h('pre', { class: 'command' }, waiting.command));
    if (waiting.input) bodyElement.append(h('div', { class: 'faint', style: { fontSize: '12px' } }, 'With this input:'), h('pre', { class: 'command' }, waiting.input));
    if (waiting.cwd && waiting.cwd !== '.') bodyElement.append(h('div', { class: 'faint', style: { fontSize: '12px' } }, `In ${waiting.cwd}`));
    // Without a suggested prefix (the server sends none for commands that delete or change much), there is no
    // rule to remember, so the command can only be allowed once.
    if (waiting.suggestedPrefix) {
      const prefix = h('input', { class: 'input prefix-input', value: waiting.suggestedPrefix });
      alwaysButton = h(
        'span',
        { class: 'row always-allow' },
        h('label', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Always allow commands starting with'), prefix),
        h('button', { class: 'btn', title: 'For the rest of this session', onClick: () => actions.respond(waiting.id, { decision: 'allow_session', prefix: prefix.value }) }, 'Allow in session'),
        h('button', { class: 'btn', title: 'In every session of this project, from now on (remove it on the project page)', onClick: () => actions.respond(waiting.id, { decision: 'allow_project', prefix: prefix.value }) }, 'Allow in project'),
      );
    }
  } else if (waiting.request === 'pull_request') {
    title = `Open this pull request on ${waiting.provider === 'azure' ? 'Azure DevOps' : 'GitHub'}?`;
    allowLabel = 'Open';
    bodyElement.append(h('div', { class: 'muted' }, `${waiting.branch} → ${waiting.target || 'the default branch'} in ${waiting.repository}${waiting.draft ? ' (draft)' : ''}. The branch is pushed first.`));
    const linked = [waiting.reviewers?.length ? `Reviewers: ${waiting.reviewers.join(', ')}.` : '', waiting.workItems?.length ? `Work items: ${waiting.workItems.join(', ')}.` : ''].filter(Boolean);
    if (linked.length > 0) bodyElement.append(h('div', { class: 'muted' }, linked.join(' ')));
    if (waiting.uncommitted) bodyElement.append(h('div', { class: 'callout warn' }, h('span', { html: icon('triangle-alert', 15) }), 'There are uncommitted changes. They are not part of the pull request.'));
    bodyElement.append(h('div', { class: 'prose' }, h('p', {}, h('strong', {}, waiting.title))), h('div', { class: 'prose', html: renderMarkdown(waiting.description || '') }));
    alwaysButton = null;
  } else if (waiting.request === 'merge') {
    title = `Merge pull request ${waiting.number} on ${waiting.provider === 'azure' ? 'Azure DevOps' : 'GitHub'}?`;
    allowLabel = 'Merge';
    const methodNames = { squash: 'Squash into one commit', merge: 'Merge commit', rebase: 'Rebase' };
    const methodSelect = h('select', { class: 'input', style: { width: 'auto' }, 'aria-label': 'Merge method' }, waiting.methods.map((method) => h('option', { value: method, selected: method === waiting.method }, methodNames[method] || method)));
    const deleteBox = h('input', { type: 'checkbox', checked: waiting.deleteBranch });
    choices = () => ({ method: methodSelect.value, deleteBranch: deleteBox.checked });
    bodyElement.append(
      h('div', { class: 'prose' }, h('p', {}, h('strong', {}, waiting.title), ' ', h('a', { href: waiting.url, target: '_blank', rel: 'noreferrer' }, 'Open'))),
      h('div', { class: 'muted' }, `${waiting.source} into ${waiting.target} in ${waiting.repository}, at commit ${String(waiting.headSha || '').slice(0, 8)}. Required checks and reviews have passed.`),
      ...(waiting.warnings || []).map((warning) => h('div', { class: 'callout warn' }, h('span', { html: icon('triangle-alert', 15) }), warning)),
      h('div', { class: 'row', style: { marginTop: '8px' } }, methodSelect, h('label', { class: 'row', style: { gap: '6px' } }, deleteBox, `Delete ${waiting.source} afterwards`)),
    );
    alwaysButton = null;
  } else if (waiting.request === 'schedule') {
    const modeName = MODES.find((mode) => mode.id === waiting.mode)?.name || waiting.mode;
    title = waiting.remove ? `Remove the scheduled task "${waiting.name}"?` : `Schedule "${waiting.name}"?`;
    allowLabel = waiting.remove ? 'Remove' : 'Schedule';
    if (waiting.reason) bodyElement.append(h('div', { class: 'callout info' }, h('span', { html: icon('shield-check', 15) }), `Auto mode asks you: ${waiting.reason}`));
    bodyElement.append(
      h('div', { class: 'muted' }, waiting.remove ? `It runs ${waiting.when}.` : `${waiting.when[0].toUpperCase()}${waiting.when.slice(1)}, ${waiting.here ? 'in this session' : 'in a new session each time'}, while Caliope runs, in ${modeName} mode. The project page lists it.`),
      h('pre', { class: 'command' }, waiting.prompt),
    );
    alwaysButton = null;
  } else if (waiting.request === 'mcp') {
    title = `Let ${waiting.server} run ${waiting.toolName}?`;
    allowLabel = 'Run';
    bodyElement.append(h('div', { class: 'muted' }, `A tool of the MCP server "${waiting.server}". The server does not mark it read-only, so it may change things.`));
    bodyElement.append(h('pre', { class: 'command' }, waiting.input || '{}'));
    alwaysButton = h('button', { class: 'btn', onClick: () => actions.respond(waiting.id, { decision: 'allow_session' }) }, `Allow ${waiting.toolName} in session`);
  } else if (waiting.request === 'browser') {
    title = waiting.action === 'navigate' ? `Let the agent's browser open ${waiting.host || 'this page'}?` : `Let the agent's browser act on ${waiting.host || 'this page'}?`;
    if (waiting.reason) bodyElement.append(h('div', { class: 'callout info' }, h('span', { html: icon('shield-check', 15) }), `Auto mode asks you: ${waiting.reason}`));
    bodyElement.append(h('pre', { class: 'command' }, waiting.detail || waiting.url || ''));
    bodyElement.append(h('div', { class: 'faint', style: { fontSize: '12px' } }, waiting.planMode ? 'Plan mode: page actions ask every time, because clicks and typing can change things.' : 'The agent uses its own browser window, with this project\'s profile, not your own browser.'));
    alwaysButton = waiting.planMode || !waiting.host
      ? null
      : h(
          'span',
          { class: 'row' },
          h('button', { class: 'btn', onClick: () => actions.respond(waiting.id, { decision: 'allow_session' }) }, 'Allow site in session'),
          h('button', { class: 'btn', title: `In every session of this project, from now on (remove it on the project page)`, onClick: () => actions.respond(waiting.id, { decision: 'allow_project' }) }, 'Allow site in project'),
        );
  } else if (waiting.query) {
    title = 'Search the web?';
    bodyElement.append(h('pre', { class: 'command' }, waiting.query));
    bodyElement.append(h('div', { class: 'faint', style: { fontSize: '12px' } }, 'The search terms go to GitHub Copilot\'s web search, or to DuckDuckGo when that isn\'t available.'));
    alwaysButton = h('button', { class: 'btn', onClick: () => actions.respond(waiting.id, { decision: 'allow_session' }) }, 'Allow web searches in session');
  } else {
    title = 'Fetch this web page?';
    if (waiting.reason) bodyElement.append(h('div', { class: 'callout info' }, h('span', { html: icon('shield-check', 15) }), `Auto mode asks you: ${waiting.reason}`));
    bodyElement.append(h('pre', { class: 'command' }, waiting.url));
    alwaysButton = h('button', { class: 'btn', onClick: () => actions.respond(waiting.id, { decision: 'allow_session' }) }, `Allow ${waiting.host || 'this site'} in session`);
  }
  const allowButton = h('button', { class: 'btn primary', title: waiting.request === 'merge' ? null : 'Key 1, or Alt+1 while you type in a text field', onClick: () => actions.respond(waiting.id, { decision: 'allow', ...choices() }) }, allowLabel, waiting.request === 'merge' ? null : h('kbd', {}, '1'));
  const denyButton = h('button', { class: 'btn danger', title: 'Key 3, or Alt+3 while you type in a text field', onClick: deny }, 'Deny', h('kbd', {}, '3'));
  const card = h(
    'div',
    { class: 'approval' },
    h('div', { class: 'approval-head' }, h('span', { html: icon('hand', 16) }), h('span', { class: 'grow ellipsis' }, title)),
    bodyElement,
    h('div', { class: 'approval-actions' }, allowButton, alwaysButton, denyButton, feedback),
  );
  return card;
}

function questionPrompt(waiting) {
  const answer = h('input', { class: 'input', placeholder: 'Type your answer and press Enter', 'aria-label': 'Your answer' });
  const send = (text) => text.trim() && actions.respond(waiting.id, { answer: text.trim() });
  answer.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') send(answer.value);
  });
  const card = h(
    'div',
    { class: 'approval plan' },
    h('div', { class: 'approval-head' }, h('span', { html: icon('message-square', 16) }), h('span', { class: 'grow' }, 'The agent has a question')),
    h('div', { class: 'approval-body' }, h('div', { class: 'prose', html: renderMarkdown(waiting.question || '') }), waiting.options?.length ? h('div', { class: 'option-buttons' }, waiting.options.map((option, index) => h('button', { class: 'btn', title: index < 9 ? `Key ${index + 1}, or Alt+${index + 1} while you type in a text field` : null, onClick: () => send(option) }, option, index < 9 ? h('kbd', {}, String(index + 1)) : null))) : null),
    h('div', { class: 'approval-actions' }, answer, h('button', { class: 'btn primary', onClick: () => send(answer.value) }, 'Send answer')),
  );
  return card;
}

function planPrompt(waiting) {
  const buildModels = state.models.filter((model) => model.protocol && model.toolCalls && model.policyState !== 'disabled');
  const modelSelect = h('select', { class: 'select', style: { width: 'auto' }, 'aria-label': 'Model to build with' }, buildModels.map((model) => h('option', { value: model.id }, model.name)));
  modelSelect.value = waiting.buildModel || state.modelDefaults.build || '';
  const effortSelect = h('select', { class: 'select', style: { width: 'auto' }, 'aria-label': 'Effort to build with' });
  const fillEfforts = () => {
    clear(effortSelect);
    const efforts = modelById(modelSelect.value)?.efforts || [];
    for (const effort of efforts) effortSelect.append(h('option', { value: effort }, effort));
    effortSelect.hidden = efforts.length === 0;
    if (efforts.includes(waiting.buildEffort)) effortSelect.value = waiting.buildEffort;
  };
  fillEfforts();
  modelSelect.addEventListener('change', fillEfforts);
  const modeSelect = h(
    'select',
    { class: 'select', style: { width: 'auto' }, 'aria-label': 'Mode to build in' },
    h('option', { value: 'auto' }, 'Auto'),
    h('option', { value: 'edits' }, 'Accept edits'),
    h('option', { value: 'ask' }, 'Ask permissions'),
    h('option', { value: 'full' }, 'Full access'),
  );
  // Build in the mode new sessions start in (Settings), unless that is Plan.
  if (['auto', 'edits', 'ask', 'full'].includes(state.settings?.defaultMode)) modeSelect.value = state.settings.defaultMode;
  const feedback = h('textarea', { class: 'textarea', rows: 2, placeholder: 'What should change in the plan? (Ctrl+Enter to send)', 'aria-label': 'What should change in the plan' });
  const approve = () => actions.respond(waiting.id, { decision: 'approve', mode: modeSelect.value, model: modelSelect.value, effort: effortSelect.hidden ? null : effortSelect.value });
  const revise = () => {
    if (!feedback.value.trim()) {
      feedback.focus();
      toast('Write what should change first.');
      return;
    }
    actions.respond(waiting.id, { decision: 'revise', feedback: feedback.value });
  };
  feedback.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.ctrlKey) revise();
  });
  const card = h(
    'div',
    { class: 'approval plan' },
    h('div', { class: 'approval-head' }, h('span', { html: icon('map', 16) }), h('span', { class: 'grow' }, 'The plan is ready for your review'), h('button', { class: 'btn ghost small', onClick: () => document.querySelector(`[data-tool-use-id="${waiting.toolUseId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 'Read the plan')),
    h(
      'div',
      { class: 'approval-body' },
      h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('span', { class: 'muted' }, 'Build with'), modelSelect, effortSelect, h('span', { class: 'muted' }, 'in'), modeSelect, h('span', { class: 'muted' }, 'mode')),
      feedback,
    ),
    h('div', { class: 'approval-actions' }, h('button', { class: 'btn primary', onClick: approve }, h('span', { html: icon('check', 15) }), 'Approve and build'), h('button', { class: 'btn', onClick: revise }, 'Request changes')),
  );
  return card;
}
