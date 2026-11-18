/** Each object is already saved beside the project. Limit how often a growing read updates the live document. */
export function ma2ReadCheckpoints(publish: () => void) {
  let lastPublished = -Infinity;
  let pending = false;
  const flush = () => {
    if (!pending) return;
    pending = false;
    publish();
    lastPublished = performance.now();
  };
  return {
    changed() {
      pending = true;
      if (performance.now() - lastPublished >= 500) flush();
    },
    flush
  };
}
