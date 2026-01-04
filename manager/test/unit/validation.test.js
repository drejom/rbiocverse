const { expect } = require('chai');
const { validateSbatchInputs, validateHpcName } = require('../../lib/validation');

describe('validateSbatchInputs', () => {
  describe('Valid inputs (happy path)', () => {
    it('should accept valid standard inputs', () => {
      expect(() => validateSbatchInputs('4', '40G', '12:00:00', 'gemini')).to.not.throw();
    });

    it('should accept minimum CPUs', () => {
      expect(() => validateSbatchInputs('1', '40G', '12:00:00', 'gemini')).to.not.throw();
    });

    it('should accept maximum CPUs for partition', () => {
      expect(() => validateSbatchInputs('44', '40G', '12:00:00', 'gemini')).to.not.throw();
    });

    it('should accept lowercase memory units', () => {
      expect(() => validateSbatchInputs('4', '40g', '12:00:00', 'gemini')).to.not.throw();
      expect(() => validateSbatchInputs('4', '100m', '12:00:00', 'gemini')).to.not.throw();
    });

    it('should accept uppercase memory units', () => {
      expect(() => validateSbatchInputs('4', '40G', '12:00:00', 'gemini')).to.not.throw();
      expect(() => validateSbatchInputs('4', '100M', '12:00:00', 'gemini')).to.not.throw();
    });

    it('should accept time with day prefix', () => {
      expect(() => validateSbatchInputs('4', '40G', '1-12:00:00', 'gemini')).to.not.throw();
      expect(() => validateSbatchInputs('4', '40G', '10-00:00:00', 'gemini')).to.not.throw();
    });

    it('should accept single-digit hours', () => {
      expect(() => validateSbatchInputs('4', '40G', '1:00:00', 'gemini')).to.not.throw();
    });
  });

  describe('Invalid CPUs', () => {
    it('should reject negative CPUs', () => {
      expect(() => validateSbatchInputs('-1', '40G', '12:00:00', 'gemini'))
        .to.throw('Invalid CPU value');
    });

    it('should reject zero CPUs', () => {
      expect(() => validateSbatchInputs('0', '40G', '12:00:00', 'gemini'))
        .to.throw('Invalid CPU value');
    });

    it('should reject CPUs above maximum (128)', () => {
      expect(() => validateSbatchInputs('129', '40G', '12:00:00', 'apollo'))
        .to.throw('Invalid CPU value');
      expect(() => validateSbatchInputs('256', '40G', '12:00:00', 'apollo'))
        .to.throw('Invalid CPU value');
    });

    it('should reject non-integer CPUs', () => {
      expect(() => validateSbatchInputs('4.5', '40G', '12:00:00', 'gemini'))
        .to.throw('Invalid CPU value');
      expect(() => validateSbatchInputs('abc', '40G', '12:00:00', 'gemini'))
        .to.throw('Invalid CPU value');
    });

    it('should reject empty CPU string', () => {
      expect(() => validateSbatchInputs('', '40G', '12:00:00', 'gemini'))
        .to.throw('Invalid CPU value');
    });
  });

  describe('Invalid memory', () => {
    it('should reject memory without unit', () => {
      expect(() => validateSbatchInputs('4', '40', '12:00:00', 'gemini'))
        .to.throw('Invalid memory value');
    });

    it('should reject memory with invalid unit', () => {
      expect(() => validateSbatchInputs('4', '40K', '12:00:00', 'gemini'))
        .to.throw('Invalid memory value');
      expect(() => validateSbatchInputs('4', '40T', '12:00:00', 'gemini'))
        .to.throw('Invalid memory value');
    });

    it('should reject memory with space before unit', () => {
      expect(() => validateSbatchInputs('4', '40 G', '12:00:00', 'gemini'))
        .to.throw('Invalid memory value');
    });

    it('should reject empty memory string', () => {
      expect(() => validateSbatchInputs('4', '', '12:00:00', 'gemini'))
        .to.throw('Invalid memory value');
    });

    it('should reject memory with special characters', () => {
      expect(() => validateSbatchInputs('4', '40G;', '12:00:00', 'gemini'))
        .to.throw('Invalid memory value');
    });
  });

  describe('Invalid time', () => {
    it('should reject time without colons', () => {
      expect(() => validateSbatchInputs('4', '40G', '120000', 'gemini'))
        .to.throw('Invalid time value');
    });

    it('should reject time with only one colon', () => {
      expect(() => validateSbatchInputs('4', '40G', '12:00', 'gemini'))
        .to.throw('Invalid time value');
    });

    it('should reject time with letters', () => {
      expect(() => validateSbatchInputs('4', '40G', '12:00:00abc', 'gemini'))
        .to.throw('Invalid time value');
    });

    it('should reject empty time string', () => {
      expect(() => validateSbatchInputs('4', '40G', '', 'gemini'))
        .to.throw('Invalid time value');
    });

    it('should reject time with missing components', () => {
      expect(() => validateSbatchInputs('4', '40G', '::', 'gemini'))
        .to.throw('Invalid time value');
    });
  });

  describe('Command injection attempts (SECURITY CRITICAL)', () => {
    it('should block injection in CPUs parameter', () => {
      expect(() => validateSbatchInputs('4; rm -rf /', '40G', '12:00:00', 'gemini'))
        .to.throw('Invalid CPU value');
      expect(() => validateSbatchInputs('4 && whoami', '40G', '12:00:00', 'gemini'))
        .to.throw('Invalid CPU value');
      expect(() => validateSbatchInputs('$(whoami)', '40G', '12:00:00', 'gemini'))
        .to.throw('Invalid CPU value');
      expect(() => validateSbatchInputs('4`whoami`', '40G', '12:00:00', 'gemini'))
        .to.throw('Invalid CPU value');
    });

    it('should block injection in memory parameter', () => {
      expect(() => validateSbatchInputs('4', '40G; rm -rf /', '12:00:00', 'gemini'))
        .to.throw('Invalid memory value');
      expect(() => validateSbatchInputs('4', '40G && whoami', '12:00:00', 'gemini'))
        .to.throw('Invalid memory value');
      expect(() => validateSbatchInputs('4', '$(whoami)G', '12:00:00', 'gemini'))
        .to.throw('Invalid memory value');
      expect(() => validateSbatchInputs('4', '40G`whoami`', '12:00:00', 'gemini'))
        .to.throw('Invalid memory value');
    });

    it('should block injection in time parameter', () => {
      expect(() => validateSbatchInputs('4', '40G', '12:00:00; rm -rf /', 'gemini'))
        .to.throw('Invalid time value');
      expect(() => validateSbatchInputs('4', '40G', '12:00:00 && whoami', 'gemini'))
        .to.throw('Invalid time value');
      expect(() => validateSbatchInputs('4', '40G', '$(whoami):00:00', 'gemini'))
        .to.throw('Invalid time value');
      expect(() => validateSbatchInputs('4', '40G', '12:00:00`whoami`', 'gemini'))
        .to.throw('Invalid time value');
    });

    it('should block pipe commands', () => {
      expect(() => validateSbatchInputs('4 | cat /etc/passwd', '40G', '12:00:00', 'gemini'))
        .to.throw('Invalid CPU value');
      expect(() => validateSbatchInputs('4', '40G | cat /etc/passwd', '12:00:00', 'gemini'))
        .to.throw('Invalid memory value');
    });

    it('should block redirect operators', () => {
      expect(() => validateSbatchInputs('4', '40G', '12:00:00 > /tmp/hack', 'gemini'))
        .to.throw('Invalid time value');
      expect(() => validateSbatchInputs('4', '40G', '12:00:00 < /etc/passwd', 'gemini'))
        .to.throw('Invalid time value');
    });
  });

  describe('Edge cases', () => {
    it('should handle null values gracefully', () => {
      expect(() => validateSbatchInputs(null, '40G', '12:00:00', 'gemini'))
        .to.throw('Invalid CPU value');
      expect(() => validateSbatchInputs('4', null, '12:00:00', 'gemini'))
        .to.throw('Invalid memory value');
      expect(() => validateSbatchInputs('4', '40G', null, 'gemini'))
        .to.throw('Invalid time value');
    });

    it('should handle undefined values gracefully', () => {
      expect(() => validateSbatchInputs(undefined, '40G', '12:00:00', 'gemini'))
        .to.throw('Invalid CPU value');
      expect(() => validateSbatchInputs('4', undefined, '12:00:00', 'gemini'))
        .to.throw('Invalid memory value');
      expect(() => validateSbatchInputs('4', '40G', undefined, 'gemini'))
        .to.throw('Invalid time value');
    });

    it('should handle whitespace-only strings', () => {
      expect(() => validateSbatchInputs('  ', '40G', '12:00:00', 'gemini'))
        .to.throw('Invalid CPU value');
      expect(() => validateSbatchInputs('4', '  ', '12:00:00', 'gemini'))
        .to.throw('Invalid memory value');
      expect(() => validateSbatchInputs('4', '40G', '  ', 'gemini'))
        .to.throw('Invalid time value');
    });
  });
});

