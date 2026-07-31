import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SdkConsumer } from '../src/consumer';
import { FinancialEvent, MemberEvent, type ConsumedMessage } from '../src/types';

/**
 * Batch-mode consumption (`runBatch`).
 *
 * Purely additive alongside the existing per-message `run()` — every current
 * consumer keeps `eachMessage` untouched. Batch mode exists for sinks whose
 * store is far faster at bulk writes (the ClickHouse event-log sink), where
 * one-INSERT-per-row is the difference between workable and unusable.
 *
 * The durability contract is the point of these tests: the batch handler must
 * complete BEFORE offsets are resolved, so a failure means redelivery rather
 * than a silently-committed gap.
 */

function createMockConsumer() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(undefined),
  };
}

/** Build the kafkajs `eachBatch` payload shape. */
function batchPayload(
  topic: string,
  messages: Array<{ offset: string; value: unknown; headers?: Record<string, string> }>,
) {
  const resolveOffset = vi.fn();
  const heartbeat = vi.fn().mockResolvedValue(undefined);
  return {
    payload: {
      batch: {
        topic,
        partition: 3,
        messages: messages.map((m) => ({
          offset: m.offset,
          key: null,
          value: Buffer.from(JSON.stringify(m.value)),
          headers: Object.fromEntries(
            Object.entries(m.headers ?? {}).map(([k, v]) => [k, Buffer.from(v)]),
          ),
          timestamp: '1700000000000',
        })),
      },
      resolveOffset,
      heartbeat,
      isRunning: () => true,
      isStale: () => false,
    },
    resolveOffset,
    heartbeat,
  };
}

