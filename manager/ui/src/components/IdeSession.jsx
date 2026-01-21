/**
 * IDE session component
 * Shows running or pending IDE session with actions
 */
import { Server, Cpu, MemoryStick, Gpu, Package, Plug, Square, X } from 'lucide-react';
import TimePie from './TimePie';

// IDE icon mapping
const ideIcons = {
  vscode: 'devicon-vscode-plain',
  rstudio: 'devicon-rstudio-plain',
  jupyter: 'devicon-jupyter-plain',
};

export function RunningSession({
  hpc,
  ide,
  status,
  countdown,
  ides,
  onConnect,
  onStop,
  stopping,
}) {
  const ideInfo = ides[ide] || { name: ide };
  const remaining = countdown?.remaining || status.timeLeftSeconds || 0;
  const total = countdown?.total || status.timeLimitSeconds || remaining;

  return (
    <div className="ide-session running">
      <div className="ide-session-header">
        <span className="ide-name">
          <i className={`${ideIcons[ide] || 'devicon-nodejs-plain'} icon-sm`} />
          {ideInfo.name}
        </span>
        <span className="ide-node">
          <Server className="icon-xs" />
          {status.node || 'node'}
        </span>
      </div>

      <div className="ide-session-info">
        <TimePie remaining={remaining} total={total} small />
        <div className="resources-inline">
          <span><Cpu className="icon-xs" />{status.cpus || '?'}</span>
          <span><MemoryStick className="icon-xs" />{status.memory || '?'}</span>
          {status.gpu && <span><Gpu className="icon-xs" />{status.gpu.toUpperCase()}</span>}
          {status.releaseVersion && <span><Package className="icon-xs" />{status.releaseVersion}</span>}
        </div>
      </div>

      {stopping ? (
        <div className="stop-progress">
          <div className="stop-progress-text">Stopping job...</div>
          <div className="stop-progress-bar">
            <div className="stop-progress-fill" />
          </div>
        </div>
      ) : (
        <div className="btn-group btn-group-sm">
          <button className="btn btn-success btn-sm" onClick={() => onConnect(hpc, ide)}>
            <Plug className="icon-sm" /> Connect
          </button>
          <button className="btn btn-danger btn-sm" onClick={() => onStop(hpc, ide)}>
            <Square className="icon-sm" /> Stop
          </button>
        </div>
      )}
    </div>
  );
}

export function PendingSession({ hpc, ide, status, ides, onStop, stopping }) {
  const ideInfo = ides[ide] || { name: ide };

  return (
    <div className="ide-session pending">
      <div className="ide-session-header">
        <span className="ide-name">
          <i className={`${ideIcons[ide] || 'devicon-nodejs-plain'} icon-sm`} />
          {ideInfo.name}
        </span>
        {!stopping && <span className="spinner" />}
      </div>
      {stopping ? (
        <div className="stop-progress">
          <div className="stop-progress-text">Cancelling job...</div>
          <div className="stop-progress-bar">
            <div className="stop-progress-fill" />
          </div>
        </div>
      ) : (
        <>
          <div className="cluster-info">Waiting for resources...</div>
          {status.startTime && (
            <div className="estimated-start">Est: {status.startTime}</div>
          )}
          <div className="btn-group btn-group-sm">
            <button className="btn btn-danger btn-sm" onClick={() => onStop(hpc, ide)}>
              <X className="icon-sm" /> Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
