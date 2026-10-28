// Server-sent events to the app windows.

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
    for (const client of this.clients) client.write(frame);
  }

  /** Comment frames keep idle connections open through proxies and let dead ones be noticed. */
  heartbeat() {
    for (const client of this.clients) client.write(': keep-alive\n\n');
  }
}
