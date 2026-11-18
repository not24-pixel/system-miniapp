import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  calculateNightWindowDurationHours,
  createAlbumFixtureState,
  createNewUserState,
  getCurrentMonthKey,
  getTzIsoDaysAgo,
  getTzWeekday,
} from './src/shared/fixtures';
import { parseNaturalFinanceInput } from './src/shared/financeParser';
import { SUBSCRIPTION_PLANS } from './src/shared/constants';
import { LifeRoleId, StatKey, SubscriptionPlanId, UserAppState } from './src/shared/types';

const PORT = 3000;
const DATA_FILE = path.resolve(process.cwd(), '.systema-store.json');

interface ServerStore {
  users: Record<string, UserAppState>;
  processedIdempotencyKeys: Record<string, unknown>;
  processedChargeIds: Record<string, boolean>;
  referralLedger: Record<string, { inviterId: string; inviteeTelegramId: string; creditedAt: string }>;
  penaltyCooldowns: Record<string, { wrongStreak: number; blockedUntilMs: number }>;
}

function loadStore(): ServerStore {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(raw) as ServerStore;
    }
  } catch (err) {
    console.warn('Could not read .systema-store.json, initializing fresh store:', err);
  }
  const initialUser = createNewUserState('usr_default', '104920112');
  return {
    users: {
      usr_default: initialUser,
      usr_new: createNewUserState('usr_new', '900100200'),
    },
    processedIdempotencyKeys: {},
    processedChargeIds: {},
    referralLedger: {},
    penaltyCooldowns: {},
  };
}

function saveStore(store: ServerStore) {
  try {
    const tmpFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmpFile, DATA_FILE);
  } catch (err) {
    console.warn('Could not persist .systema-store.json:', err);
  }
}

const store = loadStore();

export function verifyTelegramInitData(
  initData: string,
  botToken: string
): { valid: boolean; telegramId?: string; firstName?: string } {
  if (!initData || !botToken || botToken === 'YOUR_TELEGRAM_BOT_TOKEN_PLACEHOLDER') {
    return { valid: false };
  }
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { valid: false };
    params.delete('hash');
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (calculatedHash !== hash) return { valid: false };

    const userJson = params.get('user');
    if (userJson) {
      const parsedUser = JSON.parse(userJson);
      return {
        valid: true,
        telegramId: String(parsedUser.id),
        firstName: typeof parsedUser.first_name === 'string' ? parsedUser.first_name : undefined,
      };
    }
    return { valid: true };
  } catch {
    return { valid: false };
  }
}

const PENALTY_QUESTIONS_BANK = [
  {
    id: 'q1_step_clarity',
    stage: 1 as const,
    competencyId: 'comp_1_concrete_action',
    prompt: 'Какой шаг проще проверить?',
    options: ['Заняться портфолио', 'Выбрать три работы', 'Стать продуктивнее'],
    correctIndex: 1,
    explanation: 'Конкретный шаг содержит действие и понятный результат. «Стать продуктивнее» не задаёт результата.',
  },
  {
    id: 'q2_start_time',
    stage: 1 as const,
    competencyId: 'comp_2_time_anchor',
    prompt: 'Что снижает риск откладывания задачи на вечер?',
    options: [
      'Обещание сделать «когда появится время»',
      'Заранее указанное время начала и подготовленные материалы',
      'Ожидание особого вдохновения',
    ],
    correctIndex: 1,
    explanation: 'Фиксация времени начала и подготовка материалов заранее убирают трение старта.',
  },
  {
    id: 'q3_scope_limit',
    stage: 1 as const,
    competencyId: 'comp_3_small_batch',
    prompt: 'Как поступить, если задача кажется слишком большой?',
    options: [
      'Выделить один проверяемый первый этап на 15 минут',
      'Отложить задачу до выходных',
      'Сразу запланировать 5 часов без перерыва',
    ],
    correctIndex: 0,
    explanation: 'Короткий 15-минутный этап с понятным результатом позволяет начать действие без перегрузки.',
  },
  {
    id: 'q4_miss_recovery',
    stage: 2 as const,
    competencyId: 'comp_4_honest_history',
    prompt: 'Что происходит с историей при прохождении штрафного квеста?',
    options: [
      'Пропуск превращается в выполненную привычку',
      'Пропуск остаётся в истории, а бонусы навыков восстанавливаются',
      'За штрафной квест начисляется двойной XP',
    ],
    correctIndex: 1,
    explanation: 'Штрафной модуль восстанавливает бонусы навыков, но не переписывает историю прошлых отметок и не даёт XP.',
  },
  {
    id: 'q5_next_step',
    stage: 2 as const,
    competencyId: 'comp_5_next_commitment',
    prompt: 'Какое условие обязательно для финального зачёта модуля после ответов?',
    options: [
      'Просто подождать окончания таймера',
      'Сохранить конкретный следующий шаг с временем начала',
      'Оплатить подписку Система+',
    ],
    correctIndex: 1,
    explanation: 'Для завершения модуля необходимо сохранить конкретное следующее действие и время его начала.',
  },
];

function recomputeAccountTotals(user: UserAppState) {
  const activeGoals = user.goals.filter((g) => g.status === 'active' && g.type === 'savings');
  user.allocatedToGoalsRub = activeGoals.reduce((acc, g) => acc + g.currentValue, 0);
}

function addXpToUser(user: UserAppState, amount: number): boolean {
  let leveledUp = false;
  user.currentXp += amount;
  while (user.currentXp >= user.nextLevelXp) {
    user.currentXp -= user.nextLevelXp;
    user.level += 1;
    user.unspentStatPoints += 3;
    user.nextLevelXp = user.level >= 13 ? 1200 : user.nextLevelXp + 100;
    user.lastLevelUpXpGain = amount;
    leveledUp = true;
  }
  return leveledUp;
}

function subtractXpSafe(user: UserAppState, amount: number) {
  let rem = Math.max(0, amount);
  while (rem > 0) {
    if (user.currentXp >= rem) {
      user.currentXp -= rem;
      rem = 0;
    } else if (user.level > 1) {
      rem -= user.currentXp;
      user.level -= 1;
      user.nextLevelXp = user.level >= 13 ? 1200 : Math.max(100, user.nextLevelXp - 100);
      user.currentXp = user.nextLevelXp;
      user.unspentStatPoints = Math.max(0, user.unspentStatPoints - 3);
    } else {
      user.currentXp = 0;
      rem = 0;
    }
  }
}

function getShadowBonusXp(user: UserAppState): number {
  const shadowsCount = user.shadows?.length || 0;
  if (shadowsCount === 0) return 0;
  if (user.subscription.active) {
    return Math.min(40, shadowsCount * 10);
  }
  return 5;
}

function syncStreakOnActivity(user: UserAppState, tz: string): number {
  const todayIso = getTzIsoDaysAgo(0, tz);
  const yesterdayIso = getTzIsoDaysAgo(1, tz);
  let nextStreak = user.streakDays || 0;
  if (user.lastActiveDate !== todayIso) {
    if (nextStreak === 0) {
      nextStreak = 1;
    } else if (user.lastActiveDate === yesterdayIso || user.lastDailyClaimDate === yesterdayIso) {
      nextStreak += 1;
    } else {
      nextStreak = 1;
    }
    user.lastActiveDate = todayIso;
  } else if (nextStreak === 0) {
    nextStreak = 1;
  }
  user.streakDays = nextStreak;
  user.bestStreakDays = Math.max(user.bestStreakDays || 0, nextStreak);
  return nextStreak;
}

function syncSkillStatRequirements(user: UserAppState) {
  const statReqMap: Array<{ skill: keyof UserAppState['skills']; reqId: string; stat: StatKey }> = [
    { skill: 'impulse', reqId: 'req_str', stat: 'strength' },
    { skill: 'rhythm', reqId: 'req_end', stat: 'endurance' },
    { skill: 'focus', reqId: 'req_int', stat: 'intelligence' },
    { skill: 'planning', reqId: 'req_agi', stat: 'agility' },
    { skill: 'control', reqId: 'req_per', stat: 'perception' },
  ];
  for (const { skill, reqId, stat } of statReqMap) {
    const reqItem = user.skills[skill]?.requirementsForNext.find((r) => r.id === reqId);
    if (reqItem) {
      reqItem.current = user.stats[stat];
      reqItem.met = user.stats[stat] >= reqItem.target;
    }
  }
}

function grantShadowForAchievement(
  user: UserAppState,
  id: string,
  name: string,
  rank: string,
  bonusText: string
): boolean {
  if (!user.shadows) user.shadows = [];
  if (user.shadows.some((s) => s.id === id)) return false;
  if (!user.subscription.active && user.shadows.length >= 1) {
    return false;
  }
  user.shadows.unshift({
    id,
    name,
    rank,
    bonusText,
    extractedAt: 'Сегодня',
  });
  return true;
}

function isUserQuarantined(user: UserAppState): boolean {
  return Boolean(
    user.penaltyQuest.active &&
      user.penaltyQuest.status !== 'completed' &&
      user.penaltyQuest.status !== 'completed_late' &&
      user.penaltyQuest.status !== 'cancelled_error'
  );
}

function normalizeUserDailyRollover(user: UserAppState): boolean {
  const tz = user.timezone || 'Europe/Moscow';
  const todayIso = getTzIsoDaysAgo(0, tz);
  const currentMonth = getCurrentMonthKey(tz);
  let changed = false;

  if (!user.monthStatsKey) {
    user.monthStatsKey = currentMonth;
    changed = true;
  } else if (user.monthStatsKey !== currentMonth) {
    user.monthStatsKey = currentMonth;
    user.monthIncomeRub = 0;
    user.monthExpenseRub = 0;
    changed = true;
  }

  for (const habit of user.habits) {
    if (habit.status !== 'active') continue;
    const todayEntry = habit.history.find((h) => h.isoDate === todayIso);
    if (!todayEntry && (habit.completedToday || habit.currentMinutesToday > 0)) {
      habit.completedToday = false;
      habit.currentMinutesToday = 0;
      changed = true;
    }
    // Fix stale 'Сегодня' labels from previous days
    for (const h of habit.history) {
      if (h.isoDate !== todayIso && h.dateLabel === 'Сегодня') {
        h.dateLabel = h.isoDate === getTzIsoDaysAgo(1, tz) ? 'Вчера' : h.isoDate;
        changed = true;
      }
    }
  }

  return changed;
}

function evaluateAutomaticPenalties(user: UserAppState): boolean {
  let changed = normalizeUserDailyRollover(user);
  if (user.bootstrapState !== 'ready') return changed;

  const tz = user.timezone || 'Europe/Moscow';
  const todayIso = getTzIsoDaysAgo(0, tz);
  if (user.lastPenaltyCheckDate === todayIso) return changed;

  user.lastPenaltyCheckDate = todayIso;
  changed = true;

  // 24h rookie grace period so brand-new players aren't ambushed on morning 1
  if (user.createdAtIso) {
    const ageMs = Date.now() - Date.parse(user.createdAtIso);
    if (Number.isFinite(ageMs) && ageMs < 24 * 3600_000) {
      return changed;
    }
  }

  const yesterdayIso = getTzIsoDaysAgo(1, tz);
  const yWeekday = getTzWeekday(1, tz);

  // Update streak if user was active yesterday or missed yesterday
  if (user.lastActiveDate && user.lastActiveDate !== todayIso && user.lastActiveDate !== yesterdayIso) {
    user.streakDays = 0;
  }

  for (const habit of user.habits) {
    if (habit.status !== 'active' || !habit.mandatory) continue;
    if (!habit.daysOfWeek.includes(yWeekday)) continue;

    // Never penalize a habit created yesterday or today (first-day grace)
    if (!habit.createdAtIso || habit.createdAtIso >= yesterdayIso) continue;

    const entry = habit.history.find((h) => h.isoDate === yesterdayIso);
    if (entry && (entry.status === 'completed' || entry.triggeredPenaltyId)) continue;

    const penaltyId = `pq_auto_${habit.id}_${yesterdayIso}`;
    if (entry) {
      entry.status = 'missed';
      entry.triggeredPenaltyId = penaltyId;
    } else {
      habit.history.unshift({
        dateLabel: 'Вчера',
        isoDate: yesterdayIso,
        status: 'missed',
        triggeredPenaltyId: penaltyId,
      });
    }

    if (!user.penaltyQuest.active) {
      user.streakDays = 0;
      user.penaltyQuest = {
        ...user.penaltyQuest,
        id: penaltyId,
        active: true,
        reasonTitle: `${habit.title} · ${habit.durationMinutes} минут`,
        status: 'assigned',
        presentedAt: null,
        budgetTotalSeconds: 43200,
        remainingBudgetSeconds: 43200,
        currentStage: 1,
        stage1ConfirmedSeconds: 0,
        stage2ConfirmedSeconds: 0,
        questionsPassed: 0,
        nextStepSaved: false,
        selectedChallenge: null,
        challengeDone: false,
        reflectionReason: '',
      };
    }
  }

  return changed;
}

