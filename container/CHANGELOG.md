# Changelog

All notable changes to the rbiocverse package collection will be documented in this file.

## [3.22.0] - 2026-01-03

### Added
- **Python SCverse ecosystem** installed to shared PYTHONPATH:
  - Core: scanpy 1.11.5, anndata, scvi-tools, squidpy, cellrank, muon, pertpy
  - Utilities: harmonypy, bbknn, scanorama, scrublet, doubletdetection
  - GPU (Gemini only): rapids-singlecell, cupy-cuda12x, jax[cuda12]
  - ~470 packages, 14GB per cluster

- **Python package upgrade workflow** with staging model:
  - `sync-python-packages.sh` - Capture installed packages for upgrade review
  - `sync-python.py` - Categorize packages (core/gpu/staged/transitive)
  - `[staged]` section in pyproject.toml for packages added between releases
  - Staging model: packages can be promoted to core, kept staged, or dropped

- **VS Code extensions pre-installed** for HPC Code Server bootstrap:
  - REditorSupport.r, RDebugger.r-debugger, ms-python.python
  - Extensions in `/usr/local/share/vscode-extensions`

- **GitHub packages added to Imports** (previously only in Remotes):
  - `azimuth` - Reference-based single-cell mapping
  - `cellassign` - Automated cell type annotation
  - `CellChat` - Cell-cell communication analysis
  - `DoubletFinder` - Doublet detection for scRNA-seq
  - `liger` - Multi-dataset integration (LIGER/rliger)
  - `monocle3` - Trajectory analysis
  - `presto` - Fast Wilcoxon and auROC
  - `SeuratData` - Example datasets for Seurat
  - `SeuratDisk` - h5Seurat file format support
  - `SeuratWrappers` - Wrappers for external single-cell tools

- **Archived CRAN packages** (installed via URL remotes):
  - `grr` v0.9.5 - Required by orthogene (archived 2025-12-10)
  - `TFMPvalue` v0.0.9 - Required by TFBSTools (archived 2025-12-25)

- **Install script improvements**:
  - Two-phase SLURM installation (`--slurm-smart`) to avoid lock contention
  - Remote mapping support for archived CRAN and GitHub packages
  - Cluster auto-detection (Gemini/Apollo) with appropriate resource allocation

### Removed
- `HPO.db` - Deprecated by Bioconductor ("Replaced by more current version", removed 2024-05-02)
- `velocyto.R` - Unmaintained, fails to compile with modern gcc due to `-Werror=format-security`

### Changed
- Updated from Bioconductor 3.19 to 3.22
- Container base: `bioconductor/bioconductor_docker:RELEASE_3_22`
- R version: 4.5.x (required by Bioc 3.22)

### Package Statistics
- Total packages: ~1453
- Successfully installed: ~1452
- Failed: 1 (velocyto.R - removed from manifest)

---

## [3.19.0] - Previous Release

Initial tracked release with Bioconductor 3.19.

### Notes
- Base container: `bioconductor/bioconductor_docker:RELEASE_3_19`
- R version: 4.4.x
