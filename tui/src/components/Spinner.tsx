/**
 * One braille spinner shared by every screen. The tick is a module-level
 * interval rather than per-component state so a dozen running agents animate in
 * lockstep — and so the timer stops existing the moment nothing is spinning.
 */
import { useSyncExternalStore } from "react";
import { spinnerFrames, theme } from "../theme";

const FRAME_INTERVAL_MILLIS = 120;

let frameIndex = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  timer ??= setInterval(() => {
    frameIndex = (frameIndex + 1) % spinnerFrames.length;
    for (const notify of listeners) notify();
  }, FRAME_INTERVAL_MILLIS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};

const currentFrame = (): string => spinnerFrames[frameIndex] ?? spinnerFrames[0];

export const useSpinnerFrame = (): string => useSyncExternalStore(subscribe, currentFrame);

export interface SpinnerProps {
  readonly color?: string;
  readonly label?: string;
}

export const Spinner = ({ color = theme.amber, label }: SpinnerProps) => {
  const frame = useSpinnerFrame();
  return (
    <text>
      <span fg={color}>{frame}</span>
      {label === undefined ? null : <span fg={theme.muted}>{` ${label}`}</span>}
    </text>
  );
};