describe('validateHpcName', () => {
  describe('Valid cluster names', () => {
    it('should accept gemini', () => {
      expect(() => validateHpcName('gemini')).to.not.throw();
    });

    it('should accept apollo', () => {
      expect(() => validateHpcName('apollo')).to.not.throw();
    });
  });

  describe('Invalid cluster names', () => {
    it('should reject unknown cluster name', () => {
      expect(() => validateHpcName('unknown'))
        .to.throw('Invalid HPC: must be one of gemini, apollo');
    });

    it('should reject empty string', () => {
      expect(() => validateHpcName(''))
        .to.throw('Invalid HPC');
    });

    it('should reject case-sensitive variations', () => {
      expect(() => validateHpcName('Gemini'))
        .to.throw('Invalid HPC');
      expect(() => validateHpcName('APOLLO'))
        .to.throw('Invalid HPC');
    });

    it('should reject null', () => {
      expect(() => validateHpcName(null))
        .to.throw('Invalid HPC');
    });

    it('should reject undefined', () => {
      expect(() => validateHpcName(undefined))
        .to.throw('Invalid HPC');
    });
  });

  describe('Injection attempts', () => {
    it('should block command injection in cluster name', () => {
      expect(() => validateHpcName('gemini; rm -rf /'))
        .to.throw('Invalid HPC');
      expect(() => validateHpcName('apollo && whoami'))
        .to.throw('Invalid HPC');
    });
  });
});

