// Subagents (run_agent): the main agent hands one self-contained task to another model, which works in
// its own conversation with its own tools and returns a report. Several can run at once. Their tools run
// through the session's approvals, their file changes are rewound with the message that started them,
// and their requests count towards the session's spending.
import { isAbortError, abortError } from './util.js';
import { getTool, toolSpecsFor, validateToolInput } from './tools/index.js';
import { ToolInputError } from './tools/fs-tools.js';
import { projectRoot } from './tools/files.js';
import { loadSkill } from './skills.js';
import { effortFor, matchModel, usableModels } from './models.js';
import { subagentSystemPrompt, loadInstructions } from './prompts.js';
import { estimateContextTokens } from './conversation.js';
import { streamModelRequest, errorResult, toolResultBlock } from './turn-helpers.js';
import { authorize, refusedBeforePrepare } from './permissions.js';

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
  const system = subagentSystemPrompt({ cwd: session.meta.cwd, shell: settings.shell, write, web, instructions, skills });
  const effort = effortFor(model, input.effort || (explore ? 'low' : settings.subagentEffort));
  const maxTokens = Math.min(settings.maxOutputTokens, model.maxOutputTokens || settings.maxOutputTokens);
  const label = `${input.description || 'Subagent'} (${model.name})`;
  progress(`Started on ${model.name}${effort ? ` · ${effort}` : ''} · ${write ? 'can edit files and run commands' : web ? 'reads files and the web' : 'read-only'}`);

  const history = [{ role: 'user', content: [{ type: 'text', text: String(input.prompt) }] }];
  const trace = [];
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
        const outcome = await runTool({ runner, session, assistant, toolUse, toolNames, signal, label });
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

/** One tool call of a subagent, with the same checks and approvals as the main agent's. */
async function runTool({ runner, session, assistant, toolUse, toolNames, signal, label }) {
  if (!toolNames.includes(toolUse.name)) return { block: errorResult(toolUse, `There is no tool named "${toolUse.name}" for this subagent.`) };
  if (toolUse.invalidJson !== undefined) return { block: errorResult(toolUse, 'The tool input was not valid JSON (it may have been cut off). Try again with smaller input.') };
  const tool = getTool(toolUse.name);
  const problem = validateToolInput(tool, toolUse.input);
  if (problem) return { block: errorResult(toolUse, problem) };
  try {
    if (tool.name === 'use_skill') {
      const skill = await runner.findSkill(session, toolUse.input.name);
      if (!skill) return { block: errorResult(toolUse, `There is no skill named "${toolUse.input.name}".`) };
      const instructions = await loadSkill(skill);
      const block = toolResultBlock(toolUse, { content: instructions });
      return { block };
    }
    const ctx = runner.toolContext(session, assistant, toolUse, signal);
    const refusal = refusedBeforePrepare(runner.manager, session, tool, toolUse.input);
    if (refusal) return { block: errorResult(toolUse, refusal, { denied: true }) };
    const prepared = tool.prepare ? await tool.prepare(toolUse.input, ctx) : null;
    const decision = await authorize(runner, session, tool, toolUse, prepared, signal, ctx, label);
    if (!decision.allowed) return { block: errorResult(toolUse, decision.message, { denied: true }), stopTurn: decision.stopTurn };
    const result = await runner.runWithHooks(session, tool, toolUse, ctx, prepared);
    return { block: toolResultBlock(toolUse, result) };
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    if (error instanceof ToolInputError) return { block: errorResult(toolUse, error.message) };
    return { block: errorResult(toolUse, `The tool failed: ${error.message}`) };
  }
}

/** A few words about a tool call for the progress lines and the trace. */
function describeInput(input) {
  const value = input?.path ?? input?.pattern ?? input?.command ?? input?.url ?? input?.name ?? input?.job ?? '';
  const text = String(value).split('\n')[0];
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
