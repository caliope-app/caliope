// Subagents (run_agent): the main agent hands one self-contained task to another model, which works in
// its own conversation with its own tools and returns a report. Several can run at once. Their tools run
// through the session's approvals, their file changes are rewound with the message that started them,
// and their requests count towards the session's spending.
import { isAbortError, abortError } from './util.js';
import { getTool, toolSpecsFor } from './tools/index.js';
import { projectRoot } from './tools/files.js';
import { effortFor, matchModel, usableModels } from './models.js';
import { subagentSystemPrompt, loadInstructions } from './prompts.js';
import { estimateContextTokens } from './conversation.js';
import { streamModelRequest, errorResult } from './turn-helpers.js';
import { effectiveShell } from './tools/shell.js';

const READ_TOOLS = ['read_file', 'list_dir', 'glob', 'grep'];
// Web research runs on the session's model: in a replay the small model fetched wrong addresses of an API
// spec and reported confidently without it.
const WEB_TOOLS = [...READ_TOOLS, 'web_fetch', 'web_search'];
const WRITE_TOOLS = [...WEB_TOOLS, 'edit_file', 'write_file', 'notebook_edit', 'run_command', 'command_output'];
// Model calls per subagent. A task that needs more should be split by the main agent.
const MAX_STEPS = 40;
const MAX_REPORT_CHARS = 40000;
const MAX_TRACE = 150;

/**
 * Run one subagent until it reports, and return the run_agent tool result.
 * - `runner`: the session's SessionRunner (approvals, tool context).
 * - `assistant`: the main agent's message that called run_agent. File changes are checkpointed against it.
 * - `progress(text)`: a line for the run_agent card while it works.
 * - Returns { content, isError, meta, stopTurn }. Throws only when the turn is stopped.
 */
