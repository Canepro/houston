import {
  DROPPED_FRAME,
  type LogSocket,
  LogQueue,
  pumpLogQueue,
  WS_QUEUE_MAX,
} from '../../../src/web/routes/logs';

describe('the WebSocket log queue', () => {
  it('keeps the newest 3,000 lines by discarding the oldest line', async () => {
    const queue = new LogQueue();
    for (let index = 0; index <= WS_QUEUE_MAX; index += 1) queue.offer(`line-${String(index)}`);
    expect(queue.dropped).toBe(1);
    expect(await queue.next()).toBe('line-1');
  });

  it('never discards the termination sentinel and emits one synthetic dropped-count frame', async () => {
    const queue = new LogQueue();
    for (let index = 0; index <= WS_QUEUE_MAX; index += 1) {
      queue.offer(`line-${String(index)}`);
      await Promise.resolve();
    }
    queue.offer(null);
    const sent: string[] = [];
    const socket = {
      send: (value: string, done?: (error?: Error) => void) => {
        sent.push(value);
        done?.();
      },
    } as Pick<LogSocket, 'send'>;

    await pumpLogQueue(socket, queue);

    expect(sent[0]).toBe(DROPPED_FRAME(2));
    expect(sent.filter((line) => line.startsWith('... '))).toHaveLength(1);
    expect(sent[1]).toBe('line-2');
    expect(sent.at(-1)).toBe(`line-${String(WS_QUEUE_MAX)}`);
  });

  it('preserves a sentinel already in a full queue when a later line arrives', async () => {
    const queue = new LogQueue(3);
    queue.offer(null);
    queue.offer('line-1');
    queue.offer('line-2');
    queue.offer('line-3');
    expect(await queue.next()).toBeNull();
    expect(queue.dropped).toBe(1);
  });

  it('bounds the application queue while a network write is stalled', async () => {
    const queue = new LogQueue();
    const sent: string[] = [];
    let releaseFirst!: () => void;
    let first = true;
    const socket = {
      send: (value: string, done?: (error?: Error) => void) => {
        sent.push(value);
        if (first) {
          first = false;
          releaseFirst = () => done?.();
        } else {
          done?.();
        }
      },
    } as Pick<LogSocket, 'send'>;

    queue.offer('write-in-flight');
    const pumping = pumpLogQueue(socket, queue);
    await Promise.resolve();
    for (let index = 0; index <= WS_QUEUE_MAX; index += 1) queue.offer(`line-${String(index)}`);
    queue.offer(null);
    releaseFirst();
    await pumping;

    expect(sent[0]).toBe('write-in-flight');
    expect(sent[1]).toBe(DROPPED_FRAME(2));
    expect(sent[2]).toBe('line-2');
    expect(sent.at(-1)).toBe(`line-${String(WS_QUEUE_MAX)}`);
  });

  it('accepts the null success sentinel from the registered ws socket', async () => {
    const queue = new LogQueue();
    queue.offer('line-0');
    queue.offer('line-1');
    queue.offer(null);
    const sent: string[] = [];
    const socket = {
      send: (value: string, done?: (error?: Error | null) => void) => {
        sent.push(value);
        done?.(null);
      },
    } as Pick<LogSocket, 'send'>;

    await pumpLogQueue(socket, queue);

    expect(sent).toEqual(['line-0', 'line-1']);
  });
});
