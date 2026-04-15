import { afterEach, describe, expect, it, vi } from 'vitest';

import { PackageDistributionService } from '../src/package-distribution-service.js';

describe('PackageDistributionService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the original directory url when the basic view request drops the socket', async () => {
    const service = new PackageDistributionService();
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } }))
      .mockResolvedValueOnce(new Response(
        [
          '<html><body>',
          '<a href="game-release.apk">game-release.apk</a>',
          '<a href="symbols/">symbols/</a>',
          '</body></html>',
        ].join(''),
        {
          status: 200,
          headers: {
            'Content-Type': 'text/html;charset=UTF-8',
          },
        },
      ));
    vi.stubGlobal('fetch', fetchMock);

    const blocks = await service.fetchPreviewBlocks([
      'http://192.168.50.10:8003/%E5%8C%85%E4%BD%93/4399%E4%B8%BB%E5%B9%B2%E5%87%BA%E7%9A%84%E6%B5%8B%E8%AF%95/',
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://192.168.50.10:8003/%E5%8C%85%E4%BD%93/4399%E4%B8%BB%E5%B9%B2%E5%87%BA%E7%9A%84%E6%B5%8B%E8%AF%95/?get=basic',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://192.168.50.10:8003/%E5%8C%85%E4%BD%93/4399%E4%B8%BB%E5%B9%B2%E5%87%BA%E7%9A%84%E6%B5%8B%E8%AF%95/',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      sourceUrl: 'http://192.168.50.10:8003/%E5%8C%85%E4%BD%93/4399%E4%B8%BB%E5%B9%B2%E5%87%BA%E7%9A%84%E6%B5%8B%E8%AF%95/',
      fileCount: 1,
      directoryCount: 1,
      entries: [
        { entryType: 'file', name: 'game-release.apk' },
        { entryType: 'directory', name: 'symbols' },
      ],
    });
  });
});
