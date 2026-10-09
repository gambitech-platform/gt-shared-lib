import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SdkProducer } from '../src/producer';
import { SdkConsumer } from '../src/consumer';
import { FinancialEvent, MemberEvent, ServerEvent } from '../src/types';

function createMockProducer() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockConsumer() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Stress Tests', () => {
  describe('Producer — high volume send', () => {
    let mockProducer: ReturnType<typeof createMockProducer>;
    let producer: SdkProducer;

    beforeEach(() => {
      mockProducer = createMockProducer();
      producer = new SdkProducer(mockProducer as any);
    });

    it('should handle 10,000 sequential sends without errors', async () => {
      const count = 10_000;

      for (let i = 0; i < count; i++) {
        await producer.send(FinancialEvent.Transaction, {
          key: `user-${i}`,
          value: { memberId: `user-${i}`, amount: i, currency: 'USD', transactionId: `tx-${i}` },
        });
      }

      expect(mockProducer.send).toHaveBeenCalledTimes(count);
    });

    it('should handle 1,000 concurrent sends without errors', async () => {
      const count = 1_000;
      const promises: Promise<void>[] = [];

      for (let i = 0; i < count; i++) {
        promises.push(
          producer.send(MemberEvent.Login, {
            key: `user-${i}`,
            value: { memberId: `user-${i}`, ip: `10.0.${Math.floor(i / 256)}.${i % 256}` },
          }),
        );
      }

      await Promise.all(promises);
      expect(mockProducer.send).toHaveBeenCalledTimes(count);
    });

    it('should handle 500 batch sends of 100 messages each', async () => {
      const batches = 500;
      const batchSize = 100;

      for (let b = 0; b < batches; b++) {
        const messages = Array.from({ length: batchSize }, (_, i) => ({
          key: `user-${b}-${i}`,
          value: {
            memberId: `user-${b}-${i}`,
            amount: i * 10,
            currency: 'USD',
            transactionId: `tx-${b}-${i}`,
          },
        }));

        await producer.sendBatch(FinancialEvent.Transaction, messages);
      }

      expect(mockProducer.send).toHaveBeenCalledTimes(batches);

      // Verify last batch had correct number of messages
      const lastCall = mockProducer.send.mock.calls[batches - 1][0];
      expect(lastCall.messages).toHaveLength(batchSize);
    });

    it('should handle rapid topic switching across all topics', async () => {
      const topics = [
        { topic: FinancialEvent.Transaction, value: { memberId: 'u1', amount: 1, currency: 'USD', transactionId: 'tx' } },
        { topic: MemberEvent.Login, value: { memberId: 'u1', ip: '1.1.1.1' } },
        { topic: MemberEvent.Logout, value: { memberId: 'u1' } },
        { topic: MemberEvent.Register, value: { memberId: 'u1', email: 'a@b.com' } },
        { topic: MemberEvent.SessionExpired, value: { memberId: 'u1', sessionId: 's1' } },
        { topic: ServerEvent.Crash, value: { serverId: 's1', error: 'oom' } },
        { topic: ServerEvent.HealthCheck, value: { serverId: 's1', status: 'ok' } },
        { topic: ServerEvent.Restart, value: { serverId: 's1', reason: 'deploy' } },
      ] as const;

      const iterations = 1_000;

      for (let i = 0; i < iterations; i++) {
        const entry = topics[i % topics.length];
        await producer.send(entry.topic, { key: `k-${i}`, value: entry.value } as any);
      }

      expect(mockProducer.send).toHaveBeenCalledTimes(iterations);
    });
  });

  describe('Producer — error resilience', () => {
    it('should handle intermittent failures without corrupting state', async () => {
      const mockProducer = createMockProducer();
      const producer = new SdkProducer(mockProducer as any);

      let successCount = 0;
      let errorCount = 0;

      // Fail every 3rd call
      mockProducer.send.mockImplementation(async (_: any) => {
        const callNum = mockProducer.send.mock.calls.length;
        if (callNum % 3 === 0) {
          throw new Error(`intermittent failure #${callNum}`);
        }
      });

      for (let i = 0; i < 100; i++) {
        try {
          await producer.send(FinancialEvent.Transaction, {
            key: `u-${i}`,
            value: { memberId: `u-${i}`, amount: i * 10, gameId: `g-${i}` },
          });
          successCount++;
        } catch {
          errorCount++;
        }
      }

      expect(successCount + errorCount).toBe(100);
      expect(errorCount).toBeGreaterThan(0);
      expect(successCount).toBeGreaterThan(0);
    });
  });

  describe('Consumer — high volume message processing', () => {
    it('should process 10,000 messages through the handler', async () => {
      const mockConsumer = createMockConsumer();
      const consumer = new SdkConsumer(mockConsumer as any);

      const received: any[] = [];
      const handler = vi.fn((msg: any) => { received.push(msg); });

      await consumer.subscribe(FinancialEvent.Transaction, handler);
      await consumer.run();

      const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
      const count = 10_000;

      for (let i = 0; i < count; i++) {
        await eachMessage({
          topic: 'financial-event.transaction',
          partition: i % 3,
          message: {
            offset: String(i),
            key: Buffer.from(`user-${i}`),
            value: Buffer.from(JSON.stringify({
              memberId: `user-${i}`,
              amount: i,
              currency: 'USD',
              transactionId: `tx-${i}`,
            })),
            headers: {},
            timestamp: String(Date.now()),
          },
        });
      }

      expect(handler).toHaveBeenCalledTimes(count);
      expect(received).toHaveLength(count);
      expect(received[0].value.transactionId).toBe('tx-0');
      expect(received[count - 1].value.transactionId).toBe(`tx-${count - 1}`);
    });

    it('should propagate handler errors to KafkaJS on every message', async () => {
      const mockConsumer = createMockConsumer();
      const consumer = new SdkConsumer(mockConsumer as any);

      const handler = vi.fn().mockRejectedValue(new Error('handler crash'));

      await consumer.subscribe(MemberEvent.Login, handler);
      await consumer.run();

      const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
      const count = 1_000;

      for (let i = 0; i < count; i++) {
        await expect(
          eachMessage({
            topic: 'member-event.login',
            partition: 0,
            message: {
              offset: String(i),
              key: null,
              value: Buffer.from(JSON.stringify({ memberId: `u-${i}`, ip: '1.1.1.1' })),
              headers: {},
              timestamp: String(Date.now()),
            },
          }),
        ).rejects.toThrow('handler crash');
      }

      expect(handler).toHaveBeenCalledTimes(count);
    });

    it('should handle messages with large payloads', async () => {
      const mockConsumer = createMockConsumer();
      const consumer = new SdkConsumer(mockConsumer as any);

      const handler = vi.fn();
      await consumer.subscribe(ServerEvent.Crash, handler);
      await consumer.run();

      const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
      const largeError = 'x'.repeat(1_000_000); // 1MB string

      await eachMessage({
        topic: 'server-event.crash',
        partition: 0,
        message: {
          offset: '0',
          key: Buffer.from('server-1'),
          value: Buffer.from(JSON.stringify({ serverId: 'server-1', error: largeError })),
          headers: {},
          timestamp: String(Date.now()),
        },
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].value.error).toHaveLength(1_000_000);
    });

    it('should handle messages with many headers', async () => {
      const mockConsumer = createMockConsumer();
      const consumer = new SdkConsumer(mockConsumer as any);

      const handler = vi.fn();
      await consumer.subscribe(MemberEvent.Login, handler);
      await consumer.run();

      const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
      const headers: Record<string, Buffer> = {};
      for (let i = 0; i < 100; i++) {
        headers[`header-${i}`] = Buffer.from(`value-${i}`);
      }

      await eachMessage({
        topic: 'member-event.login',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          value: Buffer.from(JSON.stringify({ memberId: 'u1', ip: '1.1.1.1' })),
          headers,
          timestamp: String(Date.now()),
        },
      });

      const receivedHeaders = handler.mock.calls[0][0].headers;
      expect(Object.keys(receivedHeaders)).toHaveLength(100);
      expect(receivedHeaders['header-50']).toBe('value-50');
    });
  });

  describe('Concurrency — multiple consumers', () => {
    it('should handle 10 independent consumers processing simultaneously', async () => {
      const consumers: { consumer: SdkConsumer; mock: ReturnType<typeof createMockConsumer>; handler: ReturnType<typeof vi.fn> }[] = [];

      for (let c = 0; c < 10; c++) {
        const mock = createMockConsumer();
        const consumer = new SdkConsumer(mock as any, undefined, 3);
        const handler = vi.fn();
        await consumer.subscribe(FinancialEvent.Transaction, handler);
        // subscribe() only registers the handler; run() is what installs eachMessage.
        await consumer.run();
        consumers.push({ consumer, mock, handler });
      }

      // Simulate messages arriving on all consumers concurrently
      const allPromises: Promise<void>[] = [];

      for (const { mock } of consumers) {
        const eachMessage = mock.run.mock.calls[0][0].eachMessage;
        for (let i = 0; i < 100; i++) {
          allPromises.push(
            eachMessage({
              topic: 'financial-event.transaction',
              partition: i % 3,
              message: {
                offset: String(i),
                key: Buffer.from(`key-${i}`),
                value: Buffer.from(JSON.stringify({
                  memberId: `u-${i}`,
                  amount: i,
                  currency: 'USD',
                  transactionId: `tx-${i}`,
                })),
                headers: {},
                timestamp: String(Date.now()),
              },
            }),
          );
        }
      }

      await Promise.all(allPromises);

      for (const { handler } of consumers) {
        expect(handler).toHaveBeenCalledTimes(100);
      }
    });
  });
});
