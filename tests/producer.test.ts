import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SdkProducer } from '../src/producer';
import { KafkaProducerError } from '../src/errors';
import { FinancialEvent, MemberEvent } from '../src/types';
import type { Logger } from '../src/logger';

function createMockProducer() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SdkProducer', () => {
  let mockProducer: ReturnType<typeof createMockProducer>;
  let producer: SdkProducer;

  beforeEach(() => {
    mockProducer = createMockProducer();
    producer = new SdkProducer(mockProducer as any);
  });

  describe('connect', () => {
    it('should call producer.connect', async () => {
      await producer.connect();
      expect(mockProducer.connect).toHaveBeenCalledOnce();
    });

    it('should throw a descriptive error on failure', async () => {
      mockProducer.connect.mockRejectedValueOnce(new Error('broker down'));
      await expect(producer.connect()).rejects.toThrow('Failed to connect producer: broker down');
    });
  });

  describe('disconnect', () => {
    it('should call producer.disconnect', async () => {
      await producer.disconnect();
      expect(mockProducer.disconnect).toHaveBeenCalledOnce();
    });

    it('should throw a descriptive error on failure', async () => {
      mockProducer.disconnect.mockRejectedValueOnce(new Error('timeout'));
      await expect(producer.disconnect()).rejects.toThrow('Failed to disconnect producer: timeout');
    });
  });

  describe('send', () => {
    it('should send a single message with correct topic and serialized value', async () => {
      await producer.send(MemberEvent.Login, {
        key: 'user-1',
        value: { memberId: 'user-1', ip: '10.0.0.1' },
      });

      expect(mockProducer.send).toHaveBeenCalledOnce();
      const call = mockProducer.send.mock.calls[0][0];
      expect(call.topic).toBe('member-event.login');
      expect(call.messages).toHaveLength(1);
      expect(call.messages[0].key).toBe('user-1');

      const value = JSON.parse(call.messages[0].value.toString());
      expect(value).toEqual({ memberId: 'user-1', ip: '10.0.0.1' });
    });

    it('should default key to null when not provided', async () => {
      await producer.send(MemberEvent.Logout, {
        value: { memberId: 'user-1' },
      });

      const call = mockProducer.send.mock.calls[0][0];
      expect(call.messages[0].key).toBeNull();
    });

    it('should pass headers through', async () => {
      await producer.send(MemberEvent.Login, {
        key: 'u1',
        value: { memberId: 'u1', ip: '1.2.3.4' },
        headers: { 'x-trace-id': 'abc-123' },
      });

      const call = mockProducer.send.mock.calls[0][0];
      expect(call.messages[0].headers).toEqual({ 'x-trace-id': 'abc-123' });
    });

    it('should throw a descriptive error on failure', async () => {
      mockProducer.send.mockRejectedValueOnce(new Error('network error'));
      await expect(
        producer.send(FinancialEvent.Transaction, {
          value: { memberId: 'u1', amount: 100, currency: 'USD', transactionId: 'tx-1' },
        }),
      ).rejects.toThrow('Failed to send message to financial-event.transaction: network error');
    });
  });

  describe('sendBatch', () => {
    it('should send multiple messages in a single call', async () => {
      await producer.sendBatch(FinancialEvent.Transaction, [
        { key: 'u1', value: { memberId: 'u1', amount: 50, currency: 'USD', transactionId: 'tx-1' } },
        { key: 'u2', value: { memberId: 'u2', amount: 100, currency: 'EUR', transactionId: 'tx-2' } },
      ]);

      expect(mockProducer.send).toHaveBeenCalledOnce();
      const call = mockProducer.send.mock.calls[0][0];
      expect(call.topic).toBe('financial-event.transaction');
      expect(call.messages).toHaveLength(2);

      const v0 = JSON.parse(call.messages[0].value.toString());
      const v1 = JSON.parse(call.messages[1].value.toString());
      expect(v0.transactionId).toBe('tx-1');
      expect(v1.transactionId).toBe('tx-2');
    });

    it('should throw a descriptive error on failure', async () => {
      mockProducer.send.mockRejectedValueOnce(new Error('quota exceeded'));
      await expect(
        producer.sendBatch(FinancialEvent.Transaction, [
          { value: { memberId: 'u1', amount: 1, currency: 'USD', transactionId: 'tx-1' } },
        ]),
      ).rejects.toThrow('Failed to send batch to financial-event.transaction: quota exceeded');
    });
  });

  describe('logger', () => {
    let mockLogger: Logger;

    beforeEach(() => {
      mockLogger = { error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    });

    it('should log info on connect and disconnect', async () => {
      const p = new SdkProducer(mockProducer as any, undefined, mockLogger);
      await p.connect();
      await p.disconnect();

      const infoCalls = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls;
      expect(infoCalls[0][0]).toBe('Producer connecting');
      expect(infoCalls[1][0]).toBe('Producer connected');
      expect(infoCalls[2][0]).toBe('Producer disconnecting');
      expect(infoCalls[3][0]).toBe('Producer disconnected');
    });

    it('should log error on connect failure', async () => {
      mockProducer.connect.mockRejectedValueOnce(new Error('broker down'));
      const p = new SdkProducer(mockProducer as any, undefined, mockLogger);

      await expect(p.connect()).rejects.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to connect producer',
        expect.objectContaining({ error: 'broker down' }),
      );
    });

    it('should log debug on send with topic and key', async () => {
      const p = new SdkProducer(mockProducer as any, undefined, mockLogger);
      await p.send(MemberEvent.Login, { key: 'user-1', value: { memberId: 'user-1', ip: '10.0.0.1' } });

      const debugCalls = (mockLogger.debug as ReturnType<typeof vi.fn>).mock.calls;
      expect(debugCalls[0][0]).toBe('Sending message');
      expect(debugCalls[0][1]).toEqual({ topic: 'member-event.login', key: 'user-1' });
      expect(debugCalls[1][0]).toBe('Message sent');
      expect(debugCalls[1][1]).toEqual({ topic: 'member-event.login' });
    });

    it('should log debug on sendBatch with topic and message count', async () => {
      const p = new SdkProducer(mockProducer as any, undefined, mockLogger);
      await p.sendBatch(FinancialEvent.Transaction, [
        { key: 'u1', value: { memberId: 'u1', amount: 50, currency: 'USD', transactionId: 'tx-1' } },
        { key: 'u2', value: { memberId: 'u2', amount: 100, currency: 'EUR', transactionId: 'tx-2' } },
      ]);

      const debugCalls = (mockLogger.debug as ReturnType<typeof vi.fn>).mock.calls;
      expect(debugCalls[0][0]).toBe('Sending batch');
      expect(debugCalls[0][1]).toEqual({ topic: 'financial-event.transaction', messageCount: 2 });
      expect(debugCalls[1][0]).toBe('Batch sent');
      expect(debugCalls[1][1]).toEqual({ topic: 'financial-event.transaction', messageCount: 2 });
    });

    it('should log error on send failure', async () => {
      mockProducer.send.mockRejectedValueOnce(new Error('network error'));
      const p = new SdkProducer(mockProducer as any, undefined, mockLogger);

      await expect(
        p.send(FinancialEvent.Transaction, {
          value: { memberId: 'u1', amount: 100, currency: 'USD', transactionId: 'tx-1' },
        }),
      ).rejects.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to send message',
        expect.objectContaining({ topic: 'financial-event.transaction', error: 'network error' }),
      );
    });

    it('should log error on sendBatch failure', async () => {
      mockProducer.send.mockRejectedValueOnce(new Error('quota exceeded'));
      const p = new SdkProducer(mockProducer as any, undefined, mockLogger);

      await expect(
        p.sendBatch(FinancialEvent.Transaction, [
          { value: { memberId: 'u1', amount: 1, currency: 'USD', transactionId: 'tx-1' } },
        ]),
      ).rejects.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to send batch',
        expect.objectContaining({ topic: 'financial-event.transaction', messageCount: 1, error: 'quota exceeded' }),
      );
    });

    it('should not log when no logger is provided (noopLogger)', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      const p = new SdkProducer(mockProducer as any);
      await p.connect();
      await p.send(MemberEvent.Login, { value: { memberId: 'u1', ip: '1.1.1.1' } });
      await p.disconnect();

      expect(consoleSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
      errorSpy.mockRestore();
      debugSpy.mockRestore();
    });
  });

  describe('error preservation', () => {
    /**
     * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
     * `send` used to catch whatever KafkaJS threw and re-throw a bare
     * `new Error(...)`, discarding the original class and its `type` /
     * `retriable` fields. Downstream, `ybc-balance-api`'s outbox has to decide
     * whether an undelivered FINANCIAL EVENT is a temporary problem or a verdict
     * on the frame, and with the fields destroyed the only evidence left was the
     * message TEXT — which real KafkaJS protocol errors do not contain (a genuine
     * `MESSAGE_TOO_LARGE` reads "The request included a message larger than the
     * max message size the server will accept" and mentions neither token).
     *
     * The message is UNCHANGED on purpose: it is matched by existing tests and
     * logs. What is added is structure alongside it.
     */
    function protocolError(type: string, code: number, retriable: boolean, message: string) {
      const error = new Error(message);
      error.name = 'KafkaJSProtocolError';
      return Object.assign(error, { type, code, retriable });
    }

    it('preserves the original error as `cause` on send', async () => {
      const original = protocolError(
        'MESSAGE_TOO_LARGE',
        10,
        false,
        'The request included a message larger than the max message size the server will accept',
      );
      mockProducer.send.mockRejectedValueOnce(original);

      const thrown = await producer
        .send(FinancialEvent.Transaction, {
          value: { memberId: 'u1', amount: 1, currency: 'USD', transactionId: 'tx-1' },
        })
        .catch((e) => e);

      expect(thrown).toBeInstanceOf(KafkaProducerError);
      expect(thrown.cause).toBe(original);
    });

    it('surfaces the KafkaJS `type` / `retriable` fields it used to destroy', async () => {
      mockProducer.send.mockRejectedValueOnce(
        protocolError(
          'MESSAGE_TOO_LARGE',
          10,
          false,
          'The request included a message larger than the max message size the server will accept',
        ),
      );

      const thrown: KafkaProducerError = await producer
        .send(FinancialEvent.Transaction, {
          value: { memberId: 'u1', amount: 1, currency: 'USD', transactionId: 'tx-1' },
        })
        .catch((e) => e);

      expect(thrown.kafkaErrorType).toBe('MESSAGE_TOO_LARGE');
      expect(thrown.retriable).toBe(false);
      expect(thrown.topic).toBe('financial-event.transaction');
      expect(thrown.operation).toBe('send');
    });

    it('leaves `kafkaErrorType` / `retriable` undefined for a throw that carried neither', async () => {
      // Unknown must stay unknown. A defaulted `retriable: false` here would let
      // the outbox rule a transient failure terminal and park a committed
      // ledger row's event as `dead`.
      mockProducer.send.mockRejectedValueOnce(new TypeError('Converting circular structure to JSON'));

      const thrown: KafkaProducerError = await producer
        .send(MemberEvent.Login, { value: { memberId: 'u1', ip: '1.1.1.1' } })
        .catch((e) => e);

      expect(thrown.kafkaErrorType).toBeUndefined();
      expect(thrown.retriable).toBeUndefined();
      expect(thrown.cause).toBeInstanceOf(TypeError);
    });

    it('preserves the cause on sendBatch, connect and disconnect too', async () => {
      const sendCause = new Error('quota exceeded');
      mockProducer.send.mockRejectedValueOnce(sendCause);
      const batchThrown = await producer
        .sendBatch(FinancialEvent.Transaction, [
          { value: { memberId: 'u1', amount: 1, currency: 'USD', transactionId: 'tx-1' } },
        ])
        .catch((e) => e);
      expect(batchThrown).toBeInstanceOf(KafkaProducerError);
      expect(batchThrown.cause).toBe(sendCause);
      expect(batchThrown.operation).toBe('sendBatch');

      const connectCause = new Error('broker down');
      mockProducer.connect.mockRejectedValueOnce(connectCause);
      const connectThrown = await producer.connect().catch((e) => e);
      expect(connectThrown.cause).toBe(connectCause);
      expect(connectThrown.operation).toBe('connect');

      const disconnectCause = new Error('timeout');
      mockProducer.disconnect.mockRejectedValueOnce(disconnectCause);
      const disconnectThrown = await producer.disconnect().catch((e) => e);
      expect(disconnectThrown.cause).toBe(disconnectCause);
      expect(disconnectThrown.operation).toBe('disconnect');
    });

    // ⚠️ `.toBe` on `.message`, NEVER `.toThrow(string)` — that matcher does a
    // SUBSTRING match, so it would pass happily if this class started prepending
    // or appending bytes. The promise being pinned here is that the text is
    // UNCHANGED: operators' log greps, alerting rules, balance-api's text
    // fallback in `outbox-failure.ts`, and `ybc-segmentation-api`'s
    // `kafka-sdk.spec.ts` all read these exact strings. All four methods are
    // covered because all four were rewrapped.
    it('keeps the historical message text byte-for-byte — logs and matchers depend on it', async () => {
      mockProducer.send.mockRejectedValueOnce(new Error('network error'));
      const sendThrown = await producer
        .send(FinancialEvent.Transaction, {
          value: { memberId: 'u1', amount: 100, currency: 'USD', transactionId: 'tx-1' },
        })
        .catch((e) => e);
      expect(sendThrown.message).toBe(
        'Failed to send message to financial-event.transaction: network error',
      );

      mockProducer.send.mockRejectedValueOnce(new Error('network error'));
      const batchThrown = await producer
        .sendBatch(FinancialEvent.Transaction, [
          { value: { memberId: 'u1', amount: 100, currency: 'USD', transactionId: 'tx-1' } },
        ])
        .catch((e) => e);
      expect(batchThrown.message).toBe(
        'Failed to send batch to financial-event.transaction: network error',
      );

      mockProducer.connect.mockRejectedValueOnce(new Error('Connection refused'));
      const connectThrown = await producer.connect().catch((e) => e);
      expect(connectThrown.message).toBe('Failed to connect producer: Connection refused');

      mockProducer.disconnect.mockRejectedValueOnce(new Error('timeout'));
      const disconnectThrown = await producer.disconnect().catch((e) => e);
      expect(disconnectThrown.message).toBe('Failed to disconnect producer: timeout');
    });
  });

});
