import { Consumer } from 'kafkajs';
import { BatchHandler, ConsumedMessage, MessageHandler, Serializer, SubscribeOptions, Topic } from './types';
import { JsonSerializer } from './serializers';
import { Logger, noopLogger } from './logger';

export class SdkConsumer {
  private consumer: Consumer;
  private serializer: Serializer;
  private concurrency: number;
  private propagateErrors: boolean;
  private handlers: Map<string, MessageHandler<any>> = new Map();
  private batchHandlers: Map<string, BatchHandler<any>> = new Map();
  private running = false;
  private logger: Logger;

  constructor(
    consumer: Consumer,
    serializer?: Serializer,
    concurrency?: number,
    propagateErrors?: boolean,
    logger?: Logger,
  ) {
    this.consumer = consumer;
    this.serializer = serializer ?? new JsonSerializer();
    this.concurrency = concurrency ?? 1;
    this.propagateErrors = propagateErrors ?? true;
    this.logger = logger ?? noopLogger;
  }

  async connect(): Promise<void> {
    try {
      this.logger.info('Consumer connecting');
      await this.consumer.connect();
      this.logger.info('Consumer connected');
    } catch (error) {
      this.logger.error('Failed to connect consumer', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to connect consumer: ${error instanceof Error ? error.message : error}`);
    }
  }

  async disconnect(): Promise<void> {
    try {
      this.logger.info('Consumer disconnecting');
      await this.consumer.disconnect();
      this.running = false;
      this.handlers.clear();
      this.batchHandlers.clear();
      this.logger.info('Consumer disconnected');
    } catch (error) {
      this.logger.error('Failed to disconnect consumer', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to disconnect consumer: ${error instanceof Error ? error.message : error}`);
    }
  }

  async subscribe<T extends Topic>(
    topic: T,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<void> {
    if (this.running) {
      throw new Error(
        `Cannot subscribe to topic "${topic}" while consumer is already running. Call subscribe() before run().`,
      );
    }

    this.logger.info('Subscribing to topic', {
      topic,
      fromBeginning: options?.fromBeginning ?? false,
    });

    await this.consumer.subscribe({
      topic,
      fromBeginning: options?.fromBeginning ?? false,
    });

    this.handlers.set(topic, handler);
  }

  /**
   * Batch-mode subscription. Additive alongside `subscribe()` — a consumer uses
   * either the per-message API (`subscribe` + `run`) or the batch API
   * (`subscribeBatch` + `runBatch`), not both.
   *
   * Use this when the sink's store is dramatically faster at bulk writes (e.g.
   * ClickHouse, where one-INSERT-per-row creates one part per row).
   */
  async subscribeBatch<T extends Topic>(
    topic: T,
    handler: BatchHandler<T>,
    options?: SubscribeOptions,
  ): Promise<void> {
    if (this.running) {
      throw new Error(
        `Cannot subscribe to topic "${topic}" while consumer is already running. Call subscribeBatch() before runBatch().`,
      );
    }

    this.logger.info('Subscribing to topic (batch mode)', {
      topic,
      fromBeginning: options?.fromBeginning ?? false,
    });

    await this.consumer.subscribe({
      topic,
      fromBeginning: options?.fromBeginning ?? false,
    });

    this.batchHandlers.set(topic, handler);
  }

  /**
   * Run in batch mode.
   *
   * **Durability contract:** offsets are resolved only AFTER the handler
   * resolves. A throwing handler (with `propagateErrors: true`, the default)
   * leaves offsets unresolved, so Kafka redelivers the whole batch. That makes a
   * duplicate possible but a GAP impossible — the right trade for an audit log.
   */
  async runBatch(): Promise<void> {
    if (this.running) {
      throw new Error('Consumer is already running.');
    }
    if (this.batchHandlers.size === 0) {
      throw new Error('No topics subscribed. Call subscribeBatch() before runBatch().');
    }

    this.running = true;
    this.logger.info('Consumer starting (batch mode)', {
      topics: Array.from(this.batchHandlers.keys()),
      concurrency: this.concurrency,
    });

    await this.consumer.run({
      partitionsConsumedConcurrently: this.concurrency,
      eachBatch: async ({ batch, resolveOffset, heartbeat }: any) => {
        const handler = this.batchHandlers.get(batch.topic);
        if (!handler || batch.messages.length === 0) {
          return;
        }

        const messages: ConsumedMessage<Topic>[] = batch.messages.map((message: any) => {
          const headers: Record<string, string | undefined> = {};
          if (message.headers) {
            for (const [key, val] of Object.entries(message.headers)) {
              headers[key] = (val as Buffer | undefined)?.toString();
            }
          }
          return {
            topic: batch.topic as Topic,
            partition: batch.partition,
            offset: message.offset,
            key: message.key?.toString() ?? null,
            value: message.value ? this.serializer.deserialize(message.value as Buffer) : null,
            headers,
            timestamp: message.timestamp ?? '',
          };
        });

        this.logger.debug('Processing batch', {
          topic: batch.topic,
          partition: batch.partition,
          size: messages.length,
        });

        try {
          await handler(messages);

          // Only now is the batch durable — resolve the offsets.
          for (const message of batch.messages) {
            resolveOffset(message.offset);
          }
          await heartbeat();

          this.logger.debug('Batch processed', {
            topic: batch.topic,
            partition: batch.partition,
            size: messages.length,
          });
        } catch (error) {
          this.logger.error('Error processing batch', {
            topic: batch.topic,
            partition: batch.partition,
            size: messages.length,
            error: error instanceof Error ? error.message : String(error),
          });
          if (this.propagateErrors) {
            // Offsets deliberately NOT resolved — Kafka redelivers.
            throw error;
          }
          // propagateErrors=false: accept the loss and advance, matching the
          // per-message path's behaviour.
          for (const message of batch.messages) {
            resolveOffset(message.offset);
          }
          await heartbeat();
        }
      },
    });
  }

  async run(): Promise<void> {
    if (this.running) {
      throw new Error('Consumer is already running.');
    }
    if (this.handlers.size === 0) {
      throw new Error('No topics subscribed. Call subscribe() before run().');
    }

    this.running = true;
    this.logger.info('Consumer starting', {
      topics: Array.from(this.handlers.keys()),
      concurrency: this.concurrency,
    });

    await this.consumer.run({
      partitionsConsumedConcurrently: this.concurrency,
      eachMessage: async ({ topic: msgTopic, partition, message }) => {
        const handler = this.handlers.get(msgTopic);
        if (!handler) {
          return;
        }

        this.logger.debug('Processing message', {
          topic: msgTopic,
          partition,
          offset: message.offset,
          key: message.key?.toString() ?? null,
        });

        try {
          const value = message.value
            ? this.serializer.deserialize(message.value as Buffer)
            : null;

          const headers: Record<string, string | undefined> = {};
          if (message.headers) {
            for (const [key, val] of Object.entries(message.headers)) {
              headers[key] = val?.toString();
            }
          }

          await handler({
            topic: msgTopic as Topic,
            partition,
            offset: message.offset,
            key: message.key?.toString() ?? null,
            value,
            headers,
            timestamp: message.timestamp ?? '',
          });

          this.logger.debug('Message processed', {
            topic: msgTopic,
            partition,
            offset: message.offset,
          });
        } catch (error) {
          this.logger.error('Error processing message', {
            topic: msgTopic,
            partition,
            offset: message.offset,
            error: error instanceof Error ? error.message : String(error),
          });
          if (this.propagateErrors) {
            throw error;
          }
        }
      },
    });
  }
}
