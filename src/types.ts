import { KafkaConfig, logLevel } from 'kafkajs';
import { Logger } from './logger';

export enum FinancialEvent {
  Transaction = 'financial-event.transaction',
}

export enum MemberEvent {
  Login = 'member-event.login',
  Logout = 'member-event.logout',
  Register = 'member-event.register',
  Update = 'member-event.update',
  SessionExpired = 'member-event.session-expired',
  DataRequest = 'member-event.data-request',
  DataResponse = 'member-event.data-response',
  XpUpdate = 'member-event.xp-update',
  LevelUp = 'member-event.level-up',
  RewardUpdate = 'member-event.reward-update',
}

export enum ServerEvent {
  Crash = 'server-event.crash',
  HealthCheck = 'server-event.health-check',
  Restart = 'server-event.restart',
}

/**
 * Audit events — a uniform "someone changed something" record emitted by every
 * write mutation across the platform (player + admin). ONE topic; the actor and
 * the specific action are carried in the payload (see AuditActionData), not in
 * separate topics. The segmentation event-log sink records these verbatim.
 */
export enum AuditEvent {
  Action = 'audit-event.action',
}

export type Topic = FinancialEvent | MemberEvent | ServerEvent | AuditEvent;

export const DEFAULT_CLIENT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// --- Financial event payloads ---

export interface TransactionData {
  casinoId: number;
  clientId: string;
  transactionId: string;
  memberId: number;
  tokenCode: string;
  tokenAmount: string;
  fiatCode: string | null;
  fiatAmount: string | null;
  usdAmount: string | null;
  exchangeRate: string | null;
  type: string;
  balanceBefore: string;
  balanceAfter: string;
  status: string;
  referenceId: string | null;
  description: string | null;
  gameId: string | null;
  gameName: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  completedAt: string | null;
}

// --- User event payloads ---

export interface LoginData {
  memberId: string;
  ip: string;
  clientId: string;
}

export interface LogoutData {
  memberId: string;
  clientId: string;
}

export interface RegisterData {
  memberId: number;
  memberGuid: string;
  email: string | null;
  username: string | null;
  signupMethod: string;
  ipAddress: string | null;
  referByMemberId: number | null;
  createdAt: string;
  clientId: string;

