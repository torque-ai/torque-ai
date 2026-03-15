'use strict';

const {
  PEEK_CAPTURE_PROVIDERS,
  PEEK_PLATFORM_SUPPORT_MATRIX,
  getCaptureProvidersForPlatform,
  isPlatformSupported,
} = require('../contracts/peek');

describe('peek platform contracts', () => {
  it('defines a frozen provider catalog with implemented and planned capture backends', () => {
    expect(Object.keys(PEEK_CAPTURE_PROVIDERS)).toHaveLength(5);
    expect(Object.isFrozen(PEEK_CAPTURE_PROVIDERS)).toBe(true);

    expect(PEEK_CAPTURE_PROVIDERS.win32.status).toBe('implemented');
    expect(PEEK_CAPTURE_PROVIDERS.x11.status).toBe('planned');
    expect(PEEK_CAPTURE_PROVIDERS.wayland.status).toBe('planned');
    expect(PEEK_CAPTURE_PROVIDERS.macos.status).toBe('planned');
    expect(PEEK_CAPTURE_PROVIDERS.browser.status).toBe('planned');
  });

  it('defines platform support state and prerequisites for non-windows hosts', () => {
    expect(Object.keys(PEEK_PLATFORM_SUPPORT_MATRIX)).toHaveLength(3);

    expect(PEEK_PLATFORM_SUPPORT_MATRIX.windows.supported).toBe(true);
    expect(PEEK_PLATFORM_SUPPORT_MATRIX.linux).toMatchObject({
      supported: false,
      prerequisite: 'DS-06',
    });
    expect(PEEK_PLATFORM_SUPPORT_MATRIX.darwin).toMatchObject({
      supported: false,
      prerequisite: 'DS-06',
    });
  });

  it('returns the provider objects registered for each known platform', () => {
    expect(getCaptureProvidersForPlatform('windows').map((provider) => provider.name)).toEqual([
      'win32',
      'browser',
    ]);
    expect(getCaptureProvidersForPlatform('linux').map((provider) => provider.name)).toEqual([
      'x11',
      'wayland',
      'browser',
    ]);
    expect(getCaptureProvidersForPlatform('unknown')).toEqual([]);
  });

  it('reports whether a platform is currently supported in the delivery slice', () => {
    expect(isPlatformSupported('windows')).toBe(true);
    expect(isPlatformSupported('linux')).toBe(false);
    expect(isPlatformSupported('unknown')).toBe(false);
  });
});
