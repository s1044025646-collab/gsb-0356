// HTTP API：基于 node:http，无外部依赖。

import * as http from "node:http";
import { AcError, Automaton } from "./automaton";
import { Store, DEFAULT_EXPLAIN_LIMIT } from "./store";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendError(res: http.ServerResponse, e: unknown): void {
  if (e instanceof AcError) {
    const status =
      e.code === "NOT_FOUND" ? 404
      : e.code === "SEQ_CONFLICT" || e.code === "SCAN_ENDED" ? 409
      : e.code === "INTERNAL" ? 500
      : 400;
    send(res, status, { error: { code: e.code, message: e.message } });
  } else {
    send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
  }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf8");
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AcError("BAD_REQUEST", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const segs = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      // GET /health
      if (method === "GET" && segs.length === 1 && segs[0] === "health") {
        return send(res, 200, { ok: true });
      }

      // POST /pattern-sets {name, patterns[]}  保存模式集并编译新版本
      if (method === "POST" && segs.length === 1 && segs[0] === "pattern-sets") {
        const body = (await readBody(req)) as { name?: string; patterns?: string[] };
        const r = store.compileVersion(body.name!, body.patterns!);
        const v = store.getVersion(r.versionId);
        const ac = new Automaton(v.patterns);
        return send(res, 201, {
          ...r, name: v.name,
          patternCount: ac.patterns.length,
          totalPatternLen: ac.totalPatternLen,
          stateCount: ac.stateCount,
        });
      }

      // GET /pattern-sets  列表
      if (method === "GET" && segs.length === 1 && segs[0] === "pattern-sets") {
        return send(res, 200, { versions: store.listVersions() });
      }

      // GET /pattern-sets/:id/graph  转移图文本表示
      if (method === "GET" && segs.length === 3 && segs[0] === "pattern-sets" && segs[2] === "graph") {
        const v = store.getVersion(Number(segs[1]));
        const ac = new Automaton(v.patterns);
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(ac.dump());
      }

      // POST /scans {versionId} 或 {name, version?, explainLimit?}
      if (method === "POST" && segs.length === 1 && segs[0] === "scans") {
        const body = (await readBody(req)) as {
          versionId?: number; name?: string; version?: number; explainLimit?: number;
        };
        const versionId = body.versionId ?? store.findVersionId(body.name!, body.version);
        const scanId = store.createScan(versionId, body.explainLimit ?? DEFAULT_EXPLAIN_LIMIT);
        return send(res, 201, store.getScan(scanId));
      }

      if (segs.length >= 2 && segs[0] === "scans") {
        const scanId = Number(segs[1]);
        // POST /scans/:id/append {seq, text}
        if (method === "POST" && segs.length === 3 && segs[2] === "append") {
          const body = (await readBody(req)) as { seq?: number; text?: string };
          return send(res, 200, store.append(scanId, body.seq!, body.text!));
        }
        // POST /scans/:id/end
        if (method === "POST" && segs.length === 3 && segs[2] === "end") {
          store.end(scanId);
          return send(res, 200, store.getScan(scanId));
        }
        // GET /scans/:id
        if (method === "GET" && segs.length === 2) {
          return send(res, 200, store.getScan(scanId));
        }
        // GET /scans/:id/hits
        if (method === "GET" && segs.length === 3 && segs[2] === "hits") {
          return send(res, 200, { hits: store.getHits(scanId) });
        }
        // GET /scans/:id/explain?from=&to=
        if (method === "GET" && segs.length === 3 && segs[2] === "explain") {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          return send(res, 200, {
            explain: store.getExplain(
              scanId,
              from === null ? undefined : Number(from),
              to === null ? undefined : Number(to),
            ),
          });
        }
        // GET /scans/:id/report
        if (method === "GET" && segs.length === 3 && segs[2] === "report") {
          return send(res, 200, store.report(scanId));
        }
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: `未知路由: ${method} ${url.pathname}` } });
    } catch (e) {
      sendError(res, e);
    }
  });
}

/** 启动服务器；port=0 时由系统分配空闲端口（默认）。 */
export function startServer(store: Store, port: number): Promise<{ server: http.Server; port: number }> {
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}
