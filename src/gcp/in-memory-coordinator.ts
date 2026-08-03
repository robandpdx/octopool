import type {
  CoordinatorSnapshot,
  RecordResult,
  SelectionRequest,
  SelectionResult,
} from "../types";

type CacheFill = {
  ownerToken: string;
  expiresAt: number;
};

type Lease = {
  identityId: string;
  expiresAt: number;
};

type RateState = {
  limitCount: number;
  remaining: number;
  resetAt: number;
};

type Cooldown = {
  status: number;
  reason: string;
  expiresAt: number;
};

const CACHE_FILL_LEASE_MS = 8_000;
const IDENTITY_LEASE_MS = 10_000;

export class InMemoryPoolCoordinator {
  readonly #cacheFills = new Map<string, CacheFill>();
  readonly #leases = new Map<string, Lease>();
  readonly #rates = new Map<string, RateState>();
  readonly #cooldowns = new Map<string, Cooldown>();

  claimCacheFill(cacheKey: string): string | null {
    const now = Date.now();
    const fill = this.#cacheFills.get(cacheKey);
    if (fill !== undefined && fill.expiresAt > now) {
      return null;
    }
    const ownerToken = crypto.randomUUID();
    this.#cacheFills.set(cacheKey, {
      ownerToken,
      expiresAt: now + CACHE_FILL_LEASE_MS,
    });
    return ownerToken;
  }

  finishCacheFill(cacheKey: string, ownerToken: string): void {
    const fill = this.#cacheFills.get(cacheKey);
    if (fill?.ownerToken === ownerToken) {
      this.#cacheFills.delete(cacheKey);
    }
  }

  selectIdentity(request: SelectionRequest): SelectionResult {
    const now = Date.now();
    const candidateIds = new Set(request.candidates.map((candidate) => candidate.id));
    const lease = this.#leases.get(request.routeKey);
    if (
      lease !== undefined &&
      lease.expiresAt > now &&
      candidateIds.has(lease.identityId) &&
      !this.#isCoolingDown(lease.identityId, request, now) &&
      !this.#isQuotaExhausted(lease.identityId, request.resource, now)
    ) {
      return {
        identityId: lease.identityId,
        reason: "sticky",
        leaseTtlSeconds: Math.ceil((lease.expiresAt - now) / 1000),
      };
    }

    let best: (typeof request.candidates)[number] | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of request.candidates) {
      if (this.#isCoolingDown(candidate.id, request, now)) {
        continue;
      }
      const rate = this.#rates.get(rateKey(candidate.id, request.resource));
      if (rate !== undefined && rate.resetAt > now && rate.remaining <= 0) {
        continue;
      }
      const remaining = rate === undefined || rate.resetAt <= now ? 5000 : rate.remaining;
      const score = remaining + candidate.weight;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    if (best === undefined) {
      throw new Error("all_identity_candidates_cooling_down");
    }
    this.#leases.set(request.routeKey, {
      identityId: best.id,
      expiresAt: now + IDENTITY_LEASE_MS,
    });
    return {
      identityId: best.id,
      reason: "highest_remaining",
      leaseTtlSeconds: IDENTITY_LEASE_MS / 1000,
    };
  }

  recordResult(result: RecordResult): void {
    if (result.rate?.remaining !== undefined && result.rate.resetAt !== undefined) {
      this.#rates.set(rateKey(result.identityId, result.resource), {
        limitCount: result.rate.limit ?? 5000,
        remaining: result.rate.remaining,
        resetAt: result.rate.resetAt * 1000,
      });
    }
    if (result.status === 401 || result.status === 403 || result.status === 429) {
      const cooldown = classifyCooldown(result);
      this.#cooldowns.set(cooldownKey(result.identityId, cooldown.key), {
        status: result.status,
        reason: "github_error",
        expiresAt: Date.now() + cooldown.ttlMs,
      });
    }
  }

  snapshot(): CoordinatorSnapshot {
    const now = Date.now();
    return {
      rates: Array.from(this.#rates.entries()).flatMap(([key, rate]) => {
        if (rate.resetAt <= now) {
          return [];
        }
        const [identityId, resource] = splitKey(key);
        return [
          {
            identity_id: identityId,
            resource,
            limit_count: rate.limitCount,
            remaining: rate.remaining,
            reset_at: rate.resetAt,
          },
        ];
      }),
      cooldowns: Array.from(this.#cooldowns.entries()).flatMap(([key, cooldown]) => {
        if (cooldown.expiresAt <= now) {
          return [];
        }
        const [identityId, routeKey] = splitKey(key);
        return [
          {
            identity_id: identityId,
            route_key: routeKey,
            status: cooldown.status,
            reason: cooldown.reason,
            expires_at: cooldown.expiresAt,
          },
        ];
      }),
      leases: Array.from(this.#leases.entries()).flatMap(([routeKey, lease]) => {
        if (lease.expiresAt <= now) {
          return [];
        }
        return [
          {
            route_key: routeKey,
            identity_id: lease.identityId,
            expires_at: lease.expiresAt,
          },
        ];
      }),
    };
  }

  #cooldownExpiresAt(identityId: string, routeKey: string, now: number): number | undefined {
    const cooldown = this.#cooldowns.get(cooldownKey(identityId, routeKey));
    return cooldown !== undefined && cooldown.expiresAt > now ? cooldown.expiresAt : undefined;
  }

  #isCoolingDown(identityId: string, request: SelectionRequest, now: number): boolean {
    return (
      this.#cooldownExpiresAt(identityId, "*", now) !== undefined ||
      this.#cooldownExpiresAt(identityId, `resource:${request.resource}`, now) !== undefined ||
      this.#cooldownExpiresAt(identityId, request.routeKey, now) !== undefined
    );
  }

  #isQuotaExhausted(identityId: string, resource: string, now: number): boolean {
    const rate = this.#rates.get(rateKey(identityId, resource));
    return rate !== undefined && rate.resetAt > now && rate.remaining <= 0;
  }
}

