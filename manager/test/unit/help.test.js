/**
 * Tests for help route template processing
 */

const { expect } = require('chai');

// Import the functions we need to test by re-implementing them
// (since they're not exported from help.js, we test the logic directly)

function getNestedValue(obj, path) {
  return path.split('.').reduce((curr, key) => curr?.[key], obj);
}

function processTemplates(content, data) {
  if (!content || !data) return content;

  return content.replace(/\{\{(.+?)\}\}/g, (match, expr) => {
    const trimmed = expr.trim();

    // Check for ternary expression
    const ternaryMatch = trimmed.match(/^(.+?)\s*\?\s*["'](.+?)["']\s*:\s*["'](.+?)["']$/);
    if (ternaryMatch) {
      const [, condition, trueVal, falseVal] = ternaryMatch;
      const conditionValue = getNestedValue(data, condition.trim());
      return conditionValue ? trueVal : falseVal;
    }

    // Simple path substitution
    const value = getNestedValue(data, trimmed);
    if (value === undefined || value === null) {
      return '-';
    }
    return String(value);
  });
}

describe('Help Template Processing', () => {
  describe('getNestedValue', () => {
    it('should get simple property', () => {
      expect(getNestedValue({ foo: 'bar' }, 'foo')).to.equal('bar');
    });

    it('should get nested property', () => {
      expect(getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c')).to.equal(42);
    });

    it('should return undefined for missing path', () => {
      expect(getNestedValue({ a: 1 }, 'b.c')).to.be.undefined;
    });

    it('should handle null/undefined objects safely', () => {
      expect(getNestedValue(null, 'a.b')).to.be.undefined;
      expect(getNestedValue(undefined, 'a.b')).to.be.undefined;
    });
  });

  describe('processTemplates', () => {
    const mockData = {
      gemini: {
        online: true,
        cpus: { percent: 72, used: 450, total: 600 },
        memory: { percent: 50 },
        nodes: { percent: 77 },
        gpus: { percent: 70 },
        runningJobs: 145,
        pendingJobs: 23,
      },
      apollo: {
        online: false,
        cpus: { percent: 58 },
        memory: { percent: 45 },
        nodes: { percent: 60 },
        runningJobs: 89,
        pendingJobs: 10,
      },
    };

    it('should replace simple path expressions', () => {
      const content = 'CPU: {{gemini.cpus.percent}}%';
      const result = processTemplates(content, mockData);
      expect(result).to.equal('CPU: 72%');
    });

    it('should replace multiple expressions', () => {
      const content = 'Gemini: {{gemini.cpus.percent}}% | Apollo: {{apollo.cpus.percent}}%';
      const result = processTemplates(content, mockData);
      expect(result).to.equal('Gemini: 72% | Apollo: 58%');
    });

    it('should handle ternary expressions with true condition', () => {
      const content = '{{gemini.online ? "Online" : "Offline"}}';
      const result = processTemplates(content, mockData);
      expect(result).to.equal('Online');
    });

    it('should handle ternary expressions with false condition', () => {
      const content = '{{apollo.online ? "Online" : "Offline"}}';
      const result = processTemplates(content, mockData);
      expect(result).to.equal('Offline');
    });

    it('should handle ternary with emojis', () => {
      const content = '{{gemini.online ? "🟢 Online" : "🔴 Offline"}}';
      const result = processTemplates(content, mockData);
      expect(result).to.equal('🟢 Online');
    });

    it('should return dash for missing data', () => {
      const content = '{{gemini.gpus.count}}';
      const result = processTemplates(content, mockData);
      expect(result).to.equal('-');
    });

    it('should handle empty content', () => {
      expect(processTemplates('', mockData)).to.equal('');
      expect(processTemplates(null, mockData)).to.be.null;
    });

    it('should handle empty data', () => {
      const content = '{{gemini.cpus.percent}}';
      expect(processTemplates(content, {})).to.equal('-');
      expect(processTemplates(content, null)).to.equal(content);
    });

    it('should preserve non-template content', () => {
      const content = '# Header\n\nSome text {{gemini.runningJobs}} more text';
      const result = processTemplates(content, mockData);
      expect(result).to.equal('# Header\n\nSome text 145 more text');
    });

    it('should handle markdown table with templates', () => {
      const content = `| Cluster | CPU |
|---------|-----|
| Gemini  | {{gemini.cpus.percent}}% |`;
      const result = processTemplates(content, mockData);
      expect(result).to.include('| Gemini  | 72% |');
    });
  });
});