  // --- Full casino User mirror (all optional so old producers/messages still satisfy the type) ---
  referByUserCampaignId?: number | null;
  fireblocksVaultId?: string | null;
  referralCode?: string | null;
  walletAddress?: string | null;
  password?: string | null;
  role?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  dateOfBirth?: string | null;
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  occupation?: string | null;
  gender?: string | null;
  isActive?: number | null;
  isVerified?: number | null;
  verifyAccountToken?: string | null;
  docType?: string | null;
  twoFactorSecret?: string | null;
  twoFactorEnabled?: number | null;
  kycVerified?: number | null;
  forgotPasswordToken?: string | null;
  frontIdentityMediaId?: number | null;
  backIdentityMediaId?: number | null;
  ghostModeEnabled?: boolean | null;
  fiatView?: boolean | null;
  hideZeroBalance?: boolean | null;
  emailMarketing?: boolean | null;
  twoFactorVerifyOtp?: string | null;
  twoFactorType?: string | null;
  isAffiliatePartner?: boolean | null;
  earlyAccessCode?: string | null;
  tier?: string | null;
  rating?: number | null;
  totalWagered?: string | null;
  totalMonthlyWithdrawn?: number | null;
  totalMonthlyWithdrawLimit?: number | null;
  totalWin?: string | null;
  totalBetsCount?: number | null;
  totalWinsCount?: number | null;
  totalExperienceWithReferrals?: number | null;
  referralCommissionPercentage?: number | null;
  totalReferralCommissionEarned?: number | null;
  totalReferralCommissionClaimed?: number | null;
  totalRecentPlayWagered?: number | null;
  totalRecentPlayExperience?: number | null;
  totalWeeklyWagered?: number | null;
  totalWeekly1Wagered?: number | null;
  totalWeekly2Wagered?: number | null;
  totalWeekly3Wagered?: number | null;
  totalWeekly4Wagered?: number | null;
  totalWeeklyRaceExperienceGained?: number | null;
  totalWeeklyExperienceGained?: number | null;
  totalWeeklyExperienceGainedWithReferrals?: number | null;
  totalWeekly1ExperienceGained?: number | null;
  totalWeekly2ExperienceGained?: number | null;
  totalWeekly3ExperienceGained?: number | null;
  totalWeekly4ExperienceGained?: number | null;
  weekly1BonusDistributed?: boolean | null;
  weekly2BonusDistributed?: boolean | null;
  weekly3BonusDistributed?: boolean | null;
  weekly4BonusDistributed?: boolean | null;
  totalMonthlyWagered?: number | null;
  totalMonthly1Wagered?: number | null;
  totalMonthly2Wagered?: number | null;
  totalMonthly3Wagered?: number | null;
  totalMonthly4Wagered?: number | null;
  totalMonthlyExperienceGained?: number | null;
  totalMonthlyExperienceGainedWithReferrals?: number | null;
  totalMonthly1ExperienceGained?: number | null;
  totalMonthly2ExperienceGained?: number | null;
  totalMonthly3ExperienceGained?: number | null;
  totalMonthly4ExperienceGained?: number | null;
  monthly1BonusDistributed?: boolean | null;
  monthly2BonusDistributed?: boolean | null;
  monthly3BonusDistributed?: boolean | null;
  monthly4BonusDistributed?: boolean | null;
  loyaltyLevelUpBonusAmount?: number | null;
  loyaltyInstantRackbackAmount?: string | null;
  loyaltyRecentPlayBonusAmount?: number | null;
  loyaltyWeeklyBonusAmount?: number | null;
  loyaltyMonthlyBonusAmount?: number | null;
  provablyFairClientSeed?: string | null;
  provablyFairServerSeed?: string | null;
  provablyFairCurrentNonce?: number | null;
  provablyFairNextServerSeed?: string | null;
  bonusCouponAmountUSD?: number | null;
  levelUpTempBonus?: number | null;
  selfExclusionTill?: string | null;
  banned?: boolean | null;
  bannedReason?: string | null;
  geoBlockDisabled?: boolean | null;
  randomIpEnabled?: boolean | null;
  disabledUntil?: string | null;
  passwordUpdatedAt?: string | null;
  updatedAt?: string | null;
  metamaskAddress?: string | null;
  telegramId?: string | null;
}

export interface SessionExpiredData {
  memberId: string;
  sessionId: string;
  clientId: string;
}

export interface UserDataRequestData {
  memberIds: number[];
  requestId: string;
}

export interface UserDataResponseData {
  requestId: string;
  members: RegisterData[];
}

// --- XP & Level-up event payloads ---

export interface XpUpdateData {
  memberId: number;
  clientId: string;
  xpGained: number;
  totalExperience: number;
  bonusExperience: number;
  tier: string;
  rating: number;
  timestamp: string;
}

export interface LevelUpData {
  memberId: number;
  clientId: string;
  oldTier: string;
  oldRating: number;
  newTier: string;
  newRating: number;
  totalExperience: number;
  bonusExperience: number;
  rewardIds: number[];
  timestamp: string;
}

// --- Reward event payloads ---

export interface RewardItemData {
  id: number;
  name: string;
  rewardConfigId: number;
  rewardConfig: {
    name?: string;
    type: string;
    claimableRewardList: any[] | null;
    isAutoclaimable?: boolean;
    description?: string | null;
    imageUrl?: string | null;
    progressType?: string | null;
    progressTarget?: number | null;
  } | null;
  status: string;
  availableStartDate: string | null;
  availableEndDate: string | null;
  grantDate: string | null;
  claimStartDate: string | null;
  claimEndDate: string | null;
  claimDate: string | null;
  xpNeeded: number;
  xpAccumulated: number;
  progress: Record<string, any> | null;
  claimedRewardList: any[] | null;
  createdAt: string;
}

export interface RewardUpdateSignal {
  memberId: number;
  clientId: string;
  reason: 'rakeback_accumulated' | 'reward_assigned' | 'reward_claimed' | 'recentplay_progress' | 'progress_updated' | 'progress_completed';
  reward: RewardItemData;
  timestamp: string;
}

// --- Server event payloads ---

export interface CrashData {
  serverId: string;
  error: string;
}

export interface HealthCheckData {
  serverId: string;
  status: string;
}

export interface RestartData {
  serverId: string;
  reason: string;
}

// --- Audit event payload ---

