import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SdkConsumer } from '../src/consumer';
import { FinancialEvent, MemberEvent, type ConsumedMessage } from '../src/types';
import type { Logger } from '../src/logger';

function createMockConsumer() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SdkConsumer', () => {
  let mockConsumer: ReturnType<typeof createMockConsumer>;
  let consumer: SdkConsumer;

  beforeEach(() => {
    mockConsumer = createMockConsumer();
    consumer = new SdkConsumer(mockConsumer as any);
  });

  describe('connect', () => {
    it('should call consumer.connect', async () => {
      await consumer.connect();
      expect(mockConsumer.connect).toHaveBeenCalledOnce();
    });

    it('should throw a descriptive error on failure', async () => {
      mockConsumer.connect.mockRejectedValueOnce(new Error('broker unreachable'));
      await expect(consumer.connect()).rejects.toThrow('Failed to connect consumer: broker unreachable');
    });
  });

  describe('disconnect', () => {
    it('should call consumer.disconnect', async () => {
      await consumer.disconnect();
      expect(mockConsumer.disconnect).toHaveBeenCalledOnce();
    });

    it('should throw a descriptive error on failure', async () => {
      mockConsumer.disconnect.mockRejectedValueOnce(new Error('timeout'));
      await expect(consumer.disconnect()).rejects.toThrow('Failed to disconnect consumer: timeout');
    });
  });

  describe('subscribe', () => {
    it('should subscribe to the correct topic', async () => {
      await consumer.subscribe(FinancialEvent.Transaction, vi.fn());

      expect(mockConsumer.subscribe).toHaveBeenCalledWith({
        topic: 'financial-event.transaction',
        fromBeginning: false,
      });
    });

    it('should pass fromBeginning option', async () => {
      await consumer.subscribe(FinancialEvent.Transaction, vi.fn(), { fromBeginning: true });

      expect(mockConsumer.subscribe).toHaveBeenCalledWith({
        topic: 'financial-event.transaction',
        fromBeginning: true,
      });
    });

    it('should call consumer.run with eachMessage handler', async () => {
      await consumer.subscribe(FinancialEvent.Transaction, vi.fn());
      await consumer.run();

      expect(mockConsumer.run).toHaveBeenCalledOnce();
      const runConfig = mockConsumer.run.mock.calls[0][0];
      expect(runConfig.eachMessage).toBeTypeOf('function');
      expect(runConfig.partitionsConsumedConcurrently).toBe(1);
    });

    it('should deserialize and pass message to handler', async () => {
      const handler = vi.fn();
      await consumer.subscribe(MemberEvent.Login, handler);
      await consumer.run();

      const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
      await eachMessage({
        topic: 'member-event.login',
        partition: 0,
        message: {
          offset: '42',
          key: Buffer.from('user-1'),
          value: Buffer.from(JSON.stringify({ memberId: 'user-1', ip: '10.0.0.1' })),
          headers: {},
          timestamp: '1700000000000',
        },
      });

      expect(handler).toHaveBeenCalledOnce();
      const msg: ConsumedMessage<typeof MemberEvent.Login> = handler.mock.calls[0][0];
      expect(msg.topic).toBe('member-event.login');
      expect(msg.partition).toBe(0);
      expect(msg.offset).toBe('42');
      expect(msg.key).toBe('user-1');
      expect(msg.value).toEqual({ memberId: 'user-1', ip: '10.0.0.1' });
      expect(msg.timestamp).toBe('1700000000000');
    });

    it('should handle null message key', async () => {
      const handler = vi.fn();
      await consumer.subscribe(MemberEvent.Logout, handler);
      await consumer.run();

      const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
      await eachMessage({
        topic: 'member-event.logout',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          value: Buffer.from(JSON.stringify({ memberId: 'u1' })),
          headers: {},
          timestamp: '1700000000000',
        },
      });

      expect(handler.mock.calls[0][0].key).toBeNull();
    });

    it('should handle null message value', async () => {
      const handler = vi.fn();
      await consumer.subscribe(MemberEvent.Logout, handler);
      await consumer.run();

      const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
      await eachMessage({
        topic: 'member-event.logout',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          value: null,
          headers: {},
          timestamp: '1700000000000',
        },
      });

      expect(handler.mock.calls[0][0].value).toBeNull();
    });

    it('should convert message headers to strings', async () => {
      const handler = vi.fn();
      await consumer.subscribe(MemberEvent.Login, handler);
      await consumer.run();

      const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
      await eachMessage({
        topic: 'member-event.login',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          value: Buffer.from(JSON.stringify({ memberId: 'u1', ip: '1.1.1.1' })),
          headers: { 'x-trace-id': Buffer.from('trace-abc') },
          timestamp: '1700000000000',
        },
      });

      expect(handler.mock.calls[0][0].headers).toEqual({ 'x-trace-id': 'trace-abc' });
    });

    it('should default timestamp to empty string when undefined', async () => {
      const handler = vi.fn();
      await consumer.subscribe(MemberEvent.Login, handler);
      await consumer.run();

      const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
      await eachMessage({
        topic: 'member-event.login',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          value: Buffer.from(JSON.stringify({ memberId: 'u1', ip: '1.1.1.1' })),
          headers: {},
          timestamp: undefined,
        },
      });

      expect(handler.mock.calls[0][0].timestamp).toBe('');
    });

    it('should propagate handler errors by default so KafkaJS does not commit the offset', async () => {
      const handler = vi.fn().mockRejectedValueOnce(new Error('handler boom'));

      await consumer.subscribe(MemberEvent.Login, handler);
      await consumer.run();

      const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
      await expect(
        eachMessage({
          topic: 'member-event.login',
          partition: 0,
          message: {
            offset: '5',
            key: null,
            value: Buffer.from(JSON.stringify({ memberId: 'u1', ip: '1.1.1.1' })),
            headers: {},
            timestamp: '1700000000000',
          },
        }),
      ).rejects.toThrow('handler boom');
    });

    it('should swallow handler errors when propagateErrors is false and log via logger', async () => {
      const mockLogger = { error: vi.fn(), info: vi.fn(), debug: vi.fn() };
      const swallowConsumer = new SdkConsumer(mockConsumer as any, undefined, undefined, false, mockLogger);
      const handler = vi.fn().mockRejectedValueOnce(new Error('handler boom'));

      await swallowConsumer.subscribe(MemberEvent.Login, handler);
      await swallowConsumer.run();

      const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
      await eachMessage({
        topic: 'member-event.login',
        partition: 0,
        message: {
          offset: '5',
          key: null,
          value: Buffer.from(JSON.stringify({ memberId: 'u1', ip: '1.1.1.1' })),
          headers: {},
          timestamp: '1700000000000',
        },
      });

      expect(mockLogger.error).toHaveBeenCalled();
      expect(mockLogger.error.mock.calls[0][0]).toContain('Error processing message');
      expect(mockLogger.error.mock.calls[0][1]).toEqual(
        expect.objectContaining({ topic: 'member-event.login', offset: '5' }),
      );
    });
  });

  describe('concurrency', () => {
    it('should use default concurrency of 1', async () => {
      await consumer.subscribe(FinancialEvent.Transaction, vi.fn());
      await consumer.run();

      const runConfig = mockConsumer.run.mock.calls[0][0];
      expect(runConfig.partitionsConsumedConcurrently).toBe(1);
    });

    it('should use custom concurrency when provided', async () => {
      const concurrentConsumer = new SdkConsumer(mockConsumer as any, undefined, 5);
      await concurrentConsumer.subscribe(FinancialEvent.Transaction, vi.fn());
      await concurrentConsumer.run();

      const runConfig = mockConsumer.run.mock.calls[0][0];
      expect(runConfig.partitionsConsumedConcurrently).toBe(5);
    });
  });

  describe('logger', () => {
    let mockLogger: Logger;

    beforeEach(() => {
      mockLogger = { error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    });

    it('should log info on connect and disconnect', async () => {
      const c = new SdkConsumer(mockConsumer as any, undefined, undefined, undefined, mockLogger);
      await c.connect();
      await c.disconnect();

      const infoCalls = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls;
      expect(infoCalls[0][0]).toBe('Consumer connecting');
      expect(infoCalls[1][0]).toBe('Consumer connected');
      expect(infoCalls[2][0]).toBe('Consumer disconnecting');
      expect(infoCalls[3][0]).toBe('Consumer disconnected');
    });

    it('should log error on connect failure', async () => {
      mockConsumer.connect.mockRejectedValueOnce(new Error('broker unreachable'));
      const c = new SdkConsumer(mockConsumer as any, undefined, undefined, undefined, mockLogger);

      await expect(c.connect()).rejects.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to connect consumer',
        expect.objectContaining({ error: 'broker unreachable' }),
      );
    });

    it('should log info on subscribe with topic details', async () => {
      const c = new SdkConsumer(mockConsumer as any, undefined, undefined, undefined, mockLogger);
      await c.subscribe(MemberEvent.Login, vi.fn(), { fromBeginning: true });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Subscribing to topic',
        { topic: 'member-event.login', fromBeginning: true },
      );
    });

    it('should log info on consumer start with topics and concurrency', async () => {
      const c = new SdkConsumer(mockConsumer as any, undefined, 3, undefined, mockLogger);
      await c.subscribe(FinancialEvent.Transaction, vi.fn());
      // 'Consumer starting' is logged by run(), not subscribe() — the two were split.
      await c.run();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Consumer starting',
        { topics: ['financial-event.transaction'], concurrency: 3 },
      );
    });

    it('should log debug on message processing', async () => {
      const handler = vi.fn();
      const c = new SdkConsumer(mockConsumer as any, undefined, undefined, undefined, mockLogger);
      await c.subscribe(MemberEvent.Login, handler);
      await c.run();

      const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
      await eachMessage({
        topic: 'member-event.login',
        partition: 2,
        message: {
          offset: '99',
          key: Buffer.from('user-1'),
          value: Buffer.from(JSON.stringify({ memberId: 'user-1', ip: '10.0.0.1' })),
          headers: {},
          timestamp: '1700000000000',
        },
      });

      const debugCalls = (mockLogger.debug as ReturnType<typeof vi.fn>).mock.calls;
      expect(debugCalls[0][0]).toBe('Processing message');
      expect(debugCalls[0][1]).toEqual({
        topic: 'member-event.login',
        partition: 2,
        offset: '99',
        key: 'user-1',
      });
      expect(debugCalls[1][0]).toBe('Message processed');
      expect(debugCalls[1][1]).toEqual({
        topic: 'member-event.login',
        partition: 2,
        offset: '99',
      });
    });

    it('should log error on handler failure and still propagate', async () => {
      const handler = vi.fn().mockRejectedValueOnce(new Error('handler boom'));
      const c = new SdkConsumer(mockConsumer as any, undefined, undefined, true, mockLogger);
      await c.subscribe(MemberEvent.Login, handler);
      await c.run();

      const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
      await expect(
        eachMessage({
          topic: 'member-event.login',
          partition: 0,
          message: {
            offset: '5',
            key: null,
            value: Buffer.from(JSON.stringify({ memberId: 'u1', ip: '1.1.1.1' })),
            headers: {},
            timestamp: '1700000000000',
          },
        }),
      ).rejects.toThrow('handler boom');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error processing message',
        expect.objectContaining({
          topic: 'member-event.login',
          partition: 0,
          offset: '5',
          error: 'handler boom',
        }),
      );
    });

    it('should not log to console when no logger is provided (noopLogger)', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      const c = new SdkConsumer(mockConsumer as any);
      await c.connect();
      await c.subscribe(FinancialEvent.Transaction, vi.fn());
      await c.disconnect();

      expect(consoleSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
      errorSpy.mockRestore();
      debugSpy.mockRestore();
    });
  });
});
