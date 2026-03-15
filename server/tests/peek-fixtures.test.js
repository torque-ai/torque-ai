'use strict';

const { validatePeekInvestigationBundleEnvelope } = require('../contracts/peek');
const {
  ELECTRON_FIXTURE,
  FIXTURE_CATALOG,
  QT_FIXTURE,
  WIN32_FIXTURE,
  WINFORMS_FIXTURE,
  WPF_FIXTURE,
} = require('../contracts/peek-fixtures');

const FIXTURES = [
  ['wpf', WPF_FIXTURE, 'wpf'],
  ['win32', WIN32_FIXTURE, 'win32'],
  ['electron', ELECTRON_FIXTURE, 'electron_webview'],
  ['winforms', WINFORMS_FIXTURE, 'winforms'],
  ['qt', QT_FIXTURE, 'qt'],
];

describe('peek fixture corpus', () => {
  it.each(FIXTURES)('validates the %s fixture against the investigation bundle contract', (_name, fixture) => {
    expect(validatePeekInvestigationBundleEnvelope(fixture)).toEqual([]);
  });

  it('pins the expected app_type value for each fixture', () => {
    expect(WPF_FIXTURE.app_type).toBe('wpf');
    expect(WIN32_FIXTURE.app_type).toBe('win32');
    expect(ELECTRON_FIXTURE.app_type).toBe('electron_webview');
    expect(WINFORMS_FIXTURE.app_type).toBe('winforms');
    expect(QT_FIXTURE.app_type).toBe('qt');
  });

  it('exports a five-entry fixture catalog with stable keys', () => {
    expect(Object.keys(FIXTURE_CATALOG)).toEqual(['wpf', 'win32', 'electron', 'winforms', 'qt']);
    expect(Object.keys(FIXTURE_CATALOG)).toHaveLength(5);
    expect(FIXTURE_CATALOG).toEqual({
      wpf: WPF_FIXTURE,
      win32: WIN32_FIXTURE,
      electron: ELECTRON_FIXTURE,
      winforms: WINFORMS_FIXTURE,
      qt: QT_FIXTURE,
    });
  });

  it.each(FIXTURES)('provides non-empty capture data and metadata for %s', (_name, fixture) => {
    expect(fixture.capture_data).toBeTruthy();
    expect(Object.keys(fixture.capture_data).length).toBeGreaterThan(0);
    expect(typeof fixture.capture_data.image_base64).toBe('string');
    expect(fixture.capture_data.image_base64.length).toBeGreaterThan(0);

    expect(fixture.metadata).toBeTruthy();
    expect(Object.keys(fixture.metadata).length).toBeGreaterThan(0);
    expect(typeof fixture.metadata.window_title).toBe('string');
    expect(fixture.metadata.window_title.length).toBeGreaterThan(0);
    expect(typeof fixture.metadata.process_name).toBe('string');
    expect(fixture.metadata.process_name.length).toBeGreaterThan(0);
  });

  it('includes the requested app-specific snapshot payloads', () => {
    expect(Object.keys(WPF_FIXTURE.visual_tree).length).toBeGreaterThan(0);
    expect(Object.keys(WPF_FIXTURE.property_bag).length).toBeGreaterThan(0);

    expect(Object.keys(WIN32_FIXTURE.hwnd_metadata).length).toBeGreaterThan(0);
    expect(WIN32_FIXTURE.class_name_chain.length).toBeGreaterThan(0);

    expect(Object.keys(ELECTRON_FIXTURE.devtools_protocol).length).toBeGreaterThan(0);
    expect(Object.keys(ELECTRON_FIXTURE.dom_snapshot).length).toBeGreaterThan(0);

    expect(Object.keys(WINFORMS_FIXTURE.component_model).length).toBeGreaterThan(0);

    expect(Object.keys(QT_FIXTURE.qt_object_tree).length).toBeGreaterThan(0);
  });
});
