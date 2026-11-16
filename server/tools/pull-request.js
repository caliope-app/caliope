// list_pull_requests: the open pull requests of this repository.
// read_pull_request: one pull request with its reviewers, policies or checks, and comments.
// create_pull_request: push the current branch and open a pull request on GitHub or Azure DevOps.
// merge_pull_request: merge one, after the user confirmed it.
import { pullRequestSource, createPullRequest, pullRequestToMerge, listPullRequests, readPullRequest, providerName } from '../pull-requests.js';
import { ToolInputError } from './fs-tools.js';
import { truncateMiddle } from '../util.js';

// git runs the credential helper a repository's own settings name: only in a folder the user trusts.
const UNTRUSTED = 'The user has not trusted this folder, so Caliope does not use its git sign-in here. Ask the user to trust it on the project page.';
const MAX_RESULT_CHARS = 30000;

export const listPullRequestsTool = {
  name: 'list_pull_requests',
  kind: 'read',
  description:
    'List the open pull requests of this repository on GitHub or Azure DevOps: number, title, author, branches, last change and link. ' +
    'It signs in with the git credentials on this PC, so never read git credentials or tokens yourself.',
  inputSchema: { type: 'object', properties: {} },
  async run(input, ctx) {
    if (!ctx.trusted) throw new ToolInputError(UNTRUSTED);
    let listed;
    try {
      listed = await listPullRequests({ cwd: ctx.cwd, extraPath: ctx.extraPath, endpoints: ctx.endpoints, signal: ctx.signal });
    } catch (error) {
      throw new ToolInputError(error.message);
    }
    if (!listed) throw new ToolInputError('origin is not a GitHub or Azure DevOps repository, or this folder is not a git repository.');
    const where = providerName(listed);
    const lines = listed.pullRequests.map((pull) => `- #${pull.number} ${pull.title}${pull.draft ? ' (draft)' : ''}: ${pull.source} → ${pull.target}, by ${pull.author || 'unknown'}${pull.updatedAt ? `, ${pull.updatedAt.slice(0, 10)}` : ''}. ${pull.url}`);
    const content = lines.length ? `Open pull requests in ${listed.repository} on ${where}:\n${lines.join('\n')}` : `${listed.repository} on ${where} has no open pull requests.`;
    return { content, meta: { count: lines.length, provider: listed.provider } };
  },
};

export const readPullRequestTool = {
  name: 'read_pull_request',
  kind: 'read',
  description:
    'Read one pull request on GitHub or Azure DevOps: description, reviewers and their votes, linked work items, branch policies or checks with their state, and the comment threads. ' +
    'Use it to see review feedback, or why a pull request cannot be merged yet. It signs in with the git credentials on this PC.',
  inputSchema: {
    type: 'object',
    properties: { number: { type: 'integer', description: 'The pull request number. Default: the open pull request for the current branch.' } },
  },
  async run(input, ctx) {
    if (!ctx.trusted) throw new ToolInputError(UNTRUSTED);
    let pull;
    try {
      pull = await readPullRequest({ cwd: ctx.cwd, extraPath: ctx.extraPath, number: input.number || null, endpoints: ctx.endpoints, signal: ctx.signal });
    } catch (error) {
      throw new ToolInputError(error.message);
    }
    const azure = pull.provider === 'azure';
    const lines = [`Pull request ${pull.number} in ${pull.repository} on ${providerName(pull)}: ${pull.title}`, `${pull.state}${pull.draft ? ', draft' : ''}. ${pull.source} → ${pull.target}, by ${pull.author || 'unknown'}. ${pull.url}`];
    if (pull.mergeCheck) lines.push(`Merge check: ${pull.mergeCheck}.`);
    lines.push(`Reviewers: ${pull.reviewers.length ? pull.reviewers.map((reviewer) => `${reviewer.name} (${reviewer.vote}${reviewer.required ? ', required' : ''})`).join(', ') : 'none'}.`);
    if (azure) lines.push(pull.workItems ? `Work items: ${pull.workItems.length ? pull.workItems.join(', ') : 'none linked'}.` : 'Caliope could not read the linked work items.');
    const checksName = azure ? 'Policies' : 'Checks';
    if (pull.checks) lines.push(`${checksName}: ${pull.checks.length ? pull.checks.map((check) => `${check.name}: ${check.status}${check.required ? ' (required)' : ''}`).join('; ') : 'none'}.`);
    else lines.push(`Caliope could not read the ${checksName.toLowerCase()}.`);
    lines.push('', 'Description:', pull.description.trim() || '(none)', '', pull.threads.length ? `Comments (${pull.threads.length} thread${pull.threads.length === 1 ? '' : 's'}):` : 'No comments.');
    for (const thread of pull.threads) {
      const heading = [thread.status, thread.path ? `${thread.path}${thread.line ? ` line ${thread.line}` : ''}` : ''].filter(Boolean).join(', ');
      lines.push(`- ${heading || 'On the pull request'}:`);
      for (const comment of thread.comments) lines.push(`  ${comment.author || 'unknown'}${comment.date ? ` (${comment.date.slice(0, 10)})` : ''}: ${comment.text.trim().replace(/\n/g, '\n    ')}`);
    }
    if (pull.commentsCut) lines.push('', 'GitHub returned only the first 100 reviews, comments or code comments, so later ones and their votes are missing here. The pull request page shows them all.');
    const content = truncateMiddle(lines.join('\n'), MAX_RESULT_CHARS);
    return { content, meta: { url: pull.url, number: pull.number, provider: pull.provider, threads: pull.threads.length } };
  },
};

