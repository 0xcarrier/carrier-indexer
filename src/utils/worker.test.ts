import { work } from "./worker";

test("Test concurrent worker is the same as settings", (done) => {
  const queue = [1, 2, 3, 4];

  let isDone = false;

  work({
    concurrentWorker: 3,
    queue,
    timeout: 10 * 1000,
    handler: async (item) => {
      console.log("1. working on item", item);

      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (!isDone) {
            isDone = true;
            done();
          }

          resolve();
        }, 1000);
      });
    },
  });

  expect(queue.shift()).toBe(4);
});

test("Test worker will work until queue is empty", (done) => {
  const queue = [1, 2, 3, 4];

  work({
    concurrentWorker: 3,
    queue,
    timeout: 10 * 1000,
    handler: async (item) => {
      console.log("2. working on item", item);

      if (queue.length === 0) {
        done();
      }
    },
  });
});

test("Test awake woker", (done) => {
  const queue = [1, 2, 3, 4];
  const workers = work({
    concurrentWorker: 3,
    queue,
    timeout: 10 * 1000,
    handler: async (item) => {
      console.log("3. working on item", item);

      if (item === 3) {
        expect(queue[0]).toBe(4);
      } else if (item === 4) {
        expect(queue.length).toBe(0);

        queue.push(5, 6, 7);

        workers.awake();
      } else if (item === 7) {
        done();
      }
    },
  });
});

test("Test awake woker multiple times", () => {
  return new Promise<void>((resolveTest, reject) => {
    const queue: number[] = [];
    const workers = work({
      concurrentWorker: 3,
      queue,
      timeout: 10 * 1000,
      handler: async (item) => {
        console.log("4. working on item", item);

        return new Promise((resolve, reject) => {
          setTimeout(() => {
            resolve();

            if (queue.length === 0) {
              resolveTest();
            }
          }, 3000);
        });
      },
    });

    for (let i = 1; i <= 2; i++) {
      setTimeout(() => {
        queue.push((i - 1) * 4 + 1, (i - 1) * 4 + 2, (i - 1) * 4 + 3, (i - 1) * 4 + 4);

        workers.awake();

        if (i === 1) {
          expect(queue[queue.length - 1]).toBe(4);
        } else if (i === 2) {
          expect(queue).toEqual([4, 5, 6, 7, 8]);
        }
      }, 1000 * i);
    }
  });
}, 10000);

test("Test cancel woker", (done) => {
  const queue: number[] = [];
  const workers = work({
    concurrentWorker: 3,
    queue,
    timeout: 10 * 1000,
    handler: async (item) => {
      console.log("5. working on item", item);
    },
  });

  queue.push(1, 2);

  workers.cancel();
  workers.awake();

  setTimeout(() => {
    expect(queue).toEqual([1, 2]);
    done();
  }, 3000);
});

test("Test timeout", (done) => {
  const queue: number[] = [];
  let timeoutCount = 0;
  const workers = work({
    concurrentWorker: 2,
    queue,
    timeout: 1000,
    onTimeout: () => {
      timeoutCount += 1;
    },
    handler: async (item) => {
      console.log("6. working on item", item);

      return new Promise((resolve, reject) => {});
    },
  });

  queue.push(1, 2);
  workers.awake();

  setTimeout(() => {
    expect(queue).toEqual([]);
    expect(timeoutCount).toEqual(2);

    queue.push(3, 4);
    workers.awake();

    setTimeout(() => {
      expect(queue).toEqual([]);
      expect(timeoutCount).toEqual(4);
      done();
    }, 2000);
  }, 2000);
});

test("Test error", (done) => {
  const queue: number[] = [];
  let errorCount = 0;
  const workers = work({
    concurrentWorker: 2,
    queue,
    timeout: 10 * 1000,
    onError: () => {
      errorCount += 1;
    },
    handler: async (item) => {
      console.log("7. working on item", item);

      throw new Error("Test");
    },
  });

  queue.push(1, 2);
  workers.awake();

  setTimeout(() => {
    expect(queue).toEqual([]);
    expect(errorCount).toEqual(2);

    queue.push(3, 4);
    workers.awake();

    setTimeout(() => {
      expect(queue).toEqual([]);
      expect(errorCount).toEqual(4);
      done();
    }, 1000);
  }, 1000);
});
