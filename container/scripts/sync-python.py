#!/usr/bin/env python3
"""
sync-python.py - Analyze installed Python packages vs pyproject.toml

Categorizes packages as:
- Core: in [project.dependencies]
- GPU: in [optional-dependencies.gpu]
- Staged: in [optional-dependencies.staged]
- New (staged candidate): top-level packages not in any category
- Transitive: dependencies of other packages

Usage:
    python sync-python.py --freeze <pip_freeze.txt> --pyproject <pyproject.toml> [--output <snapshot.toml>]
"""

import argparse
import re
import subprocess
import sys
import tomllib
from collections import defaultdict
from datetime import datetime
from pathlib import Path


def normalize_package_name(name: str) -> str:
    """Normalize package name for comparison (PEP 503)."""
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_requirement(req: str) -> str:
    """Extract package name from a requirement string like 'scanpy>=1.10'."""
    # Remove extras like [cuda12]
    req = re.sub(r"\[.*?\]", "", req)
    # Extract just the package name
    match = re.match(r"^([a-zA-Z0-9_-]+)", req.strip())
    return normalize_package_name(match.group(1)) if match else ""


def parse_freeze_line(line: str) -> tuple[str, str] | None:
    """Parse a pip freeze line into (package_name, version)."""
    line = line.strip()
    if not line or line.startswith("#") or line.startswith("-"):
        return None

    # Handle editable installs
    if line.startswith("-e"):
        return None

    # Standard format: package==version
    if "==" in line:
        name, version = line.split("==", 1)
        return normalize_package_name(name), version

    return None


def load_pyproject(path: Path) -> dict:
    """Load and parse pyproject.toml."""
    with open(path, "rb") as f:
        return tomllib.load(f)


def get_declared_packages(pyproject: dict) -> dict[str, set[str]]:
    """Extract package names from pyproject.toml by category."""
    result = {
        "core": set(),
        "gpu": set(),
        "staged": set(),
    }

    # Core dependencies
    deps = pyproject.get("project", {}).get("dependencies", [])
    for dep in deps:
        name = parse_requirement(dep)
        if name:
            result["core"].add(name)

    # Optional dependencies
    opt_deps = pyproject.get("project", {}).get("optional-dependencies", {})

    for dep in opt_deps.get("gpu", []):
        name = parse_requirement(dep)
        if name:
            result["gpu"].add(name)

    for dep in opt_deps.get("staged", []):
        name = parse_requirement(dep)
        if name:
            result["staged"].add(name)

    return result


