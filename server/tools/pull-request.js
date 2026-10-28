// list_pull_requests: the open pull requests of this repository.
// create_pull_request: push the current branch and open a pull request on GitHub or Azure DevOps.
// merge_pull_request: merge one, after the user confirmed it.
import { pullRequestSource, createPullRequest, pullRequestToMerge, listPullRequests, providerName } from '../pull-requests.js';
import { ToolInputError } from './fs-tools.js';

// git runs the credential helper a repository's own settings name: only in a folder the user trusts.
const UNTRUSTED = 'The user has not trusted this folder, so Caliope does not use its git sign-in here. Ask the user to trust it on the project page.';

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
    },
    required: ['title', 'description'],
  },
  /** The repository and branch, for the approval prompt; a missing origin or detached HEAD stops here. */
  async prepare(input, ctx) {
    if (!ctx.trusted) throw new ToolInputError(UNTRUSTED);
    try {
      const source = await pullRequestSource(ctx.cwd, ctx.extraPath);
      return source;
    } catch (error) {
      throw new ToolInputError(error.message);
    }
  },
  async run(input, ctx, source) {
    const result = await createPullRequest({ cwd: ctx.cwd, source, title: input.title, description: input.description || '', target: input.target_branch || '', draft: Boolean(input.draft), endpoints: ctx.endpoints, signal: ctx.signal });
    const where = providerName(result);
    const note = source.uncommitted ? '\nThere are uncommitted changes; they are not in the pull request.' : '';
    let content;
    if (result.created) content = `Opened pull request ${result.number} on ${where}: ${result.url}`;
    else if (result.existing) content = `The branch was pushed. It already has an open pull request on ${where}: ${result.url}`;
    else content = `The branch was pushed, but ${result.reason} Ask the user to open the pull request on this page, where the title and branches are filled in: ${result.url}`;
    return { content: content + note, meta: { url: result.url, number: result.number ?? null, provider: result.provider, created: Boolean(result.created) } };
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