describe('SdkConsumer — batch mode', () => {
  let mockConsumer: ReturnType<typeof createMockConsumer>;
  let consumer: SdkConsumer;

  beforeEach(() => {
    mockConsumer = createMockConsumer();
    consumer = new SdkConsumer(mockConsumer as any);
  });

  describe('subscribeBatch', () => {
    it('subscribes to the topic', async () => {
      await consumer.subscribeBatch(FinancialEvent.Win, vi.fn());
      expect(mockConsumer.subscribe).toHaveBeenCalledWith({
        topic: FinancialEvent.Win,
        fromBeginning: false,
      });
    });

    it('honours fromBeginning', async () => {
      await consumer.subscribeBatch(FinancialEvent.Win, vi.fn(), { fromBeginning: true });
      expect(mockConsumer.subscribe).toHaveBeenCalledWith({
        topic: FinancialEvent.Win,
        fromBeginning: true,
      });
    });

    it('refuses to subscribe once running', async () => {
      await consumer.subscribeBatch(FinancialEvent.Win, vi.fn());
      await consumer.runBatch();
      await expect(consumer.subscribeBatch(MemberEvent.Login, vi.fn())).rejects.toThrow(
        /already running/i,
      );
    });
  });

  describe('runBatch', () => {
    it('throws when nothing is subscribed', async () => {
      await expect(consumer.runBatch()).rejects.toThrow(/No topics subscribed/i);
    });

    it('uses kafkajs eachBatch, not eachMessage', async () => {
      await consumer.subscribeBatch(FinancialEvent.Win, vi.fn());
      await consumer.runBatch();
      const arg = mockConsumer.run.mock.calls[0][0];
      expect(arg.eachBatch).toBeInstanceOf(Function);
      expect(arg.eachMessage).toBeUndefined();
    });

    it('delivers the whole batch to the handler in ONE call', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      await consumer.subscribeBatch(FinancialEvent.Win, handler);
      await consumer.runBatch();

      const { payload } = batchPayload(FinancialEvent.Win, [
        { offset: '1', value: { a: 1 } },
        { offset: '2', value: { a: 2 } },
        { offset: '3', value: { a: 3 } },
      ]);
      await mockConsumer.run.mock.calls[0][0].eachBatch(payload);

      expect(handler).toHaveBeenCalledOnce();
      const messages = handler.mock.calls[0][0] as ConsumedMessage[];
      expect(messages).toHaveLength(3);
      expect(messages.map((m) => m.offset)).toEqual(['1', '2', '3']);
    });

    it('deserializes values and decodes headers', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      await consumer.subscribeBatch(FinancialEvent.Win, handler);
      await consumer.runBatch();

      const { payload } = batchPayload(FinancialEvent.Win, [
        { offset: '7', value: { amount: '10.00' }, headers: { 'x-event-id': 'evt-1' } },
      ]);
      await mockConsumer.run.mock.calls[0][0].eachBatch(payload);

      const [msg] = handler.mock.calls[0][0] as ConsumedMessage[];
      expect(msg.value).toEqual({ amount: '10.00' });
      expect(msg.headers['x-event-id']).toBe('evt-1');
      expect(msg.topic).toBe(FinancialEvent.Win);
      expect(msg.partition).toBe(3);
    });

    it('resolves offsets ONLY AFTER the handler completes', async () => {
      // The durability contract: if offsets resolved first, a handler failure
      // would leave a permanent audit gap.
      const order: string[] = [];
      const handler = vi.fn().mockImplementation(async () => {
        order.push('handler');
      });
      await consumer.subscribeBatch(FinancialEvent.Win, handler);
      await consumer.runBatch();

      const { payload, resolveOffset } = batchPayload(FinancialEvent.Win, [
        { offset: '1', value: {} },
      ]);
      resolveOffset.mockImplementation(() => order.push('resolveOffset'));
      await mockConsumer.run.mock.calls[0][0].eachBatch(payload);

      expect(order).toEqual(['handler', 'resolveOffset']);
    });

    it('does NOT resolve offsets when the handler throws (propagateErrors=true)', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('clickhouse down'));
      await consumer.subscribeBatch(FinancialEvent.Win, handler);
      await consumer.runBatch();

      const { payload, resolveOffset } = batchPayload(FinancialEvent.Win, [
        { offset: '1', value: {} },
      ]);
      await expect(mockConsumer.run.mock.calls[0][0].eachBatch(payload)).rejects.toThrow(
        'clickhouse down',
      );
      expect(resolveOffset).not.toHaveBeenCalled();
    });

    it('swallows and resolves when propagateErrors=false', async () => {
      const tolerant = new SdkConsumer(mockConsumer as any, undefined, 1, false);
      const handler = vi.fn().mockRejectedValue(new Error('boom'));
      await tolerant.subscribeBatch(FinancialEvent.Win, handler);
      await tolerant.runBatch();

      const { payload, resolveOffset } = batchPayload(FinancialEvent.Win, [
        { offset: '1', value: {} },
      ]);
      await expect(mockConsumer.run.mock.calls[0][0].eachBatch(payload)).resolves.toBeUndefined();
      expect(resolveOffset).toHaveBeenCalledWith('1');
    });

    it('heartbeats so a slow batch does not trigger a rebalance', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      await consumer.subscribeBatch(FinancialEvent.Win, handler);
      await consumer.runBatch();

      const { payload, heartbeat } = batchPayload(FinancialEvent.Win, [{ offset: '1', value: {} }]);
      await mockConsumer.run.mock.calls[0][0].eachBatch(payload);
      expect(heartbeat).toHaveBeenCalled();
    });

    it('ignores a batch for an unsubscribed topic', async () => {
      const handler = vi.fn();
      await consumer.subscribeBatch(FinancialEvent.Win, handler);
      await consumer.runBatch();

      const { payload } = batchPayload(MemberEvent.Login, [{ offset: '1', value: {} }]);
      await mockConsumer.run.mock.calls[0][0].eachBatch(payload);
      expect(handler).not.toHaveBeenCalled();
    });

    it('skips an empty batch without calling the handler', async () => {
      const handler = vi.fn();
      await consumer.subscribeBatch(FinancialEvent.Win, handler);
      await consumer.runBatch();

      const { payload } = batchPayload(FinancialEvent.Win, []);
      await mockConsumer.run.mock.calls[0][0].eachBatch(payload);
      expect(handler).not.toHaveBeenCalled();
    });

    it('tolerates a null message value', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      await consumer.subscribeBatch(FinancialEvent.Win, handler);
      await consumer.runBatch();

      const { payload } = batchPayload(FinancialEvent.Win, [{ offset: '1', value: null }]);
      (payload.batch.messages[0] as { value: Buffer | null }).value = null;
      await mockConsumer.run.mock.calls[0][0].eachBatch(payload);

      const [msg] = handler.mock.calls[0][0] as ConsumedMessage[];
      expect(msg.value).toBeNull();
    });
  });
});