def get_required_by(package: str) -> list[str]:
    """Get list of packages that require this package using pip show."""
    try:
        result = subprocess.run(
            ["pip", "show", package],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return []

        for line in result.stdout.split("\n"):
            if line.startswith("Required-by:"):
                deps = line.split(":", 1)[1].strip()
                if deps:
                    return [d.strip() for d in deps.split(",")]
                return []
    except (subprocess.TimeoutExpired, Exception):
        return []

    return []


def categorize_packages(
    installed: dict[str, str],
    declared: dict[str, set[str]],
    check_transitive: bool = True,
) -> dict[str, dict[str, str]]:
    """Categorize installed packages."""
    categories = {
        "core": {},
        "gpu": {},
        "staged": {},
        "staged_new": {},  # New packages to consider staging
        "transitive": {},
    }

    all_declared = declared["core"] | declared["gpu"] | declared["staged"]

    for pkg, version in installed.items():
        normalized = normalize_package_name(pkg)

        if normalized in declared["core"]:
            categories["core"][pkg] = version
        elif normalized in declared["gpu"]:
            categories["gpu"][pkg] = version
        elif normalized in declared["staged"]:
            categories["staged"][pkg] = version
        elif check_transitive:
            # Check if anything requires this package
            required_by = get_required_by(pkg)
            if required_by:
                categories["transitive"][pkg] = version
            else:
                # Top-level package not in pyproject.toml
                categories["staged_new"][pkg] = version
        else:
            # Without transitive check, assume undeclared are candidates
            categories["staged_new"][pkg] = version

    return categories


def generate_report(
    categories: dict[str, dict[str, str]],
    declared: dict[str, set[str]],
    cluster: str,
    version: str,
) -> str:
    """Generate human-readable report."""
    lines = [
        "=== Python Package Sync Report ===",
        f"Cluster: {cluster}",
        f"Bioc Version: {version}",
        f"Date: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
    ]

    # Core packages
    lines.append(f"CORE PACKAGES ({len(categories['core'])} installed):")
    if categories["core"]:
        for pkg, ver in sorted(categories["core"].items()):
            lines.append(f"  {pkg:30} {ver}")
    else:
        lines.append("  (none)")
    lines.append("")

    # GPU packages
    lines.append(f"GPU PACKAGES ({len(categories['gpu'])} installed):")
    if categories["gpu"]:
        for pkg, ver in sorted(categories["gpu"].items()):
            lines.append(f"  {pkg:30} {ver}")
    else:
        lines.append("  (none)")
    lines.append("")

    # Existing staged packages
    lines.append(f"STAGED PACKAGES ({len(categories['staged'])} existing):")
    if categories["staged"]:
        for pkg, ver in sorted(categories["staged"].items()):
            lines.append(f"  {pkg:30} {ver}")
    else:
        lines.append("  (none)")
    lines.append("")

    # New staged candidates
    lines.append(f"NEW STAGED CANDIDATES ({len(categories['staged_new'])} found):")
    if categories["staged_new"]:
        lines.append("  These packages are installed but not in pyproject.toml:")
        for pkg, ver in sorted(categories["staged_new"].items()):
            lines.append(f"  {pkg:30} {ver}  <- consider adding to [staged]")
    else:
        lines.append("  (none - all top-level packages are declared)")
    lines.append("")

    # Transitive summary
    lines.append(f"TRANSITIVE DEPENDENCIES ({len(categories['transitive'])} packages):")
    lines.append("  (auto-installed, no action needed)")
    lines.append("")

    # Summary
    total = sum(len(c) for c in categories.values())
    lines.append(f"TOTAL: {total} packages installed")

    return "\n".join(lines)


def generate_snapshot(
    installed: dict[str, str],
    cluster: str,
    version: str,
) -> str:
    """Generate TOML snapshot of installed packages."""
    lines = [
        f"# Python package snapshot",
        f"# Cluster: {cluster}",
        f"# Bioc Version: {version}",
        f"# Date: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"# Packages: {len(installed)}",
        "",
        "[packages]",
    ]

    for pkg, ver in sorted(installed.items()):
        lines.append(f'{pkg} = "{ver}"')

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Analyze installed Python packages vs pyproject.toml"
    )
    parser.add_argument(
        "--freeze",
        type=Path,
        required=True,
        help="Path to pip freeze output file",
    )
    parser.add_argument(
        "--pyproject",
        type=Path,
        required=True,
        help="Path to pyproject.toml",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Path for snapshot output file",
    )
    parser.add_argument(
        "--cluster",
        default="unknown",
        help="Cluster name (gemini/apollo)",
    )
    parser.add_argument(
        "--version",
        default="unknown",
        help="Bioconductor version",
    )
    parser.add_argument(
        "--skip-transitive-check",
        action="store_true",
        help="Skip checking for transitive dependencies (faster but less accurate)",
    )

    args = parser.parse_args()

    # Load pip freeze
    installed = {}
    with open(args.freeze) as f:
        for line in f:
            parsed = parse_freeze_line(line)
            if parsed:
                installed[parsed[0]] = parsed[1]

    # Load pyproject.toml
    pyproject = load_pyproject(args.pyproject)
    declared = get_declared_packages(pyproject)

    # Categorize packages
    categories = categorize_packages(
        installed,
        declared,
        check_transitive=not args.skip_transitive_check,
    )

    # Generate and print report
    report = generate_report(categories, declared, args.cluster, args.version)
    print(report)

    # Generate snapshot if requested
    if args.output:
        snapshot = generate_snapshot(installed, args.cluster, args.version)
        args.output.write_text(snapshot)
        print(f"\nSnapshot saved: {args.output}")

    # Exit with code indicating new staged candidates found
    if categories["staged_new"]:
        sys.exit(1)  # Signal that review is needed
    sys.exit(0)


if __name__ == "__main__":
    main()
