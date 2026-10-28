// Pull requests on GitHub and Azure DevOps (Azure Repos).
// - Signed in with git's own credentials for the remote (`git credential fill`, on Windows usually Git
//   Credential Manager): the sign-in that `git push` already uses, so no gh, az or separate token is needed.
// - Without a usable sign-in, the result is the host's "create pull request" page to open in the browser.
import { findGit, runGit } from './tools/files.js';
import { sleep } from './util.js';

// git may show Git Credential Manager's sign-in window, but never waits for typing in a console.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0' };
// Azure DevOps refuses longer pull request descriptions.
const MAX_AZURE_DESCRIPTION = 4000;

/**
 * Where a git remote lives, from its URL, or null for other hosts.
 * - GitHub: https://github.com/owner/repo(.git), git@github.com:owner/repo(.git), ssh://git@github.com/owner/repo.
 * - Azure DevOps: https://(org@)dev.azure.com/org/project/_git/repo, https://org.visualstudio.com/(DefaultCollection/)project/_git/repo,
 *   git@ssh.dev.azure.com:v3/org/project/repo, org@vs-ssh.visualstudio.com:v3/org/project/repo.
 * - Returns { provider: 'github', owner, repo, webUrl } or { provider: 'azure', organization, project, repository, baseUrl, webUrl }.
 */
export function parseRemote(remoteUrl) {
  const url = String(remoteUrl || '').trim();
  const github = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  if (github) {
    const [, owner, repo] = github;
    return { provider: 'github', owner, repo, webUrl: `https://github.com/${owner}/${repo}` };
  }
  const decode = (parts) => {
    try {
      return parts.map(decodeURIComponent);
    } catch {
      return null;
    }
  };
  // Decoded names go into git's credential lookup (one line per field) and into the API address: an
  // organization is letters, digits and hyphens, and no name may hold a line break or slash.
  const usable = (organization, project, repository) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(organization) && ![project, repository].some((name) => /[\x00-\x1f\\/]/.test(name));
  const azure =
    /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)\/?$/i.exec(url) ||
    /^(?:git@ssh\.dev\.azure\.com|[^@/]+@vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i.exec(url);
  const visualStudio = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)\/?$/i.exec(url);
  const names = decode((azure || visualStudio || []).slice(1));
  if (!names || names.length !== 3 || !usable(...names)) return null;
  const [organization, project, repository] = names;
  const baseUrl = azure ? `https://dev.azure.com/${organization}` : `https://${organization}.visualstudio.com`;
  return azureRemote(organization, project, repository, baseUrl);
}

/** A remote address for messages, without a user name or token it may contain. */
function shownRemote(remoteUrl) {
  const shown = remoteUrl.replace(/\/\/[^@/]*@/, '//');
  return shown;
}

function azureRemote(organization, project, repository, baseUrl) {
  const remote = { provider: 'azure', organization, project, repository, baseUrl, webUrl: `${baseUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}` };
  return remote;
}

/**
 * The repository and branch a pull request from `cwd` would use: { gitExe, remote, branch, uncommitted }.
 * - Throws a message the agent can act on when there is no origin, it is not GitHub or Azure DevOps, or HEAD is detached.
 */
