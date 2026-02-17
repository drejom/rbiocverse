// HPC Proxy - Per-user reverse proxy for multi-user HPC environments
//
// Routes /port/:port/* requests to localhost::port, allowing multiple users
// to run development servers on the same compute node without port conflicts.
//
// Usage:
//   hpc-proxy --port 9001
//   hpc-proxy --port 9001 --base-rewrite  # Inject <base> tags for relative URLs
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

var (
	// Build-time variables set via ldflags
	version   = "dev"
	buildTime = "unknown"

	// CLI flags
	port        int
	baseRewrite bool
	portFile    string
	verbose     bool
	showVersion bool
)

func init() {
	flag.IntVar(&port, "port", 0, "Port to listen on (required, or use 0 for auto-assign)")
	flag.BoolVar(&baseRewrite, "base-rewrite", false, "Inject <base> tag into HTML responses for relative URL handling")
	flag.StringVar(&portFile, "port-file", "", "File to write assigned port (default: ~/.hpc-proxy/port)")
	flag.BoolVar(&verbose, "verbose", false, "Enable verbose logging")
	flag.BoolVar(&showVersion, "version", false, "Print version and exit")
}

func main() {
	flag.Parse()

	if showVersion {
		fmt.Printf("hpc-proxy version %s (built %s)\n", version, buildTime)
		os.Exit(0)
	}

	// Default port file location
	if portFile == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			log.Fatalf("Cannot determine home directory: %v", err)
		}
		portFile = filepath.Join(home, ".hpc-proxy", "port")
	}

	// Create proxy server
	proxy := NewProxy(port, baseRewrite, verbose)

	// Start listening (may auto-assign port if port=0)
	actualPort, err := proxy.Start()
	if err != nil {
		log.Fatalf("Failed to start proxy: %v", err)
	}

	// Write port to file for tunnel discovery
	if err := writePortFile(portFile, actualPort); err != nil {
		log.Fatalf("Failed to write port file: %v", err)
	}

	log.Printf("HPC Proxy listening on :%d (port file: %s)", actualPort, portFile)
	if baseRewrite {
		log.Printf("Base tag rewriting enabled")
	}

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("Shutting down...")
	proxy.Shutdown()

	// Clean up port file
	os.Remove(portFile)
}

func writePortFile(path string, port int) error {
	// Ensure directory exists
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}

	// Write port atomically
	content := fmt.Sprintf("%d\n", port)
	return os.WriteFile(path, []byte(content), 0644)
}
