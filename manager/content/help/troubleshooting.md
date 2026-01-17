# Troubleshooting

Common issues and solutions.

## Connection Problems

### "Connection lost" or blank screen

1. **Check if your job is running** - Look at the launcher. If the session panel is gone, your job ended.
2. **Click Connect again** - The SSH tunnel may have dropped. Reconnecting usually works.
3. **Job time expired?** - Launch a new session with more walltime.
4. **Cluster unreachable?** - Network issues. Wait a few minutes and try again.

### IDE won't load

- **First launch is slow** - Extensions initializing. Wait 30-60 seconds.
- **Try a different browser** - Chrome/Edge work best.
- **Clear browser cache** - Sometimes fixes rendering issues.
- **Check job status** - Make sure you're still in "Running" state.

### Stuck on "Pending"

Your job is waiting in the SLURM queue.

**Try:**
1. **Request fewer resources** - Smaller jobs queue faster
2. **Check health indicators** - Red bars mean long waits
3. **Use the other cluster** - Apollo vs Gemini may differ
4. **GPU jobs** - GPU queues are often shorter than CPU queues

## Performance Issues

### IDE is slow/laggy

- **Request more CPUs/memory** - Increase resources
- **Close unused tabs** - Many open files slow VS Code
- **Restart your session** - Memory leaks can accumulate
- **Check your code** - Infinite loops or memory issues

### "Out of memory" errors

1. Request more memory when launching
2. Process data in chunks
3. Use disk-based formats (parquet, zarr)
4. Monitor with `htop` in terminal

### Long queue times

- **Check fairshare** - Low fairshare = lower priority
- **Try off-peak hours** - Early morning/evenings are quieter
- **Use shorter walltime** - Easier to schedule
- **Check both clusters** - Utilization differs

## IDE-Specific Issues

### VS Code: Extensions not loading

Extensions are stored in your home directory. If they don't load:

1. Wait for first-time initialization (can take a minute)
2. Check Extensions panel for errors
3. Try reinstalling the extension
4. Check disk quota - extensions need space

### VS Code: Keyboard shortcuts not working

Browser captures some shortcuts. See the [VS Code](/help/vscode) help section for solutions.

### RStudio: Session won't start

- **Check .Rprofile** - Errors in startup files break RStudio
- **Rename .rstudio-hpc** - `mv ~/.rstudio-hpc ~/.rstudio-hpc.bak`
- **Launch from command line** - See error messages

### JupyterLab: Kernel dies

Usually out of memory:

1. Request more memory
2. Restart kernel to clear memory
3. Process data in smaller chunks
4. Check for memory leaks

## Network/Proxy Issues

### Live Server not accessible

The Live Server proxy routes port 5500:

1. Start Live Server in VS Code
2. Access via `/live/` in your browser
3. Make sure your app serves on port 5500

### Shiny app not accessible

Shiny proxy routes port 3838:

1. Run your Shiny app on port 3838
2. Access via `/shiny/` in your browser
3. Check the terminal for errors

## Still Stuck?

If these solutions don't help:

1. **Check the node** - Note which node you're on (shown in session panel)
2. **Check SLURM** - Run `squeue -u $USER` in terminal
3. **Look at logs** - Check `~/.vscode-slurm/` or `~/.rstudio-hpc/` for error logs
4. **Try a fresh session** - Stop and relaunch with defaults
5. **Contact support** - Include your username, cluster, and error messages
