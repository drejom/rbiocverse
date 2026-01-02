const { expect } = require('chai');
const { parseTimeToSeconds, formatHumanTime, calculateRemainingTime } = require('../../lib/helpers');

describe('parseTimeToSeconds', () => {
  describe('Valid time strings', () => {
    it('should parse HH:MM:SS format', () => {
      expect(parseTimeToSeconds('12:00:00')).to.equal(43200);
      expect(parseTimeToSeconds('01:30:45')).to.equal(5445);
      expect(parseTimeToSeconds('00:00:01')).to.equal(1);
    });

    it('should parse D-HH:MM:SS format', () => {
      expect(parseTimeToSeconds('1-00:00:00')).to.equal(86400);
      expect(parseTimeToSeconds('2-12:30:00')).to.equal(217800); // 2*86400 + 12*3600 + 30*60
      expect(parseTimeToSeconds('10-05:15:30')).to.equal(882930); // 10*86400 + 5*3600 + 15*60 + 30
    });

    it('should parse MM:SS format (SLURM short format for <1hr)', () => {
      expect(parseTimeToSeconds('12:00')).to.equal(720); // 12 minutes
      expect(parseTimeToSeconds('30:45')).to.equal(1845); // 30 min 45 sec
    });

    it('should handle zero values', () => {
      expect(parseTimeToSeconds('00:00:00')).to.equal(0);
      expect(parseTimeToSeconds('0-00:00:00')).to.equal(0);
    });
  });

  describe('Invalid inputs', () => {
    it('should return null for empty string', () => {
      expect(parseTimeToSeconds('')).to.be.null;
    });

    it('should return null for null', () => {
      expect(parseTimeToSeconds(null)).to.be.null;
    });

    it('should return null for undefined', () => {
      expect(parseTimeToSeconds(undefined)).to.be.null;
    });

    it('should return null for invalid format', () => {
      expect(parseTimeToSeconds('120000')).to.be.null;
      expect(parseTimeToSeconds('invalid')).to.be.null;
    });
  });
});

describe('formatHumanTime', () => {
  describe('Valid time values', () => {
    it('should format seconds only', () => {
      expect(formatHumanTime(30)).to.equal('0m');
      expect(formatHumanTime(59)).to.equal('0m');
    });

    it('should format minutes only', () => {
      expect(formatHumanTime(60)).to.equal('1m');
      expect(formatHumanTime(300)).to.equal('5m');
      expect(formatHumanTime(3599)).to.equal('59m');
    });

    it('should format hours and minutes', () => {
      expect(formatHumanTime(3600)).to.equal('1h 0m');
      expect(formatHumanTime(3660)).to.equal('1h 1m');
      expect(formatHumanTime(7200)).to.equal('2h 0m');
      expect(formatHumanTime(43200)).to.equal('12h 0m');
      expect(formatHumanTime(45900)).to.equal('12h 45m');
    });

    it('should format large values', () => {
      expect(formatHumanTime(86400)).to.equal('24h 0m');
      expect(formatHumanTime(90000)).to.equal('25h 0m');
    });
  });

  describe('Edge cases', () => {
    it('should handle zero', () => {
      expect(formatHumanTime(0)).to.equal('0m');
    });

    it('should handle negative values', () => {
      expect(formatHumanTime(-100)).to.equal('0m');
    });

    it('should handle null', () => {
      expect(formatHumanTime(null)).to.equal('0m');
    });

    it('should handle undefined', () => {
      expect(formatHumanTime(undefined)).to.equal('0m');
    });
  });
});

describe('calculateRemainingTime', () => {
  describe('Valid calculations', () => {
    it('should calculate remaining time correctly', () => {
      // Job started 1 hour ago, walltime is 2 hours
      const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
      const result = calculateRemainingTime(oneHourAgo, '02:00:00');

      // Should have ~1 hour remaining
      const parts = result.split(':').map(Number);
      const totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];

      // Allow 2 second margin for test execution time
      expect(totalSeconds).to.be.within(3598, 3602);
    });

    it('should return 00:00:00 for expired jobs', () => {
      // Job started 3 hours ago, walltime was 2 hours
      const threeHoursAgo = new Date(Date.now() - 10800000).toISOString();
      const result = calculateRemainingTime(threeHoursAgo, '02:00:00');

      expect(result).to.equal('00:00:00');
    });

    it('should handle jobs that just started', () => {
      const now = new Date().toISOString();
      const result = calculateRemainingTime(now, '12:00:00');

      // Should have close to 12 hours remaining
      const parts = result.split(':').map(Number);
      const totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];

      // Allow 2 second margin
      expect(totalSeconds).to.be.within(43198, 43202);
    });

    it('should handle Date objects', () => {
      const oneHourAgo = new Date(Date.now() - 3600000);
      const result = calculateRemainingTime(oneHourAgo, '02:00:00');

      const parts = result.split(':').map(Number);
      const totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];

      expect(totalSeconds).to.be.within(3598, 3602);
    });
  });

  describe('Invalid inputs', () => {
    it('should return null for missing startedAt', () => {
      expect(calculateRemainingTime(null, '12:00:00')).to.be.null;
      expect(calculateRemainingTime(undefined, '12:00:00')).to.be.null;
      expect(calculateRemainingTime('', '12:00:00')).to.be.null;
    });

    it('should return null for missing walltime', () => {
      const now = new Date().toISOString();
      expect(calculateRemainingTime(now, null)).to.be.null;
      expect(calculateRemainingTime(now, undefined)).to.be.null;
      expect(calculateRemainingTime(now, '')).to.be.null;
    });
  });

  describe('Format validation', () => {
    it('should return formatted time with leading zeros', () => {
      const now = new Date().toISOString();
      const result = calculateRemainingTime(now, '00:09:05');

      // Should match HH:MM:SS format
      expect(result).to.match(/^\d{2}:\d{2}:\d{2}$/);

      const parts = result.split(':');
      expect(parts[0]).to.have.lengthOf(2);
      expect(parts[1]).to.have.lengthOf(2);
      expect(parts[2]).to.have.lengthOf(2);
    });
  });
});
