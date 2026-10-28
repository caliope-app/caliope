// Incremental Server-Sent Events parser (WHATWG event-stream rules).

/**
 * Create a parser that calls `onEvent({ event, data })` for each complete event.
 * - `push(text)` accepts any slice of the stream. Lines may be split across pushes.
 * - Handles \n, \r\n and \r line endings, comments, and multi-line data fields.
 */
export function createSseParser(onEvent) {
  let buffer = '';
  let eventName = '';
  let dataLines = [];
  let pendingCarriageReturn = false;

  function dispatch() {
    if (dataLines.length > 0) {
      onEvent({ event: eventName || 'message', data: dataLines.join('\n') });
    }
    eventName = '';
    dataLines = [];
  }

  function processLine(line) {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }

  function push(text) {
    let input = text;
    if (pendingCarriageReturn && input.startsWith('\n')) input = input.slice(1);
    pendingCarriageReturn = false;
    buffer += input;
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const character = buffer[i];
      if (character === '\n' || character === '\r') {
        processLine(buffer.slice(start, i));
        if (character === '\r') {
          if (i + 1 < buffer.length) {
            if (buffer[i + 1] === '\n') i++;
          } else {
            pendingCarriageReturn = true;
          }
        }
        start = i + 1;
      }
    }
    buffer = buffer.slice(start);
  }

  function end() {
    if (buffer.length > 0) processLine(buffer);
    buffer = '';
    dispatch();
  }

  return { push, end };
}

/**
 * Read a fetch Response body as SSE events.
 * - Yields { event, data } objects until the body ends. Aborting the request ends the body.
 */
export async function* readSseEvents(body) {
  const decoder = new TextDecoder('utf-8');
  const queue = [];
  const parser = createSseParser((event) => queue.push(event));
  for await (const chunk of body) {
    parser.push(decoder.decode(chunk, { stream: true }));
    while (queue.length > 0) yield queue.shift();
  }
  parser.push(decoder.decode());
  parser.end();
  while (queue.length > 0) yield queue.shift();
}
