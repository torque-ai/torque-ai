'use strict';

const { detectVisualSurfaces, loadManifest, findUnregistered } = require('../hooks/manifest-patterns');

describe('manifest-patterns', () => {
  describe('detectVisualSurfaces', () => {
    it('detects WPF Window XAML files', () => {
      const files = ['src/Views/BudgetPage.xaml'];
      const contents = { 'src/Views/BudgetPage.xaml': '<Window x:Class="App.Views.BudgetPage">' };
      const result = detectVisualSurfaces(files, contents, 'wpf');
      expect(result).toEqual([
        { file: 'src/Views/BudgetPage.xaml', type: 'Window', id: 'BudgetPage' }
      ]);
    });

    it('detects WPF Page XAML files', () => {
      const files = ['src/Views/SettingsPage.xaml'];
      const contents = { 'src/Views/SettingsPage.xaml': '<Page x:Class="App.Views.SettingsPage">' };
      const result = detectVisualSurfaces(files, contents, 'wpf');
      expect(result).toEqual([
        { file: 'src/Views/SettingsPage.xaml', type: 'Page', id: 'SettingsPage' }
      ]);
    });

    it('detects WPF UserControl XAML files', () => {
      const files = ['src/Controls/FilterPanel.xaml'];
      const contents = { 'src/Controls/FilterPanel.xaml': '<UserControl x:Class="App.Controls.FilterPanel">' };
      const result = detectVisualSurfaces(files, contents, 'wpf');
      expect(result).toEqual([
        { file: 'src/Controls/FilterPanel.xaml', type: 'UserControl', id: 'FilterPanel' }
      ]);
    });

    it('detects React page files', () => {
      const files = ['pages/budget.tsx', 'app/settings/page.tsx'];
      const result = detectVisualSurfaces(files, {}, 'react');
      expect(result).toEqual([
        { file: 'pages/budget.tsx', type: 'page', id: 'budget' },
        { file: 'app/settings/page.tsx', type: 'page', id: 'settings' }
      ]);
    });

    it('detects Electron BrowserWindow creation', () => {
      const files = ['src/windows/preferences.js'];
      const contents = { 'src/windows/preferences.js': 'const win = new BrowserWindow({ width: 800 })' };
      const result = detectVisualSurfaces(files, contents, 'electron');
      expect(result).toEqual([
        { file: 'src/windows/preferences.js', type: 'BrowserWindow', id: 'preferences' }
      ]);
    });

    it('returns empty array for non-visual files', () => {
      const files = ['src/utils/math.js'];
      const contents = { 'src/utils/math.js': 'module.exports = { add: (a, b) => a + b }' };
      const result = detectVisualSurfaces(files, contents, 'react');
      expect(result).toEqual([]);
    });
  });

  describe('loadManifest', () => {
    it('returns null for missing manifest', () => {
      const result = loadManifest('/nonexistent/path');
      expect(result).toBeNull();
    });
  });

  describe('findUnregistered', () => {
    it('identifies surfaces not in manifest sections', () => {
      const surfaces = [
        { file: 'src/Views/BudgetPage.xaml', type: 'Window', id: 'BudgetPage' },
        { file: 'src/Views/Dashboard.xaml', type: 'Window', id: 'Dashboard' }
      ];
      const manifest = {
        sections: [
          { id: 'dashboard', label: 'Dashboard' }
        ]
      };
      const result = findUnregistered(surfaces, manifest);
      expect(result).toEqual([
        { file: 'src/Views/BudgetPage.xaml', type: 'Window', id: 'BudgetPage' }
      ]);
    });

    it('returns all surfaces when manifest is null', () => {
      const surfaces = [{ file: 'src/Views/X.xaml', type: 'Window', id: 'X' }];
      const result = findUnregistered(surfaces, null);
      expect(result).toEqual(surfaces);
    });
  });
});
