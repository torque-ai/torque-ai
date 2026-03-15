'use strict';

const {
  buildTaskFilterConditions,
  appendWhereClause,
  MAX_TAGS,
  MAX_TAG_LENGTH,
} = require('../db/query-filters');

describe('server/db/query-filters.js', () => {
  describe('buildTaskFilterConditions', () => {
    const escapeLikePattern = vi.fn((v) => `escaped:${v}`);

    beforeEach(() => {
      escapeLikePattern.mockClear();
    });

    it('defaults to archived = 0 when options are empty', () => {
      const { conditions, values } = buildTaskFilterConditions({}, escapeLikePattern);
      expect(conditions).toEqual(['archived = 0']);
      expect(values).toEqual([]);
      expect(escapeLikePattern).not.toHaveBeenCalled();
    });

    it('adds archived = 1 when archivedOnly is true', () => {
      const { conditions } = buildTaskFilterConditions({ archivedOnly: true }, escapeLikePattern);
      expect(conditions).toContain('archived = 1');
      expect(conditions).not.toContain('archived = 0');
    });

    it('skips archived filter when includeArchived is true', () => {
      const { conditions } = buildTaskFilterConditions({ includeArchived: true }, escapeLikePattern);
      expect(conditions).toEqual([]);
    });

    it('filters by project', () => {
      const { conditions, values } = buildTaskFilterConditions({ project: 'myproj' }, escapeLikePattern);
      expect(conditions).toContain('project = ?');
      expect(values).toContain('myproj');
    });

    it('filters by workingDirectory', () => {
      const { conditions, values } = buildTaskFilterConditions({ workingDirectory: '/tmp/work' }, escapeLikePattern);
      expect(conditions).toContain('working_directory = ?');
      expect(values).toContain('/tmp/work');
    });

    it('filters by single status', () => {
      const { conditions, values } = buildTaskFilterConditions({ status: 'running' }, escapeLikePattern);
      expect(conditions).toContain('status = ?');
      expect(values).toContain('running');
    });

    it('filters by multiple statuses with IN clause', () => {
      const { conditions, values } = buildTaskFilterConditions(
        { statuses: ['queued', 'running', 'completed'] },
        escapeLikePattern,
      );
      expect(conditions).toContain('status IN (?, ?, ?)');
      expect(values).toEqual(expect.arrayContaining(['queued', 'running', 'completed']));
    });

    it('filters by provider', () => {
      const { conditions, values } = buildTaskFilterConditions({ provider: 'codex' }, escapeLikePattern);
      expect(conditions).toContain('provider = ?');
      expect(values).toContain('codex');
    });

    it('filters by project_id with subquery', () => {
      const { conditions, values } = buildTaskFilterConditions({ project_id: 'pid-1' }, escapeLikePattern);
      expect(conditions).toContain('id IN (SELECT task_id FROM plan_project_tasks WHERE project_id = ?)');
      expect(values).toContain('pid-1');
    });

    it('filters by date range (created_at)', () => {
      const { conditions, values } = buildTaskFilterConditions(
        { from_date: '2026-01-01', to_date: '2026-02-01' },
        escapeLikePattern,
      );
      expect(conditions).toContain('created_at >= ?');
      expect(conditions).toContain('created_at < ?');
      expect(values).toContain('2026-01-01');
      expect(values).toContain('2026-02-01');
    });

    it('filters by date range (completed_at)', () => {
      const { conditions, values } = buildTaskFilterConditions(
        { completed_from: '2026-01-02', completed_to: '2026-01-03' },
        escapeLikePattern,
      );
      expect(conditions).toContain('completed_at >= ?');
      expect(conditions).toContain('completed_at < ?');
      expect(values).toContain('2026-01-02');
      expect(values).toContain('2026-01-03');
    });

    it('filters by search with LIKE and ESCAPE', () => {
      const { conditions, values } = buildTaskFilterConditions(
        { search: 'implement feature' },
        escapeLikePattern,
      );
      expect(conditions).toContain("task_description LIKE ? ESCAPE '\\'");
      expect(values).toContain('%escaped:implement feature%');
      expect(escapeLikePattern).toHaveBeenCalledWith('implement feature');
    });

    it('filters by single tag with LIKE and ESCAPE', () => {
      const { conditions, values } = buildTaskFilterConditions(
        { tag: 'backend' },
        escapeLikePattern,
      );
      expect(conditions).toContain("tags LIKE ? ESCAPE '\\'");
      expect(values).toContain('%"escaped:backend"%');
      expect(escapeLikePattern).toHaveBeenCalledWith('backend');
    });

    it('filters by multiple tags with OR', () => {
      const { conditions, values } = buildTaskFilterConditions(
        { includeArchived: true, tags: ['backend', 'frontend'] },
        escapeLikePattern,
      );
      expect(conditions).toHaveLength(1);
      expect(conditions[0]).toBe("(tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
      expect(values).toEqual(['%"escaped:backend"%', '%"escaped:frontend"%']);
      expect(escapeLikePattern).toHaveBeenCalledWith('backend');
      expect(escapeLikePattern).toHaveBeenCalledWith('frontend');
      expect(escapeLikePattern).toHaveBeenCalledTimes(2);
    });

    it('enforces MAX_TAGS limit', () => {
      const tags = Array.from({ length: MAX_TAGS + 5 }, (_, i) => `tag-${i}`);
      const { values } = buildTaskFilterConditions({ tags }, escapeLikePattern);
      expect(values).toHaveLength(MAX_TAGS);
      expect(escapeLikePattern).toHaveBeenCalledTimes(MAX_TAGS);
    });

    it('ignores tags beyond MAX_TAG_LENGTH', () => {
      const longTag = 'x'.repeat(MAX_TAG_LENGTH + 1);
      const validTag = 'ok';
      const { conditions, values } = buildTaskFilterConditions(
        { includeArchived: true, tags: [longTag, validTag] },
        escapeLikePattern,
      );
      // longTag filtered out before escaping
      expect(conditions).toHaveLength(1);
      expect(conditions[0]).toBe("(tags LIKE ? ESCAPE '\\')");
      expect(values).toEqual(['%"escaped:ok"%']);
      expect(escapeLikePattern).toHaveBeenCalledTimes(1);
      expect(escapeLikePattern).toHaveBeenCalledWith('ok');
    });

    it('ignores non-string and empty tags', () => {
      const { conditions, values } = buildTaskFilterConditions(
        { includeArchived: true, tags: [12, null, undefined, {}, '', 'valid', 'extra', false] },
        escapeLikePattern,
      );
      // Only 'valid' and 'extra' pass the filter
      expect(conditions).toHaveLength(1);
      expect(conditions[0]).toBe("(tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
      expect(values).toEqual(['%"escaped:valid"%', '%"escaped:extra"%']);
      expect(escapeLikePattern).toHaveBeenCalledTimes(2);
    });

    it('returns no tag condition when all tags are invalid', () => {
      const { conditions, values } = buildTaskFilterConditions(
        { includeArchived: true, tags: [42, null, ''] },
        escapeLikePattern,
      );
      expect(conditions).toEqual([]);
      expect(values).toEqual([]);
    });

    it('ignores single tag beyond MAX_TAG_LENGTH', () => {
      const { conditions } = buildTaskFilterConditions(
        { includeArchived: true, tag: 'x'.repeat(MAX_TAG_LENGTH + 1) },
        escapeLikePattern,
      );
      expect(conditions).toEqual([]);
    });

    it('ignores empty single tag', () => {
      const { conditions } = buildTaskFilterConditions({ includeArchived: true, tag: '' }, escapeLikePattern);
      expect(conditions).toEqual([]);
    });

    it('ignores non-string single tag', () => {
      const { conditions } = buildTaskFilterConditions({ includeArchived: true, tag: 42 }, escapeLikePattern);
      expect(conditions).toEqual([]);
    });

    it('ignores empty search string', () => {
      const { conditions } = buildTaskFilterConditions({ includeArchived: true, search: '' }, escapeLikePattern);
      expect(conditions).toEqual([]);
    });

    it('ignores non-string search', () => {
      const { conditions } = buildTaskFilterConditions({ includeArchived: true, search: 123 }, escapeLikePattern);
      expect(conditions).toEqual([]);
    });

    it('builds all filters together', () => {
      const options = {
        archivedOnly: true,
        project: 'proj',
        workingDirectory: '/dir',
        status: 'running',
        statuses: ['queued', 'running'],
        tags: ['t1', 't2'],
        tag: 'single',
        provider: 'codex',
        project_id: 'pid',
        from_date: '2026-01-01',
        to_date: '2026-02-01',
        completed_from: '2026-01-05',
        completed_to: '2026-01-10',
        search: 'keyword',
      };

      const { conditions, values } = buildTaskFilterConditions(options, escapeLikePattern);

      expect(conditions).toEqual([
        'archived = 1',
        'project = ?',
        'working_directory = ?',
        'status = ?',
        'status IN (?, ?)',
        "(tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')",
        "tags LIKE ? ESCAPE '\\'",
        'provider = ?',
        'id IN (SELECT task_id FROM plan_project_tasks WHERE project_id = ?)',
        'created_at >= ?',
        'created_at < ?',
        'completed_at >= ?',
        'completed_at < ?',
        "task_description LIKE ? ESCAPE '\\'",
      ]);

      expect(values).toEqual([
        'proj',
        '/dir',
        'running',
        'queued', 'running',
        '%"escaped:t1"%', '%"escaped:t2"%',
        '%"escaped:single"%',
        'codex',
        'pid',
        '2026-01-01',
        '2026-02-01',
        '2026-01-05',
        '2026-01-10',
        '%escaped:keyword%',
      ]);
    });
  });

  describe('appendWhereClause', () => {
    it('returns original query when no conditions exist', () => {
      expect(appendWhereClause('SELECT * FROM tasks', [])).toBe('SELECT * FROM tasks');
    });

    it('appends WHERE clause with single condition', () => {
      expect(appendWhereClause('SELECT * FROM tasks', ['status = ?']))
        .toBe('SELECT * FROM tasks WHERE status = ?');
    });

    it('joins multiple conditions with AND', () => {
      const conditions = ['status = ?', 'provider = ?', 'project = ?'];
      expect(appendWhereClause('SELECT * FROM tasks', conditions))
        .toBe('SELECT * FROM tasks WHERE status = ? AND provider = ? AND project = ?');
    });
  });

  describe('exports', () => {
    it('exports MAX_TAG_LENGTH as 100', () => {
      expect(MAX_TAG_LENGTH).toBe(100);
    });

    it('exports MAX_TAGS as 20', () => {
      expect(MAX_TAGS).toBe(20);
    });
  });
});
