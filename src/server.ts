import http from 'node:http';
import { Service } from './service';
import { ApiError, httpStatusFor } from './errors';

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      if (parts.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
      } catch {
        reject(new ApiError('VALIDATION', '请求体必须是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createServer(service: Service) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const m = req.method || 'GET';
      const p = url.pathname;
      const num = (s: string | undefined) => {
        const n = Number(s);
        if (!Number.isInteger(n)) throw new ApiError('VALIDATION', `非法的 id: ${s}`);
        return n;
      };
      let match: RegExpMatchArray | null;

      if (m === 'GET' && p === '/api/health') {
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && p === '/api/pattern-sets') {
        const b = (await readBody(req)) as { name?: string; patterns?: unknown };
        return send(res, 201, service.createPatternSet(b.name, b.patterns));
      }
      if ((match = p.match(/^\/api\/pattern-sets\/(\d+)\/versions$/)) && m === 'POST') {
        const b = (await readBody(req)) as { patterns?: unknown };
        return send(res, 201, service.createVersion(num(match[1]), b.patterns));
      }
      if ((match = p.match(/^\/api\/versions\/(\d+)\/compile$/)) && m === 'POST') {
        return send(res, 200, service.compile(num(match[1])));
      }
      if ((match = p.match(/^\/api\/versions\/(\d+)$/)) && m === 'GET') {
        return send(res, 200, service.getVersion(num(match[1])));
      }
      if ((match = p.match(/^\/api\/versions\/(\d+)\/graph$/)) && m === 'GET') {
        return send(res, 200, { graph: service.graph(num(match[1])) });
      }
      if (m === 'POST' && p === '/api/scans') {
        const b = (await readBody(req)) as { versionId?: number };
        return send(res, 201, service.createScan(num(String(b?.versionId))));
      }
      if ((match = p.match(/^\/api\/scans\/(\d+)\/append$/)) && m === 'POST') {
        const b = (await readBody(req)) as { seq?: number; text?: string };
        return send(res, 200, service.append(num(match[1]), b?.seq, b?.text));
      }
      if ((match = p.match(/^\/api\/scans\/(\d+)\/finish$/)) && m === 'POST') {
        return send(res, 200, service.finish(num(match[1])));
      }
      if ((match = p.match(/^\/api\/scans\/(\d+)\/hits$/)) && m === 'GET') {
        return send(res, 200, service.hits(num(match[1])));
      }
      if ((match = p.match(/^\/api\/scans\/(\d+)\/stats$/)) && m === 'GET') {
        return send(res, 200, service.stats(num(match[1])));
      }
      if ((match = p.match(/^\/api\/scans\/(\d+)\/explain$/)) && m === 'GET') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const limit = url.searchParams.get('limit');
        return send(
          res,
          200,
          service.explain(
            num(match[1]),
            from === null ? undefined : num(from),
            to === null ? undefined : num(to),
            limit === null ? undefined : num(limit),
          ),
        );
      }
      if ((match = p.match(/^\/api\/scans\/(\d+)\/export$/)) && m === 'GET') {
        return send(res, 200, service.exportReport(num(match[1])));
      }
      throw new ApiError('NOT_FOUND', `路由不存在: ${m} ${p}`);
    } catch (e) {
      if (e instanceof ApiError) {
        return send(res, e.httpStatus ?? httpStatusFor(e.code), {
          error: { code: e.code, message: e.message },
        });
      }
      return send(res, 500, {
        error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) },
      });
    }
  });
}

export function startServer(service: Service, port?: number): Promise<number> {
  const server = createServer(service);
  const wanted = port ?? Number(process.env.AC_PORT ?? 0); // 默认 0 = 选择空闲端口
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(wanted, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : wanted);
    });
  });
}
