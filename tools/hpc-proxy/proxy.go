package main

import (
	"compress/gzip"
	"context"
	"fmt"
	"html"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Pre-compiled regexes for performance
var (
	routePattern = regexp.MustCompile(`^/port/(\d+)(/.*)?$`)
	headPattern  = regexp.MustCompile(`(?i)(<head[^>]*>)`)
	// Match existing base tag to avoid duplicates
	baseTagPattern = regexp.MustCompile(`(?i)<base\s+[^>]*href=`)
	// Match href="/..." and src="/..." (absolute paths starting with single /)
	// Captures: $1 = attribute prefix (e.g., href="), $2 = the path (e.g., /foo/bar)
	absPathPattern = regexp.MustCompile(`((?:href|src|action)=["'])(/[^"']*)`)
)

// Proxy handles HTTP/WebSocket reverse proxying with path-based routing
type Proxy struct {
	port        int
	baseRewrite bool
	verbose     bool
	server      *http.Server
	listener    net.Listener
}

// NewProxy creates a new proxy instance
func NewProxy(port int, baseRewrite, verbose bool) *Proxy {
	return &Proxy{
		port:        port,
		baseRewrite: baseRewrite,
		verbose:     verbose,
	}
}

// Start begins listening and returns the actual port (useful when port=0)
func (p *Proxy) Start() (int, error) {
	// Bind to all interfaces so SSH tunnel can reach via node hostname
	// Security: runs inside Singularity container, HPC compute nodes aren't externally accessible
	listener, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", p.port))
	if err != nil {
		return 0, fmt.Errorf("listen: %w", err)
	}
	p.listener = listener

	// Get actual port (in case p.port was 0)
	actualPort := listener.Addr().(*net.TCPAddr).Port
	p.port = actualPort

	p.server = &http.Server{
		Handler:      p,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 0, // Disable for WebSocket/SSE
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		if err := p.server.Serve(listener); err != http.ErrServerClosed {
			log.Printf("Server error: %v", err)
		}
	}()

	return actualPort, nil
}

// Shutdown gracefully stops the proxy
func (p *Proxy) Shutdown() {
	if p.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		p.server.Shutdown(ctx)
	}
}

