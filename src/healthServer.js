import http from 'node:http';

/**
 * Creates the HTTP endpoint used by Render and UptimeRobot.
 * A running Node.js process is not considered healthy until Discord is ready.
 *
 * @param {{ getDiscordStatus: () => { ready: boolean, state: string } }} options
 * @returns {http.Server}
 */
export function createHealthServer({ getDiscordStatus }) {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;

    if (pathname !== '/' && pathname !== '/health' && pathname !== '/ready') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'not_found' }));
      return;
    }

    const discord = getDiscordStatus();
    const isLivenessCheck = pathname === '/health';
    const processCanRecover = discord.state !== 'stopping';
    const statusCode = isLivenessCheck
      ? (processCanRecover ? 200 : 503)
      : (discord.ready ? 200 : 503);
    const body = {
      status: discord.ready ? 'ok' : (processCanRecover ? 'degraded' : 'unavailable'),
      discord: discord.state,
      uptimeSeconds: Math.floor(process.uptime())
    };

    res.writeHead(statusCode, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    });
    res.end(JSON.stringify(body));
  });
}
