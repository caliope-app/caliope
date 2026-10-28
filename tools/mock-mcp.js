// A small MCP server over stdio for the tests: one read-only tool and one that changes something.
//   node tools/mock-mcp.js
import readline from 'node:readline';

const TOOLS = [
  { name: 'echo', description: 'Repeat the text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'create_item', description: 'Create a work item.', inputSchema: { type: 'object', properties: { title: { type: ['string', 'null'] } }, required: ['title'] } },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function answer(request) {
  if (request.method === 'initialize') return { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '1.0.0' } };
  if (request.method === 'tools/list') return { tools: TOOLS };
  if (request.method === 'tools/call') {
    const { name, arguments: input } = request.params;
    if (name === 'echo') return { content: [{ type: 'text', text: `echo: ${input.text}` }] };
    if (name === 'create_item') return { content: [{ type: 'text', text: `Created item 42: ${input.title} (cwd ${process.cwd()}, MOCK_MCP_TOKEN ${process.env.MOCK_MCP_TOKEN || 'unset'})` }] };
    return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
  }
  return null;
}

// Something on stdout that is not a message, like servers that log there.
process.stdout.write('mock-mcp starting\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = answer(request);
  if (result) send({ jsonrpc: '2.0', id: request.id, result });
  else send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Unknown method ${request.method}` } });
});
lines.on('close', () => process.exit(0));