function isTrustedAdminOrDev(req: express.Request, user: UserAppState): boolean {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const adminId = (process.env.ADMIN_TELEGRAM_ID || '').trim();
  const hasRealBotToken = Boolean(token && token !== 'YOUR_TELEGRAM_BOT_TOKEN_PLACEHOLDER');
  if (!hasRealBotToken || process.env.NODE_ENV !== 'production') {
    return true;
  }
  const initData = (req.headers['x-telegram-init-data'] as string) || '';
  const verified = verifyTelegramInitData(initData, token);
  const effectiveTgId = verified.valid && verified.telegramId ? verified.telegramId : user.telegramId;
  return Boolean(adminId && effectiveTgId === adminId);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  function getUser(req: express.Request): UserAppState {
    const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const initData = (req.headers['x-telegram-init-data'] as string) || '';
    const verified = verifyTelegramInitData(initData, token);

    let userId = (req.headers['x-systema-user'] as string) || (req.query.userId as string) || 'usr_default';
    let resolvedTgId = userId.startsWith('tg_') ? userId.slice(3) : '104920112';

    if (verified.valid && verified.telegramId) {
      resolvedTgId = verified.telegramId;
      userId = `tg_${resolvedTgId}`;
    }

    if (!store.users[userId]) {
      store.users[userId] = createNewUserState(userId, resolvedTgId);
      if (verified.firstName && (!store.users[userId].playerCallsign || store.users[userId].playerCallsign === 'Игрок')) {
        store.users[userId].playerCallsign = verified.firstName.slice(0, 32);
      }
      saveStore(store);
    }
    return store.users[userId];
  }

  app.get('/api/bootstrap', (req, res) => {
    const user = getUser(req);
    const reqTz = ((req.headers['x-systema-tz'] as string) || (req.query.tz as string) || '').trim();
    if (reqTz) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: reqTz });
        if (user.timezone !== reqTz) {
          user.timezone = reqTz;
          saveStore(store);
        }
      } catch {
        // Ignore invalid IANA timezone string
      }
    }
    recomputeAccountTotals(user);
    if (evaluateAutomaticPenalties(user)) {
      saveStore(store);
    }
    res.json({
      ok: true,
      user,
      isAdmin: isTrustedAdminOrDev(req, user),
      questionsPublic: PENALTY_QUESTIONS_BANK.map(({ id, stage, competencyId, prompt, options }) => ({
        id,
        stage,
        competencyId,
        prompt,
        options,
      })),
    });
  });

  app.post('/api/profile/reset-mode', (req, res) => {
    const current = getUser(req);
    if (!isTrustedAdminOrDev(req, current)) {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', message: 'Доступно только администратору.' });
      return;
    }
    const { mode } = req.body as { mode: 'new_player' | 'active_player' | 'penalty_demo' };
    const userId = current.userId;
    const tgId = current.telegramId || '104920112';
    if (mode === 'new_player') {
      store.users[userId] = createNewUserState(userId, tgId);
    } else if (mode === 'penalty_demo') {
      const demo = createAlbumFixtureState(userId, tgId);
      demo.bootstrapState = 'penalty_alert';
      demo.penaltyQuest.active = true;
      store.users[userId] = demo;
    } else {
      store.users[userId] = createAlbumFixtureState(userId, tgId);
    }
    saveStore(store);
    res.json({ ok: true, user: store.users[userId] });
  });

  // Onboarding
  app.post('/api/onboarding/refuse', (req, res) => {
    const user = getUser(req);
    user.bootstrapState = 'refusal_rejected';
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/onboarding/accept', (req, res) => {
    const user = getUser(req);
    const { firstName } = (req.body || {}) as { firstName?: string };
    if (
      typeof firstName === 'string' &&
      firstName.trim() &&
      (!user.playerCallsign || user.playerCallsign === 'Игрок')
    ) {
      user.playerCallsign = firstName.trim().slice(0, 32);
    }
    if (['new_invitation', 'refusal_rejected', 'accepted'].includes(user.bootstrapState)) {
      user.bootstrapState = 'accepted';
    }
    if (!user.trophies) user.trophies = [];
    if (!user.trophies.includes('Контракт с Системой')) {
      user.trophies.push('Контракт с Системой');
    }
    let leveledUp = false;
    if (user.level === 1 && user.currentXp === 0) {
      leveledUp = addXpToUser(user, 15);
    }
    saveStore(store);
    res.json({ ok: true, user, leveledUp });
  });

  app.post('/api/onboarding/roles', (req, res) => {
    const user = getUser(req);
    const { roles, customRoleText, playerCallsign, quickStart } = req.body as {
      roles?: LifeRoleId[];
      customRoleText?: string;
      playerCallsign?: string;
      quickStart?: boolean;
    };
    const wasFirstRoleSetup = user.roles.length === 0;
    if (Array.isArray(roles) && roles.length > 0) {
      user.roles = roles;
    }
    if (typeof customRoleText === 'string') {
      user.customRoleText = customRoleText.slice(0, 120);
    }
    if (typeof playerCallsign === 'string') {
      user.playerCallsign = (playerCallsign.trim() || 'Игрок').slice(0, 32);
    }

    // Grant one-time RPG starter stat boost matching selected class label verbatim
    if (wasFirstRoleSetup && user.roles.length > 0) {
      const primary = user.roles[0];
      if (primary === 'studying') user.stats.intelligence += 2;
      else if (primary === 'employed') user.stats.endurance += 2;
      else if (primary === 'freelance') user.stats.agility += 2;
      else if (primary === 'business') user.stats.perception += 2;
      else if (primary === 'family') user.stats.strength += 2;
      else {
        user.stats.intelligence += 1;
        user.stats.endurance += 1;
      }
      syncSkillStatRequirements(user);
    }

    if (quickStart) {
      if (user.goals.length === 0) {
        const primary = user.roles[0] || 'employed';
        const customTopic = user.customRoleText?.trim();
        const starterTitle =
          primary === 'studying'
            ? 'Изучение материала по плану'
            : primary === 'freelance'
            ? 'Отклики и поиск клиентов'
            : primary === 'business'
            ? 'Рост выручки и воронки'
            : primary === 'family'
            ? 'Спорт и восстановление энергии'
            : primary === 'custom'
            ? customTopic
              ? `Практика: ${customTopic}`
              : 'Практика ключевого навыка'
            : 'Глубокая работа без отвлечений';
        const gId = `goal_start_${Date.now()}`;
        user.goals.push({
          id: gId,
          type: 'scheduled_action',
          title: starterTitle,
          currentValue: 0,
          targetValue: 21,
          unit: 'сессий',
          status: 'active',
          durationMinutes: 15,
          daysPerWeek: 5,
          preferredTime: 'Вечером',
        });
        user.tasks.unshift(
          {
            id: `tsk_start_${Date.now()}`,
            title: `${starterTitle} · 15 минут`,
            goalId: gId,
            durationMinutes: 15,
            xpReward: 30,
            completed: false,
            dueDateText: 'Сегодня',
            priority: 'high',
          },
          {
            id: `tsk_intro_${Date.now() + 1}`,
            title: 'Калибровка дня: записать 1 трату или план',
            xpReward: 20,
            completed: false,
            dueDateText: 'Сегодня',
            priority: 'normal',
          }
        );
      }
      user.bootstrapState = 'ready';
    } else if (user.bootstrapState !== 'ready') {
      user.bootstrapState = 'onboarding_goal_type';
    }
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/onboarding/complete', (req, res) => {
    const user = getUser(req);
    user.bootstrapState = 'ready';
    saveStore(store);
    res.json({ ok: true, user });
  });

  // Goals creation & milestones
  app.post('/api/goals/create', (req, res) => {
    const user = getUser(req);
    const {
      type,
      title,
      targetValue,
      durationMinutes,
      daysPerWeek,
      preferredTime,
      deadlineText,
      firstStepTitle,
      mandatoryDeadline,
      targetSavingsRub,
      alreadySavedRub,
      isOnboarding,
    } = req.body;

    if (isOnboarding && (type === 'scheduled_action' || type === 'deadline_project' || type === 'savings')) {
      user.onboardingSelectedGoalType = type;
    }

    const activeGoalsCount = user.goals.filter((g) => g.status === 'active').length;
    const allowOnboardingBypass = Boolean(isOnboarding && user.bootstrapState !== 'ready' && activeGoalsCount === 0);
    if (!allowOnboardingBypass && !user.subscription.active && activeGoalsCount >= 3) {
      res.status(403).json({
        ok: false,
        code: 'FREE_GOAL_LIMIT_REACHED',
        message: 'Активных целей: 3 / 3. Чтобы добавить новую цель, подключите Систему+ или завершите одну из текущих.',
      });
      return;
    }

    const totalBalances = user.accounts
      .filter((a) => a.status === 'active')
      .reduce((sum, a) => sum + a.balanceRub, 0);
    const existingAllocated = user.goals
      .filter((g) => g.status === 'active' && g.type === 'savings')
      .reduce((sum, g) => sum + g.currentValue, 0);
    const initialSaved = Math.max(0, Math.round(Number(alreadySavedRub) || 0));

    if (type === 'savings' && initialSaved > 0 && existingAllocated + initialSaved > totalBalances) {
      if (isOnboarding && totalBalances === 0 && existingAllocated === 0) {
        // Initialize starter card account with the user's declared initial savings so accounting is consistent
        const cardAcc = user.accounts.find((a) => a.id === 'acc_card' || a.type === 'card');
        if (cardAcc) {
          cardAcc.balanceRub = initialSaved;
        } else {
          user.accounts.push({
            id: 'acc_card',
            name: 'Карта',
            type: 'card',
            balanceRub: initialSaved,
            status: 'active',
          });
        }
      } else {
        const available = Math.max(0, totalBalances - existingAllocated);
        res.status(400).json({
          ok: false,
          code: 'SAVINGS_EXCEEDS_ACCOUNT_BALANCE',
          message: `Доступно для распределения: ${available.toLocaleString('ru-RU')} ₽ (остаток ${totalBalances.toLocaleString('ru-RU')} ₽ с учётом других копилок).`,
        });
        return;
      }
    }

    const goalId = `goal_${Date.now()}`;
    if (type === 'scheduled_action') {
      const cleanTitle = String(title || 'Фокус над проектом').trim();
      const mins = Number(durationMinutes) || 15;
      const targetSessions = Math.max(5, Math.min(90, Number(targetValue) || 21));
      user.goals.push({
        id: goalId,
        type: 'scheduled_action',
        title: cleanTitle,
        currentValue: 0,
        targetValue: targetSessions,
        unit: 'сессий',
        status: 'active',
        durationMinutes: mins,
        daysPerWeek: Number(daysPerWeek) || 5,
        preferredTime: preferredTime || 'Вечером',
      });
      const createdTask = {
        id: `tsk_${Date.now()}`,
        title: `${cleanTitle} · ${mins} минут`,
        goalId,
        durationMinutes: mins,
        xpReward: 30,
        completed: false,
        dueDateText: 'Сегодня',
        priority: 'normal' as const,
      };
      user.tasks.unshift(createdTask);
      if (isOnboarding) {
        user.focusSession = {
          active: false,
          paused: false,
          taskId: createdTask.id,
          title: cleanTitle,
          totalSeconds: mins * 60,
          remainingSeconds: mins * 60,
        };
      }
    } else if (type === 'deadline_project') {
      const cleanTitle = String(title || 'Запустить портфолио').trim();
      const step1 = String(firstStepTitle || 'Собрать примеры работ').trim();
      user.goals.push({
        id: goalId,
        type: 'deadline_project',
        title: cleanTitle,
        currentValue: 0,
        targetValue: 3,
        unit: 'этапов',
        status: 'active',
        mandatoryDeadline: Boolean(mandatoryDeadline),
        deadlineText: deadlineText || 'Через 30 дней',
        milestones: [
          {
            id: `ms_1_${Date.now()}`,
            goalId,
            title: step1,
            order: 1,
            completed: false,
            locked: false,
            mandatory: Boolean(mandatoryDeadline),
          },
          {
            id: `ms_2_${Date.now()}`,
            goalId,
            title: 'Оформить страницы',
            order: 2,
            completed: false,
            locked: true,
            mandatory: Boolean(mandatoryDeadline),
            deadlineDate: 'Через 7 дней',
          },
          {
            id: `ms_3_${Date.now()}`,
            goalId,
            title: 'Опубликовать',
            order: 3,
            completed: false,
            locked: true,
            mandatory: Boolean(mandatoryDeadline),
          },
        ],
      });
      const createdTask = {
        id: `tsk_${Date.now()}`,
        title: step1,
        goalId,
        durationMinutes: 15,
        xpReward: 30,
        completed: false,
        dueDateText: 'Сегодня',
        priority: 'normal' as const,
        mandatory: Boolean(mandatoryDeadline),
      };
      user.tasks.unshift(createdTask);
      if (isOnboarding) {
        user.focusSession = {
          active: false,
          paused: false,
          taskId: createdTask.id,
          title: step1,
          totalSeconds: 900,
          remainingSeconds: 900,
        };
      }
    } else {
      const saved = Math.max(0, Math.round(Number(alreadySavedRub) || 0));
      const target = Math.max(1000, Math.round(Number(targetSavingsRub) || 100000));
      const cleanTitle = String(title || 'Подушка безопасности').trim();
      user.goals.push({
        id: goalId,
        type: 'savings',
        title: cleanTitle,
        currentValue: saved,
        targetValue: target,
        unit: '₽',
        status: 'active',
        deadlineText: deadlineText || 'Без жёсткой даты',
      });
      if (isOnboarding) {
        const createdTask = {
          id: `tsk_${Date.now()}`,
          title: `План накоплений: ${cleanTitle}`,
          goalId,
          durationMinutes: 10,
          xpReward: 30,
          completed: false,
          dueDateText: 'Сегодня',
          priority: 'normal' as const,
        };
        user.tasks.unshift(createdTask);
        user.focusSession = {
          active: false,
          paused: false,
          taskId: createdTask.id,
          title: createdTask.title,
          totalSeconds: 600,
          remainingSeconds: 600,
        };
      }
      recomputeAccountTotals(user);
    }

    if (isOnboarding) {
      user.bootstrapState = 'first_task';
    }
    saveStore(store);
    res.json({ ok: true, user, createdGoalId: goalId });
  });

  app.post('/api/goals/smart-steps', (req, res) => {
    const user = getUser(req);
    const { title, goalId, apply } = req.body as { title?: string; goalId?: string; apply?: boolean };
    const targetGoal = goalId ? user.goals.find((g) => g.id === goalId) : undefined;
    const rawTitle = String(title || targetGoal?.title || 'Ключевой проект').trim();
    const lower = rawTitle.toLowerCase();

    let steps: [string, string, string];
    if (lower.includes('портфолио') || lower.includes('сайт') || lower.includes('дизайн') || lower.includes('резюме')) {
      steps = [
        'Отобрать 3 лучших кейса и тезисы результата (15 мин)',
        'Сверстать / оформить витрину и описание услуг',
        'Проверить ссылки и опубликовать ссылку в профиле',
      ];
    } else if (lower.includes('англ') || lower.includes('язык') || lower.includes('экзам') || lower.includes('диплом') || lower.includes('учеб')) {
      steps = [
        'Составить список ключевых тем и пройти тест-срез',
        'Закрыть слабые блоки по 25 минут в день',
        'Пройти контрольный разбор и финальную сдачу',
      ];
    } else if (lower.includes('доход') || lower.includes('клиент') || lower.includes('запуск') || lower.includes('бизнес') || lower.includes('канал') || lower.includes('tiktok')) {
      steps = [
        'Сформулировать оффер / тему первых 3 публикаций',
        'Сделать первый тестовый выпуск и разослать 5 касаний',
        'Зафиксировать конверсию и докрутить воронку',
      ];
    } else {
      steps = [
        `Декомпозиция «${rawTitle.slice(0, 28)}»: первый шаг на 15 мин`,
        `Основной рывок: закрыть ядро результата по «${rawTitle.slice(0, 22)}»`,
        'Финальная полировка и фиксация итога в Системе',
      ];
    }

    if (apply && targetGoal && targetGoal.type === 'deadline_project') {
      const usedCount = user.smartStepsUsedCount || 0;
      if (!user.subscription.active && usedCount >= 2) {
        res.status(403).json({
          ok: false,
          code: 'SYSTEM_PLUS_REQUIRED',
          message: 'Лимит бесплатных авто-разбивок (2 / 2). Безлимит умных этапов доступен в Система+.',
          user,
        });
        return;
      }
      const mandatory = Boolean(targetGoal.mandatoryDeadline);
      targetGoal.milestones = steps.map((stepTitle, idx) => ({
        id: `ms_${idx + 1}_${Date.now()}`,
        goalId: targetGoal.id,
        title: stepTitle,
        order: idx + 1,
        completed: false,
        locked: idx > 0,
        mandatory,
        deadlineDate: idx === 1 ? 'Через 7 дней' : undefined,
      }));
      targetGoal.currentValue = 0;
      targetGoal.targetValue = steps.length;
      targetGoal.unit = 'этапов';
      const existingTask = user.tasks.find((t) => t.goalId === targetGoal.id && !t.completed);
      if (existingTask) {
        existingTask.title = steps[0];
      } else {
        user.tasks.unshift({
          id: `tsk_ms_${Date.now()}`,
          title: steps[0],
          goalId: targetGoal.id,
          durationMinutes: 15,
          xpReward: 30,
          completed: false,
          dueDateText: 'Сегодня',
          priority: 'high',
        });
      }
      if (!user.subscription.active) {
        user.smartStepsUsedCount = usedCount + 1;
      }
      saveStore(store);
    }

    res.json({ ok: true, steps, user });
  });

  app.post('/api/goals/milestone-toggle', (req, res) => {
    const user = getUser(req);
    const { goalId, milestoneId } = req.body as { goalId: string; milestoneId: string };
    const goal = user.goals.find((g) => g.id === goalId);
    if (!goal || !goal.milestones) {
      res.status(404).json({ ok: false, message: 'Цель или этап не найдены' });
      return;
    }
    const ms = goal.milestones.find((m) => m.id === milestoneId);
    if (!ms || ms.locked) {
      res.status(400).json({ ok: false, message: 'Сначала завершите предыдущий этап проекта' });
      return;
    }
    ms.completed = !ms.completed;
    // Unlock next milestone sequentially
    goal.milestones.forEach((m, index) => {
      if (index === 0) {
        m.locked = false;
      } else {
        m.locked = !goal.milestones![index - 1].completed;
      }
    });
    goal.currentValue = goal.milestones.filter((m) => m.completed).length;

    const tz = user.timezone || 'Europe/Moscow';
    syncStreakOnActivity(user, tz);

    let goalJustCompleted = false;
    let leveledUp = false;
    if (goal.currentValue >= goal.targetValue) {
      goal.status = 'completed';
      if (!goal.rewardXpGranted) {
        goal.rewardXpGranted = true;
        goalJustCompleted = true;
        user.lastCompletedGoalTitle = goal.title;
        user.lastCompletedGoalProgress = `${goal.currentValue} / ${goal.targetValue} этапов`;
        leveledUp = addXpToUser(user, 500);
        grantShadowForAchievement(
          user,
          `shd_goal_${goal.id}`,
          'Беру · Тень Проекта',
          'A-Тень',
          '+5 XP за задания'
        );
      }
    } else if (goal.status === 'completed') {
      goal.status = 'active';
    }

    saveStore(store);
    res.json({ ok: true, user, goalJustCompleted, leveledUp });
  });

  app.post('/api/goals/update-savings', (req, res) => {
    const user = getUser(req);
    const { goalId, newAllocatedRub } = req.body as { goalId: string; newAllocatedRub: number };
    const goal = user.goals.find((g) => g.id === goalId);
    if (!goal) {
      res.status(404).json({ ok: false, message: 'Цель не найдена' });
      return;
    }
    const totalBalances = user.accounts
      .filter((a) => a.status === 'active')
      .reduce((sum, a) => sum + a.balanceRub, 0);
    const otherAllocated = user.goals
      .filter((g) => g.id !== goal.id && g.status === 'active' && g.type === 'savings')
      .reduce((sum, g) => sum + g.currentValue, 0);
    const clamped = Math.max(0, Math.round(Number(newAllocatedRub) || 0));
    if (otherAllocated + clamped > totalBalances) {
      const maxForGoal = Math.max(0, totalBalances - otherAllocated);
      res.status(400).json({
        ok: false,
        code: 'SAVINGS_EXCEEDS_ACCOUNT_BALANCE',
        message: `С учётом остальных целей-копилок максимум для этой цели: ${maxForGoal.toLocaleString('ru-RU')} ₽ (общий остаток ${totalBalances.toLocaleString('ru-RU')} ₽).`,
      });
      return;
    }
    goal.currentValue = clamped;
    recomputeAccountTotals(user);
    let goalJustCompleted = false;
    let leveledUp = false;
    if (goal.currentValue >= goal.targetValue) {
      goal.status = 'completed';
      if (!goal.rewardXpGranted) {
        goal.rewardXpGranted = true;
        goalJustCompleted = true;
        user.lastCompletedGoalTitle = goal.title;
        user.lastCompletedGoalProgress = `${goal.currentValue.toLocaleString('ru-RU')} / ${goal.targetValue.toLocaleString('ru-RU')} ₽`;
        leveledUp = addXpToUser(user, 500);
        grantShadowForAchievement(
          user,
          `shd_sav_${goal.id}`,
          'Грид · Тень Резерва',
          'A-Тень',
          '+5 XP за задания'
        );
      }
    }
    saveStore(store);
    res.json({ ok: true, user, goalJustCompleted, leveledUp });
  });

  app.post('/api/goals/update', (req, res) => {
    const user = getUser(req);
    const {
      goalId,
      title,
      deadlineText,
      mandatoryDeadline,
      durationMinutes,
      targetValue,
      daysPerWeek,
      preferredTime,
    } = req.body as {
      goalId: string;
      title?: string;
      deadlineText?: string;
      mandatoryDeadline?: boolean;
      durationMinutes?: number;
      targetValue?: number;
      daysPerWeek?: number;
      preferredTime?: string;
    };
    const goal = user.goals.find((g) => g.id === goalId);
    if (!goal) {
      res.status(404).json({ ok: false, message: 'Цель не найдена' });
      return;
    }
    if (typeof title === 'string' && title.trim()) {
      goal.title = title.trim();
    }
    if (typeof deadlineText === 'string' && deadlineText.trim()) {
      goal.deadlineText = deadlineText.trim();
    }
    if (typeof mandatoryDeadline === 'boolean') {
      goal.mandatoryDeadline = mandatoryDeadline;
    }
    if (goal.type === 'scheduled_action') {
      if (typeof durationMinutes === 'number' && durationMinutes > 0) {
        goal.durationMinutes = Math.round(durationMinutes);
      }
      if (typeof targetValue === 'number' && targetValue >= 1) {
        goal.targetValue = Math.max(goal.currentValue, Math.round(targetValue));
      }
      if (typeof daysPerWeek === 'number' && daysPerWeek >= 1 && daysPerWeek <= 7) {
        goal.daysPerWeek = Math.round(daysPerWeek);
      }
      if (typeof preferredTime === 'string' && preferredTime.trim()) {
        goal.preferredTime = preferredTime.trim();
      }
    }
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/goals/delete', (req, res) => {
    const user = getUser(req);
    const { goalId, mode = 'delete', deleteLinkedTasks = false } = req.body as {
      goalId: string;
      mode?: 'archive' | 'restore' | 'delete';
      deleteLinkedTasks?: boolean;
    };
    const idx = user.goals.findIndex((g) => g.id === goalId);
    if (idx === -1) {
      res.status(404).json({ ok: false, message: 'Цель не найдена' });
      return;
    }
    const goal = user.goals[idx];

    if (mode === 'archive') {
      goal.status = 'archived';
      recomputeAccountTotals(user);
      saveStore(store);
      res.json({ ok: true, user });
      return;
    }

    if (mode === 'restore') {
      const activeGoalsCount = user.goals.filter((g) => g.status === 'active').length;
      if (!user.subscription.active && activeGoalsCount >= 3) {
        res.status(403).json({
          ok: false,
          code: 'FREE_GOAL_LIMIT_REACHED',
          message: 'Активных целей: 3 / 3. Чтобы восстановить цель, подключите Систему+ или завершите одну из текущих.',
        });
        return;
      }
      goal.status = 'active';
      recomputeAccountTotals(user);
      saveStore(store);
      res.json({ ok: true, user });
      return;
    }

    // Full delete
    user.goals.splice(idx, 1);
    const removedTaskIds = new Set<string>();
    if (deleteLinkedTasks) {
      user.tasks = user.tasks.filter((t) => {
        if (t.goalId === goalId && !t.completed) {
          removedTaskIds.add(t.id);
          return false;
        }
        if (t.goalId === goalId) {
          t.goalId = undefined;
        }
        return true;
      });
    } else {
      user.tasks.forEach((t) => {
        if (t.goalId === goalId) t.goalId = undefined;
      });
    }
    if (user.focusSession.taskId && removedTaskIds.has(user.focusSession.taskId)) {
      user.focusSession.active = false;
      user.focusSession.paused = false;
      user.focusSession.taskId = '';
    }
    recomputeAccountTotals(user);
    saveStore(store);
    res.json({ ok: true, user });
  });

  // Tasks & Focus Sessions
  app.post('/api/tasks/start-focus', (req, res) => {
    const user = getUser(req);
    if (isUserQuarantined(user)) {
      res.status(403).json({
        ok: false,
        code: 'PENALTY_LOCKED',
        message: 'Штрафной квест активен: фокус и прокачка заморожены до снятия штрафа.',
        user,
      });
      return;
    }
    const { taskId, goalId, durationMinutes } = req.body as {
      taskId?: string;
      goalId?: string;
      durationMinutes?: number;
    };
    const durationOverride = Number(durationMinutes) || 0;
    if (durationOverride >= 60 && !user.subscription.active) {
      res.status(403).json({
        ok: false,
        code: 'SYSTEM_PLUS_REQUIRED',
        message: 'Врата на 60 и 90 минут доступны с Система+.',
        user,
      });
      return;
    }
    let task =
      (taskId ? user.tasks.find((t) => t.id === taskId) : undefined) ||
      (goalId ? user.tasks.find((t) => t.goalId === goalId && !t.completed) : undefined) ||
      user.tasks.find((t) => !t.completed);

    if (!task) {
      const targetGoal = goalId ? user.goals.find((g) => g.id === goalId) : user.goals.find((g) => g.status === 'active');
      const mins = durationOverride || targetGoal?.durationMinutes || 15;
      task = {
        id: `tsk_focus_${Date.now()}`,
        title: targetGoal ? `${targetGoal.title} · ${mins} минут` : `Фокус-сессия · ${mins} минут`,
        goalId: targetGoal?.id,
        durationMinutes: mins,
        xpReward: 30,
        completed: false,
        dueDateText: 'Сегодня',
        priority: 'normal',
      };
      user.tasks.unshift(task);
    }

    const mins = durationOverride || task.durationMinutes || 15;
    user.focusSession = {
      active: true,
      paused: false,
      taskId: task.id,
      title: task.title,
      totalSeconds: mins * 60,
      remainingSeconds: mins * 60,
      startedAtMs: Date.now(),
    };
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/tasks/focus-pause', (req, res) => {
    const user = getUser(req);
    const { paused, remainingSeconds, cancel } = req.body as {
      paused?: boolean;
      remainingSeconds?: number;
      cancel?: boolean;
    };
    if (cancel) {
      user.focusSession.active = false;
      user.focusSession.paused = false;
      user.focusSession.startedAtMs = undefined;
    } else if (user.focusSession.active) {
      if (typeof remainingSeconds === 'number' && Number.isFinite(remainingSeconds)) {
        user.focusSession.remainingSeconds = Math.max(0, Math.round(remainingSeconds));
      }
      if (typeof paused === 'boolean') {
        user.focusSession.paused = paused;
        if (paused) {
          user.focusSession.startedAtMs = undefined;
        } else {
          user.focusSession.startedAtMs =
            Date.now() - Math.max(0, user.focusSession.totalSeconds - user.focusSession.remainingSeconds) * 1000;
        }
      }
    }
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/tasks/toggle', (req, res) => {
    const user = getUser(req);
    if (isUserQuarantined(user)) {
      res.status(403).json({
        ok: false,
        code: 'PENALTY_LOCKED',
        message: 'Штрафной квест активен: выполнение заданий и начисление XP заблокированы.',
        user,
      });
      return;
    }
    const { taskId, withFocusBonus } = req.body as { taskId: string; withFocusBonus?: boolean };
    const task = user.tasks.find((t) => t.id === taskId);
    if (!task) {
      res.status(404).json({ ok: false, code: 'TASK_NOT_FOUND', message: 'Задание не найдено' });
      return;
    }

    const penaltySuspendsBonuses =
      user.penaltyQuest.active &&
      user.penaltyQuest.status !== 'completed' &&
      user.penaltyQuest.status !== 'completed_late' &&
      user.penaltyQuest.status !== 'cancelled_error';

    const focusSkillLevel = user.skills.focus?.level || 1;
    const focusBonusAmount = focusSkillLevel === 3 ? 15 : focusSkillLevel === 2 ? 10 : 5;
    const intelStatBonus = Math.floor(Math.max(0, (user.stats.intelligence || 10) - 10) / 2);
    const shadowBonus = getShadowBonusXp(user);

    const tz = user.timezone || 'Europe/Moscow';
    const todayIso = getTzIsoDaysAgo(0, tz);

    let leveledUp = false;
    let goalJustCompleted = false;

    if (!task.completed) {
      task.completed = true;
      task.completedAt = new Date().toISOString();
      const baseXp = task.xpReward || 30;
      const focusPart = !penaltySuspendsBonuses && withFocusBonus !== false ? focusBonusAmount : 0;
      const bonusXp = !penaltySuspendsBonuses ? focusPart + intelStatBonus + shadowBonus : 0;
      const totalDelta = baseXp + bonusXp;
      task.skillBonusXp = bonusXp;
      const parts: string[] = [];
      if (focusPart > 0) parts.push('Фокус');
      if (intelStatBonus > 0) parts.push('ИНТ');
      if (shadowBonus > 0) parts.push('Тень');
      task.skillBonusName = parts.length > 0 ? parts.join(' + ') : undefined;

      leveledUp = addXpToUser(user, totalDelta);

      syncStreakOnActivity(user, tz);

      if (user.focusSession.active && user.focusSession.taskId === task.id) {
        user.focusSession.active = false;
        user.focusSession.paused = false;
        user.focusSession.startedAtMs = undefined;
      }

      // Update Focus skill session counter if completed via focus session
      if (withFocusBonus) {
        const focusSessionsReq = user.skills.focus.requirementsForNext.find((r) => r.id === 'req_sessions');
        if (focusSessionsReq) {
          focusSessionsReq.current += 1;
          focusSessionsReq.met = focusSessionsReq.current >= focusSessionsReq.target;
        }
      }

      // Also increment Impulse planned task counter
      const impulseActReq = user.skills.impulse?.requirementsForNext.find((r) => r.id === 'req_imp_act');
      if (impulseActReq) {
        impulseActReq.current += 1;
        impulseActReq.met = impulseActReq.current >= impulseActReq.target;
      }

      let goalTitle: string | undefined;
      let goalProgressText = '';
      let goalProgressPercent = 0;
      const linkedGoal = task.goalId ? user.goals.find((g) => g.id === task.goalId) : undefined;
      if (linkedGoal) {
        goalTitle = linkedGoal.title;
        if (linkedGoal.type === 'scheduled_action') {
          linkedGoal.currentValue = Math.min(linkedGoal.targetValue, linkedGoal.currentValue + 1);
          goalProgressText = `${linkedGoal.currentValue} / ${linkedGoal.targetValue} ${linkedGoal.unit || 'сессий'}`;
          goalProgressPercent = Math.round((linkedGoal.currentValue / Math.max(1, linkedGoal.targetValue)) * 100);
          if (linkedGoal.currentValue >= linkedGoal.targetValue) {
            linkedGoal.status = 'completed';
            if (!linkedGoal.rewardXpGranted) {
              linkedGoal.rewardXpGranted = true;
              goalJustCompleted = true;
              user.lastCompletedGoalTitle = linkedGoal.title;
              user.lastCompletedGoalProgress = `${linkedGoal.currentValue} / ${linkedGoal.targetValue}`;
              if (addXpToUser(user, 500)) leveledUp = true;
              grantShadowForAchievement(
                user,
                `shd_sch_${linkedGoal.id}`,
                'Игрис · Рыцарь Фокуса',
                'S-Тень',
                '+5 XP за задания'
              );
            }
          }
        } else {
          goalProgressPercent = Math.round((linkedGoal.currentValue / Math.max(1, linkedGoal.targetValue)) * 100);
          goalProgressText = `${linkedGoal.currentValue} / ${linkedGoal.targetValue} ${linkedGoal.unit}`;
        }
      }

      // Auto-spawn next occurrence for Система+ recurring tasks with real calendar dates
      if (task.recurrence && task.recurrence !== 'none' && user.subscription.active) {
        const offsetDays = task.recurrence === 'daily' ? 1 : task.recurrence === 'weekly' ? 7 : 1;
        let nextOffset = offsetDays;
        if (task.recurrence === 'weekdays') {
          const wd = getTzWeekday(1, tz);
          if (wd === 'СБ') nextOffset = 3;
          else if (wd === 'ВС') nextOffset = 2;
          else nextOffset = 1;
        }
        const targetIso = getTzIsoDaysAgo(-nextOffset, tz);
        const [, mm, dd] = targetIso.split('-');
        const nextDueLabel =
          nextOffset === 1 ? `Завтра (${dd}.${mm})` : `${dd}.${mm}`;
        const alreadySpawned = user.tasks.some(
          (t) => !t.completed && t.title === task.title && t.dueDateText === nextDueLabel
        );
        if (!alreadySpawned) {
          user.tasks.push({
            id: `tsk_rec_${Date.now()}`,
            title: task.title,
            goalId: task.goalId,
            durationMinutes: task.durationMinutes,
            xpReward: task.xpReward || 30,
            completed: false,
            dueDateText: nextDueLabel,
            priority: task.priority,
            recurrence: task.recurrence,
          });
        }
      }

      user.lastCompletedTaskBreakdown = {
        taskId: task.id,
        title: task.title,
        baseXp,
        bonusXp,
        bonusName: task.skillBonusName || 'Фокус',
        totalXp: totalDelta,
        goalTitle,
        goalProgressText,
        goalProgressPercent,
      };
    } else {
      const baseXp = task.xpReward || 30;
      const bonusXp = task.skillBonusXp || 0;
      const totalRevert = baseXp + bonusXp;
      task.completed = false;
      task.completedAt = undefined;

      subtractXpSafe(user, totalRevert);
      const linkedGoal = task.goalId ? user.goals.find((g) => g.id === task.goalId) : undefined;
      if (linkedGoal && linkedGoal.type === 'scheduled_action') {
        linkedGoal.currentValue = Math.max(0, linkedGoal.currentValue - 1);
        if (linkedGoal.status === 'completed' && linkedGoal.currentValue < linkedGoal.targetValue) {
          linkedGoal.status = 'active';
        }
      }
      user.lastCompletedTaskBreakdown = null;
    }

    saveStore(store);
    res.json({ ok: true, user, leveledUp, goalJustCompleted });
  });

  app.post('/api/tasks/save', (req, res) => {
    const user = getUser(req);
    const { id, title, goalId, dueDateText, priority, recurrence, deleteTask } = req.body;
    if (deleteTask && id) {
      user.tasks = user.tasks.filter((t) => t.id !== id);
      saveStore(store);
      res.json({ ok: true, user });
      return;
    }
    if (!title || !String(title).trim()) {
      res.status(400).json({ ok: false, code: 'INVALID_TITLE', message: 'Введите название задания' });
      return;
    }
    if (recurrence && recurrence !== 'none' && !user.subscription.active) {
      res.status(403).json({
        ok: false,
        code: 'SYSTEM_PLUS_REQUIRED',
        message: 'Повторяющиеся задания на автопилоте доступны в Система+.',
      });
      return;
    }
    const normalizedGoalId = typeof goalId === 'string' && goalId.trim() ? goalId.trim() : undefined;
    const existing = user.tasks.find((t) => t.id === id);
    if (existing) {
      existing.title = String(title).trim();
      if (goalId !== undefined) {
        existing.goalId = normalizedGoalId;
      }
      existing.dueDateText = dueDateText || existing.dueDateText;
      existing.priority = priority || existing.priority;
      if (recurrence !== undefined) existing.recurrence = recurrence;
    } else {
      user.tasks.unshift({
        id: `tsk_${Date.now()}`,
        title: String(title).trim(),
        goalId: normalizedGoalId,
        dueDateText: dueDateText || 'Сегодня',
        priority: priority || 'normal',
        recurrence: recurrence || 'none',
        xpReward: 30,
        completed: false,
      });
    }
    saveStore(store);
    res.json({ ok: true, user });
  });

  // Habits
  app.post('/api/habits/progress', (req, res) => {
    const user = getUser(req);
    if (isUserQuarantined(user)) {
      res.status(403).json({
        ok: false,
        code: 'PENALTY_LOCKED',
        message: 'Штрафной квест активен: отметка привычек заморожена до снятия штрафа.',
        user,
      });
      return;
    }
    const { habitId, addMinutes } = req.body as { habitId: string; addMinutes?: number };
    const habit = user.habits.find((h) => h.id === habitId);
    if (!habit) {
      res.status(404).json({ ok: false, code: 'HABIT_NOT_FOUND', message: 'Привычка не найдена' });
      return;
    }

    const tz = user.timezone || 'Europe/Moscow';
    const todayIso = getTzIsoDaysAgo(0, tz);

    let leveledUp = false;
    const wasCompleted = habit.completedToday;
    if (typeof addMinutes === 'number') {
      const deltaMin = Math.max(1, Math.min(240, Math.round(addMinutes)));
      habit.currentMinutesToday = Math.min(habit.durationMinutes, habit.currentMinutesToday + deltaMin);
      if (habit.currentMinutesToday >= habit.durationMinutes && !wasCompleted) {
        habit.completedToday = true;
        leveledUp = addXpToUser(user, 20);
        syncStreakOnActivity(user, tz);
      }
    } else {
      habit.completedToday = !habit.completedToday;
      habit.currentMinutesToday = habit.completedToday ? habit.durationMinutes : 0;
      if (habit.completedToday && !wasCompleted) {
        leveledUp = addXpToUser(user, 20);
        syncStreakOnActivity(user, tz);
      } else if (!habit.completedToday && wasCompleted) {
        subtractXpSafe(user, 20);
      }
    }

    // Keep today's habit history entry synchronized using user's timezone calendar date
    const todayStatus = habit.completedToday
      ? 'completed'
      : habit.currentMinutesToday > 0
      ? 'partial'
      : 'pending';
    const existingTodayIdx = habit.history.findIndex(
      (h) => h.isoDate === todayIso || h.dateLabel === 'Сегодня'
    );
    const todayHistoryEntry = {
      dateLabel: 'Сегодня',
      isoDate: todayIso,
      status: todayStatus as 'completed' | 'partial' | 'pending',
      valueMinutes: habit.currentMinutesToday,
      targetMinutes: habit.durationMinutes,
    };
    if (existingTodayIdx >= 0) {
      habit.history[existingTodayIdx] = todayHistoryEntry;
    } else {
      habit.history.unshift(todayHistoryEntry);
    }

    saveStore(store);
    res.json({ ok: true, user, leveledUp });
  });

  app.post('/api/habits/save', (req, res) => {
    const user = getUser(req);
    const tz = user.timezone || 'Europe/Moscow';
    const todayIso = getTzIsoDaysAgo(0, tz);
    const { id, title, durationMinutes, daysOfWeek, deadlineTime, mandatory, archive, restore, deleteHabit } = req.body;
    const idx = user.habits.findIndex((h) => h.id === id);
    const existing = idx >= 0 ? user.habits[idx] : undefined;

    if (deleteHabit && idx >= 0) {
      user.habits.splice(idx, 1);
      saveStore(store);
      res.json({ ok: true, user });
      return;
    }

    if (existing) {
      if (archive) {
        existing.status = 'archived';
      } else if (restore) {
        const activeHabitsCount = user.habits.filter((h) => h.status === 'active').length;
        if (!user.subscription.active && activeHabitsCount >= 3) {
          res.status(403).json({
            ok: false,
            code: 'FREE_HABIT_LIMIT_REACHED',
            message: 'Активных привычек: 3 / 3. Чтобы восстановить привычку, подключите Систему+ или архивируйте другую.',
          });
          return;
        }
        existing.status = 'active';
      } else {
        existing.title = title?.trim() || existing.title;
        existing.durationMinutes = Number(durationMinutes) || existing.durationMinutes;
        existing.daysOfWeek = Array.isArray(daysOfWeek) ? daysOfWeek : existing.daysOfWeek;
        existing.deadlineTime = deadlineTime || existing.deadlineTime;
        existing.mandatory = Boolean(mandatory);
      }
      saveStore(store);
      res.json({ ok: true, user });
      return;
    }

    const activeHabitsCount = user.habits.filter((h) => h.status === 'active').length;
    if (!user.subscription.active && activeHabitsCount >= 3) {
      res.status(403).json({
        ok: false,
        code: 'FREE_HABIT_LIMIT_REACHED',
        message: 'Активных привычек: 3 / 3. Чтобы добавить новую привычку, расширьте возможности в Система+ или архивируйте одну из текущих.',
      });
      return;
    }

    user.habits.push({
      id: `hab_${Date.now()}`,
      title: String(title || 'Новая привычка').trim(),
      durationMinutes: Number(durationMinutes) || 15,
      currentMinutesToday: 0,
      completedToday: false,
      daysOfWeek: Array.isArray(daysOfWeek) ? daysOfWeek : ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ'],
      deadlineTime: deadlineTime || '23:00',
      mandatory: Boolean(mandatory),
      status: 'active',
      createdAtIso: todayIso,
      history: [{ dateLabel: 'Сегодня', isoDate: todayIso, status: 'pending' }],
    });
    saveStore(store);
    res.json({ ok: true, user });
  });

  // Finance
  app.post('/api/finance/parse', (req, res) => {
    const user = getUser(req);
    const { text } = req.body as { text: string };
    const defaultAcc = user.accounts.find((a) => a.status === 'active') || user.accounts[0] || { id: 'acc_card', name: 'Карта' };
    const items = parseNaturalFinanceInput(text || '', user.accounts, defaultAcc.id, defaultAcc.name);
    res.json({ ok: true, items });
  });

  app.post('/api/finance/commit-batch', (req, res) => {
    const user = getUser(req);
    const { items, idempotencyKey } = req.body as {
      items: Array<{
        title: string;
        category: string;
        amountRub: number;
        accountId: string;
        type: 'expense' | 'income';
        dateLabel?: string;
      }>;
      idempotencyKey?: string;
    };

    if (idempotencyKey && store.processedIdempotencyKeys[idempotencyKey]) {
      res.json({ ok: true, user, deduplicated: true });
      return;
    }

    const validItems = Array.isArray(items)
      ? items.filter((item) => Math.round(Math.abs(Number(item.amountRub) || 0)) > 0)
      : [];

    if (validItems.length === 0) {
      res.status(400).json({ ok: false, code: 'EMPTY_BATCH', message: 'Укажите сумму больше 0 ₽ и название записи' });
      return;
    }

    if (user.accounts.length === 0) {
      user.accounts.push(
        { id: 'acc_card', name: 'Карта', type: 'card', balanceRub: 0, status: 'active' },
        { id: 'acc_cash', name: 'Наличные', type: 'cash', balanceRub: 0, status: 'active' }
      );
    }

    for (const item of validItems) {
      const amount = Math.round(Math.abs(Number(item.amountRub) || 0));
      const acc =
        user.accounts.find((a) => a.id === item.accountId) ||
        user.accounts.find((a) => a.status === 'active') ||
        user.accounts[0];
      if (!acc) continue;

      if (item.type === 'income') {
        acc.balanceRub += amount;
        user.monthIncomeRub += amount;
      } else {
        acc.balanceRub -= amount;
        user.monthExpenseRub += amount;
      }

      user.financialEntries.unshift({
        id: `fin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: item.type || 'expense',
        title: item.title?.trim() || item.category || 'Запись',
        category: item.category || 'Еда',
        amountRub: amount,
        accountId: acc.id,
        dateLabel: item.dateLabel || 'Сегодня',
        createdAt: new Date().toISOString(),
        idempotencyKey,
      });
    }

    if (idempotencyKey) {
      store.processedIdempotencyKeys[idempotencyKey] = true;
    }
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/finance/update-entry', (req, res) => {
    const user = getUser(req);
    const { entryId, newAmountRub, title, category, accountId, deleteEntry } = req.body;
    const idx = user.financialEntries.findIndex((e) => e.id === entryId);
    if (idx === -1) {
      res.status(404).json({ ok: false, code: 'ENTRY_NOT_FOUND', message: 'Запись не найдена' });
      return;
    }

    const entry = user.financialEntries[idx];
    const oldAcc = user.accounts.find((a) => a.id === entry.accountId) || user.accounts[0];

    if (deleteEntry) {
      if (oldAcc) {
        if (entry.type === 'expense') {
          oldAcc.balanceRub += entry.amountRub;
          user.monthExpenseRub = Math.max(0, user.monthExpenseRub - entry.amountRub);
        } else if (entry.type === 'income') {
          oldAcc.balanceRub -= entry.amountRub;
          user.monthIncomeRub = Math.max(0, user.monthIncomeRub - entry.amountRub);
        } else if (entry.type === 'transfer') {
          const toAcc = user.accounts.find((a) => a.id === entry.toAccountId);
          oldAcc.balanceRub += entry.amountRub;
          if (toAcc) toAcc.balanceRub -= entry.amountRub;
        }
      }
      user.financialEntries.splice(idx, 1);
      saveStore(store);
      res.json({ ok: true, user });
      return;
    }

    const parsedNew = Math.round(Number(newAmountRub));
    if (!Number.isFinite(parsedNew) || parsedNew <= 0) {
      res.status(400).json({ ok: false, code: 'INVALID_AMOUNT', message: 'Укажите корректную сумму больше 0 ₽' });
      return;
    }

    const newAcc =
      (accountId ? user.accounts.find((a) => a.id === accountId) : undefined) || oldAcc;
    const diff = parsedNew - entry.amountRub;

    if (entry.type === 'expense') {
      if (oldAcc && newAcc && oldAcc.id !== newAcc.id) {
        oldAcc.balanceRub += entry.amountRub;
        newAcc.balanceRub -= parsedNew;
        entry.accountId = newAcc.id;
      } else if (oldAcc && diff !== 0) {
        oldAcc.balanceRub -= diff;
      }
      user.monthExpenseRub = Math.max(0, user.monthExpenseRub + diff);
    } else if (entry.type === 'income') {
      if (oldAcc && newAcc && oldAcc.id !== newAcc.id) {
        oldAcc.balanceRub -= entry.amountRub;
        newAcc.balanceRub += parsedNew;
        entry.accountId = newAcc.id;
      } else if (oldAcc && diff !== 0) {
        oldAcc.balanceRub += diff;
      }
      user.monthIncomeRub = Math.max(0, user.monthIncomeRub + diff);
    }

    entry.amountRub = parsedNew;
    if (typeof title === 'string' && title.trim()) entry.title = title.trim();
    if (typeof category === 'string' && category.trim()) entry.category = category.trim();

    saveStore(store);
    res.json({ ok: true, user, diffApplied: diff });
  });

  app.post('/api/finance/transfer', (req, res) => {
    const user = getUser(req);
    const { fromAccountId, toAccountId, amountRub } = req.body;
    const amount = Math.round(Math.abs(Number(amountRub) || 0));
    if (amount <= 0 || fromAccountId === toAccountId) {
      res.status(400).json({ ok: false, code: 'INVALID_TRANSFER', message: 'Выберите разные счета и укажите сумму больше 0 ₽' });
      return;
    }
    const fromAcc = user.accounts.find((a) => a.id === fromAccountId);
    const toAcc = user.accounts.find((a) => a.id === toAccountId);
    if (!fromAcc || !toAcc) {
      res.status(404).json({ ok: false, code: 'ACCOUNT_NOT_FOUND', message: 'Счёт не найден' });
      return;
    }

    fromAcc.balanceRub -= amount;
    toAcc.balanceRub += amount;
    user.financialEntries.unshift({
      id: `tr_${Date.now()}`,
      type: 'transfer',
      title: `Перевод: ${fromAcc.name} → ${toAcc.name}`,
      category: 'Перевод',
      amountRub: amount,
      accountId: fromAcc.id,
      toAccountId: toAcc.id,
      dateLabel: 'Сегодня',
      createdAt: new Date().toISOString(),
    });

    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/finance/create-account', (req, res) => {
    const user = getUser(req);
    const { name, type, balanceRub } = req.body;
    const activeAccounts = user.accounts.filter((a) => a.status === 'active').length;
    if (!user.subscription.active && activeAccounts >= 3) {
      res.status(403).json({
        ok: false,
        code: 'FREE_ACCOUNT_LIMIT_REACHED',
        message: 'Активных счетов: 3 / 3. Чтобы добавить новый счёт, подключите Систему+.',
      });
      return;
    }
    user.accounts.push({
      id: `acc_${Date.now()}`,
      name: String(name || 'Новый счёт').trim(),
      type: type || 'card',
      balanceRub: Math.round(Number(balanceRub) || 0),
      status: 'active',
    });
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/finance/manage-account', (req, res) => {
    const user = getUser(req);
    const { accountId, action, transferToAccountId } = req.body as {
      accountId: string;
      action: 'archive' | 'restore' | 'delete';
      transferToAccountId?: string;
    };
    const idx = user.accounts.findIndex((a) => a.id === accountId);
    if (idx === -1) {
      res.status(404).json({ ok: false, message: 'Счёт не найден' });
      return;
    }
    const acc = user.accounts[idx];
    const activeAccounts = user.accounts.filter((a) => a.status === 'active');

    if (action === 'restore') {
      if (!user.subscription.active && activeAccounts.length >= 3) {
        res.status(403).json({
          ok: false,
          code: 'FREE_ACCOUNT_LIMIT_REACHED',
          message: 'Активных счетов: 3 / 3. Чтобы восстановить счёт, подключите Систему+.',
        });
        return;
      }
      acc.status = 'active';
      saveStore(store);
      res.json({ ok: true, user });
      return;
    }

    if (acc.status === 'active' && activeAccounts.length <= 1) {
      res.status(400).json({
        ok: false,
        code: 'ONLY_ONE_ACTIVE_ACCOUNT',
        message: 'Должен остаться хотя бы один активный счёт.',
      });
      return;
    }

    if (action === 'archive') {
      acc.status = 'archived';
      saveStore(store);
      res.json({ ok: true, user });
      return;
    }

    // Full delete
    if (acc.balanceRub !== 0) {
      const targetAcc = transferToAccountId
        ? user.accounts.find((a) => a.id === transferToAccountId && a.id !== acc.id && a.status === 'active')
        : undefined;
      if (!targetAcc) {
        res.status(400).json({
          ok: false,
          code: 'ACCOUNT_BALANCE_NOT_ZERO',
          message: 'На счёте ненулевой остаток — переведите его на другой счёт или отправьте счёт в архив.',
        });
        return;
      }
      targetAcc.balanceRub += acc.balanceRub;
      user.financialEntries.unshift({
        id: `tr_close_${Date.now()}`,
        type: 'transfer',
        title: `Закрытие счёта ${acc.name} → ${targetAcc.name}`,
        category: 'Перевод',
        amountRub: Math.abs(acc.balanceRub),
        accountId: acc.id,
        toAccountId: targetAcc.id,
        dateLabel: 'Сегодня',
        createdAt: new Date().toISOString(),
      });
    }
    user.accounts.splice(idx, 1);
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/finance/reconcile', (req, res) => {
    const user = getUser(req);
    const tz = user.timezone || 'Europe/Moscow';
    const todayIso = getTzIsoDaysAgo(0, tz);
    const key = `reconcile_${user.userId}_${todayIso}`;
    const ctrlLvl = user.skills.control?.level || 1;
    const xpGain = ctrlLvl >= 3 ? 15 : ctrlLvl === 2 ? 10 : 5;
    let leveledUp = false;
    let alreadyReconciled = false;
    if (!store.processedIdempotencyKeys[key]) {
      store.processedIdempotencyKeys[key] = true;
      leveledUp = addXpToUser(user, xpGain);
      saveStore(store);
    } else {
      alreadyReconciled = true;
    }
    res.json({ ok: true, user, leveledUp, xpGain, alreadyReconciled });
  });

  // Player Stats & Skills
  app.post('/api/player/stats/preview', (req, res) => {
    const user = getUser(req);
    const { stat, delta } = req.body as { stat: StatKey; delta: 1 | -1 };
    if (!stat || !(stat in user.pendingStatAdditions)) {
      res.status(400).json({ ok: false, code: 'INVALID_STAT', message: 'Некорректная характеристика' });
      return;
    }

    const totalPending = (Object.values(user.pendingStatAdditions) as number[]).reduce((a, b) => a + b, 0);
    if (delta === 1) {
      if (totalPending >= user.unspentStatPoints) {
        res.status(400).json({ ok: false, code: 'NO_POINTS_LEFT', message: 'Нет доступных очков прокачки' });
        return;
      }
      user.pendingStatAdditions[stat] += 1;
    } else if (delta === -1) {
      if (user.pendingStatAdditions[stat] > 0) {
        user.pendingStatAdditions[stat] -= 1;
      }
    }

    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/player/stats/reset', (req, res) => {
    const user = getUser(req);
    user.pendingStatAdditions = {
      strength: 0,
      endurance: 0,
      agility: 0,
      intelligence: 0,
      perception: 0,
    };
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/player/stats/commit', (req, res) => {
    const user = getUser(req);
    if (isUserQuarantined(user)) {
      res.status(403).json({
        ok: false,
        code: 'PENALTY_LOCKED',
        message: 'Штрафной квест активен: распределение характеристик заморожено.',
        user,
      });
      return;
    }
    const totalPending = (Object.values(user.pendingStatAdditions) as number[]).reduce((a, b) => a + b, 0);
    if (totalPending <= 0 || totalPending > user.unspentStatPoints) {
      res.status(400).json({ ok: false, code: 'INVALID_POINT_COMMIT', message: 'Выберите характеристики для распределения очков' });
      return;
    }

    (Object.keys(user.pendingStatAdditions) as StatKey[]).forEach((k) => {
      user.stats[k] += user.pendingStatAdditions[k];
      user.pendingStatAdditions[k] = 0;
    });
    user.unspentStatPoints -= totalPending;

    // Sync stat requirements across all 5 skill branches
    syncSkillStatRequirements(user);

    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/player/skills/upgrade', (req, res) => {
    const user = getUser(req);
    if (isUserQuarantined(user)) {
      res.status(403).json({
        ok: false,
        code: 'PENALTY_LOCKED',
        message: 'Штрафной квест активен: улучшение навыков заморожено.',
        user,
      });
      return;
    }
    const { skillId } = req.body as { skillId: keyof UserAppState['skills'] };
    const skill = user.skills[skillId];
    if (!skill) {
      res.status(404).json({ ok: false, code: 'SKILL_NOT_FOUND', message: 'Навык не найден' });
      return;
    }

    const allMet = skill.requirementsForNext.every((r) => r.current >= r.target);
    if (!allMet) {
      res.status(400).json({
        ok: false,
        code: 'SKILL_REQUIREMENTS_NOT_MET',
        message: 'Условия для перехода на следующий уровень навыка ещё не выполнены.',
      });
      return;
    }

    if (skill.level < skill.maxLevel) {
      skill.level += 1;
      user.lastUpgradedSkillId = skill.id;
      const nextStatTarget = skill.level === 2 ? 18 : 22;
      if (skill.id === 'focus') {
        skill.currentEffectText =
          skill.level === 2
            ? 'Сейчас: +10 XP · цепочка из 2 сессий'
            : 'Сейчас: +15 XP · цепочка из 3 сессий';
        const curSessions = skill.requirementsForNext.find((r) => r.id === 'req_sessions')?.current ?? 10;
        skill.requirementsForNext =
          skill.level >= skill.maxLevel
            ? []
            : [
                {
                  id: 'req_int',
                  label: 'Интеллект',
                  current: user.stats.intelligence,
                  target: nextStatTarget,
                  met: user.stats.intelligence >= nextStatTarget,
                },
                {
                  id: 'req_sessions',
                  label: 'Сессии',
                  current: curSessions,
                  target: 25,
                  met: curSessions >= 25,
                },
              ];
      } else if (skill.id === 'impulse') {
        skill.currentEffectText =
          skill.level === 2
            ? 'Сейчас: +10 XP за запланированную активность'
            : 'Сейчас: +15 XP за запланированную активность';
        const curActs = skill.requirementsForNext.find((r) => r.id === 'req_imp_act')?.current ?? 10;
        skill.requirementsForNext =
          skill.level >= skill.maxLevel
            ? []
            : [
                {
                  id: 'req_str',
                  label: 'Сила',
                  current: user.stats.strength,
                  target: 20,
                  met: user.stats.strength >= 20,
                },
                {
                  id: 'req_imp_act',
                  label: 'Запланированные задачи',
                  current: curActs,
                  target: 25,
                  met: curActs >= 25,
                },
              ];
      } else if (skill.id === 'rhythm') {
        skill.currentEffectText =
          skill.level === 2
            ? '2 защиты игровой серии на 30 дней'
            : '3 защиты игровой серии на 30 дней';
        skill.requirementsForNext =
          skill.level >= skill.maxLevel
            ? []
            : [
                {
                  id: 'req_end',
                  label: 'Выносливость',
                  current: user.stats.endurance,
                  target: 20,
                  met: user.stats.endurance >= 20,
                },
              ];
      } else if (skill.id === 'planning') {
        skill.currentEffectText =
          skill.level === 2
            ? 'Следующий шаг для 3 активных целей'
            : 'Следующий шаг для всех активных целей';
        skill.requirementsForNext =
          skill.level >= skill.maxLevel
            ? []
            : [
                {
                  id: 'req_agi',
                  label: 'Ловкость',
                  current: user.stats.agility,
                  target: 20,
                  met: user.stats.agility >= 20,
                },
              ];
      } else if (skill.id === 'control') {
        skill.currentEffectText =
          skill.level === 2
            ? 'Недельный обзор финансов (+10 XP за сверку)'
            : 'Проверка лимитов категорий (+15 XP за сверку)';
        skill.requirementsForNext =
          skill.level >= skill.maxLevel
            ? []
            : [
                {
                  id: 'req_per',
                  label: 'Восприятие',
                  current: user.stats.perception,
                  target: 20,
                  met: user.stats.perception >= 20,
                },
              ];
      }
    }

    saveStore(store);
    res.json({ ok: true, user });
  });

  // Penalty Quest
  app.post('/api/penalty/present', (req, res) => {
    const user = getUser(req);
    if (!user.penaltyQuest.presentedAt) {
      user.penaltyQuest.presentedAt = new Date().toISOString();
      user.penaltyQuest.status = 'terms_viewed';
      saveStore(store);
    }
    res.json({ ok: true, user });
  });

  app.post('/api/penalty/heartbeat', (req, res) => {
    const user = getUser(req);
    const { secondsDelta } = req.body as { secondsDelta?: number };
    const addSec = Math.min(10, Math.max(1, Number(secondsDelta) || 10));

    if (user.penaltyQuest.currentStage === 1) {
      user.penaltyQuest.stage1ConfirmedSeconds = Math.min(150, user.penaltyQuest.stage1ConfirmedSeconds + addSec);
    } else {
      user.penaltyQuest.stage2ConfirmedSeconds = Math.min(150, user.penaltyQuest.stage2ConfirmedSeconds + addSec);
    }

    user.penaltyQuest.lastHeartbeatToken = `hb_${Date.now()}`;
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/penalty/answer', (req, res) => {
    const user = getUser(req);
    const { questionId, optionIndex } = req.body as { questionId: string; optionIndex: number };

    const cd = store.penaltyCooldowns[user.userId] || { wrongStreak: 0, blockedUntilMs: 0 };
    if (Date.now() < cd.blockedUntilMs) {
      const waitSec = Math.ceil((cd.blockedUntilMs - Date.now()) / 1000);
      res.status(429).json({
        ok: false,
        code: 'ANSWER_COOLDOWN',
        message: `Три неверные попытки подряд. Повторная отправка доступна через ${waitSec} с.`,
      });
      return;
    }

    const q = PENALTY_QUESTIONS_BANK.find((item) => item.id === questionId) || PENALTY_QUESTIONS_BANK[0];
    user.penaltyQuest.selectedAnswerIndex = optionIndex;

    if (optionIndex === q.correctIndex) {
      cd.wrongStreak = 0;
      store.penaltyCooldowns[user.userId] = cd;
      user.penaltyQuest.lastAnswerError = null;
      user.penaltyQuest.questionsPassed = Math.min(
        user.penaltyQuest.totalQuestionsRequired,
        user.penaltyQuest.questionsPassed + 1
      );
      if (user.penaltyQuest.questionsPassed >= 3) {
        user.penaltyQuest.currentStage = 2;
      }
      saveStore(store);
      res.json({ ok: true, correct: true, explanation: q.explanation, user });
    } else {
      cd.wrongStreak += 1;
      if (cd.wrongStreak >= 3) {
        cd.blockedUntilMs = Date.now() + 30000;
      }
      store.penaltyCooldowns[user.userId] = cd;
      user.penaltyQuest.lastAnswerError = q.explanation;
      saveStore(store);
      res.json({ ok: true, correct: false, explanation: q.explanation, user });
    }
  });

  app.post('/api/penalty/select-challenge', (req, res) => {
    const user = getUser(req);
    const challenge = req.body?.challenge as 'body' | 'focus' | 'revenge';
    if (challenge === 'body' || challenge === 'focus' || challenge === 'revenge') {
      user.penaltyQuest.selectedChallenge = challenge;
      user.penaltyQuest.challengeDone = false;
      user.penaltyQuest.status = 'in_progress';
      saveStore(store);
    }
    res.json({ ok: true, user });
  });

  app.post('/api/penalty/trial-complete', (req, res) => {
    const user = getUser(req);
    const challenge = req.body?.challenge as 'body' | 'focus' | 'revenge' | undefined;
    if (challenge === 'body' || challenge === 'focus' || challenge === 'revenge') {
      user.penaltyQuest.selectedChallenge = challenge;
    }
    user.penaltyQuest.challengeDone = true;
    user.penaltyQuest.status = 'in_progress';
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/penalty/save-next-step', (req, res) => {
    const user = getUser(req);
    const { actionTitle, whenText, reflectionReason } = req.body as {
      actionTitle: string;
      whenText: string;
      reflectionReason?: string;
    };
    if (!actionTitle || !String(actionTitle).trim()) {
      res.status(400).json({ ok: false, code: 'ACTION_REQUIRED', message: 'Укажите конкретное действие' });
      return;
    }
    if (typeof reflectionReason === 'string') {
      user.penaltyQuest.reflectionReason = reflectionReason.trim().slice(0, 140);
    }
    user.penaltyQuest.nextStepAction = String(actionTitle).trim();
    user.penaltyQuest.nextStepWhen = String(whenText || 'Завтра в 19:00').trim();
    user.penaltyQuest.nextStepSaved = true;

    user.tasks.unshift({
      id: `tsk_recovery_${Date.now()}`,
      title: user.penaltyQuest.nextStepAction,
      dueDateText: user.penaltyQuest.nextStepWhen,
      xpReward: 30,
      completed: false,
      priority: 'normal',
    });

    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/penalty/complete', (req, res) => {
    const user = getUser(req);
    const pq = user.penaltyQuest;

    if (!pq.nextStepSaved) {
      res.status(400).json({
        ok: false,
        code: 'PENALTY_CONDITIONS_INCOMPLETE',
        message: 'Для завершения квеста сохраните конкретный следующий шаг.',
      });
      return;
    }

    if (pq.status !== 'completed' && pq.status !== 'completed_late') {
      const outcome = pq.remainingBudgetSeconds <= 0 ? 'completed_late' : 'completed';
      pq.status = outcome;
      pq.active = false;
      if (user.bootstrapState === 'penalty_alert') {
        user.bootstrapState = 'ready';
      }
      const trialTitleMap: Record<string, string> = {
        body: 'Испытание: Выносливость (20 повт.)',
        focus: 'Испытание: Концентрация (3 мин)',
        revenge: 'Испытание: Реванш по задаче',
      };
      const histTitle =
        (pq.selectedChallenge && trialTitleMap[pq.selectedChallenge]) || 'Учебный разбор';
      user.penaltyHistory.unshift({
        id: `pq_done_${Date.now()}`,
        dateLabel: 'Сегодня',
        title: histTitle,
        outcome,
      });
      saveStore(store);
    }

    res.json({ ok: true, user });
  });

  app.post('/api/penalty/use-shield', (req, res) => {
    const user = getUser(req);
    if (!user.subscription.active) {
      res.status(403).json({
        ok: false,
        code: 'SYSTEM_PLUS_REQUIRED',
        message: 'Щит Системы доступен с подпиской Система+.',
      });
      return;
    }
    const charges = user.shieldChargesRemaining ?? 0;
    if (charges <= 0) {
      res.status(400).json({
        ok: false,
        code: 'NO_SHIELD_CHARGES',
        message: 'Заряды Щита Системы на этот месяц исчерпаны.',
      });
      return;
    }
    user.shieldChargesRemaining = charges - 1;
    user.penaltyQuest.active = false;
    user.penaltyQuest.status = 'completed';
    if (user.bootstrapState === 'penalty_alert') {
      user.bootstrapState = 'ready';
    }
    user.penaltyHistory.unshift({
      id: `pq_shield_${Date.now()}`,
      dateLabel: 'Сегодня',
      title: `${user.penaltyQuest.reasonTitle} (Щит Системы+)`,
      outcome: 'completed',
    });
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/daily-quest/claim', (req, res) => {
    const user = getUser(req);
    if (isUserQuarantined(user)) {
      res.status(403).json({
        ok: false,
        code: 'PENALTY_LOCKED',
        message: 'Штрафной квест активен: сундук Ежедневного Квеста откроется после снятия штрафа.',
        user,
      });
      return;
    }
    const tz = user.timezone || 'Europe/Moscow';
    const todayKey = getTzIsoDaysAgo(0, tz);
    if (user.lastDailyClaimDate === todayKey) {
      res.status(400).json({
        ok: false,
        code: 'DAILY_ALREADY_CLAIMED',
        message: 'Ежедневная награда Системы сегодня уже получена.',
      });
      return;
    }
    const doneTasks = user.tasks.filter((t) => t.completed).length;
    const doneHabits = user.habits.filter((h) => h.status === 'active' && h.completedToday).length;
    if (doneTasks + doneHabits < 2) {
      res.status(400).json({
        ok: false,
        code: 'DAILY_NOT_READY',
        message: 'Выполните минимум 2 действия дня (задания или привычки), чтобы открыть сундук Системы.',
      });
      return;
    }

    const curStreak = syncStreakOnActivity(user, tz);
    user.lastDailyClaimDate = todayKey;

    let chestXp = 100;
    let bonusLabel = '+100 XP · Сундук Системы';
    if (curStreak > 0 && curStreak % 7 === 0) {
      chestXp = 150;
      user.shieldChargesRemaining = (user.shieldChargesRemaining || 0) + 1;
      bonusLabel = `+150 XP + 1 Щит · Серия ${curStreak} дн.!`;
      grantShadowForAchievement(
        user,
        'shd_streak_7',
        'Айрон · Хранитель Серии',
        'A-Тень',
        '+5 XP за задания'
      );
    } else if (curStreak > 0 && curStreak % 3 === 0) {
      chestXp = 125;
      bonusLabel = `+125 XP · Резонанс серии ${curStreak} дн.`;
    }
    if (user.subscription.active) {
      chestXp = Math.round(chestXp * 1.5);
      bonusLabel = `+${chestXp} XP (×1.5 PRO) · Серия ${curStreak} дн.`;
    }
    user.lastChestBonusText = bonusLabel;

    const leveledUp = addXpToUser(user, chestXp);
    if (!user.trophies) user.trophies = [];
    if (!user.trophies.includes('Сундук Ежедневного Квеста')) {
      user.trophies.push('Сундук Ежедневного Квеста');
    }
    saveStore(store);
    res.json({ ok: true, user, leveledUp });
  });

  app.post('/api/settings/theme', (req, res) => {
    const user = getUser(req);
    const { theme } = req.body as { theme: 'blue' | 'monarch' | 'igris' | 'sovereign' };
    const isProTheme = theme === 'monarch' || theme === 'igris' || theme === 'sovereign';
    if (isProTheme && !user.subscription.active) {
      res.status(403).json({
        ok: false,
        code: 'SYSTEM_PLUS_REQUIRED',
        message: 'Премиум-облик интерфейса доступен с подпиской Система+.',
      });
      return;
    }
    user.hudTheme = isProTheme ? theme : 'blue';
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/settings/night-window', (req, res) => {
    const user = getUser(req);
    const { start, end, soundEnabled, hapticsEnabled, hudTheme, botNotificationsEnabled, timezone } = req.body as {
      start?: string;
      end?: string;
      soundEnabled?: boolean;
      hapticsEnabled?: boolean;
      hudTheme?: 'blue' | 'monarch' | 'igris' | 'sovereign';
      botNotificationsEnabled?: boolean;
      timezone?: string;
    };
    if (typeof soundEnabled === 'boolean') {
      user.soundEnabled = soundEnabled;
    }
    if (typeof hapticsEnabled === 'boolean') {
      user.hapticsEnabled = hapticsEnabled;
    }
    if (typeof botNotificationsEnabled === 'boolean') {
      user.botNotificationsEnabled = botNotificationsEnabled;
    }
    if (typeof timezone === 'string' && timezone.trim()) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone.trim() });
        user.timezone = timezone.trim();
      } catch {
        // Ignore invalid timezone
      }
    }
    if (
      hudTheme &&
      (hudTheme === 'blue' ||
        ((hudTheme === 'monarch' || hudTheme === 'igris' || hudTheme === 'sovereign') &&
          user.subscription.active))
    ) {
      user.hudTheme = hudTheme;
    }
    if (start && end) {
      const hours = calculateNightWindowDurationHours(start, end);
      if (hours <= 0 || hours > 10) {
        res.status(400).json({
          ok: false,
          code: 'NIGHT_WINDOW_TOO_LONG',
          message: 'Ночной период должен быть одним интервалом до 10 часов в сутки.',
        });
        return;
      }
      user.nightPeriodStart = start;
      user.nightPeriodEnd = end;
    }
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/settings/toggle-plus', (req, res) => {
    const user = getUser(req);
    if (!isTrustedAdminOrDev(req, user)) {
      res.status(403).json({
        ok: false,
        code: 'FORBIDDEN',
        message: 'Ручное переключение подписки доступно только администратору.',
      });
      return;
    }
    const { enabled } = req.body as { enabled?: boolean };
    const nextActive = typeof enabled === 'boolean' ? enabled : !user.subscription.active;

    if (nextActive) {
      user.subscription.tier = 'paid';
      user.subscription.active = true;
      user.subscription.planId = '12m';
      user.subscription.planLabel = 'Система+ · Личный доступ';
      user.subscription.priceStars = 0;
      user.subscription.periodDays = 365;
      user.subscription.autoRenew = false;
      user.subscription.paymentCheckStatus = 'completed';
      user.subscription.expiresAtLabel = 'Включено в настройках';
      user.shieldChargesRemaining = Math.max(user.shieldChargesRemaining || 0, 2);
    } else {
      user.subscription.tier = 'free';
      user.subscription.active = false;
      user.subscription.planId = undefined;
      user.subscription.planLabel = 'Бесплатно';
      user.subscription.priceStars = 99;
      user.subscription.periodDays = 30;
      user.subscription.autoRenew = false;
      user.subscription.paymentCheckStatus = 'idle';
      user.subscription.expiresAtLabel = '';
      user.shieldChargesRemaining = 0;
      if (user.hudTheme && user.hudTheme !== 'blue') {
        user.hudTheme = 'blue';
      }
      // Enforce Free tier 3/3 active limit cleanly by archiving overflow
      let seenGoals = 0;
      for (const g of user.goals) {
        if (g.status === 'active') {
          seenGoals += 1;
          if (seenGoals > 3) g.status = 'archived';
        }
      }
      let seenHabits = 0;
      for (const h of user.habits) {
        if (h.status === 'active') {
          seenHabits += 1;
          if (seenHabits > 3) h.status = 'archived';
        }
      }
      let seenAccounts = 0;
      for (const a of user.accounts) {
        if (a.status === 'active') {
          seenAccounts += 1;
          if (seenAccounts > 3) a.status = 'archived';
        }
      }
      recomputeAccountTotals(user);
    }

    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/subscription/create-invoice', async (req, res) => {
    const { planId, telegramId } = req.body as { planId?: SubscriptionPlanId; telegramId?: string };
    const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId) || SUBSCRIPTION_PLANS[0];
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token || token.includes('PLACEHOLDER')) {
      res.json({ ok: true, fallbackDemo: true, plan });
      return;
    }

    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${token}/createInvoiceLink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Система+ (${plan.title})`,
          description: `Безлимит целей, привычек, счетов, автопилот и аналитика на ${plan.days} дней`,
          payload: JSON.stringify({ planId: plan.id, telegramId: telegramId || 'unknown' }),
          provider_token: '',
          currency: 'XTR',
          prices: [{ label: `Система+ · ${plan.title}`, amount: plan.stars }],
        }),
      });
      const tgJson = (await tgRes.json()) as { ok: boolean; result?: string; description?: string };
      if (tgJson.ok && tgJson.result) {
        res.json({ ok: true, invoiceUrl: tgJson.result, fallbackDemo: false, plan });
      } else {
        res.json({ ok: true, fallbackDemo: true, plan, warning: tgJson.description });
      }
    } catch {
      res.json({ ok: true, fallbackDemo: true, plan });
    }
  });

  app.post('/api/subscription/subscribe', async (req, res) => {
    const user = getUser(req);
    const { chargeId, planId } = req.body as { chargeId?: string; planId?: SubscriptionPlanId };
    const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId) || SUBSCRIPTION_PLANS[0];
    const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const hasRealBotToken = Boolean(token && token !== 'YOUR_TELEGRAM_BOT_TOKEN_PLACEHOLDER');

    if (process.env.NODE_ENV === 'production' && hasRealBotToken && !isTrustedAdminOrDev(req, user)) {
      const alreadyVerifiedByWebhook = Boolean(chargeId && store.processedChargeIds[chargeId]);
      if (!alreadyVerifiedByWebhook) {
        res.status(402).json({
          ok: false,
          code: 'PAYMENT_VERIFICATION_PENDING',
          message: 'Ожидается подтверждение оплаты Telegram Stars от сервера Telegram.',
          user,
        });
        return;
      }
    }

    const effectiveChargeId = chargeId || `xtr_charge_${user.userId}_${Date.now()}`;
    if (!store.processedChargeIds[effectiveChargeId] || !user.subscription.active) {
      store.processedChargeIds[effectiveChargeId] = true;
      user.subscription.tier = 'paid';
      user.subscription.active = true;
      user.subscription.planId = plan.id;
      user.subscription.planLabel = plan.title;
      user.subscription.priceStars = plan.stars;
      user.subscription.periodDays = plan.days;
      user.subscription.autoRenew = true;
      user.subscription.paymentCheckStatus = 'completed';
      user.subscription.expiresAtLabel = `Через ${plan.days} дней`;
      user.shieldChargesRemaining = Math.max(user.shieldChargesRemaining || 0, 2);
      saveStore(store);

      const adminId = process.env.ADMIN_TELEGRAM_ID;
      if (hasRealBotToken && adminId) {
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: adminId,
            text: `⭐ Новая подписка Система+ (${plan.title} · ${plan.stars} Stars)\nИгрок: ${user.playerCallsign || 'Игрок'} (ID: ${user.telegramId})`,
          }),
        }).catch(() => {});
      }
    }
    res.json({ ok: true, user });
  });

  app.post('/api/subscription/toggle-autorenew', (req, res) => {
    const user = getUser(req);
    user.subscription.autoRenew = !user.subscription.autoRenew;
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/referrals/activate', (req, res) => {
    const user = getUser(req);
    if (user.subscription.referralBonusDaysAvailable < 3) {
      res.status(400).json({ ok: false, code: 'NO_BONUS_DAYS', message: 'Нет накопленных бонусных дней для активации' });
      return;
    }
    user.subscription.referralBonusDaysAvailable -= 3;
    user.subscription.tier = 'bonus';
    user.subscription.active = true;
    user.subscription.autoRenew = false;
    user.subscription.referralBonusActiveRemaining = '3 дня активны';
    user.shieldChargesRemaining = Math.max(user.shieldChargesRemaining || 0, 1);
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/referrals/schedule-after-paid', (req, res) => {
    const user = getUser(req);
    user.subscription.autoRenew = false;
    user.subscription.referralScheduledAfterPaid = true;
    saveStore(store);
    res.json({ ok: true, user });
  });

  app.post('/api/telegram/webhook', async (req, res) => {
    const update = req.body || {};
    const message = update.message;
    const preCheckout = update.pre_checkout_query;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const appUrl = process.env.APP_URL || 'https://your-miniapp-domain.example.com';

    if (preCheckout && token && !token.includes('PLACEHOLDER')) {
      await fetch(`https://api.telegram.org/bot${token}/answerPreCheckoutQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pre_checkout_query_id: preCheckout.id, ok: true }),
      }).catch(() => {});
      res.json({ ok: true });
      return;
    }

    if (message?.successful_payment) {
      const payment = message.successful_payment;
      const chargeId = String(payment.telegram_payment_charge_id || `wh_${Date.now()}`);
      store.processedChargeIds[chargeId] = true;
      let planId: SubscriptionPlanId = '1m';
      let tgId = String(message.from?.id || '');
      try {
        const parsed = JSON.parse(payment.invoice_payload || '{}');
        if (parsed.planId) planId = parsed.planId;
        if (parsed.telegramId && parsed.telegramId !== 'unknown') tgId = String(parsed.telegramId);
      } catch {
        const parts = String(payment.invoice_payload || '').split(':');
        if (parts[1] === '1m' || parts[1] === '3m' || parts[1] === '12m') planId = parts[1];
      }
      if (tgId) {
        const uKey = `tg_${tgId}`;
        if (!store.users[uKey]) store.users[uKey] = createNewUserState(uKey, tgId);
        const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId) || SUBSCRIPTION_PLANS[0];
        const target = store.users[uKey];
        target.subscription.tier = 'paid';
        target.subscription.active = true;
        target.subscription.planId = plan.id;
        target.subscription.planLabel = plan.title;
        target.subscription.priceStars = plan.stars;
        target.subscription.periodDays = plan.days;
        target.subscription.paymentCheckStatus = 'completed';
        target.subscription.expiresAtLabel = `Через ${plan.days} дней`;
        target.shieldChargesRemaining = Math.max(target.shieldChargesRemaining || 0, 2);
      }
      saveStore(store);

      const adminId = process.env.ADMIN_TELEGRAM_ID;
      if (token && !token.includes('PLACEHOLDER') && adminId) {
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: adminId,
            text: `💫 Оплата Telegram Stars получена: ${payment.total_amount} XTR от ${message.from?.id}`,
          }),
        }).catch(() => {});
      }
      res.json({ ok: true });
      return;
    }

    if (message?.text?.startsWith('/start')) {
      const inviteeId = String(message.from?.id || '');
      const payload = message.text.slice('/start'.length).trim();
      if (payload.startsWith('ref_') && inviteeId) {
        const inviterRaw = payload.slice(4).trim();
        const inviterTgId = inviterRaw.startsWith('sys_') ? inviterRaw.slice(4) : inviterRaw;
        if (inviterTgId && inviterTgId !== inviteeId && !store.referralLedger[inviteeId]) {
          const inviterUser =
            Object.values(store.users).find(
              (u) => u.telegramId === inviterTgId || u.subscription.referralCode === payload
            ) || store.users[`tg_${inviterTgId}`];
          if (inviterUser) {
            inviterUser.subscription.referralBonusDaysAvailable =
              (inviterUser.subscription.referralBonusDaysAvailable || 0) + 3;
            store.referralLedger[inviteeId] = {
              inviterId: inviterUser.userId,
              inviteeTelegramId: inviteeId,
              creditedAt: new Date().toISOString(),
            };
            saveStore(store);
          }
        }
      }
      res.json({
        method: 'sendMessage',
        chat_id: message.chat?.id,
        text: '⚔️ Система пробуждена. Нажмите кнопку ниже, чтобы открыть интерфейс Игрока.',
        reply_markup: {
          inline_keyboard: [[{ text: 'Открыть Систему', web_app: { url: appUrl } }]],
        },
      });
      return;
    }
    res.json({ ok: true });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Система (Bot + Mini App Server) running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
