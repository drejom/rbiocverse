/**
 * IDE selector component
 * Toggle buttons for choosing VS Code, RStudio, or JupyterLab
 */

// IDE icon mapping (using devicon classes)
const ideIcons = {
  vscode: 'devicon-vscode-plain',
  rstudio: 'devicon-rstudio-plain',
  jupyter: 'devicon-jupyter-plain',
};

export function IdeSelector({
  ides,
  selectedIde,
  onSelect,
  runningIdes = [],
  availableIdes = [],
  releaseVersion,
  releases,
}) {
  return (
    <div className="ide-selector">
      {Object.entries(ides).map(([ide, info]) => {
        const isRunning = runningIdes.includes(ide);
        const isAvailable = availableIdes.includes(ide);
        const isSelected = selectedIde === ide;
        const isDisabled = isRunning || !isAvailable;

        let title = `Launch ${info.name}`;
        if (isRunning) {
          title = `${info.name} is already running`;
        } else if (!isAvailable) {
          const releaseName = releases?.[releaseVersion]?.name || releaseVersion;
          title = `${info.name} not available on ${releaseName}`;
        }

        return (
          <button
            key={ide}
            className={`ide-btn ${isSelected ? 'selected' : ''}`}
            onClick={() => !isDisabled && onSelect(ide)}
            disabled={isDisabled}
            title={title}
          >
            <i className={`${ideIcons[ide] || 'devicon-nodejs-plain'} icon-sm`} />
            <span>{info.name}</span>
          </button>
        );
      })}
    </div>
  );
}

export default IdeSelector;