export class InMemoryPoolCoordinatorNamespace {
  readonly #coordinators = new Map<string, InMemoryPoolCoordinator>();

  getByName(name: string): InMemoryPoolCoordinator {
    let coordinator = this.#coordinators.get(name);
    if (coordinator === undefined) {
      coordinator = new InMemoryPoolCoordinator();
      this.#coordinators.set(name, coordinator);
    }
    return coordinator;
  }
}

function classifyCooldown(result: RecordResult): { key: string; ttlMs: number } {
  const retryAfterMs =
    result.rate?.retryAfter !== undefined ? Math.max(result.rate.retryAfter, 1) * 1000 : undefined;
  if (result.status === 401) {
    return { key: "*", ttlMs: retryAfterMs ?? 120_000 };
  }
  if (retryAfterMs !== undefined) {
    return { key: "*", ttlMs: retryAfterMs };
  }
  if (result.status === 403 && result.rate?.remaining !== undefined && result.rate.remaining > 0) {
    return { key: "*", ttlMs: 120_000 };
  }
  if (result.status === 429) {
    return { key: `resource:${result.resource}`, ttlMs: 120_000 };
  }
  return { key: result.routeKey, ttlMs: 120_000 };
}

function rateKey(identityId: string, resource: string): string {
  return joinKey(identityId, resource);
}

function cooldownKey(identityId: string, routeKey: string): string {
  return joinKey(identityId, routeKey);
}

function joinKey(first: string, second: string): string {
  return `${first.length}:${first}${second}`;
}

function splitKey(key: string): [string, string] {
  const separator = key.indexOf(":");
  const firstLength = Number(key.slice(0, separator));
  const first = key.slice(separator + 1, separator + 1 + firstLength);
  return [first, key.slice(separator + 1 + firstLength)];
}
