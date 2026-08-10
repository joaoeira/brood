/**
 * The contract between the UI and whatever is driving it. Screens never touch
 * Effect, the supervisor, or the filesystem directly — they call a BridgeHandle
 * and read the result out of the store. That is what lets demo mode be a
 * complete, credential-free substitute for a live swarm.
 */
import type { TranscriptReader } from "../transcript/watch";

export interface ConfigSummary {
  readonly configPath: string;
  readonly workspacePath: string;
  readonly sessionDirectory: string;
  readonly maxConcurrency: number;
  readonly maxAgentAdmissions: number;
  readonly defaultProfile: string;
  readonly profileNames: ReadonlyArray<string>;
}

export interface BridgeHandle {
  readonly mode: "live" | "demo";
  readonly configSummary: ConfigSummary;
  /** Reads the selected agent's session; file-backed when live, in-memory when demo. */
  readonly transcript: TranscriptReader;
  /** Fire and forget — the run's outcome arrives through the store, not this call. */
  start(goal: string, instructions?: string): void;
  refreshStatus(): Promise<void>;
  fetchDetail(reference: string): Promise<void>;
  fetchBulletins(): Promise<void>;
  fetchTraffic(): Promise<void>;
  /** Resolves to undefined on success, or a display-ready rejection message. */
  sendOperatorMessage(reference: string, body: string): Promise<string | undefined>;
  interrupt(reference: string): Promise<void>;
  /** Requests an orderly stop and resolves once the swarm has drained. */
  quit(): Promise<void>;
  dispose(): Promise<void>;
}