// ServeHTTP handles all incoming requests (HTTP and WebSocket)
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Parse route: /port/:port/*
	targetPort, remainingPath, ok := p.parseRoute(r.URL.Path)
	if !ok {
		http.Error(w, "Invalid route. Use /port/:port/path", http.StatusBadRequest)
		return
	}

	// Validate port
	if targetPort < 1 || targetPort > 65535 {
		http.Error(w, "Invalid port number", http.StatusBadRequest)
		return
	}

	if p.verbose {
		log.Printf("%s %s -> localhost:%d%s", r.Method, r.URL.Path, targetPort, remainingPath)
	}

	// Proxy HTTP/WebSocket request (httputil.ReverseProxy handles both in Go 1.21+)
	p.handleHTTP(w, r, targetPort, remainingPath)
}

// parseRoute extracts port and path from /port/:port/remaining/path
func (p *Proxy) parseRoute(path string) (port int, remaining string, ok bool) {
	matches := routePattern.FindStringSubmatch(path)
	if matches == nil {
		return 0, "", false
	}

	port, err := strconv.Atoi(matches[1])
	if err != nil {
		return 0, "", false
	}

	remaining = matches[2]
	if remaining == "" {
		remaining = "/"
	}

	return port, remaining, true
}

// handleHTTP proxies HTTP and WebSocket requests using httputil.ReverseProxy
func (p *Proxy) handleHTTP(w http.ResponseWriter, r *http.Request, targetPort int, path string) {
	target := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", targetPort),
	}

	proxy := httputil.NewSingleHostReverseProxy(target)

	// Customize director to rewrite path
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Path = path
		req.URL.RawPath = path
		// Preserve query string
		req.URL.RawQuery = r.URL.RawQuery
		// Set X-Forwarded headers
		req.Header.Set("X-Forwarded-Host", r.Host)
		// Detect protocol from existing header or TLS state
		proto := r.Header.Get("X-Forwarded-Proto")
		if proto == "" {
			if r.TLS != nil {
				proto = "https"
			} else {
				proto = "http"
			}
		}
		req.Header.Set("X-Forwarded-Proto", proto)
		req.Header.Set("X-Original-Path", r.URL.Path)
	}

	// Optionally modify response for redirect and HTML rewriting
	// Pass the original path so base tag can be set correctly for subdirectories
	originalPath := r.URL.Path
	if p.baseRewrite {
		proxy.ModifyResponse = func(resp *http.Response) error {
			return p.rewriteResponse(resp, targetPort, originalPath)
		}
	}

	// Handle errors
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("Proxy error to port %d: %v", targetPort, err)
		http.Error(w, fmt.Sprintf("Service on port %d unavailable", targetPort), http.StatusBadGateway)
	}

	proxy.ServeHTTP(w, r)
}

// rewriteResponse modifies responses to fix absolute URLs for path-based routing
// This includes both HTML content and redirect Location headers
// originalPath is the full request path (e.g., /port/5500/docs/) used to compute the base tag
func (p *Proxy) rewriteResponse(resp *http.Response, targetPort int, originalPath string) error {
	prefix := fmt.Sprintf("/port/%d", targetPort)

	// Rewrite Location header for any response that has one (redirects, 201 Created, etc.)
	if location := resp.Header.Get("Location"); location != "" {
		// Only rewrite absolute paths (starting with /) that aren't already prefixed
		if strings.HasPrefix(location, "/") && !strings.HasPrefix(location, "/port/") {
			newLocation := prefix + location
			resp.Header.Set("Location", newLocation)
			if p.verbose {
				log.Printf("Rewrote Location header: %s -> %s", location, newLocation)
			}
		}
	}

	// Only process HTML content for body rewriting
	contentType := resp.Header.Get("Content-Type")
	if !strings.Contains(contentType, "text/html") {
		return nil
	}

	// Compute base path for relative URL resolution
	// For /port/5500/docs/index.html -> base is /port/5500/docs/
	// For /port/5500/docs/ -> base is /port/5500/docs/
	// For /port/5500/ -> base is /port/5500/
	// For /port/5500 -> base is /port/5500/ (treat as directory)
	// For /index.html -> base is /
	basePath := originalPath
	if !strings.HasSuffix(basePath, "/") {
		// Check if this looks like a file (has extension) or directory
		// Files: /port/5500/index.html, /foo.css -> strip filename
		// Directories: /port/5500, /docs -> append trailing slash
		lastSlash := strings.LastIndex(basePath, "/")
		lastDot := strings.LastIndex(basePath, ".")
		if lastDot > lastSlash {
			// Has extension after last slash -> it's a file, get directory part
			// e.g., /port/5500/docs/index.html -> /port/5500/docs/
			if lastSlash >= 0 {
				basePath = basePath[:lastSlash+1]
			}
		} else {
			// No extension -> treat as directory, append slash
			// e.g., /port/5500 -> /port/5500/
			basePath = basePath + "/"
		}
	}

	return p.rewriteHTML(resp, prefix, basePath)
}

// rewriteHTML modifies HTML responses to rewrite absolute URLs for path-based routing
// prefix is the port prefix (e.g., /port/5500) for rewriting absolute paths
// basePath is the full directory path (e.g., /port/5500/docs/) for the base tag
func (p *Proxy) rewriteHTML(resp *http.Response, prefix string, basePath string) error {


	// Handle compressed responses
	encoding := resp.Header.Get("Content-Encoding")
	var reader io.Reader = resp.Body
	var isGzipped bool

	if encoding == "gzip" {
		gzReader, err := gzip.NewReader(resp.Body)
		if err != nil {
			// Not actually gzipped, use original body
			reader = resp.Body
		} else {
			reader = gzReader
			isGzipped = true
			defer gzReader.Close()
		}
	}

	// Read body
	body, err := io.ReadAll(reader)
	resp.Body.Close()
	if err != nil {
		return err
	}

	bodyStr := string(body)

	// Rewrite absolute paths: href="/foo" -> href="/port/5500/foo"
	// This handles CSS, JS, links, images, forms with absolute paths
	// Skip protocol-relative URLs (//...) and already-rewritten URLs (/port/...)
	bodyStr = absPathPattern.ReplaceAllStringFunc(bodyStr, func(match string) string {
		// Extract the path part (after the attribute prefix)
		parts := absPathPattern.FindStringSubmatch(match)
		if len(parts) < 3 {
			return match
		}
		attrPrefix := parts[1] // e.g., href="
		path := parts[2]       // e.g., /foo/bar

		// Skip protocol-relative URLs (start with //)
		if strings.HasPrefix(path, "//") {
			return match
		}
		// Skip already-rewritten URLs
		if strings.HasPrefix(path, "/port/") {
			return match
		}
		return attrPrefix + prefix + path
	})

	// Inject base tag for relative URLs using the full path (not just prefix)
	// This ensures relative paths like "deps/..." resolve correctly in subdirectories
	// Skip if HTML already has a base tag to avoid invalid HTML with multiple base tags
	if !baseTagPattern.MatchString(bodyStr) {
		// HTML-escape basePath to prevent XSS via crafted URLs
		baseTag := fmt.Sprintf(`<base href="%s">`, html.EscapeString(basePath))
		if headPattern.MatchString(bodyStr) {
			bodyStr = headPattern.ReplaceAllString(bodyStr, "${1}\n"+baseTag)
		} else {
			// Fallback: if there's no <head>, inject the base tag at the start of the document
			bodyStr = baseTag + "\n" + bodyStr
		}
	}

	// Update response (always return uncompressed for simplicity)
	resp.Body = io.NopCloser(strings.NewReader(bodyStr))
	resp.ContentLength = int64(len(bodyStr))
	resp.Header.Set("Content-Length", strconv.Itoa(len(bodyStr)))
	// Clear Transfer-Encoding since we now have a fixed Content-Length
	resp.Header.Del("Transfer-Encoding")
	resp.TransferEncoding = nil
	if isGzipped {
		resp.Header.Del("Content-Encoding")
	}

	return nil
}
