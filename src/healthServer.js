import http from 'node:http';

/**
 * Render liveness server. Discord connectivity is reported for diagnostics,
 * but temporary Discord failures must not trigger a Render restart loop.
 *
 * @param {{ getDiscordStatus: () => { connected: boolean, state: string } }} options
 * @returns {http.Server}
 */
export function createHealthServer({ getDiscordStatus }) {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;

    if (pathname !== '/' && pathname !== '/health') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'not_found' }));
      return;
    }

    const discord = getDiscordStatus();
    const body = {
      status: 'ok',
      discord: discord.state,
      connected: discord.connected,
      pendingWrites: discord.pendingWrites ?? 0,
      uptimeSeconds: Math.floor(process.uptime())
    };

    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    });
    res.end(JSON.stringify(body));
  });
}
