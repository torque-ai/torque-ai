const { formatTime, calculateDuration } = require('../handlers/task/utils');

describe('task-utils', () => {
  describe('formatTime', () => {
    it('formats a valid ISO-8601 string to local time', () => {
      const iso = '2024-01-01T12:00:00.000Z';
      expect(formatTime(iso)).toBe(new Date(iso).toLocaleString('en-US'));
    });

    it('formats ISO strings with different timezone offsets consistently', () => {
      const iso = '2024-06-15T23:45:30.500+02:00';
      expect(formatTime(iso)).toBe(new Date(iso).toLocaleString('en-US'));
    });

    it('returns N/A for null input', () => {
      expect(formatTime(null)).toBe('N/A');
    });

    it('returns N/A for undefined input', () => {
      expect(formatTime(undefined)).toBe('N/A');
    });

    it('returns N/A for empty string input', () => {
      expect(formatTime('')).toBe('N/A');
    });

    it('returns Invalid Date for non-date strings', () => {
      expect(formatTime('not-a-date')).toBe('Invalid Date');
    });

    it('returns N/A for whitespace-only string input', () => {
      expect(formatTime('   ')).toBe('Invalid Date');
    });

    it('handles leap-year boundary timestamps', () => {
      const iso = '2024-02-29T00:00:00.000Z';
      expect(formatTime(iso)).toBe(new Date(iso).toLocaleString('en-US'));
    });
  });

  describe('calculateDuration', () => {
    it('returns N/A when start is missing', () => {
      expect(calculateDuration(null, '2024-01-01T00:00:10.000Z')).toBe('N/A');
    });

    it('returns N/A when end is missing', () => {
      expect(calculateDuration('2024-01-01T00:00:00.000Z', undefined)).toBe('N/A');
    });

    it('returns N/A when both timestamps are missing', () => {
      expect(calculateDuration(null, null)).toBe('N/A');
    });

    it('returns 0s for zero-length interval', () => {
      const t = '2024-01-01T00:00:00.000Z';
      expect(calculateDuration(t, t)).toBe('0s');
    });

    it('returns seconds for intervals under 60 seconds', () => {
      expect(calculateDuration('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:31.999Z')).toBe('31s');
    });

    it('returns minutes and seconds for mixed duration', () => {
      expect(calculateDuration('2024-01-01T00:00:00.000Z', '2024-01-01T00:01:30.000Z')).toBe('1m 30s');
    });

    it('returns only rounded-down minutes and seconds for exact boundary', () => {
      expect(calculateDuration('2024-01-01T00:00:00.000Z', '2024-01-01T00:01:00.000Z')).toBe('1m 0s');
    });

    it('handles multi-hour intervals as cumulative minutes', () => {
      expect(calculateDuration('2024-01-01T00:00:00.000Z', '2024-01-01T03:00:00.000Z')).toBe('180m 0s');
    });

    it('handles minute-heavy intervals with seconds remainder', () => {
      expect(calculateDuration('2024-01-01T00:00:10.000Z', '2024-01-01T00:59:59.900Z')).toBe('59m 49s');
    });

    it('returns negative duration when end is before start', () => {
      expect(calculateDuration('2024-01-01T00:01:00.000Z', '2024-01-01T00:00:59.000Z')).toBe('-1s');
    });
  });
});
