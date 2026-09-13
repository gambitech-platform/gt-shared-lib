/**
 * The one error type this SDK's producer throws.
 *
 * ── Why it exists ────────────────────────────────────────────────────────────
 * `SdkProducer` used to catch whatever KafkaJS threw and re-throw a bare
 * `new Error("Failed to send message to <topic>: <message>")`. That message is
 * fine for a log line and useless for a decision: it discards the original
 * error's class and, with it, the two fields that actually say what happened —
 * KafkaJS's `type` (the protocol error code name) and `retriable`.
 *
 * `ybc-balance-api`'s transactional outbox has to make exactly that decision:
 * an undelivered `financial-event.transaction` is either a temporary problem
 * (keep the obligation, retry) or a verdict on the frame (park it `dead` for an
 * operator). With the fields destroyed, its classifier was reduced to matching
 * on message TEXT — and real KafkaJS protocol errors do not contain the tokens
 * anyone would match on. A genuine `MESSAGE_TOO_LARGE` reads:
 *
 *     The request included a message larger than the max message size the
 *     server will accept
 *
 * which mentions neither "message too large" nor "MessageTooLarge". So the
 * text-only classifier could not recognise the one failure class it most needed
 * to, and an unsendable frame retried forever instead of surfacing.
 *
 * ── What is deliberately NOT changed ─────────────────────────────────────────
 * `message` is byte-identical to what the old bare `Error` carried. Operators'
 * log greps, alerting rules and existing tests read it. The structure is ADDED
 * ALONGSIDE it, never in place of it.
 *
 * ── Unknown stays unknown ────────────────────────────────────────────────────
 * `kafkaErrorType` and `retriable` are `undefined` when the caught error
 * carried neither — never defaulted. A defaulted `retriable: false` would read
 * as "the broker will refuse this forever" and let a consumer park a committed
 * ledger row's financial event as terminal over a transient blip.
 */

/** Which `SdkProducer` call failed. */
export type KafkaProducerOperation = "connect" | "disconnect" | "send" | "sendBatch";

export class KafkaProducerError extends Error {
  /** Which `SdkProducer` call failed. */
  readonly operation: KafkaProducerOperation;
  /** The topic involved, for `send` / `sendBatch`. Absent for connect/disconnect. */
  readonly topic?: string;
  /**
   * KafkaJS's protocol error `type` (e.g. `MESSAGE_TOO_LARGE`,
   * `NOT_LEADER_FOR_PARTITION`), when the caught error carried one.
   * `undefined` means "the throw carried no type", never "no type applies".
   */
  readonly kafkaErrorType?: string;
  /** KafkaJS's protocol error `code`, when the caught error carried one. */
  readonly kafkaErrorCode?: number;
  /**
   * KafkaJS's `retriable` flag, when the caught error carried one.
   *
   * ⚠️ `false` here does NOT mean "terminal". `KafkaJSNumberOfRetriesExceeded`
   * is non-retriable in KafkaJS's own sense (it gave up) while describing a
   * perfectly transient broker outage. A consumer deciding whether to keep an
   * obligation must read `kafkaErrorType`, not this flag alone.
   */
  readonly retriable?: boolean;
  /** The error KafkaJS actually threw. Preserved, never flattened. */
  readonly cause: unknown;

  constructor(
    message: string,
    options: {
      operation: KafkaProducerOperation;
      topic?: string;
      cause: unknown;
    },
  ) {
    super(message);
    this.name = "KafkaProducerError";
    this.operation = options.operation;
    this.topic = options.topic;
    this.cause = options.cause;

    const fields = readKafkaErrorFields(options.cause);
    this.kafkaErrorType = fields.type;
    this.kafkaErrorCode = fields.code;
    this.retriable = fields.retriable;

    // `Error` is subclassable in ES2015+, but a downlevel `target` restores the
    // prototype to `Error` and silently breaks `instanceof`. Explicit is cheap.
    Object.setPrototypeOf(this, KafkaProducerError.prototype);
  }
}

/**
 * Pull KafkaJS's structured fields off a caught error, without asserting a
 * class (the SDK must not take a value-level dependency on `kafkajs`'s error
 * classes, and a duck-typed read works across duplicated module instances too).
 *
 * ONE LEVEL ONLY, on purpose. `KafkaJSNumberOfRetriesExceeded` wraps a `cause`,
 * and descending into it would report the inner error's `retriable: true` for
 * an outer failure that KafkaJS has already given up on. Whether that matters
 * is the consumer's judgement, and the consumer still has `cause` to walk.
 */
export function readKafkaErrorFields(error: unknown): {
  type?: string;
  code?: number;
  retriable?: boolean;
} {
  if (typeof error !== "object" || error === null) return {};
  const candidate = error as { type?: unknown; code?: unknown; retriable?: unknown };
  return {
    type: typeof candidate.type === "string" ? candidate.type : undefined,
    code: typeof candidate.code === "number" ? candidate.code : undefined,
    retriable: typeof candidate.retriable === "boolean" ? candidate.retriable : undefined,
  };
}
