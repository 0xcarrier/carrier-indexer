export function work<T>(options: {
  concurrentWorker: number;
  queue: T[];
  timeout?: number;
  handler: (item: T) => Promise<void>;
  onTimeout?: (item: T) => void;
  onError?: (item: T, err: Error) => void;
}) {
  let cancelled = false;
  const workers = startWork({ ...options, isCancelled: () => cancelled });

  return {
    awake: () => {
      workers.forEach((worker) => {
        if (worker.isIdle()) {
          worker.next();
        }
      });
    },
    cancel: () => {
      cancelled = true;
    },
  };
}

function startWork<T>(options: {
  concurrentWorker: number;
  queue: T[];
  timeout?: number;
  handler: (item: T) => Promise<void>;
  isCancelled: () => boolean;
  onTimeout?: (item: T) => void;
  onError?: (item: T, err: Error) => void;
}) {
  const { concurrentWorker } = options;
  const workers: ReturnType<typeof workItem>[] = [];

  for (let i = 0; i < concurrentWorker; i++) {
    workers.push(workItem(options));
  }

  return workers;
}

function workItem<T>(options: {
  queue: T[];
  timeout?: number;
  handler: (item: T) => Promise<void>;
  isCancelled: () => boolean;
  onTimeout?: (item: T) => void;
  onError?: (item: T, err: Error) => void;
}) {
  const { queue, timeout, handler, isCancelled, onTimeout, onError } = options;

  let idle: boolean;

  function next() {
    if (!isCancelled()) {
      const item = queue.shift();

      if (item != null && !isCancelled()) {
        idle = false;

        const timer =
          timeout != null
            ? setTimeout(() => {
                if (onTimeout) {
                  onTimeout(item);
                }

                next();
              }, timeout)
            : undefined;

        handler(item)
          .then(() => {
            clearTimeout(timer);
            next();
          })
          .catch((e) => {
            if (onError) {
              onError(item, e);
            }

            clearTimeout(timer);
            next();
          });
      } else {
        idle = true;
      }
    } else {
      idle = true;
    }
  }

  next();

  return {
    next,
    isIdle: () => idle,
  };
}
