export type PreviewQueueCancel = () => void;

type QueuedPreview = {
  cancelled: boolean;
  run: () => Promise<void>;
};

export function createPreviewQueue() {
  const waiting: QueuedPreview[] = [];
  let active = false;

  const pump = async (): Promise<void> => {
    if (active) return;
    let next: QueuedPreview | undefined;
    while ((next = waiting.shift())) {
      if (!next.cancelled) break;
    }
    if (!next || next.cancelled) return;
    active = true;
    try {
      await next.run();
    } catch {
      // A failed row owns its error UI. It must not stop later queue entries.
    } finally {
      active = false;
      void pump();
    }
  };

  return {
    enqueue(run: () => Promise<void>): PreviewQueueCancel {
      const item = { cancelled: false, run };
      waiting.push(item);
      void pump();
      return () => {
        item.cancelled = true;
      };
    },
  };
}

export const appPreviewQueue = createPreviewQueue();
