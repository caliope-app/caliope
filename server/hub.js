// Server-sent events to the app windows.

// Output a window has not read yet. The connection of a window that falls this far behind (asleep, frozen) is
// closed, instead of the server holding ever more events for it. Its EventSource connects again by itself, and
// the window then loads the app state and the open session again (see connect in web/app.js).
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

export class EventHub {
  constructor() {
    this.clients = new Set();
    this.lastClientAt = Date.now();
  }

  add(response) {
    this.clients.add(response);
    this.lastClientAt = Date.now();
    response.on('close', () => {
      this.clients.delete(response);
      this.lastClientAt = Date.now();
    });
  }

  get clientCount() {
    return this.clients.size;
  }

  broadcast(event) {
    if (this.clients.size === 0) return;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) this.send(client, frame);
  }

  /** Comment frames keep idle connections open through proxies and let dead ones be noticed. */
  heartbeat() {
    for (const client of this.clients) this.send(client, ': keep-alive\n\n');
  }

  send(client, frame) {
    if (client.writableLength > MAX_BUFFERED_BYTES) client.destroy();
    else client.write(frame);
  }
}
