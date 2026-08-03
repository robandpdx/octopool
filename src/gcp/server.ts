import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import app from "../app";
import { runScheduledMaintenance } from "../maintenance";
import { GcpExecutionContext } from "./context";
import { createGcpEnvFromProcess } from "./env";

const DEFAULT_PORT = 8080;
const MAINTENANCE_PATH = "/internal/maintenance";

export type GcpRequestHandlerOptions = {
  maintenanceToken?: string;
};

export async function handleGcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: GcpRequestHandlerOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === MAINTENANCE_PATH) {
    return await handleMaintenanceRequest(request, env, options.maintenanceToken);
  }
  return await app.fetch(request, env, ctx);
}

export function startCloudRunServer(
  env = createGcpEnvFromProcess(),
): ReturnType<typeof createServer> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = createServer(async (incoming, outgoing) => {
    const ctx = new GcpExecutionContext();
    try {
      const request = await requestFromIncomingMessage(incoming);
      const maintenanceToken = process.env.OCTOPOOL_MAINTENANCE_TOKEN;
      const options =
        maintenanceToken === undefined
          ? {}
          : {
              maintenanceToken,
            };
      const response = await handleGcpRequest(request, env, ctx, options);
      await writeWebResponse(outgoing, response);
    } catch (error) {
      console.error("gcp request failed", error);
      await writeWebResponse(outgoing, new Response("internal server error", { status: 500 }));
    } finally {
      await ctx.drain();
    }
  });
  server.listen(port, () => {
    console.log(`octopool Cloud Run server listening on :${port}`);
  });
  return server;
}

export async function requestFromIncomingMessage(incoming: IncomingMessage): Promise<Request> {
  const headers = headersFromIncomingMessage(incoming);
  const host = headers.get("host") ?? "localhost";
  const proto = headers.get("x-forwarded-proto") ?? "http";
  const url = new URL(incoming.url ?? "/", `${proto}://${host}`);
  const init: RequestInit = {
    method: incoming.method ?? "GET",
    headers,
  };
  if (incoming.method !== "GET" && incoming.method !== "HEAD") {
    init.body = await readIncomingBody(incoming);
  }
  return new Request(url, init);
}

export async function writeWebResponse(
  outgoing: ServerResponse,
  response: Response,
): Promise<void> {
  outgoing.statusCode = response.status;
  outgoing.statusMessage = response.statusText;
  response.headers.forEach((value, key) => {
    outgoing.setHeader(key, value);
  });
  const body = Buffer.from(await response.arrayBuffer());
  outgoing.end(body);
}

async function handleMaintenanceRequest(
  request: Request,
  env: Env,
  maintenanceToken: string | undefined,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  if (maintenanceToken === undefined || maintenanceToken === "") {
    return new Response("not found", { status: 404 });
  }
  const authorization = request.headers.get("authorization");
  const expectedAuthorization = ["Bearer", maintenanceToken].join(" ");
  if (authorization !== expectedAuthorization) {
    return new Response("unauthorized", { status: 401 });
  }
  await runScheduledMaintenance(env);
  return Response.json({ ok: true });
}

function headersFromIncomingMessage(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }
    headers.set(key, value);
  }
  return headers;
}

async function readIncomingBody(incoming: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of incoming) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startCloudRunServer();
}
