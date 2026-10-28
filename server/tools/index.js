// The tool list. A session freezes the names it starts with, so the list sent to the model never
// changes mid-session (changing it would invalidate earlier thinking blocks and the prompt cache).
import { readFileTool, listDirTool, globTool, grepTool, editFileTool, writeFileTool, notebookEditTool } from './fs-tools.js';
import { runCommandTool, commandOutputTool } from './shell.js';
import { webFetchTool, webSearchTool } from './web.js';
import { browserTool } from './browser.js';
import { listPullRequestsTool, createPullRequestTool, mergePullRequestTool } from './pull-request.js';

// Tools whose work happens in the agent loop (they talk to the user or another model).
export const todoWriteTool = {
  name: 'todo_write',
  kind: 'meta',
  description:
    'Replace the task list shown to the user. Use it for longer work (five or more steps): add the steps, keep exactly one ' +
    'in_progress while you work, and mark steps completed as you go. Call it in the same response as your next other tool call, never on its own: every response is a paid request. Send the full list every time.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The step, in a few words.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
};

export const askUserTool = {
  name: 'ask_user',
  kind: 'meta',
  description:
    'Ask the user a question and wait for the answer. Use it when a decision is genuinely theirs: requirements that are ' +
    'unclear, or a choice between approaches with real trade-offs. Offer 2-4 short options when you can; the user can also type their own answer.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, ending with a question mark.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Suggested answers (2-4).' },
    },
    required: ['question'],
  },
};

export const presentPlanTool = {
  name: 'present_plan',
  kind: 'meta',
  description:
    'Plan mode only: present your implementation plan for the user to approve. Call it once you have explored enough to write ' +
    'a concrete plan (Markdown: goal, approach, the files to change and how, risks, and how you will verify the result). ' +
    'If the user approves, the session leaves plan mode and implementation starts. If they ask for changes, revise and present again.',
  inputSchema: {
    type: 'object',
    properties: { plan: { type: 'string', description: 'The plan in Markdown.' } },
    required: ['plan'],
  },
};


export const runAgentTool = {
  name: 'run_agent',
  kind: 'meta',
  description:
    'Start a subagent: a separate model run with its own context that does one self-contained task with its own tools and returns a report. ' +
    'Use it for broad searches or investigations whose details you do not need in your own context, for independent parts of a task ' +
    '(several run_agent calls in one response run at the same time), or for a second opinion from a different model. ' +
    'The subagent sees nothing of this conversation: give it a complete brief (goal, relevant paths, constraints, what to report). ' +
    'It cannot ask the user questions. A subagent pays to read everything again: do not use it for lookups that take one or two tool calls, ' +
    'or to read files you will read yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'A short label for the task (3-6 words), shown to the user.' },
      prompt: { type: 'string', description: 'The complete brief for the subagent.' },
      model: { type: 'string', description: 'Leave empty: subagents that only read the project then run on the small model named in your instructions, which costs far less, and the others on your model. Name a model (an id from the list, or a family such as "sonnet", "opus", "haiku", "gpt" or "gemini") only for a second opinion from a different model, or when the user asks for one.' },
      effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Reasoning effort for models that support it.' },
      tools: { type: 'string', enum: ['read', 'web', 'write'], description: '"read" (default): read and search the project\'s files. "web": also fetch web pages and search the web, for documentation and API specs. "write": also edit files and run commands, with the same approvals as you.' },
    },
    required: ['description', 'prompt'],
  },
};

export const rememberTool = {
  name: 'remember',
  kind: 'meta',
  description:
    'Keep this project\'s memory, the notes every future session here starts with: build or test commands that work, ' +
    'conventions, decisions, and corrections the user gave you ("always…", "never…"). Add a note with `note`; correct one ' +
    'with `replace` (the old note, word for word) and `note`; remove one with `replace` alone; call without both to see the ' +
    'current notes. Not for task progress or anything already in the instruction files. One line per note.',
  inputSchema: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'The new note, in one line.' },
      replace: { type: 'string', description: 'An existing note, word for word: replaced by `note`, or removed without one.' },
    },
    required: [],
  },
};

