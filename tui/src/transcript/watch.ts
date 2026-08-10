/**
 * Keeps a transcript view fed from disk. Pi writes settled messages only, so a
 * one-second poll is as live as the file can be — there is nothing to gain from
 * fs.watch here, and polling survives the file not existing yet (a session file
 * is not created until the agent's first assistant reply completes).
 *
 * The reader is an injected function rather than a hard-wired filesystem call
 * so demo mode can serve synthetic sessions through the same parser.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { useEffect, useState } from "react";
import { parseTranscript, type Transcript } from "./parse";

const POLL_INTERVAL_MILLIS = 1_000;

export interface TranscriptSnapshot {
  readonly fileName: string;
  readonly transcript: Transcript;
}

export type TranscriptReader = (agentId: string) => Promise<TranscriptSnapshot | undefined>;

interface CacheEntry {
  readonly path: string;
  readonly size: number;
  readonly mtimeMillis: number;
  readonly snapshot: TranscriptSnapshot;
}

/** Newest `.jsonl` by mtime, mirroring how Pi itself picks a directory's current session. */
const newestSessionFile = async (directory: string): Promise<string | undefined> => {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  let best: { path: string; mtimeMillis: number } | undefined;
  for (const name of names) {
    const path = join(directory, name);
    try {
      const stats = await stat(path);
      if (best === undefined || stats.mtimeMs > best.mtimeMillis) {
        best = { path, mtimeMillis: stats.mtimeMs };
      }
    } catch {
      continue;
    }
  }
  return best?.path;
};

export const makeFileTranscriptReader = (sessionDirectory: string): TranscriptReader => {
  const cache = new Map<string, CacheEntry>();
  return async (agentId) => {
    const directory = join(sessionDirectory, agentId);
    let path: string | undefined;
    try {
      path = await newestSessionFile(directory);
    } catch {
      return undefined;
    }
    if (path === undefined) return undefined;

    let size: number;
    let mtimeMillis: number;
    try {
      const stats = await stat(path);
      size = stats.size;
      mtimeMillis = stats.mtimeMs;
    } catch {
      return undefined;
    }

    const cached = cache.get(agentId);
    if (
      cached !== undefined &&
      cached.path === path &&
      cached.size === size &&
      cached.mtimeMillis === mtimeMillis
    ) {
      return cached.snapshot;
    }

    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return cached?.snapshot;
    }
    const fileName = path.slice(path.lastIndexOf("/") + 1);
    const snapshot: TranscriptSnapshot = { fileName, transcript: parseTranscript(text) };
    cache.set(agentId, { path, size, mtimeMillis, snapshot });
    return snapshot;
  };
};

/** Serves raw JSONL held in memory through the same parser the file reader uses. */
export const makeMemoryTranscriptReader =
  (
    lookup: (agentId: string) => { readonly fileName: string; readonly text: string } | undefined,
  ): TranscriptReader =>
  async (agentId) => {
    const source = lookup(agentId);
    if (source === undefined) return undefined;
    return { fileName: source.fileName, transcript: parseTranscript(source.text) };
  };

export interface TranscriptState {
  readonly snapshot?: TranscriptSnapshot;
  readonly loading: boolean;
}

export const useTranscript = (
  reader: TranscriptReader,
  agentId: string | undefined,
  active: boolean,
): TranscriptState => {
  const [state, setState] = useState<TranscriptState>({ loading: true });

  useEffect(() => {
    if (!active || agentId === undefined) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    const poll = (): void => {
      void reader(agentId)
        .then((snapshot) => {
          if (cancelled) return;
          setState(snapshot === undefined ? { loading: false } : { snapshot, loading: false });
        })
        .catch(() => {
          if (!cancelled) setState({ loading: false });
        });
    };
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MILLIS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [reader, agentId, active]);

  return state;
};
