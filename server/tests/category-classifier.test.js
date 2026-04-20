'use strict';
const { classify, getCategories, CATEGORIES } = require('../routing/category-classifier');

describe('category-classifier', () => {
  describe('classify()', () => {
    it('classifies security tasks', () => {
      expect(classify('Fix the SQL injection vulnerability in auth module')).toBe('security');
      expect(classify('Add encryption to credential storage')).toBe('security');
      expect(classify('Audit for XSS and CSRF vulnerabilities')).toBe('security');
    });

    it('classifies XAML/WPF tasks', () => {
      expect(classify('Fix the layout in MainWindow.xaml')).toBe('xaml_wpf');
      expect(classify('Update WPF styles for dark theme', ['App.xaml'])).toBe('xaml_wpf');
      expect(classify('Build MAUI page for settings')).toBe('xaml_wpf');
    });

    it('classifies architectural tasks', () => {
      expect(classify('Refactor the multi-module dependency graph')).toBe('architectural');
      expect(classify('Design the migration strategy for v3')).toBe('architectural');
    });

    it('classifies reasoning tasks', () => {
      expect(classify('Analyze the root cause of the memory leak')).toBe('reasoning');
      expect(classify('Debug complex race condition in scheduler')).toBe('reasoning');
      expect(classify('Review the entire authentication flow')).toBe('reasoning');
      expect(classify('Reasoning through the scheduler deadlock')).toBe('reasoning');
      expect(classify('Reasoned diagnosis of the cache regression')).toBe('reasoning');
    });

    it('classifies large code gen tasks', () => {
      expect(classify('Implement the notification system from scratch')).toBe('large_code_gen');
      expect(classify('Build a feature for user profile management')).toBe('large_code_gen');
      expect(classify('Create a module for data export')).toBe('large_code_gen');
    });

    it('classifies documentation tasks', () => {
      expect(classify('Document the API endpoints')).toBe('documentation');
      expect(classify('Write a README for the project')).toBe('documentation');
      expect(classify('Add JSDoc comments to utils.js')).toBe('documentation');
    });

    it('classifies simple generation tasks', () => {
      expect(classify('Generate a commit message for the changes')).toBe('simple_generation');
      expect(classify('Scaffold the boilerplate for a new service')).toBe('simple_generation');
    });

    it('classifies targeted file edit tasks', () => {
      expect(classify('Add JSDoc to the getUser function in src/users.ts')).toBe('targeted_file_edit');
      expect(classify('Fix the import statement in utils/helpers.js')).toBe('targeted_file_edit');
    });

    it('returns default for unmatched tasks', () => {
      expect(classify('Do something')).toBe('default');
      expect(classify('')).toBe('default');
      expect(classify(null)).toBe('default');
    });

    it('respects priority — security wins over documentation', () => {
      expect(classify('Document the security audit results')).toBe('security');
    });

    it('respects priority — XAML wins via file extension', () => {
      expect(classify('Update the styles', ['Theme.xaml'])).toBe('xaml_wpf');
    });
  });

  describe('getCategories()', () => {
    it('returns all categories with metadata', () => {
      const cats = getCategories();
      expect(cats).toHaveLength(CATEGORIES.length);
      expect(cats.map(c => c.key)).toEqual(CATEGORIES);
      for (const cat of cats) {
        expect(cat).toHaveProperty('key');
        expect(cat).toHaveProperty('displayName');
        expect(cat).toHaveProperty('description');
      }
    });
  });
});
