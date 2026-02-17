package main

import (
	"compress/gzip"
	"context"
	"fmt"
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
	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", p.port))
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

// ServeHTTP handles all incoming requests
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

	// Check for WebSocket upgrade
	if isWebSocketRequest(r) {
		p.handleWebSocket(w, r, targetPort, remainingPath)
		return
	}

	// Regular HTTP proxy
	p.handleHTTP(w, r, targetPort, remainingPath)
}

// parseRoute extracts port and path from /port/:port/remaining/path
func (p *Proxy) parseRoute(path string) (port int, remaining string, ok bool) {
	// Match /port/1234 or /port/1234/anything
	pattern := regexp.MustCompile(`^/port/(\d+)(/.*)?$`)
	matches := pattern.FindStringSubmatch(path)
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

// handleHTTP proxies regular HTTP requests
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
		req.Header.Set("X-Forwarded-Proto", "https")
		req.Header.Set("X-Original-Path", r.URL.Path)
	}

	// Optionally modify response for base tag injection
	if p.baseRewrite {
		proxy.ModifyResponse = func(resp *http.Response) error {
			return p.injectBaseTag(resp, targetPort)
		}
	}

	// Handle errors
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("Proxy error to port %d: %v", targetPort, err)
		http.Error(w, fmt.Sprintf("Service on port %d unavailable", targetPort), http.StatusBadGateway)
	}

	proxy.ServeHTTP(w, r)
}

// handleWebSocket proxies WebSocket connections
func (p *Proxy) handleWebSocket(w http.ResponseWriter, r *http.Request, targetPort int, path string) {
	// Preserve query string for WebSocket connections
	if r.URL.RawQuery != "" {
		path = path + "?" + r.URL.RawQuery
	}
	// Connect to backend
	backendAddr := fmt.Sprintf("127.0.0.1:%d", targetPort)
	backendConn, err := net.DialTimeout("tcp", backendAddr, 10*time.Second)
	if err != nil {
		log.Printf("WebSocket backend connect failed: %v", err)
		http.Error(w, "Backend unavailable", http.StatusBadGateway)
		return
	}

	// Hijack client connection
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		backendConn.Close()
		http.Error(w, "WebSocket not supported", http.StatusInternalServerError)
		return
	}

	clientConn, _, err := hijacker.Hijack()
	if err != nil {
		backendConn.Close()
		log.Printf("Hijack failed: %v", err)
		return
	}

	// Forward the upgrade request to backend
	upgradeReq := p.buildUpgradeRequest(r, path)
	if _, err := backendConn.Write([]byte(upgradeReq)); err != nil {
		clientConn.Close()
		backendConn.Close()
		log.Printf("Failed to send upgrade request: %v", err)
		return
	}

	// Bidirectional copy
	go func() {
		io.Copy(backendConn, clientConn)
		backendConn.Close()
	}()
	go func() {
		io.Copy(clientConn, backendConn)
		clientConn.Close()
	}()

	if p.verbose {
		log.Printf("WebSocket connection established to port %d", targetPort)
	}
}

// buildUpgradeRequest constructs the WebSocket upgrade request
func (p *Proxy) buildUpgradeRequest(r *http.Request, path string) string {
	var sb strings.Builder

	// Request line
	sb.WriteString(fmt.Sprintf("GET %s HTTP/1.1\r\n", path))

	// Copy relevant headers
	for name, values := range r.Header {
		// Skip hop-by-hop headers except for WebSocket-related ones
		nameLower := strings.ToLower(name)
		if nameLower == "connection" || nameLower == "upgrade" ||
			nameLower == "sec-websocket-key" || nameLower == "sec-websocket-version" ||
			nameLower == "sec-websocket-extensions" || nameLower == "sec-websocket-protocol" ||
			nameLower == "host" || nameLower == "origin" {
			for _, v := range values {
				sb.WriteString(fmt.Sprintf("%s: %s\r\n", name, v))
			}
		}
	}

	sb.WriteString("\r\n")
	return sb.String()
}

// injectBaseTag modifies HTML responses to inject a <base> tag
func (p *Proxy) injectBaseTag(resp *http.Response, targetPort int) error {
	contentType := resp.Header.Get("Content-Type")
	if !strings.Contains(contentType, "text/html") {
		return nil
	}

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

	// Inject base tag after <head>
	baseTag := fmt.Sprintf(`<base href="/port/%d/">`, targetPort)
	bodyStr := string(body)

	// Try to inject after <head> tag
	headPattern := regexp.MustCompile(`(?i)(<head[^>]*>)`)
	if headPattern.MatchString(bodyStr) {
		bodyStr = headPattern.ReplaceAllString(bodyStr, "${1}\n"+baseTag)
	} else {
		// Fallback: inject at start of document
		bodyStr = baseTag + "\n" + bodyStr
	}

	// Update response (always return uncompressed for simplicity)
	resp.Body = io.NopCloser(strings.NewReader(bodyStr))
	resp.ContentLength = int64(len(bodyStr))
	resp.Header.Set("Content-Length", strconv.Itoa(len(bodyStr)))
	if isGzipped {
		resp.Header.Del("Content-Encoding")
	}

	return nil
}

// isWebSocketRequest checks if this is a WebSocket upgrade request
func isWebSocketRequest(r *http.Request) bool {
	return strings.ToLower(r.Header.Get("Upgrade")) == "websocket" &&
		strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade")
}