/**
 * Uniform audit record for any state-changing action across the platform.
 *
 * Emitted by write mutations in auth-api and casino-api; recorded verbatim by
 * the segmentation event-log sink (which reads `clientId`/`casinoId` for tenant
 * scoping and the envelope headers for id/source/occurredAt).
 *
 * WHITELIST DISCIPLINE: `changed` carries field NAMES + coarse before/after
 * values only. Never put secrets (password hashes, 2FA secrets, tokens) in any
 * field of this payload.
 */
export interface AuditActionData {
  /** Dotted action verb, e.g. 'role.created', 'casino.suspended', 'account.2fa-toggled'. */
  action: string;
  /** Kind of thing acted on, e.g. 'role', 'casino', 'admin-user', 'withdrawal'. */
  entityType: string;
  /** Id of the affected entity (stringified). */
  entityId: string;
  /** Who acted. 'system' for unauthenticated/pre-auth paths. */
  actorType: 'player' | 'admin' | 'system';
  /** Actor id (stringified), or null when unauthenticated. */
  actorId: string | null;
  /** Human-readable actor label (username/email), or null. */
  actorName: string | null;
  /** Tenant the action belongs to (casino/client id). */
  clientId: string;
  /** Optional numeric casino id when the emitting service has it. */
  casinoId?: number | null;
  /** Short human-readable description of what happened. */
  summary: string;
  /** Whitelisted field-level diff — names + safe values only, never secrets. */
  changed?: Record<string, { from?: unknown; to?: unknown }> | null;
  /** ISO occurredAt override; defaults to emit time. */
  occurredAt?: string;
}

// --- Topic → Data type mapping ---

export interface TopicDataMap {
  [FinancialEvent.Transaction]: TransactionData;
  [MemberEvent.Login]: LoginData;
  [MemberEvent.Logout]: LogoutData;
  [MemberEvent.Register]: RegisterData;
  [MemberEvent.Update]: RegisterData;
  [MemberEvent.SessionExpired]: SessionExpiredData;
  [MemberEvent.DataRequest]: UserDataRequestData;
  [MemberEvent.DataResponse]: UserDataResponseData;
  [MemberEvent.XpUpdate]: XpUpdateData;
  [MemberEvent.LevelUp]: LevelUpData;
  [MemberEvent.RewardUpdate]: RewardUpdateSignal;
  [ServerEvent.Crash]: CrashData;
  [ServerEvent.HealthCheck]: HealthCheckData;
  [ServerEvent.Restart]: RestartData;
  [AuditEvent.Action]: AuditActionData;
}

export interface KafkaClientConfig {
  brokers: string[];
  clientId: string;
  logLevel?: logLevel;
  logger?: Logger;
  /** Pass-through for any additional KafkaJS config */
  kafkaOptions?: Partial<KafkaConfig>;
}

export interface ProducerMessage<T = unknown> {
  key?: string;
  value: T;
  headers?: Record<string, string>;
}

export interface ConsumedMessage<T extends Topic = Topic> {
  topic: T;
  partition: number;
  offset: string;
  key: string | null;
  value: TopicDataMap[T];
  headers: Record<string, string | undefined>;
  timestamp: string;
}

export type MessageHandler<T extends Topic = Topic> = (message: ConsumedMessage<T>) => Promise<void> | void;

/**
 * Handler for batch-mode consumption (`SdkConsumer.subscribeBatch`).
 *
 * Receives every message in one Kafka batch at once, so a sink can write them in
 * a single round trip. Offsets resolve only after this resolves — throwing means
 * the whole batch is redelivered rather than silently skipped.
 */
export type BatchHandler<T extends Topic = Topic> = (
  messages: ConsumedMessage<T>[],
) => Promise<void> | void;

export interface Serializer<T = unknown> {
  serialize(data: T): Buffer;
  deserialize(buffer: Buffer): T;
}

export interface ProducerConfig {
  serializer?: Serializer;
  logger?: Logger;
}

export interface ConsumerConfig {
  groupId: string;
  serializer?: Serializer;
  /** Max partitions processed concurrently. Ignored when sequential is true. Default: 1 */
  concurrency?: number;
  /** Process messages strictly in order (one at a time). Default: true */
  sequential?: boolean;
  /** When true, handler errors propagate to KafkaJS so the offset is not committed. When false, errors are logged and swallowed. Default: true */
  propagateErrors?: boolean;
  logger?: Logger;
}

export interface SubscribeOptions {
  fromBeginning?: boolean;
}
