/**
 * Launch form component
 * Resource inputs (CPUs, Memory, Time) and optional GPU selector on one line
 */
import { Cpu, MemoryStick, Timer, Zap, Gpu } from 'lucide-react';
import { ChangeEvent } from 'react';
import type { PartitionLimits, GpuTypeConfig } from '../types';

interface FormValues {
  cpus: string;
  mem: string;
  time: string;
}

interface LaunchFormProps {
  values: FormValues;
  onChange: (values: FormValues) => void;
  limits?: PartitionLimits | null;
  gpuConfig?: Record<string, GpuTypeConfig> | null;
  selectedGpu: string;
  onGpuSelect: (gpu: string) => void;
}

export function LaunchForm({ values, onChange, limits, gpuConfig, selectedGpu, onGpuSelect }: LaunchFormProps) {
  const handleChange = (field: keyof FormValues) => (e: ChangeEvent<HTMLInputElement>) => {
    onChange({ ...values, [field]: e.target.value });
  };

  // Build tooltips from limits
  const cpuTitle = limits?.maxCpus ? `Max: ${limits.maxCpus} CPUs` : '';
  const memTitle = limits?.maxMemMB ? `Max: ${Math.floor(limits.maxMemMB / 1024)}G` : '';
  const timeTitle = limits?.maxTime ? `Max: ${limits.maxTime}` : '';

  const hasGpu = gpuConfig && Object.keys(gpuConfig).length > 0;
  const gpuTypes = hasGpu ? Object.keys(gpuConfig) : [];

  return (
    <div className="launch-form">
      <div className="form-input input-cpus">
        <label>
          <Cpu className="icon-sm" />
          CPUs
        </label>
        <input
          type="number"
          value={values.cpus}
          onChange={handleChange('cpus')}
          min="1"
          max={limits?.maxCpus || 128}
          title={cpuTitle}
        />
      </div>
      <div className="form-input input-mem">
        <label>
          <MemoryStick className="icon-sm" />
          Memory
        </label>
        <input
          type="text"
          value={values.mem}
          onChange={handleChange('mem')}
          placeholder={memTitle || '40G'}
          title={memTitle}
        />
      </div>
      <div className="form-input input-time">
        <label>
          <Timer className="icon-sm" />
          Time
        </label>
        <input
          type="text"
          value={values.time}
          onChange={handleChange('time')}
          placeholder={timeTitle || '12:00:00'}
          title={timeTitle}
        />
      </div>
      {hasGpu && (
        <div className="gpu-selector">
          <label className="gpu-label">
            <Zap className="icon-sm" /> Accelerator
          </label>
          <div className="gpu-toggle">
            <button
              type="button"
              className={`gpu-btn ${!selectedGpu ? 'selected' : ''}`}
              onClick={() => onGpuSelect('')}
            >
              <Cpu className="icon-xs" /> CPU
            </button>
            {gpuTypes.map((type) => (
              <button
                key={type}
                type="button"
                className={`gpu-btn ${selectedGpu === type ? 'selected' : ''}`}
                onClick={() => onGpuSelect(type)}
              >
                <Gpu className="icon-xs" /> {type.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default LaunchForm;
