# {{icon:question}} FAQ

Frequently asked questions about rbiocverse.

## General

### What is rbiocverse?

rbiocverse provides browser-based access to VS Code, RStudio, and JupyterLab running on HPRCC. Your code runs on powerful compute nodes while you work from any browser.

### Which cluster should I use?

- **Gemini** - Has GPUs (A100, V100). Use for deep learning, GPU-accelerated computation.
- **Apollo** - CPU-focused with high memory. Use for general workloads, large-memory jobs.

Check health indicators - use whichever has more availability.

### Can I run multiple sessions?

Yes! You can run sessions on different clusters simultaneously. For example, RStudio on Gemini and VS Code on Apollo.

### How long can my session run?

Up to 14 days on most partitions. GPU partitions have shorter limits (4-8 days). See the [Environment](/help/environment) section for partition limits.

### What happens when time runs out?

Your SLURM job ends and the IDE disconnects. **Save your work before time expires.** Unsaved changes in open editors will be lost.

## Data & Files

### Where should I save my files?

Your home directory (`$HOME`) is shared across all clusters and sessions. Save work there for persistence.

### Is my data backed up?

Home directories are backed up by cluster administrators. For critical data, maintain your own backups or use version control.

### Can I access network drives?

Cluster network mounts are available in your sessions. Check with your admin for mount paths.

## Sessions & Jobs

### Why is my job pending?

The cluster is busy. Smaller resource requests queue faster. Check health indicators and consider the other cluster.

### Can I pause my session?

Not directly, but you can:
1. Disconnect and reconnect later (job keeps running)
2. Save work, stop the job, relaunch when ready

### What if I forget to stop my job?

Jobs end automatically at walltime. Unused jobs consume cluster resources - please stop sessions when done.

## Technical

### Why install as PWA?

PWA (Progressive Web App) mode gives your IDE better keyboard shortcut access. Browsers capture shortcuts like `Ctrl+N` that IDEs need. PWA mode bypasses most of these restrictions.

### Can I use my own VS Code extensions?

Yes! Install extensions normally - they persist in your home directory between sessions.

### How does authentication work?

You log in with your COH credentials. On first login, the system tests SSH access to the clusters. If your existing SSH keys work, you're ready to go. If not, a managed SSH key is generated for you.

### What about managed SSH keys?

If you don't have working SSH keys, the system generates and manages one for you:

1. A keypair is generated and the private key is encrypted with your password
2. You copy the public key to `~/.ssh/authorized_keys` on the clusters
3. On each login, your password decrypts the key for the session
4. On logout, the decrypted key is cleared from memory

**Important:** Your private key is encrypted with your password. Only you can decrypt it - not even server administrators.

### What happens if I change my password?

If your password changes (through HR/Active Directory), your encrypted SSH key can no longer be decrypted. You'll need to regenerate your key:

1. Go to **Manage Keys** in the user menu
2. Click **Regenerate Key**
3. Enter your new password
4. Copy the new public key to the clusters

### Can I use my own SSH keys instead?

Yes! If you already have SSH keys set up for the clusters, the system will use those instead of generating a managed key. This avoids the password change issue entirely.

To set up your own keys:

1. Generate a key: `ssh-keygen -t ed25519`
2. Copy to clusters: `ssh-copy-id gemini.coh.org` and `ssh-copy-id apollo.coh.org`
3. On your next login, the system will detect working SSH and skip managed key generation

If you have a managed key and want to switch to your own:

1. Set up your own SSH keys on the clusters
2. Go to **Manage Keys** → **Remove Key**
3. The system will use your own keys going forward

### Why do I need to re-login after a server restart?

For security, decrypted SSH keys are only held in memory during active sessions. After a server restart, you'll need to log in again to decrypt your key. Your JWT session token may still be valid, but you'll be prompted to re-enter your password.

**Note:** If you use your own SSH keys (not managed), server restarts don't affect you - just log in normally.

### Where are IDE settings stored?

- **VS Code**: `~/.vscode-slurm/`
- **RStudio**: `~/.rstudio-hpc/`
- **JupyterLab**: `~/.jupyter/`

Settings persist between sessions.

## Python & R

### Which Python version?

Python comes from the container image, matched to your Bioconductor release. Check with `python --version` in terminal.

### Can I install packages?

Yes:
- **R**: `install.packages()` installs to `R_LIBS_USER`
- **Python**: `pip install --user` or create a virtualenv

### Why won't my package install?

Common causes:
1. **Disk quota** - Check with `quota` command
2. **Compilation needs** - Some packages need system libraries
3. **Version conflicts** - Try creating a fresh environment

## Getting Help

### How do I report an issue?

Contact support with:
1. Your username
2. Which cluster
3. What you were doing
4. Any error messages

### Is there documentation?

You're reading it! Browse the help sections for specific topics.

### Where can I learn more about HPRCC?

- HPRCC documentation from the HPC team
- SLURM documentation: https://slurm.schedmd.com/
- Software Carpentry HPC lessons
