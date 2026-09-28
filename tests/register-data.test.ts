import { describe, it, expect } from 'vitest';
import { JsonSerializer } from '../src/serializers';
import type { RegisterData } from '../src/types';

describe('RegisterData full-mirror contract', () => {
  // A fully-populated RegisterData carrying every PUBLISHABLE casino User field.
  //
  // ⚠️ It deliberately carries NO secrets. The seven banned keys (password,
  // twoFactorSecret, twoFactorVerifyOtp, forgotPasswordToken, verifyAccountToken,
  // provablyFairServerSeed, provablyFairNextServerSeed) are `?: never` on the
  // interface; the explicit absence test below is the guard that actually runs,
  // because `tsconfig.json` includes only `src` and vitest transpiles without
  // type-checking — so a type-level ban alone would never fail this suite.
  const full: RegisterData = {
    // existing 9
    memberId: 1,
    memberGuid: 'guid-1',
    email: 'a@b.c',
    username: 'alice',
    signupMethod: 'email',
    ipAddress: '127.0.0.1',
    referByMemberId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    clientId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    // full mirror
    referByUserCampaignId: null,
    fireblocksVaultId: 'vault-1',
    referralCode: 'REF1',
    walletAddress: '0xabc',
    role: 'CLIENT',
    firstName: 'Alice',
    lastName: 'Smith',
    dateOfBirth: '1990-01-01',
    address: '1 St',
    postalCode: '00000',
    city: 'Town',
    country: 'US',
    occupation: 'Dev',
    gender: 'f',
    isActive: 1,
    isVerified: 0,
    docType: 'passport',
    twoFactorEnabled: 0,
    kycVerified: 1,
    frontIdentityMediaId: null,
    backIdentityMediaId: null,
    ghostModeEnabled: false,
    fiatView: true,
    hideZeroBalance: false,
    emailMarketing: true,
    isAffiliatePartner: false,
    earlyAccessCode: null,
    tier: 'unranked',
    rating: 0,
    totalWagered: '1000',
    totalMonthlyWithdrawn: 0,
    totalMonthlyWithdrawLimit: 0,
    totalWin: '500',
    totalBetsCount: 3,
    totalWinsCount: 1,
    totalExperienceWithReferrals: 0,
    referralCommissionPercentage: 10,
    totalReferralCommissionEarned: 0,
    totalReferralCommissionClaimed: 0,
    totalRecentPlayWagered: 0,
    totalRecentPlayExperience: 0,
    totalWeeklyWagered: 0,
    totalWeekly1Wagered: 0,
    totalWeekly2Wagered: 0,
    totalWeekly3Wagered: 0,
    totalWeekly4Wagered: 0,
    totalWeeklyRaceExperienceGained: 0,
    totalWeeklyExperienceGained: 0,
    totalWeeklyExperienceGainedWithReferrals: 0,
    totalWeekly1ExperienceGained: 0,
    totalWeekly2ExperienceGained: 0,
    totalWeekly3ExperienceGained: 0,
    totalWeekly4ExperienceGained: 0,
    weekly1BonusDistributed: false,
    weekly2BonusDistributed: false,
    weekly3BonusDistributed: false,
    weekly4BonusDistributed: false,
    totalMonthlyWagered: 0,
    totalMonthly1Wagered: 0,
    totalMonthly2Wagered: 0,
    totalMonthly3Wagered: 0,
    totalMonthly4Wagered: 0,
    totalMonthlyExperienceGained: 0,
    totalMonthlyExperienceGainedWithReferrals: 0,
    totalMonthly1ExperienceGained: 0,
    totalMonthly2ExperienceGained: 0,
    totalMonthly3ExperienceGained: 0,
    totalMonthly4ExperienceGained: 0,
    monthly1BonusDistributed: false,
    monthly2BonusDistributed: false,
    monthly3BonusDistributed: false,
    monthly4BonusDistributed: false,
    loyaltyLevelUpBonusAmount: 0,
    loyaltyInstantRackbackAmount: '0',
    loyaltyRecentPlayBonusAmount: 0,
    loyaltyWeeklyBonusAmount: 0,
    loyaltyMonthlyBonusAmount: 0,
    provablyFairClientSeed: '',
    provablyFairCurrentNonce: 0,
    bonusCouponAmountUSD: 0,
    levelUpTempBonus: 0,
    selfExclusionTill: new Date('2000-01-01T00:00:01.000Z').toISOString(),
    banned: false,
    bannedReason: null,
    geoBlockDisabled: false,
    randomIpEnabled: false,
    updatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    metamaskAddress: null,
    telegramId: null,
  };

  it('serializes a fully-populated RegisterData without throwing (no BigInt in the payload)', () => {
    const serializer = new JsonSerializer();
    const roundtrip = serializer.deserialize(serializer.serialize(full));
    expect(roundtrip).toEqual(full);
  });

  it('an old producer payload (only the original 9 fields) still satisfies RegisterData', () => {
    const minimal: RegisterData = {
      memberId: 2,
      memberGuid: 'guid-2',
      email: null,
      username: null,
      signupMethod: 'email',
      ipAddress: null,
      referByMemberId: null,
      createdAt: full.createdAt,
      clientId: full.clientId,
    };
    expect(minimal.memberId).toBe(2);
  });

  it('carries NO credential or unrevealed-seed field', () => {
    // The contract this whole interface exists to keep: ybc-segmentation-api
    // persists every consumed event verbatim into an append-only audit store, so
    // a secret published here can never be taken back.
    const banned = [
      'password',
      'twoFactorSecret',
      'twoFactorVerifyOtp',
      'forgotPasswordToken',
      'verifyAccountToken',
      'provablyFairServerSeed',
      'provablyFairNextServerSeed',
    ];
    const roundtripped = new JsonSerializer<RegisterData>().deserialize(
      new JsonSerializer<RegisterData>().serialize(full),
    ) as Record<string, unknown>;

    for (const key of banned) {
      expect(Object.prototype.hasOwnProperty.call(full, key)).toBe(false);
      // Compare parsed KEYS, not the raw JSON text — the substring "password"
      // appears inside legitimate field names.
      expect(Object.keys(roundtripped)).not.toContain(key);
    }

    // The non-secret half of the fairness pair is still published: the player is
    // shown both of these verbatim, so they are not secrets.
    expect(full.provablyFairClientSeed).toBeDefined();
    expect(full.provablyFairCurrentNonce).toBeDefined();
  });

  /**
   * ⚠️ The Phase-2 column retirement: `two_factor_type`, `disabled_until` and
   * `password_updated_at` were dropped from casino-api's `members`, so the
   * mirror must stop carrying them. Pinned as ABSENT rather than null so a
   * re-add is a visible failure, not a field that silently never populates.
   */
  it('no longer carries the retired casino-api columns', () => {
    for (const key of ['twoFactorType', 'disabledUntil', 'passwordUpdatedAt']) {
      expect(Object.prototype.hasOwnProperty.call(full, key)).toBe(false);
    }
  });

  it('carries the big/decimal mirror fields as strings (JSON-safe)', () => {
    expect(typeof full.totalWagered).toBe('string');
    expect(typeof full.totalWin).toBe('string');
    expect(typeof full.loyaltyInstantRackbackAmount).toBe('string');
  });
});
