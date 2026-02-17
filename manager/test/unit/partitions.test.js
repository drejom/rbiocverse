const { expect } = require('chai');
const {
  parseScontrolOutput,
  parsePartitionLine,
  parseGpuInfo,
} = require('../../lib/partitions');

describe('Partition Parsing', () => {
  describe('parseScontrolOutput', () => {
    it('should parse multiple partitions', () => {
      const output = `PartitionName=compute AllowGroups=ALL AllowAccounts=ALL Default=YES MaxTime=14-00:00:00 MaxCPUsPerNode=44 MaxMemPerNode=640000 TotalCPUs=4776 TotalNodes=85 TRES=cpu=4606,mem=62356400M,node=85
PartitionName=gpu-a100 AllowGroups=ALL AllowAccounts=ALL Default=NO MaxTime=4-00:00:00 MaxCPUsPerNode=34 MaxMemPerNode=384000 TotalCPUs=136 TotalNodes=4 TRES=cpu=136,mem=1536000M,node=4,gres/gpu=16`;

      const partitions = parseScontrolOutput(output);

      expect(partitions).to.have.length(2);
      expect(partitions[0].name).to.equal('compute');
      expect(partitions[0].isDefault).to.be.true;
      expect(partitions[1].name).to.equal('gpu-a100');
      expect(partitions[1].isDefault).to.be.false;
    });

    it('should skip empty lines', () => {
      const output = `PartitionName=compute AllowGroups=ALL Default=YES MaxTime=14-00:00:00

PartitionName=fast AllowGroups=ALL Default=NO MaxTime=12:00:00
`;

      const partitions = parseScontrolOutput(output);
      expect(partitions).to.have.length(2);
    });

    it('should return empty array for empty input', () => {
      expect(parseScontrolOutput('')).to.have.length(0);
      expect(parseScontrolOutput('\n\n')).to.have.length(0);
    });
  });

  describe('parsePartitionLine', () => {
    describe('Basic field parsing', () => {
      it('should parse partition name', () => {
        const line = 'PartitionName=compute AllowGroups=ALL';
        const result = parsePartitionLine(line);
        expect(result.name).to.equal('compute');
      });

      it('should parse default partition', () => {
        const line = 'PartitionName=compute Default=YES MaxTime=14-00:00:00';
        const result = parsePartitionLine(line);
        expect(result.isDefault).to.be.true;
      });

      it('should parse non-default partition', () => {
        const line = 'PartitionName=gpu-a100 Default=NO MaxTime=4-00:00:00';
        const result = parsePartitionLine(line);
        expect(result.isDefault).to.be.false;
      });

      it('should return null for invalid line', () => {
        const result = parsePartitionLine('Invalid line without PartitionName');
        expect(result).to.be.null;
      });
    });

    describe('Resource limits parsing', () => {
      it('should parse MaxCPUsPerNode', () => {
        const line = 'PartitionName=compute MaxCPUsPerNode=44';
        const result = parsePartitionLine(line);
        expect(result.maxCpus).to.equal(44);
      });

      it('should parse MaxMemPerNode in MB', () => {
        const line = 'PartitionName=compute MaxMemPerNode=640000';
        const result = parsePartitionLine(line);
        expect(result.maxMemMB).to.equal(640000);
      });

      it('should parse MaxTime', () => {
        const line = 'PartitionName=compute MaxTime=14-00:00:00';
        const result = parsePartitionLine(line);
        expect(result.maxTime).to.equal('14-00:00:00');
      });

      it('should parse DefaultTime', () => {
        const line = 'PartitionName=compute DefaultTime=8:00:00';
        const result = parsePartitionLine(line);
        expect(result.defaultTime).to.equal('8:00:00');
      });

      it('should parse TotalCPUs and TotalNodes', () => {
        const line = 'PartitionName=compute TotalCPUs=4776 TotalNodes=85';
        const result = parsePartitionLine(line);
        expect(result.totalCpus).to.equal(4776);
        expect(result.totalNodes).to.equal(85);
      });

      it('should parse TRES memory', () => {
        const line = 'PartitionName=compute TRES=cpu=4606,mem=62356400M,node=85';
        const result = parsePartitionLine(line);
        expect(result.totalMemMB).to.equal(62356400);
      });
    });

    describe('UNLIMITED handling', () => {
      it('should derive maxCpus from total when UNLIMITED', () => {
        // 160 CPUs / 5 nodes = 32 CPUs per node
        const line = 'PartitionName=bigmem MaxCPUsPerNode=UNLIMITED TotalCPUs=160 TotalNodes=5';
        const result = parsePartitionLine(line);
        expect(result.maxCpus).to.equal(32);
      });

      it('should derive maxMemMB from TRES when UNLIMITED', () => {
        // 2000000 MB / 5 nodes = 400000 MB per node
        const line = 'PartitionName=bigmem MaxMemPerNode=UNLIMITED TotalNodes=5 TRES=mem=2000000M';
        const result = parsePartitionLine(line);
        expect(result.maxMemMB).to.equal(400000);
      });

      it('should cap UNLIMITED time at 14 days', () => {
        const line = 'PartitionName=admin MaxTime=UNLIMITED';
        const result = parsePartitionLine(line);
        expect(result.maxTime).to.equal('14-00:00:00');
      });

      it('should handle UNLIMITED without totals gracefully', () => {
        const line = 'PartitionName=test MaxCPUsPerNode=UNLIMITED MaxMemPerNode=UNLIMITED';
        const result = parsePartitionLine(line);
        expect(result.maxCpus).to.be.null;
        expect(result.maxMemMB).to.be.null;
      });
    });

    describe('Restriction detection', () => {
      it('should detect AllowAccounts restriction', () => {
        const line = 'PartitionName=abild AllowAccounts=abild Default=NO';
        const result = parsePartitionLine(line);
        expect(result.restricted).to.be.true;
        expect(result.restrictionReason).to.equal('AllowAccounts=abild');
      });

      it('should detect DenyAccounts restriction', () => {
        const line = 'PartitionName=all DenyAccounts=test Default=YES';
        const result = parsePartitionLine(line);
        expect(result.restricted).to.be.true;
        expect(result.restrictionReason).to.equal('DenyAccounts=test');
      });

      it('should not mark unrestricted partitions', () => {
        const line = 'PartitionName=compute AllowAccounts=ALL Default=YES';
        const result = parsePartitionLine(line);
        expect(result.restricted).to.be.false;
        expect(result.restrictionReason).to.be.null;
      });
    });

    describe('Real-world partition examples', () => {
      it('should parse Gemini compute partition', () => {
        const line = 'PartitionName=compute AllowGroups=ALL AllowAccounts=ALL AllowQos=ALL AllocNodes=ALL Default=YES QoS=N/A DefaultTime=NONE DisableRootJobs=NO ExclusiveUser=NO GraceTime=0 Hidden=NO MaxNodes=UNLIMITED MaxTime=14-00:00:00 MinNodes=0 LLN=NO MaxCPUsPerNode=44 MaxMemPerNode=640000 Nodes=cgenomics[01-85] PriorityJobFactor=1 PriorityTier=1 RootOnly=NO ReqResv=NO OverSubscribe=NO OverTimeLimit=NONE PreemptMode=OFF State=UP TotalCPUs=4776 TotalNodes=85 SelectTypeParameters=NONE JobDefaults=(null) DefMemPerNode=UNLIMITED MaxMemPerCPU=UNLIMITED TRES=cpu=4606,mem=62356400M,node=85,billing=12217,gres/gpu=120';
        const result = parsePartitionLine(line);

        expect(result.name).to.equal('compute');
        expect(result.isDefault).to.be.true;
        expect(result.maxCpus).to.equal(44);
        expect(result.maxMemMB).to.equal(640000);
        expect(result.maxTime).to.equal('14-00:00:00');
        expect(result.totalCpus).to.equal(4776);
        expect(result.totalNodes).to.equal(85);
        expect(result.restricted).to.be.false;
      });

      it('should parse Apollo all partition with DenyAccounts', () => {
        const line = 'PartitionName=all AllowGroups=ALL AllowAccounts=ALL DenyAccounts=abild,admin AllowQos=ALL AllocNodes=ALL Default=YES QoS=N/A DefaultTime=NONE DisableRootJobs=NO ExclusiveUser=NO GraceTime=0 Hidden=NO MaxNodes=UNLIMITED MaxTime=14-00:00:00 MinNodes=0 LLN=NO MaxCPUsPerNode=UNLIMITED MaxMemPerNode=UNLIMITED Nodes=amethyst[01-42],sapphire[001-016] PriorityJobFactor=1 PriorityTier=1 RootOnly=NO ReqResv=NO OverSubscribe=NO OverTimeLimit=NONE PreemptMode=OFF State=UP TotalCPUs=1856 TotalNodes=58 SelectTypeParameters=NONE JobDefaults=(null) DefMemPerNode=UNLIMITED MaxMemPerCPU=UNLIMITED TRES=cpu=1856,mem=23631116M,node=58,billing=1856';
        const result = parsePartitionLine(line);

        expect(result.name).to.equal('all');
        expect(result.isDefault).to.be.true;
        expect(result.maxCpus).to.equal(32); // 1856/58 = 32
        expect(result.maxTime).to.equal('14-00:00:00');
        expect(result.restricted).to.be.true;
        expect(result.restrictionReason).to.equal('DenyAccounts=abild,admin');
      });

      it('should parse GPU partition with short time limit', () => {
        const line = 'PartitionName=gpu-a100 AllowGroups=ALL AllowAccounts=ALL Default=NO MaxTime=4-00:00:00 MaxCPUsPerNode=34 MaxMemPerNode=384000 TotalCPUs=136 TotalNodes=4';
        const result = parsePartitionLine(line);

        expect(result.name).to.equal('gpu-a100');
        expect(result.isDefault).to.be.false;
        expect(result.maxCpus).to.equal(34);
        expect(result.maxMemMB).to.equal(384000);
        expect(result.maxTime).to.equal('4-00:00:00');
      });
    });
  });

  describe('parseGpuInfo', () => {
    it('should parse GPU info from sinfo output', () => {
      const output = `gpu-a100 gpu:A100:4
gpu-v100 gpu:V100:4`;

      const gpus = parseGpuInfo(output);

      expect(gpus['gpu-a100']).to.deep.equal({ gpuType: 'A100', gpuCount: 4 });
      expect(gpus['gpu-v100']).to.deep.equal({ gpuType: 'V100', gpuCount: 4 });
    });

    it('should handle lowercase GPU types', () => {
      const output = 'gpu-a100 gpu:a100:8';
      const gpus = parseGpuInfo(output);
      expect(gpus['gpu-a100'].gpuType).to.equal('A100');
    });

    it('should skip non-GPU lines', () => {
      const output = `compute (null)
gpu-a100 gpu:A100:4
fast (null)`;

      const gpus = parseGpuInfo(output);
      expect(Object.keys(gpus)).to.have.length(1);
      expect(gpus['gpu-a100']).to.exist;
    });

    it('should return empty object for empty input', () => {
      expect(parseGpuInfo('')).to.deep.equal({});
    });
  });
});
