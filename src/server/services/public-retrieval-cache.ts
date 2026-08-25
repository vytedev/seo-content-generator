import { createHash } from "node:crypto";
import {
  CalibrationSnapshotSchema,
  type CalibrationSnapshot,
} from "../../shared/contracts/calibration.js";
import type { PublicPageRetriever } from "../providers/public-page-retriever.js";

interface CacheEntry {
  request_hash: string;
  content_hash: string;
  retrieved_at: string;
  expires_at: number;
  snapshot: CalibrationSnapshot;
}

export class CachedPublicPageRetriever implements PublicPageRetriever {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly upstream: PublicPageRetriever,
    private readonly ttlMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {
    if (ttlMs <= 0) throw new Error("Public retrieval cache TTL must be positive.");
  }

  async retrieve(url: string): Promise<CalibrationSnapshot> {
    const requestHash = createHash("sha256").update(url).digest("hex");
    const cached = this.entries.get(requestHash);
    if (cached && cached.expires_at > this.now())
      return CalibrationSnapshotSchema.parse(structuredClone(cached.snapshot));
    const snapshot = CalibrationSnapshotSchema.parse(await this.upstream.retrieve(url));
    this.entries.set(requestHash, {
      request_hash: requestHash,
      content_hash: snapshot.content_hash,
      retrieved_at: snapshot.retrieved_at,
      expires_at: this.now() + this.ttlMs,
      snapshot: structuredClone(snapshot),
    });
    return snapshot;
  }
}