export const createPullRequestTool = {
  name: 'create_pull_request',
  kind: 'pull_request',
  description:
    'Push the current branch to origin and open a pull request on GitHub or Azure DevOps, signed in with the git credentials on this PC. ' +
    'Commit the work first. Write a short, specific title and a description that says what changed and why, how it was verified, and what the reviewer should know. ' +
    'The user approves the pull request before it is opened.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The pull request title.' },
      description: { type: 'string', description: 'The description, in Markdown.' },
      target_branch: { type: 'string', description: 'The branch to merge into. Default: the repository\'s default branch.' },
      draft: { type: 'boolean', description: 'Open it as a draft. Default false.' },
      reviewers: { type: 'array', items: { type: 'string' }, description: 'Reviewers to add: email addresses or identity IDs on Azure DevOps, user names on GitHub. Default: none.' },
      work_items: { type: 'array', items: { type: 'integer' }, description: 'Azure DevOps work item IDs to link, for example when a branch policy requires a linked work item.' },
    },
    required: ['title', 'description'],
  },
  /** The repository and branch, for the approval prompt; a missing origin or detached HEAD stops here. */
  async prepare(input, ctx) {
    if (!ctx.trusted) throw new ToolInputError(UNTRUSTED);
    let source;
    try {
      source = await pullRequestSource(ctx.cwd, ctx.extraPath);
    } catch (error) {
      throw new ToolInputError(error.message);
    }
    if (source.remote.provider === 'github' && input.work_items?.length) throw new ToolInputError('Work items are linked on Azure DevOps only. On GitHub, write "Fixes #123" in the description to link an issue.');
    return source;
  },
  async run(input, ctx, source) {
    const reviewers = (input.reviewers || []).map(String);
    const workItems = input.work_items || [];
    const result = await createPullRequest({ cwd: ctx.cwd, source, title: input.title, description: input.description || '', target: input.target_branch || '', draft: Boolean(input.draft), reviewers, workItems, endpoints: ctx.endpoints, signal: ctx.signal });
    const where = providerName(result);
    const notes = [];
    if (result.descriptionCut) notes.push('Azure DevOps takes at most 4,000 characters of description, so the description was cut there. The rest is not on the pull request.');
    if (result.warning) notes.push(result.warning);
    if (!result.created && !result.existing && (reviewers.length || workItems.length)) notes.push('Ask the user to add the reviewers and work items on that page too.');
    if (result.existing && (reviewers.length || workItems.length)) notes.push('The reviewers and work items were not added to that pull request: they go in only with a new one. Ask the user to add them on its page.');
    if (source.uncommitted) notes.push('There are uncommitted changes; they are not in the pull request.');
    let content;
    if (result.created) content = `Opened pull request ${result.number} on ${where}: ${result.url}`;
    else if (result.existing) content = `The branch was pushed. It already has an open pull request on ${where}: ${result.url}`;
    else content = `The branch was pushed, but ${result.reason} Ask the user to open the pull request on this page, where the title and branches are filled in: ${result.url}`;
    return { content: [content, ...notes].join('\n'), meta: { url: result.url, number: result.number ?? null, provider: result.provider, created: Boolean(result.created) } };
  },
};

export const mergePullRequestTool = {
  name: 'merge_pull_request',
  kind: 'merge',
  description:
    'Merge a pull request on GitHub or Azure DevOps (complete it, in Azure DevOps terms), signed in with the git credentials on this PC. ' +
    'Only use this when the user asked you to merge, never as the next step after opening a pull request. The user confirms every merge, also with full access. ' +
    'It refuses while required checks, reviews or branch policies have not passed, or while there are conflicts; never try to work around that.',
  inputSchema: {
    type: 'object',
    properties: {
      number: { type: 'integer', description: 'The pull request number. Default: the open pull request for the current branch.' },
      method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'squash, merge (a merge commit) or rebase. Default: squash when the repository allows it. The user can change it when confirming.' },
      delete_branch: { type: 'boolean', description: 'Delete the source branch after merging. Default false.' },
    },
  },
  /** The pull request and whether it can be merged now, for the approval prompt; anything blocking stops here. */
  async prepare(input, ctx) {
    if (!ctx.trusted) throw new ToolInputError(UNTRUSTED);
    try {
      const toMerge = await pullRequestToMerge({ cwd: ctx.cwd, extraPath: ctx.extraPath, number: input.number || null, method: input.method || null, endpoints: ctx.endpoints, signal: ctx.signal });
      return toMerge;
    } catch (error) {
      throw new ToolInputError(error.message);
    }
  },
  async run(input, ctx, toMerge) {
    // The approval card may have changed the method and the branch choice (see permissions.js).
    const deleteBranch = typeof toMerge.deleteBranch === 'boolean' ? toMerge.deleteBranch : Boolean(input.delete_branch);
    const result = await toMerge.merge({ method: toMerge.method, deleteBranch, signal: ctx.signal });
    const where = providerName(toMerge);
    let content;
    if (result.completed) content = `Merged pull request ${toMerge.number} (${toMerge.source} into ${toMerge.target}) on ${where}${result.commit ? ` as ${result.commit.slice(0, 12)}` : ''}.${result.branchDeleted ? ` The branch ${toMerge.source} was deleted.` : ''} ${toMerge.url}`;
    else content = `${where} accepted the merge of pull request ${toMerge.number} and is still completing it. Check the page: ${toMerge.url}`;
    return { content, meta: { url: toMerge.url, number: toMerge.number, provider: toMerge.provider, merged: result.completed } };
  },
};