describe('Partition limits validation', () => {
  describe('Gemini compute partition', () => {
    it('should accept valid resources within limits', () => {
      expect(() => validateSbatchInputs('4', '40G', '12:00:00', 'gemini')).to.not.throw();
      expect(() => validateSbatchInputs('44', '600G', '14-00:00:00', 'gemini')).to.not.throw();
    });

    it('should reject CPUs exceeding partition limit (44)', () => {
      expect(() => validateSbatchInputs('45', '40G', '12:00:00', 'gemini'))
        .to.throw('CPU limit exceeded: gemini allows max 44 CPUs');
    });

    it('should reject memory exceeding partition limit (625G)', () => {
      expect(() => validateSbatchInputs('4', '700G', '12:00:00', 'gemini'))
        .to.throw('Memory limit exceeded: gemini allows max 625G');
    });

    it('should reject time exceeding partition limit (14 days)', () => {
      expect(() => validateSbatchInputs('4', '40G', '15-00:00:00', 'gemini'))
        .to.throw('Time limit exceeded: gemini allows max 14-00:00:00');
    });
  });

  describe('Gemini GPU partitions', () => {
    it('should apply A100 partition CPU limit (34)', () => {
      expect(() => validateSbatchInputs('34', '300G', '4-00:00:00', 'gemini', 'a100')).to.not.throw();
      expect(() => validateSbatchInputs('35', '300G', '4-00:00:00', 'gemini', 'a100'))
        .to.throw('CPU limit exceeded: gemini allows max 34 CPUs');
    });

    it('should apply A100 time limit (4 days)', () => {
      expect(() => validateSbatchInputs('4', '40G', '5-00:00:00', 'gemini', 'a100'))
        .to.throw('Time limit exceeded: gemini allows max 4-00:00:00');
    });

    it('should apply V100 time limit (8 days)', () => {
      expect(() => validateSbatchInputs('4', '40G', '8-00:00:00', 'gemini', 'v100')).to.not.throw();
      expect(() => validateSbatchInputs('4', '40G', '9-00:00:00', 'gemini', 'v100'))
        .to.throw('Time limit exceeded: gemini allows max 8-00:00:00');
    });
  });

  describe('Apollo partition', () => {
    it('should accept valid resources for Apollo', () => {
      expect(() => validateSbatchInputs('64', '400G', '14-00:00:00', 'apollo')).to.not.throw();
    });

    it('should reject time exceeding Apollo limit (14 days)', () => {
      expect(() => validateSbatchInputs('4', '40G', '15-00:00:00', 'apollo'))
        .to.throw('Time limit exceeded: apollo allows max 14-00:00:00');
    });

    it('should accept high CPU count (no per-node limit)', () => {
      expect(() => validateSbatchInputs('128', '400G', '12:00:00', 'apollo')).to.not.throw();
    });
  });
});