export async function runSubagent({ runner, session, assistant, input, signal, progress }) {
  const manager = runner.manager;
  const settings = manager.settings.get();
  const write = input.tools === 'write';
  const web = input.tools === 'web';
  // A subagent that only reads the project, without a model named (here or in Settings), explores on a small
  // model at low effort.
  const explore = !write && !web && !input.model && !settings.subagentModel ? manager.exploreModel() : null;
  const model = input.model ? matchModel(input.model, manager.client.models) : explore || manager.resolveModel(settings.subagentModel || session.meta.model);
  if (!model || !model.protocol || !model.toolCalls) {
    const names = usableModels(manager.client.models).map((item) => item.id).join(', ');
    return { content: `No usable model matches "${input.model || settings.subagentModel || session.meta.model}". Models you can name: ${names || 'none (the model list is not loaded)'}.`, isError: true, meta: {} };
  }
  if (write && session.meta.mode === 'plan') {
    return { content: 'Plan mode is on, so subagents can only read. Start it with tools "read", or present your plan first.', isError: true, meta: {} };
  }
  const skills = session.data.skills || [];
  const toolNames = [...(write ? WRITE_TOOLS : web ? WEB_TOOLS : READ_TOOLS), ...(skills.length > 0 ? ['use_skill'] : [])];
  const tools = toolSpecsFor(toolNames);
  const extraPath = manager.settings.effectiveExtraPath();
  const instructions = await loadInstructions({ cwd: session.meta.cwd, root: await projectRoot(session.meta.cwd, extraPath), settings, includeProject: manager.projectTrusted(session.meta) });
  // The shell the commands really run in: cmd.exe also in Constrained Language Mode.
  const shell = await effectiveShell(settings.shell);
  const system = subagentSystemPrompt({ cwd: session.meta.cwd, shell, write, web, instructions, skills });
  const effort = effortFor(model, input.effort || (explore ? 'low' : settings.subagentEffort));
  const maxTokens = Math.min(settings.maxOutputTokens, model.maxOutputTokens || settings.maxOutputTokens);
  const label = `${input.description || 'Subagent'} (${model.name})`;
  progress(`Started on ${model.name}${effort ? ` · ${effort}` : ''} · ${write ? 'can edit files and run commands' : web ? 'reads files and the web' : 'read-only'}`);

  const history = [{ role: 'user', content: [{ type: 'text', text: String(input.prompt) }] }];
  const trace = [];
  // Subfolders whose instruction files this subagent got with a tool result (see withFolderInstructions).
  const instructionFolders = [];
  let steps = 0;
  let spentNano = 0;
  let unpriced = 0;
  let lastText = '';
  let ending = null;
  try {
    while (!ending) {
      if (signal.aborted) throw abortError();
      // Near the context limit, or at the step limit, the next answer must be the report. The tool list
      // stays the same: the API needs it for the earlier tool calls, and changing it would void the thinking.
      const nearlyFull = Boolean(model.maxPromptTokens) && estimateContextTokens(history, system) > model.maxPromptTokens * 0.8;
      const lastCall = steps === MAX_STEPS - 1 || nearlyFull;
      if (lastCall) history.push({ role: 'user', content: [{ type: 'text', text: 'Stop using tools now and write your report with what you have.' }] });
      const result = await streamModelRequest({
        client: manager.client,
        log: manager.log,
        model,
        adaptations: manager.adaptationsFor(model.id),
        signal,
        makeRequest: () => {
          // Before every attempt, also retries.
          manager.checkSpendingLimit(session);
          return { request: { model, system, tools, history, effort, maxTokens, thinkingDisplay: 'omitted' } };
        },
        onUnfinished: (usage) => manager.recordUsage(session, model, usage, 'subagent'),
        onNotice: (text) => manager.appendEvent(session, { kind: 'notice', text }),
      });
      steps++;
      manager.recordUsage(session, model, result.usage, 'subagent');
      if (typeof result.usage.nanoAiu === 'number') spentNano += result.usage.nanoAiu;
      else unpriced++;
      // `usage` lets the context estimate start from the real token count.
      history.push({ role: 'assistant', content: result.content, usage: result.usage });
      const text = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
      if (text) lastText = text;
      if (result.stopReason === 'refusal') {
        ending = { error: `${model.name} declined this task.` };
        break;
      }
      const toolUses = result.content.filter((block) => block.type === 'tool_use');
      if (toolUses.length === 0 || lastCall) {
        ending = { report: text || lastText };
        break;
      }
      const results = [];
      for (const toolUse of toolUses) {
        // A tool that ignores the stop signal (a read) must not let the next one (an edit) run after Stop.
        if (signal.aborted) throw abortError();
        // After the user denied an action, the rest of this step does not run.
        if (ending?.stopTurn) {
          results.push(errorResult(toolUse, 'Not run: the user denied an earlier action in this step.', { notRun: true }));
          continue;
        }
        progress(`${toolUse.name} ${describeInput(toolUse.input)}`.trim());
        const outcome = await runTool({ runner, session, assistant, toolUse, toolNames, signal, label, instructionFolders });
        results.push(outcome.block);
        if (trace.length < MAX_TRACE) trace.push({ tool: toolUse.name, target: describeInput(toolUse.input), error: Boolean(outcome.block.is_error) });
        if (outcome.stopTurn) ending = { stopTurn: true, report: lastText };
      }
      history.push({ role: 'user', content: results });
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    manager.log.warn(`Subagent on ${model.id} failed.`, error);
    ending = { error: `The subagent failed: ${error.message}`, report: lastText };
  }

  const meta = { description: input.description || '', model: model.id, modelName: model.name, effort, tools: write ? 'write' : web ? 'web' : 'read', steps, trace, nanoAiu: unpriced === steps ? null : spentNano, unpriced };
  const footer = `[Subagent on ${model.name}: ${steps} model ${steps === 1 ? 'call' : 'calls'}, ${trace.length} tool ${trace.length === 1 ? 'call' : 'calls'}]`;
  if (ending.stopTurn) {
    return { content: `The user denied an action of the subagent, so it stopped.${ending.report ? `\nIts last notes:\n${ending.report.slice(0, MAX_REPORT_CHARS)}` : ''}\n${footer}`, isError: true, meta: { ...meta, report: ending.report || '' }, stopTurn: true };
  }
  if (ending.error) {
    return { content: `${ending.error}${ending.report ? `\nIts last notes:\n${ending.report.slice(0, MAX_REPORT_CHARS)}` : ''}\n${footer}`, isError: true, meta: { ...meta, report: ending.report || '' } };
  }
  const report = (ending.report || '(The subagent finished without a report.)').slice(0, MAX_REPORT_CHARS);
  return { content: `${report}\n\n${footer}`, meta: { ...meta, report } };
}

/**
 * One tool call of a subagent, with the same checks and approvals as the main agent's (see runToolCall).
 * - Only the tools of this subagent's list run.
 * - `instructionFolders`: the subagent's own list, so the main agent still gets those instruction files itself.
 */
async function runTool({ runner, session, assistant, toolUse, toolNames, signal, label, instructionFolders }) {
  if (!toolNames.includes(toolUse.name)) return { block: errorResult(toolUse, `There is no tool named "${toolUse.name}" for this subagent.`) };
  const outcome = await runner.runToolCall(session, assistant, getTool(toolUse.name), toolUse, signal, { label, instructionFolders });
  return outcome;
}

/** A few words about a tool call for the progress lines and the trace. */
function describeInput(input) {
  const value = input?.path ?? input?.pattern ?? input?.command ?? input?.url ?? input?.name ?? input?.job ?? '';
  const text = String(value).split('\n')[0];
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
