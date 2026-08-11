/**
 * Mouse-wheel support shared by every scrolling surface. OpenTUI delivers
 * scroll events to the renderable under the pointer; each surface translates
 * them into the same row-stepping its keyboard bindings use, so wheel and
 * keys can never disagree about position.
 */

export interface WheelEventLike {
  readonly scroll?: {
    readonly direction: "up" | "down" | "left" | "right";
    readonly delta: number;
  };
}

/** Signed vertical row delta for a scroll event, or undefined for non-vertical input. */
export const wheelRows = (event: WheelEventLike): number | undefined => {
  const scroll = event.scroll;
  if (scroll === undefined || (scroll.direction !== "up" && scroll.direction !== "down")) {
    return undefined;
  }
  const step = Math.min(3, Math.max(1, Math.round(scroll.delta)));
  return scroll.direction === "down" ? step : -step;
};
