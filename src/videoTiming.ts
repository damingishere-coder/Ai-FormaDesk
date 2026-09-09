// Keep deadlines on the original timeline. Resetting the deadline to each
// callback's arrival accumulates jitter and can halve capture on a 60 Hz screen.
export function videoFrameClock(fps: number) {
  let previous = 0;
  return (elapsedSeconds: number) => {
    const frame = Math.floor((elapsedSeconds + 0.001) * fps);
    if (frame <= previous) return false;
    previous = frame;
    return true;
  };
}
