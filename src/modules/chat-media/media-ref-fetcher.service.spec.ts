import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../common/storage/storage.service';
import { BaileysMediaRef } from '../../engine/adapters/baileys-media-ref.entity';
import { EngineRegistry } from '../../engine/engine-registry.service';
import {
  EngineStatus,
  type IWhatsAppEngine,
  type MediaFetchOutcome,
} from '../../engine/interfaces/whatsapp-engine.interface';
import type { MediaRef } from '../../engine/types/baileys.types';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { ChatMediaArchiveService } from './chat-media-archive.service';
import { MediaRefFetcherService } from './media-ref-fetcher.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHAT = '85294970208@c.us';

const refSettings = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  intervalMs: 20_000,
  chats: '',
  maxAttempts: 3,
  timeoutMs: 5_000,
  retryBaseMs: 1_000,
  retryMaxMs: 8_000,
  historyEnabled: false,
  historyIntervalMs: 60_000,
  historyPageSize: 50,
  historyMaxPages: 5,
  historyWaitMs: 1_000,
  ...over,
});

describe('MediaRefFetcherService', () => {
  let baseDir: string;
  let ds: DataSource;
  let refs: Repository<BaileysMediaRef>;
  let messages: Repository<Message>;
  let storage: StorageService;

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-ref-fetch-'));
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, BaileysMediaRef, Session],
      synchronize: true,
    });
    await ds.initialize();
    refs = ds.getRepository(BaileysMediaRef);
    messages = ds.getRepository(Message);
    const cfg = {
      get: (k: string, d?: unknown) =>
        k === 'storage.type' ? 'local' : k === 'storage.localPath' ? path.join(baseDir, 'media') : d,
    };
    storage = new StorageService(cfg as unknown as ConfigService);
  });

  afterAll(async () => {
    await ds.destroy();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        id: 's1',
        name: 'one',
        status: SessionStatus.READY,
        phone: null,
        pushName: null,
        config: {},
        proxyUrl: null,
        proxyType: null,
        connectedAt: null,
        lastActiveAt: null,
      }),
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await refs.clear();
    await messages.clear();
    await ds.getRepository(Session).clear();
    for await (const f of storage.iterateFiles('')) await storage.deleteFile(f);
  });

  type Fetch = (ref: MediaRef, opts?: { maxBytes?: number; timeoutMs?: number }) => Promise<MediaFetchOutcome>;
  const ok: Fetch = () => Promise.resolve({ ok: true, bytes: PNG, mimetype: 'image/png' });

  function build(
    opts: { settings?: Record<string, unknown>; archive?: boolean; engine?: Partial<IWhatsAppEngine> | null } = {},
  ) {
    const values: Record<string, unknown> = {
      'chatMedia.archiveEnabled': opts.archive ?? true,
      'chatMedia.refFetch': refSettings(opts.settings),
    };
    const config = { get: (k: string, d?: unknown) => (k in values ? values[k] : d) } as unknown as ConfigService;
    const archive = new ChatMediaArchiveService(messages, storage, config);
    const registry = new EngineRegistry();
    const engine = {
      getStatus: () => EngineStatus.READY,
      fetchMediaByRef: jest.fn(ok),
      ...(opts.engine ?? {}),
    } as unknown as IWhatsAppEngine;
    if (opts.engine !== null) registry.set('s1', engine);
    const svc = new MediaRefFetcherService(refs, messages, archive, registry, config);
    return {
      svc,
      engine: engine as unknown as { fetchMediaByRef: jest.Mock; requestOlderHistory?: jest.Mock },
      registry,
    };
  }

  const addRef = (id: string, over: Partial<BaileysMediaRef> = {}) =>
    refs.save(
      refs.create({
        sessionId: 's1',
        waMessageId: id,
        chatId: CHAT,
        fromMe: false,
        kind: 'image',
        mimetype: 'image/jpeg',
        fileLength: 8,
        mediaKey: 'a2V5',
        directPath: `/v/${id}`,
        url: null,
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTimestamp: null,
        messageTimestamp: 1_000,
        status: 'pending',
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        ...over,
      }),
    );
  const addRow = (id: string, over: Partial<Message> = {}) =>
    messages.save(
      messages.create({
        sessionId: 's1',
        chatId: CHAT,
        waMessageId: id,
        from: CHAT,
        to: 'me@c.us',
        body: '',
        type: 'image',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.SENT,
        timestamp: 1_000,
        ...over,
      }),
    );
  const firstCall = (m: jest.Mock, n = 0): unknown[] => (m.mock.calls as unknown[][])[n];
  const ref = (id: string) => refs.findOneByOrFail({ waMessageId: id });

  describe('fetchTick', () => {
    it('does nothing while switched off', async () => {
      const { svc, engine } = build({ settings: { enabled: false } });
      await addRef('A');
      expect(await svc.fetchTick()).toEqual({ result: null });
      expect(engine.fetchMediaByRef).not.toHaveBeenCalled();
    });

    it('does nothing, and says why once, while the archive is off', async () => {
      const { svc, engine } = build({ archive: false });
      const warn = jest
        .spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      await addRef('A');
      await svc.fetchTick();
      await svc.fetchTick();
      expect(engine.fetchMediaByRef).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('fetches the file, stores it, points the message row at it and marks the reference done', async () => {
      const { svc, engine } = build();
      await addRef('A');
      const row = await addRow('A');
      expect((await svc.fetchTick()).result).toMatchObject({ waMessageId: 'A', outcome: 'done' });
      expect(engine.fetchMediaByRef).toHaveBeenCalledWith(
        expect.objectContaining({
          waMessageId: 'A',
          chatId: CHAT,
          kind: 'image',
          mediaKey: 'a2V5',
          directPath: '/v/A',
        }),
        expect.objectContaining({ timeoutMs: 5_000 }),
      );
      const stored = await messages.findOneByOrFail({ id: row.id });
      expect(stored.mediaMimetype).toBe('image/png');
      expect(await storage.getFile(stored.mediaPath!)).toEqual(PNG);
      expect(await ref('A')).toMatchObject({ status: 'done', attempts: 1, lastError: null });
    });

    it('takes the newest reference first', async () => {
      const { svc, engine } = build();
      await addRef('OLD', { messageTimestamp: 100 });
      await addRef('NEW', { messageTimestamp: 900 });
      await addRow('OLD');
      await addRow('NEW');
      await svc.fetchTick();
      expect((firstCall(engine.fetchMediaByRef)[0] as MediaRef).waMessageId).toBe('NEW');
    });

    it('only works on the chats it is told to', async () => {
      const { svc, engine } = build({ settings: { chats: CHAT } });
      await addRef('OTHER', { chatId: 'other@c.us', messageTimestamp: 9_999 });
      await addRef('MINE');
      await addRow('MINE');
      await svc.fetchTick();
      expect((firstCall(engine.fetchMediaByRef)[0] as MediaRef).waMessageId).toBe('MINE');
      expect((await svc.fetchTick()).result).toBeNull();
      expect((await ref('OTHER')).status).toBe('pending');
    });

    it('marks a reference whose file is gone as expired, and does not try it again', async () => {
      const { svc, engine } = build({
        engine: {
          fetchMediaByRef: jest.fn(() =>
            Promise.resolve({ ok: false, reason: 'expired', detail: 'NOT_FOUND' } as const),
          ),
        },
      });
      await addRef('A');
      await addRow('A');
      await svc.fetchTick();
      expect(await ref('A')).toMatchObject({ status: 'expired', lastError: 'NOT_FOUND' });
      expect((await svc.fetchTick()).result).toBeNull();
      expect(engine.fetchMediaByRef).toHaveBeenCalledTimes(1);
    });

    it('retries a phone that did not answer, but not before the backoff, and gives up after the attempts', async () => {
      const fetchMediaByRef = jest.fn(() =>
        Promise.resolve({ ok: false, reason: 'phone-unavailable', detail: 'no answer' } as const),
      );
      const { svc } = build({ engine: { fetchMediaByRef } });
      await addRef('A');
      await addRow('A');
      const t0 = 1_700_000_000_000; // a whole second: attempt times are stored in seconds
      await svc.fetchTick(t0);
      expect(await ref('A')).toMatchObject({ status: 'pending', attempts: 1 });
      expect((await svc.fetchTick(t0 + 999)).result).toBeNull(); // backoff after one attempt is 1 s
      await svc.fetchTick(t0 + 1_000);
      expect(await ref('A')).toMatchObject({ status: 'pending', attempts: 2 });
      expect((await svc.fetchTick(t0 + 1_000 + 1_999)).result).toBeNull(); // and 2 s after two
      await svc.fetchTick(t0 + 1_000 + 2_000);
      expect(await ref('A')).toMatchObject({ status: 'failed', attempts: 3 });
      expect(fetchMediaByRef).toHaveBeenCalledTimes(3);
    });

    it('tries a never-tried reference before a retry', async () => {
      const { svc, engine } = build();
      await addRef('RETRY', { attempts: 1, lastAttemptAt: 1, messageTimestamp: 9_000 });
      await addRef('FRESH', { messageTimestamp: 1 });
      await addRow('RETRY');
      await addRow('FRESH');
      await svc.fetchTick();
      expect((firstCall(engine.fetchMediaByRef)[0] as MediaRef).waMessageId).toBe('FRESH');
    });

    it('leaves a reference untouched when the engine has no connection', async () => {
      const { svc } = build({
        engine: {
          fetchMediaByRef: jest.fn(() =>
            Promise.resolve({ ok: false, reason: 'not-ready', detail: 'no connection' } as const),
          ),
        },
      });
      await addRef('A');
      await addRow('A');
      expect((await svc.fetchTick()).result).toMatchObject({ outcome: 'skipped' });
      expect(await ref('A')).toMatchObject({ status: 'pending', attempts: 0, lastAttemptAt: null });
    });

    it('does not download a file the message row already has', async () => {
      const { svc, engine } = build();
      await addRef('A');
      await addRow('A', { mediaPath: 'chat-media/s1/x.png', mediaMimetype: 'image/png' });
      await svc.fetchTick();
      expect(engine.fetchMediaByRef).not.toHaveBeenCalled();
      expect(await ref('A')).toMatchObject({ status: 'done' });
    });

    it('does not download for a message that has no row, and counts it as an attempt', async () => {
      const { svc, engine } = build();
      await addRef('A');
      await svc.fetchTick();
      expect(engine.fetchMediaByRef).not.toHaveBeenCalled();
      expect(await ref('A')).toMatchObject({ status: 'pending', attempts: 1, lastError: 'message row not found' });
    });

    it('fails a file the archive refuses as too large, for good', async () => {
      const { svc } = build();
      jest.spyOn(svc['archive'], 'archiveFetched').mockResolvedValue({ status: 'too-large' });
      await addRef('A');
      await addRow('A');
      await svc.fetchTick();
      expect(await ref('A')).toMatchObject({ status: 'failed', lastError: 'over the archive size cap' });
    });

    it('skips an engine that cannot fetch, or is not ready', async () => {
      const a = build({ engine: { fetchMediaByRef: undefined } });
      await addRef('A');
      await addRow('A');
      expect((await a.svc.fetchTick()).result).toBeNull();
      const b = build({ engine: { getStatus: () => EngineStatus.DISCONNECTED } });
      expect((await b.svc.fetchTick()).result).toBeNull();
      expect(b.engine.fetchMediaByRef).not.toHaveBeenCalled();
    });
  });

  describe('historyTick', () => {
    const anchorOf = (id: string, timestamp: number, fromMe = false) => ({ id, fromMe, timestamp });
    const answered = (messages: number, oldest: ReturnType<typeof anchorOf> | null) =>
      Promise.resolve({ requestId: 'r', answered: true, messages, oldest });
    const withHistory = (
      over: Record<string, unknown> = {},
      requestOlderHistory: jest.Mock = jest.fn(() => answered(0, null)),
    ) => build({ settings: { historyEnabled: true, chats: CHAT, ...over }, engine: { requestOlderHistory } });
    const quiet = (svc: MediaRefFetcherService) =>
      jest
        .spyOn((svc as unknown as { logger: { log: (m: string) => void } }).logger, 'log')
        .mockImplementation(() => undefined);

    it('does nothing while off, or with no chats listed', async () => {
      const off = build({ settings: { chats: CHAT }, engine: { requestOlderHistory: jest.fn() } });
      await addRow('A');
      expect(await off.svc.historyTick()).toEqual([]);
      const none = withHistory({ chats: '' });
      expect(await none.svc.historyTick()).toEqual([]);
    });

    it('starts at the newest message held, saying who sent it, and waits for the answer', async () => {
      const { svc, engine } = withHistory();
      quiet(svc);
      await addRow('OLD', { timestamp: 500 });
      await addRow('NEWEST', { timestamp: 2_000, direction: MessageDirection.OUTGOING });
      await svc.historyTick();
      expect(engine.requestOlderHistory).toHaveBeenCalledWith(
        CHAT,
        { id: 'NEWEST', fromMe: true, timestamp: 2_000 },
        50,
        { waitMs: 1_000 },
      );
    });

    it('carries on from the oldest message of each answer, which may already be held', async () => {
      const requestOlderHistory = jest
        .fn()
        .mockImplementationOnce(() => answered(50, anchorOf('MID', 1_000)))
        .mockImplementationOnce(() => answered(50, anchorOf('FAR', 100)))
        .mockImplementation(() => answered(0, null));
      const { svc } = withHistory({}, requestOlderHistory);
      quiet(svc);
      await addRow('NEWEST', { timestamp: 2_000 });
      expect(await svc.historyTick()).toEqual([{ chatId: CHAT, action: 'answered' }]);
      await svc.historyTick();
      await svc.historyTick();
      expect(requestOlderHistory.mock.calls.map(c => (c as unknown[][])[1])).toEqual([
        expect.objectContaining({ id: 'NEWEST' }),
        expect.objectContaining({ id: 'MID' }),
        expect.objectContaining({ id: 'FAR' }),
      ]);
    });

    it('stops for a chat on an answer with nothing older, and asks no more', async () => {
      const { svc, engine } = withHistory();
      quiet(svc);
      await addRow('A', { timestamp: 500 });
      expect(await svc.historyTick()).toEqual([{ chatId: CHAT, action: 'done' }]);
      expect(await svc.historyTick()).toEqual([{ chatId: CHAT, action: 'skip' }]);
      expect(engine.requestOlderHistory).toHaveBeenCalledTimes(1);
    });

    it('asks again from the same message when the phone did not answer, then gives up', async () => {
      const requestOlderHistory = jest.fn(() =>
        Promise.resolve({ requestId: 'r', answered: false, messages: 0, oldest: null }),
      );
      const { svc } = withHistory({}, requestOlderHistory);
      quiet(svc);
      await addRow('A', { timestamp: 500 });
      expect(await svc.historyTick()).toEqual([{ chatId: CHAT, action: 'unanswered' }]);
      expect(await svc.historyTick()).toEqual([{ chatId: CHAT, action: 'done' }]);
      expect(await svc.historyTick()).toEqual([{ chatId: CHAT, action: 'skip' }]);
      expect(requestOlderHistory).toHaveBeenCalledTimes(2);
    });

    it('leaves the walk in place and tries again when the request could not be sent', async () => {
      const requestOlderHistory = jest
        .fn()
        .mockRejectedValueOnce(new Error('not connected'))
        .mockImplementation(() => answered(5, anchorOf('B', 1)));
      const { svc } = withHistory({}, requestOlderHistory);
      quiet(svc);
      jest
        .spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      await addRow('A', { timestamp: 500 });
      expect(await svc.historyTick()).toEqual([{ chatId: CHAT, action: 'failed' }]);
      expect(await svc.historyTick()).toEqual([{ chatId: CHAT, action: 'answered' }]);
    });

    it('asks for one chat per pass', async () => {
      const requestOlderHistory = jest.fn(() => answered(5, anchorOf('X', 1)));
      const { svc } = withHistory({ chats: `${CHAT},628111@c.us` }, requestOlderHistory);
      quiet(svc);
      await addRow('A', { timestamp: 500 });
      await addRow('B', { timestamp: 500, chatId: '628111@c.us' });
      expect(await svc.historyTick()).toHaveLength(1);
      expect(requestOlderHistory).toHaveBeenCalledTimes(1);
    });

    it('does not ask for a chat with no messages to start from, and does not give up after one empty read', async () => {
      const { svc, engine } = withHistory();
      quiet(svc);
      jest
        .spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      expect(await svc.historyTick()).toEqual([{ chatId: CHAT, action: 'no-anchor' }]);
      expect(engine.requestOlderHistory).not.toHaveBeenCalled();
    });

    it('gives up only after several empty reads in a row, and a message found in between resets the count', async () => {
      const { svc, engine } = withHistory(
        {},
        jest.fn(() => answered(0, null)),
      );
      quiet(svc);
      jest
        .spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      for (let i = 0; i < 4; i++) expect((await svc.historyTick())[0].action).toBe('no-anchor');
      await addRow('LATE', { timestamp: 500 });
      expect((await svc.historyTick())[0].action).toBe('done');
      expect(engine.requestOlderHistory).toHaveBeenCalledTimes(1);
    });
  });
});