export const scheduleTool = {
  name: 'schedule',
  kind: 'meta',
  description:
    'Do something later or repeatedly, while Caliope is open. Use it when the user asks for a reminder, a recurring task or a loop ' +
    '("check the build every 10 minutes until it is green"), and instead of waiting yourself for something slow, such as a pipeline, a deploy or a review. ' +
    'A reminder or loop comes back to this session as a message marked as your scheduled task, so you keep the context; a recurring task (hourly, daily, weekdays, weekly) starts a new session each time. ' +
    'End a loop with action "delete" as soon as its goal is reached (it stops by itself after 100 runs or 7 days). In Ask permissions and Accept edits mode the user approves each new task.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'delete', 'list'], description: 'Default create.' },
      name: { type: 'string', description: 'A short name, for example "Pipeline check".' },
      prompt: { type: 'string', description: 'What to do each time, written as a message to yourself with everything you need to know.' },
      every: { type: 'string', enum: ['once', 'minutes', 'hourly', 'daily', 'weekdays', 'weekly'], description: 'once: a reminder; minutes: a loop every `minutes`; the others repeat at `at`.' },
      minutes: { type: 'integer', description: 'For a loop: every 5 to 1440 minutes. For a reminder: run this many minutes from now.' },
      at: { type: 'string', description: 'HH:MM in the user\'s local time: for a reminder at a time of day, and for hourly (the minutes count), daily, weekdays and weekly tasks.' },
      day: { type: 'integer', description: 'For weekly: 0 = Sunday … 6 = Saturday.' },
      here: { type: 'boolean', description: 'true: come back in this session (default for once and minutes); false: a new session each time (default for the others).' },
      id: { type: 'string', description: 'For delete: the task id from list or from when you created it.' },
    },
  },
};

export const searchSessionsTool = {
  name: 'search_sessions',
  kind: 'meta',
  description:
    'Search earlier Caliope sessions in this project by words they contain: the user\'s messages, your answers and summaries. ' +
    'Use it when the user refers to earlier work ("what did we decide about…", "the session where we fixed…") or asks you to look something up in past sessions. ' +
    'Returns up to 10 sessions with id, title, date and excerpts; read one with read_session.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words that must all appear in the session.' },
    },
    required: ['query'],
  },
};

export const readSessionTool = {
  name: 'read_session',
  kind: 'meta',
  description: 'Read an earlier session of this project found with search_sessions: the user\'s messages, the answers, and the tool calls, shortened where long.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The session id from search_sessions.' } },
    required: ['id'],
  },
};

export const useSkillTool = {
  name: 'use_skill',
  kind: 'meta',
  description: 'Load a skill (packaged instructions for a kind of task) by name, from the list in your instructions. Returns the skill\'s instructions and the files it comes with. Use it before starting a task that matches a skill.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The skill name.' } },
    required: ['name'],
  },
};

const ALL_TOOLS = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  editFileTool,
  writeFileTool,
  notebookEditTool,
  runCommandTool,
  commandOutputTool,
  listPullRequestsTool,
  createPullRequestTool,
  mergePullRequestTool,
  webFetchTool,
  webSearchTool,
  browserTool,
  todoWriteTool,
  askUserTool,
  presentPlanTool,
  runAgentTool,
  rememberTool,
  scheduleTool,
  searchSessionsTool,
  readSessionTool,
  useSkillTool,
];

const TOOLS_BY_NAME = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name) {
  return TOOLS_BY_NAME.get(name) || null;
}

/** Tool names for a new session, in a fixed order. use_skill is always there: skills can be added while it runs. */
export function toolNamesForNewSession({ browserTools, subagents = true }) {
  const optional = { browser: browserTools, run_agent: subagents };
  const names = ALL_TOOLS.filter((tool) => !(tool.name in optional) || optional[tool.name]).map((tool) => tool.name);
  return names;
}

/**
 * The definitions the model sees, to store with a session. An app update that rewords a tool must not
 * change them mid-session: the API treats a changed tool list as an edited history.
 */
export function toolSpecsFor(names) {
  const specs = names.map(getTool).filter(Boolean).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  return specs;
}

/**
 * Check a tool input against the parts of its JSON schema the tools use: required keys and simple types.
 * - Returns an error message, or null when the input is acceptable.
 */
export function validateToolInput(tool, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'The tool input must be a JSON object.';
  const schema = tool.inputSchema;
  for (const key of schema.required || []) {
    if (input[key] === undefined || input[key] === null) return `Missing required parameter "${key}".`;
  }
  for (const [key, value] of Object.entries(input)) {
    const property = schema.properties?.[key];
    if (!property || value === undefined || value === null) continue;
    const type = property.type;
    const ok =
      (type === 'string' && typeof value === 'string') ||
      (type === 'integer' && Number.isInteger(value)) ||
      (type === 'number' && typeof value === 'number') ||
      (type === 'boolean' && typeof value === 'boolean') ||
      (type === 'array' && Array.isArray(value)) ||
      (type === 'object' && typeof value === 'object' && !Array.isArray(value));
    if (!ok) return `Parameter "${key}" must be ${type === 'integer' ? 'a whole number' : `a ${type}`}.`;
    if (property.enum && !property.enum.includes(value)) return `Parameter "${key}" must be one of: ${property.enum.join(', ')}.`;
  }
  return null;
}