export async function pullRequestSource(cwd, extraPath) {
  const gitExe = findGit(extraPath);
  if (!gitExe) throw new Error('git was not found on this PC.');
  const remoteUrl = (await runGit(gitExe, ['remote', 'get-url', 'origin'], cwd).catch(() => '')).trim();
  if (!remoteUrl) throw new Error('This repository has no remote named origin to open a pull request on.');
  const remote = parseRemote(remoteUrl);
  if (!remote) throw new Error(`Caliope opens pull requests on GitHub and Azure DevOps; origin is ${shownRemote(remoteUrl)}.`);
  // The approval names the fetch address. A pushurl or pushInsteadOf setting could send the commits elsewhere.
  // A folder on this PC is fine: nothing leaves the PC.
  const pushUrls = (await runGit(gitExe, ['remote', 'get-url', '--push', '--all', 'origin'], cwd)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const elsewhere = pushUrls.find((pushUrl) => {
    if (/^[A-Za-z]:[\\/]/.test(pushUrl) || /^file:\/\/\/[A-Za-z]:/i.test(pushUrl)) return false;
    const target = parseRemote(pushUrl);
    return !target || target.provider !== remote.provider || repositoryName(target).toLowerCase() !== repositoryName(remote).toLowerCase();
  });
  if (elsewhere) throw new Error(`origin pushes to ${shownRemote(elsewhere)}, not to ${repositoryName(remote)}. Caliope only pushes to the repository it opens the pull request in.`);
  const branch = (await runGit(gitExe, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
  if (!branch || branch === 'HEAD') throw new Error('HEAD is detached. Create or check out a branch for the pull request first.');
  const uncommitted = (await runGit(gitExe, ['status', '--porcelain'], cwd)).trim().length > 0;
  const source = { gitExe, remote, branch, uncommitted };
  return source;
}

/**
 * Push the current branch to origin and open a pull request into `target` (the default branch when empty).
 * - `endpoints`: { githubApi, azureDevOpsUrl } (the API addresses, which tests point at a mock).
 * - Returns { created, url, number, provider, existing?, reason? }. `created` is false when it only gives the
 *   "create pull request" page (no sign-in) or found an open pull request for the branch.
 */
export async function createPullRequest({ cwd, source, title, description = '', target = '', draft = false, endpoints, signal }) {
  const { gitExe, remote, branch } = source;
  const credential = await gitCredential(gitExe, cwd, remote);
  const api = apiFor(remote, credential, endpoints);
  const base = target || (credential ? await api.defaultBranch(signal).catch(() => null) : null);
  if (base && base === branch) throw new Error(`The current branch is ${branch}, the branch to merge into. Commit the work on a new branch first.`);
  await runGit(gitExe, ['push', '--set-upstream', 'origin', 'HEAD'], cwd, { timeoutMs: 180000, env: GIT_ENV });
  if (!credential || !base) {
    const reason = credential ? `${providerName(remote)} did not accept git's sign-in for this repository.` : `git has no saved sign-in for ${providerName(remote)}.`;
    return { created: false, provider: remote.provider, url: api.createPageUrl(branch, base, title, description), reason };
  }
  const result = await api.create({ branch, base, title, description, draft, signal });
  return { provider: remote.provider, ...result };
}

/**
 * The pull request to merge, checked: `number`, or the open one for the current branch.
 * - Returns { provider, repository, number, title, url, source, target, headSha, methods, method, warnings, merge }, where
 *   merge({ method, deleteBranch, signal }) merges exactly the commit the user approved.
 * - Throws when there is no sign-in, or while checks, reviews or branch policies block it: Caliope never bypasses them.
 */
export async function pullRequestToMerge({ cwd, extraPath, number, method, endpoints, signal }) {
  const gitExe = findGit(extraPath);
  if (!gitExe) throw new Error('git was not found on this PC.');
  const remoteUrl = (await runGit(gitExe, ['remote', 'get-url', 'origin'], cwd).catch(() => '')).trim();
  const remote = parseRemote(remoteUrl);
  if (!remote) throw new Error(remoteUrl ? `Caliope merges pull requests on GitHub and Azure DevOps; origin is ${shownRemote(remoteUrl)}.` : 'This repository has no remote named origin.');
  const branch = number ? null : (await runGit(gitExe, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
  if (!number && (!branch || branch === 'HEAD')) throw new Error('HEAD is detached. Give the pull request number.');
  const credential = await gitCredential(gitExe, cwd, remote);
  if (!credential) throw new Error(`git has no saved sign-in for ${providerName(remote)}, so Caliope cannot merge. Ask the user to merge it on ${providerName(remote)}.`);
  const api = apiFor(remote, credential, endpoints);
  const pullRequest = await api.pullRequest({ number, branch, signal });
  if (pullRequest.blockers.length > 0) throw new Error(`Pull request ${pullRequest.number} cannot be merged now: ${pullRequest.blockers.join(' ')} Do not try to work around this; tell the user. ${pullRequest.url}`);
  // Squash is the usual choice for one pull request. The user can pick another allowed method on the card.
  const chosen = method || ['squash', 'merge', 'rebase'].find((name) => pullRequest.methods.includes(name));
  if (!pullRequest.methods.includes(chosen)) throw new Error(`This repository does not allow the merge method "${chosen}". Allowed: ${pullRequest.methods.join(', ')}.`);
  const toMerge = { provider: remote.provider, repository: repositoryName(remote), ...pullRequest, method: chosen, merge: (options) => api.merge({ pullRequest, ...options }) };
  return toMerge;
}

/**
 * The open pull requests of the repository in `cwd`, newest first, or null when origin is not on GitHub
 * or Azure DevOps.
 * - Returns { provider, repository, webUrl, pullRequests: [{ number, title, url, author, source, target, draft, updatedAt }] }.
 * - Uses only a sign-in git already saved: listing never opens a sign-in window. Throws when there is none.
 */
export async function listPullRequests({ cwd, extraPath, endpoints, signal }) {
  const gitExe = findGit(extraPath);
  if (!gitExe) throw new Error('git was not found on this PC.');
  const remote = parseRemote((await runGit(gitExe, ['remote', 'get-url', 'origin'], cwd).catch(() => '')).trim());
  if (!remote) return null;
  const credential = await gitCredential(gitExe, cwd, remote, { interactive: false });
  if (!credential) throw new Error(`git has no saved sign-in for ${providerName(remote)}. Push or pull once in this repository, then try again.`);
  const pullRequests = await apiFor(remote, credential, endpoints).list(signal);
  const listed = { provider: remote.provider, repository: repositoryName(remote), webUrl: remote.webUrl, pullRequests };
  return listed;
}

/** The pull request API of the remote's host (see githubApi and azureApi). */
function apiFor(remote, credential, endpoints) {
  const api = remote.provider === 'github' ? githubApi(remote, credential, endpoints) : azureApi(remote, credential, endpoints);
  return api;
}

/** The repository as people write it: owner/repo on GitHub, organization/project/repository on Azure DevOps. */
export function repositoryName(remote) {
  const name = remote.provider === 'github' ? `${remote.owner}/${remote.repo}` : `${remote.organization}/${remote.project}/${remote.repository}`;
  return name;
}

/**
 * git's saved credential for the remote's https address (also for an SSH remote), or null.
 * - `interactive: false`: Git Credential Manager answers only from what it saved, without a sign-in window.
 */
async function gitCredential(gitExe, cwd, remote, { interactive = true } = {}) {
  const address = new URL(remote.provider === 'github' ? `${remote.webUrl}.git` : remote.webUrl);
  const input = `protocol=https\nhost=${address.host}\npath=${decodeURIComponent(address.pathname.slice(1))}\n\n`;
  try {
    const env = interactive ? GIT_ENV : { ...GIT_ENV, GCM_INTERACTIVE: 'never' };
    const output = await runGit(gitExe, ['credential', 'fill'], cwd, { input, timeoutMs: interactive ? 180000 : 20000, env });
    const values = Object.fromEntries(output.split(/\r?\n/).filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    return values.password ? values : null;
  } catch {
    return null;
  }
}

function githubApi(remote, credential, endpoints) {
  const repoUrl = `${endpoints.githubApi}/repos/${remote.owner}/${remote.repo}`;
  const headers = { Authorization: `Bearer ${credential?.password}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Caliope' };
  return {
    async defaultBranch(signal) {
      const repository = await request(repoUrl, { headers, signal });
      return repository.ok ? repository.data.default_branch : null;
    },
    async list(signal) {
      const open = await request(`${repoUrl}/pulls?state=open&sort=updated&direction=desc&per_page=50`, { headers, signal });
      if (!open.ok || !Array.isArray(open.data)) throw new Error(`GitHub did not list the pull requests (HTTP ${open.status}): ${open.data?.message || 'not signed in'}`);
      const pullRequests = open.data.map((pull) => ({ number: pull.number, title: pull.title, url: pull.html_url, author: pull.user?.login || '', source: pull.head?.ref || '', target: pull.base?.ref || '', draft: Boolean(pull.draft), updatedAt: pull.updated_at || null }));
      return pullRequests;
    },
    async create({ branch, base, title, description, draft, signal }) {
      const created = await request(`${repoUrl}/pulls`, { method: 'POST', headers, body: { title, head: branch, base, body: description, draft }, signal });
      if (created.status === 201) return { created: true, url: created.data.html_url, number: created.data.number };
      if (created.status === 422 && /already exists/i.test(created.text)) {
        const open = await request(`${repoUrl}/pulls?state=open&head=${encodeURIComponent(`${remote.owner}:${branch}`)}`, { headers, signal });
        if (open.data?.[0]) return { created: false, existing: true, url: open.data[0].html_url, number: open.data[0].number };
      }
      throw new Error(`GitHub refused the pull request (HTTP ${created.status}): ${created.data?.message || created.text.slice(0, 300)}`);
    },
    async pullRequest({ number, branch, signal }) {
      let found = number;
      if (!found) {
        const open = await request(`${repoUrl}/pulls?state=open&head=${encodeURIComponent(`${remote.owner}:${branch}`)}`, { headers, signal });
        found = open.data?.[0]?.number;
        if (!found) throw new Error(`The branch ${branch} has no open pull request on GitHub.`);
      }
      // GitHub works out whether it can be merged in the background. `mergeable` is null until then.
      let details;
      for (let attempt = 0; attempt < 4; attempt++) {
        details = await request(`${repoUrl}/pulls/${found}`, { headers, signal });
        if (!details.ok) throw new Error(`GitHub did not return pull request ${found} (HTTP ${details.status}): ${details.data?.message || details.text.slice(0, 300)}`);
        if (details.data.mergeable !== null || details.data.state !== 'open') break;
        await sleep(1500);
      }
      const pull = details.data;
      const repository = (await request(repoUrl, { headers, signal })).data || {};
      const methods = [['merge', repository.allow_merge_commit], ['squash', repository.allow_squash_merge], ['rebase', repository.allow_rebase_merge]].filter(([, allowed]) => allowed !== false).map(([name]) => name);
      const blockers = [];
      const warnings = [];
      if (pull.merged) blockers.push('It is already merged.');
      else if (pull.state !== 'open') blockers.push('It is closed.');
      else if (pull.draft) blockers.push('It is a draft.');
      else if (pull.mergeable_state === 'dirty') blockers.push('It has merge conflicts.');
      else if (pull.mergeable_state === 'blocked') blockers.push('Required checks or reviews have not passed yet.');
      else if (pull.mergeable_state === 'behind') blockers.push(`The branch is behind ${pull.base.ref} and must be updated first.`);
      else if (pull.mergeable !== true) blockers.push('GitHub has not finished checking whether it can be merged; try again in a minute.');
      if (pull.mergeable_state === 'unstable') warnings.push('Some checks that are not required failed or are still running.');
      const sameRepository = pull.head.repo?.full_name?.toLowerCase() === `${remote.owner}/${remote.repo}`.toLowerCase();
      return { number: pull.number, title: pull.title, url: pull.html_url, source: pull.head.ref, target: pull.base.ref, headSha: pull.head.sha, sameRepository, methods, blockers, warnings };
    },
    async merge({ pullRequest, method, deleteBranch, signal }) {
      // Someone may have changed it while the approval card waited: the user approved this target.
      const now = await request(`${repoUrl}/pulls/${pullRequest.number}`, { headers, signal });
      if (!now.ok) throw new Error(`GitHub did not return pull request ${pullRequest.number} before merging (HTTP ${now.status}): ${now.data?.message || now.text.slice(0, 300)}`);
      if (now.data.base?.ref !== pullRequest.target || now.data.head?.sha !== pullRequest.headSha) throw new Error(changedMessage(pullRequest));
      // `sha`: GitHub refuses when the branch got new commits after this last look.
      const merged = await request(`${repoUrl}/pulls/${pullRequest.number}/merge`, { method: 'PUT', headers, body: { merge_method: method, sha: pullRequest.headSha }, signal });
      if (!merged.ok || merged.data.merged !== true) throw new Error(`GitHub did not merge pull request ${pullRequest.number} (HTTP ${merged.status}): ${merged.data?.message || merged.text.slice(0, 300)}`);
      let branchDeleted = false;
      if (deleteBranch && pullRequest.sameRepository) {
        const ref = pullRequest.source.split('/').map(encodeURIComponent).join('/');
        branchDeleted = (await request(`${repoUrl}/git/refs/heads/${ref}`, { method: 'DELETE', headers, signal })).status === 204;
      }
      return { completed: true, commit: merged.data.sha, branchDeleted };
    },
    createPageUrl(branch, base, title, description) {
      const query = new URLSearchParams({ quick_pull: '1', title: title || '', body: description || '' });
      // Branch names keep their slashes in GitHub's compare address.
      const ref = (name) => name.split('/').map(encodeURIComponent).join('/');
      return `${remote.webUrl}/compare/${base ? `${ref(base)}...` : ''}${ref(branch)}?${query}`;
    },
  };
}

function azureApi(remote, credential, endpoints) {
  const base = endpoints.azureDevOpsUrl ? `${endpoints.azureDevOpsUrl}/${encodeURIComponent(remote.organization)}` : remote.baseUrl;
  const repoUrl = `${base}/${encodeURIComponent(remote.project)}/_apis/git/repositories/${encodeURIComponent(remote.repository)}`;
  // Git Credential Manager saves either a Microsoft Entra access token (a JWT, sent as a bearer token) or a PAT.
  const token = credential?.password || '';
  const authorization = /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(token) ? `Bearer ${token}` : `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  const headers = { Authorization: authorization, Accept: 'application/json' };
  return {
    async defaultBranch(signal) {
      const repository = await request(`${repoUrl}?api-version=7.1`, { headers, signal });
      const branch = repository.ok && repository.data ? String(repository.data.defaultBranch || '').replace(/^refs\/heads\//, '') : '';
      return branch || null;
    },
    async list(signal) {
      const active = await request(`${repoUrl}/pullrequests?searchCriteria.status=active&$top=50&api-version=7.1`, { headers, signal });
      if (!active.ok || !Array.isArray(active.data?.value)) throw new Error(`Azure DevOps did not list the pull requests (HTTP ${active.status}): ${active.data?.message || 'not signed in'}`);
      const branch = (ref) => String(ref || '').replace(/^refs\/heads\//, '');
      const pullRequests = active.data.value.map((pull) => ({ number: pull.pullRequestId, title: pull.title, url: `${remote.webUrl}/pullrequest/${pull.pullRequestId}`, author: pull.createdBy?.displayName || '', source: branch(pull.sourceRefName), target: branch(pull.targetRefName), draft: Boolean(pull.isDraft), updatedAt: pull.creationDate || null }));
      return pullRequests;
    },
    async create({ branch, base: target, title, description, draft, signal }) {
      const body = { sourceRefName: `refs/heads/${branch}`, targetRefName: `refs/heads/${target}`, title, description: description.slice(0, MAX_AZURE_DESCRIPTION), isDraft: draft };
      const created = await request(`${repoUrl}/pullrequests?api-version=7.1`, { method: 'POST', headers, body, signal });
      if (created.status === 201 && created.data) return { created: true, url: `${remote.webUrl}/pullrequest/${created.data.pullRequestId}`, number: created.data.pullRequestId };
      if (created.status === 409) {
        const query = new URLSearchParams({ 'searchCriteria.sourceRefName': `refs/heads/${branch}`, 'searchCriteria.status': 'active', 'api-version': '7.1' });
        const open = await request(`${repoUrl}/pullrequests?${query}`, { headers, signal });
        const existing = open.data?.value?.[0];
        if (existing) return { created: false, existing: true, url: `${remote.webUrl}/pullrequest/${existing.pullRequestId}`, number: existing.pullRequestId };
      }
      throw new Error(`Azure DevOps refused the pull request (HTTP ${created.status}): ${created.data?.message || created.text.slice(0, 300)}`);
    },
    async pullRequest({ number, branch, signal }) {
      let pull;
      if (number) {
        const found = await request(`${repoUrl}/pullrequests/${number}?api-version=7.1`, { headers, signal });
        if (!found.ok) throw new Error(`Azure DevOps did not return pull request ${number} (HTTP ${found.status}): ${found.data?.message || 'not signed in'}`);
        pull = found.data;
      } else {
        const query = new URLSearchParams({ 'searchCriteria.sourceRefName': `refs/heads/${branch}`, 'searchCriteria.status': 'active', 'api-version': '7.1' });
        pull = (await request(`${repoUrl}/pullrequests?${query}`, { headers, signal })).data?.value?.[0];
        if (!pull) throw new Error(`The branch ${branch} has no active pull request on Azure DevOps.`);
      }
      const url = `${remote.webUrl}/pullrequest/${pull.pullRequestId}`;
      const blockers = [];
      if (pull.status !== 'active') blockers.push(`It is ${pull.status}.`);
      else if (pull.isDraft) blockers.push('It is a draft.');
      else if (pull.mergeStatus === 'conflicts') blockers.push('It has merge conflicts.');
      else if (pull.mergeStatus !== 'succeeded') blockers.push(`Azure DevOps reports the merge as "${pull.mergeStatus || 'not checked yet'}".`);
      // Required branch policies (reviewers, builds, linked work items) must have passed.
      const artifactId = `vstfs:///CodeReview/CodeReviewId/${pull.repository.project.id}/${pull.pullRequestId}`;
      const evaluations = await request(`${base}/${encodeURIComponent(remote.project)}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifactId)}&api-version=7.1-preview.1`, { headers, signal });
      if (!evaluations.ok) blockers.push('Caliope could not read the branch policies.');
      const unmet = (evaluations.data?.value || []).filter((evaluation) => evaluation.configuration?.isBlocking && evaluation.configuration?.isEnabled !== false && !['approved', 'notApplicable'].includes(evaluation.status));
      if (unmet.length > 0) blockers.push(`Required policies have not passed: ${unmet.map((evaluation) => `${evaluation.configuration.type?.displayName || 'policy'} (${evaluation.status})`).join(', ')}.`);
      const source = pull.sourceRefName.replace(/^refs\/heads\//, '');
      const target = pull.targetRefName.replace(/^refs\/heads\//, '');
      return { number: pull.pullRequestId, title: pull.title, url, source, target, headSha: pull.lastMergeSourceCommit?.commitId, methods: ['merge', 'squash', 'rebase'], blockers, warnings: [] };
    },
    async merge({ pullRequest, method, deleteBranch, signal }) {
      const completionOptions = { mergeStrategy: { merge: 'noFastForward', squash: 'squash', rebase: 'rebase' }[method], deleteSourceBranch: Boolean(deleteBranch) };
      const pullRequestUrl = `${repoUrl}/pullrequests/${pullRequest.number}?api-version=7.1`;
      // Someone may have changed it while the approval card waited: the user approved this target.
      const now = await request(pullRequestUrl, { headers, signal });
      if (!now.ok) throw new Error(`Azure DevOps did not return pull request ${pullRequest.number} before completing it (HTTP ${now.status}): ${now.data?.message || 'not signed in'}`);
      if (now.data.targetRefName !== `refs/heads/${pullRequest.target}` || now.data.lastMergeSourceCommit?.commitId !== pullRequest.headSha) throw new Error(changedMessage(pullRequest));
      // `lastMergeSourceCommit`: Azure DevOps refuses when the branch got new commits after this last look.
      const updated = await request(pullRequestUrl, { method: 'PATCH', headers, body: { status: 'completed', lastMergeSourceCommit: { commitId: pullRequest.headSha }, completionOptions }, signal });
      if (!updated.ok) throw new Error(`Azure DevOps did not complete pull request ${pullRequest.number} (HTTP ${updated.status}): ${updated.data?.message || updated.text.slice(0, 300)}`);
      // Azure DevOps merges in the background after accepting the completion.
      let pull = updated.data;
      for (let attempt = 0; attempt < 15 && pull.status !== 'completed'; attempt++) {
        if (pull.mergeFailureMessage) throw new Error(`Azure DevOps could not complete pull request ${pullRequest.number}: ${pull.mergeFailureMessage}`);
        await sleep(2000);
        pull = (await request(pullRequestUrl, { headers, signal })).data || pull;
      }
      return { completed: pull.status === 'completed', commit: pull.lastMergeCommit?.commitId || null, branchDeleted: pull.status === 'completed' && Boolean(deleteBranch) };
    },
    createPageUrl(branch, targetBranch) {
      const query = new URLSearchParams({ sourceRef: branch, ...(targetBranch ? { targetRef: targetBranch } : {}) });
      return `${remote.webUrl}/pullrequestcreate?${query}`;
    },
  };
}

/** A JSON request; `ok` is false for a sign-in page (Azure DevOps answers 203 with HTML when the token is refused). */
async function request(url, { method = 'GET', headers, body, signal }) {
  const timeout = AbortSignal.timeout(30000);
  const response = await fetch(url, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON, such as a sign-in page.
  }
  const result = { status: response.status, ok: response.ok && response.status !== 203 && data !== null, data, text };
  return result;
}

function changedMessage(pullRequest) {
  const message = `Pull request ${pullRequest.number} changed after the user approved the merge (new commits or another target branch), so it was not merged. Call merge_pull_request again so the user sees the current state.`;
  return message;
}

/** "GitHub" or "Azure DevOps", for a remote or a result that has `provider`. */
export function providerName({ provider }) {
  return provider === 'github' ? 'GitHub' : 'Azure DevOps';
}
