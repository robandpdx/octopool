import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { GcpExecutionContext } from "../src/gcp/context";
import { createGcpEnv } from "../src/gcp/env";
import { InMemoryPoolCoordinatorNamespace } from "../src/gcp/in-memory-coordinator";
import { handleGcpRequest, requestFromIncomingMessage } from "../src/gcp/server";

describe("GCP Cloud Run support", () => {
  it("runs scheduled maintenance from an authorized internal endpoint", async () => {
    const queries: string[] = [];
    const env = createGcpEnv({
      db: maintenanceDb(queries),
      variables: {},
    });
    const request = new Request("https://octopool.example/internal/maintenance", {
      method: "POST",
      headers: { authorization: ["Bearer", "maintenance-token"].join(" ") },
    });

    const response = await handleGcpRequest(request, env, new GcpExecutionContext(), {
      maintenanceToken: "maintenance-token",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(queries).toEqual([
      expect.stringContaining("DELETE FROM github_cache_entries"),
      expect.stringContaining("DELETE FROM audit_events"),
    ]);
  });

  it("rejects internal maintenance requests without the shared token", async () => {
    const queries: string[] = [];
    const env = createGcpEnv({
      db: maintenanceDb(queries),
      variables: {},
    });
    const request = new Request("https://octopool.example/internal/maintenance", {
      method: "POST",
      headers: { authorization: ["Bearer", "wrong-token"].join(" ") },
    });

    const response = await handleGcpRequest(request, env, new GcpExecutionContext(), {
      maintenanceToken: "maintenance-token",
    });

    expect(response.status).toBe(401);
    expect(queries).toEqual([]);
  });

  it("converts Node requests into Web requests with Cloud Run forwarded protocol", async () => {
    const incoming = Readable.from(["hello"]) as IncomingLike;
    incoming.method = "POST";
    incoming.url = "/relay?pool=maintainers";
    incoming.headers = {
      host: "octopool.example",
      "x-forwarded-proto": "https",
      "content-type": "text/plain",
    };

    const request = await requestFromIncomingMessage(incoming as unknown as IncomingMessage);

    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://octopool.example/relay?pool=maintainers");
    expect(request.headers.get("content-type")).toBe("text/plain");
    expect(await request.text()).toBe("hello");
  });

  it("provides sticky single-instance coordination for Cloud Run prototypes", async () => {
    const namespace = new InMemoryPoolCoordinatorNamespace();
    const coordinator = namespace.getByName("pool:maintainers");
    const request = {
      pool: "maintainers",
      routeKey: "GET /repos/example/project",
      resource: "core",
      candidates: [
        { id: "low", weight: 1 },
        { id: "high", weight: 10 },
      ],
    };

    const first = coordinator.selectIdentity(request);
    const second = coordinator.selectIdentity(request);
    coordinator.recordResult({
      identityId: first.identityId,
      routeKey: request.routeKey,
      resource: request.resource,
      status: 403,
      rate: { remaining: 10 },
    });

    expect(first.identityId).toBe("high");
    expect(second).toMatchObject({ identityId: "high", reason: "sticky" });
    expect(coordinator.snapshot().cooldowns).toHaveLength(1);
    expect(namespace.getByName("pool:maintainers")).toBe(coordinator);
  });
});

type IncomingLike = Readable & {
  method: string;
  url: string;
  headers: Record<string, string>;
};

function maintenanceDb(queries: string[]): Env["DB"] {
  return {
    prepare: (query: string) => {
      queries.push(query);
      return {
        bind: vi.fn(() => ({
          run: async () => ({ meta: { changes: 0 } }),
        })),
      };
    },
  } as unknown as Env["DB"];
}
