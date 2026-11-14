import { DataSource, Repository } from 'typeorm';
import { BaileysMediaRef } from './baileys-media-ref.entity';
import { BaileysMediaRefStoreService } from './baileys-media-ref-store.service';
import { Session, SessionStatus } from '../../modules/session/entities/session.entity';
import type { MediaRef } from '../types/baileys.types';

describe('BaileysMediaRefStoreService', () => {
  let ds: DataSource;
  let repo: Repository<BaileysMediaRef>;
  let service: BaileysMediaRefStoreService;

  const seedSession = async (id: string): Promise<void> => {
    await ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        id,
        name: `session-${id}`,
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
  };

  const ref = (id: string, over: Partial<MediaRef> = {}): MediaRef => ({
    waMessageId: id,
    chatId: '628111@c.us',
    fromMe: false,
    kind: 'image',
    mimetype: 'image/jpeg',
    fileLength: 1000,
    mediaKey: 'a2V5',
    directPath: `/v/${id}`,
    url: `https://mmg.whatsapp.net/v/${id}`,
    fileEncSha256: 'ZW5j',
    fileSha256: 'c2hh',
    mediaKeyTimestamp: 1_759_000_000,
    messageTimestamp: 1_760_000_000,
    ...over,
  });

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [BaileysMediaRef, Session],
      synchronize: true,
    });
    await ds.initialize();
    repo = ds.getRepository(BaileysMediaRef);
    service = new BaileysMediaRefStoreService(repo);
    await seedSession('s1');
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('keeps each reference as a pending row, with every field', async () => {
    expect(await service.putMany('s1', [ref('M1'), ref('M2', { kind: 'audio', fromMe: true })])).toBe(2);
    const rows = await repo.find({ order: { waMessageId: 'ASC' } });
    expect(rows.map(r => [r.waMessageId, r.kind, r.fromMe, r.status, r.attempts])).toEqual([
      ['M1', 'image', false, 'pending', 0],
      ['M2', 'audio', true, 'pending', 0],
    ]);
    expect(rows[0]).toMatchObject({
      sessionId: 's1',
      chatId: '628111@c.us',
      mimetype: 'image/jpeg',
      fileLength: 1000,
      mediaKey: 'a2V5',
      directPath: '/v/M1',
      messageTimestamp: 1_760_000_000,
    });
  });

  it('refreshes the key and path of a reference seen again, and leaves its download progress alone', async () => {
    await service.putMany('s1', [ref('M1')]);
    await repo.update(
      { waMessageId: 'M1' },
      { status: 'done', attempts: 3, lastAttemptAt: 1_760_000_500, lastError: 'earlier' },
    );

    await service.putMany('s1', [ref('M1', { directPath: '/v/fresh', mediaKey: 'bmV3' })]);

    const row = await repo.findOneByOrFail({ waMessageId: 'M1' });
    expect([row.directPath, row.mediaKey]).toEqual(['/v/fresh', 'bmV3']);
    expect([row.status, row.attempts, row.lastAttemptAt, row.lastError]).toEqual(['done', 3, 1_760_000_500, 'earlier']);
    expect(await repo.count()).toBe(1);
  });

  it('files the same message id once per session', async () => {
    await seedSession('s2');
    await service.putMany('s1', [ref('M1')]);
    await service.putMany('s2', [ref('M1')]);
    expect(await repo.count()).toBe(2);
  });

  it('keeps the first of two references to one message id in a batch', async () => {
    await service.putMany('s1', [ref('M1', { chatId: 'first@c.us' }), ref('M1', { chatId: 'second@lid' })]);
    expect((await repo.findOneByOrFail({ waMessageId: 'M1' })).chatId).toBe('first@c.us');
  });

  it('keeps a large batch, in chunks', async () => {
    const many = Array.from({ length: 450 }, (_, i) => ref(`M${i}`));
    expect(await service.putMany('s1', many)).toBe(450);
    expect(await repo.count()).toBe(450);
  });

  it('writes nothing for an empty batch', async () => {
    expect(await service.putMany('s1', [])).toBe(0);
    expect(await repo.count()).toBe(0);
  });

  it('does not throw when the session has no row (deleted mid-sync), and says so once', async () => {
    const warn = jest
      .spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    expect(await service.putMany('gone', [ref('M1')])).toBe(0);
    expect(await service.putMany('gone', [ref('M2')])).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await repo.count()).toBe(0);
  });

  it('does not throw on any other failure, and keeps going with the next chunk', async () => {
    const real = repo.upsert.bind(repo);
    let calls = 0;
    jest.spyOn(repo, 'upsert').mockImplementation((...args) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('disk is busy'));
      return real(...args);
    });
    const warn = jest
      .spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const many = Array.from({ length: 250 }, (_, i) => ref(`M${i}`));
    expect(await service.putMany('s1', many)).toBe(50); // the first chunk of 200 failed, the last 50 were kept
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk is busy'));
    expect(await repo.count()).toBe(50);
  });

  it('removes its rows with the session', async () => {
    await service.putMany('s1', [ref('M1')]);
    await ds.getRepository(Session).delete({ id: 's1' });
    expect(await repo.count()).toBe(0);
  });
});
