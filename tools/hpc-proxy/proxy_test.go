package main

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseRoute(t *testing.T) {
	p := NewProxy(0, false, false)

	tests := []struct {
		name          string
		path          string
		wantPort      int
		wantRemaining string
		wantOk        bool
	}{
		{"valid with path", "/port/5500/index.html", 5500, "/index.html", true},
		{"valid root", "/port/8080/", 8080, "/", true},
		{"valid no trailing slash", "/port/3000", 3000, "/", true},
		{"valid nested path", "/port/5500/css/style.css", 5500, "/css/style.css", true},
		{"invalid no port prefix", "/foo/5500/bar", 0, "", false},
		{"invalid port not number", "/port/abc/bar", 0, "", false},
		{"invalid empty", "", 0, "", false},
		{"invalid just port", "/port/", 0, "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			port, remaining, ok := p.parseRoute(tt.path)
			if ok != tt.wantOk {
				t.Errorf("parseRoute(%q) ok = %v, want %v", tt.path, ok, tt.wantOk)
			}
			if port != tt.wantPort {
				t.Errorf("parseRoute(%q) port = %d, want %d", tt.path, port, tt.wantPort)
			}
			if remaining != tt.wantRemaining {
				t.Errorf("parseRoute(%q) remaining = %q, want %q", tt.path, remaining, tt.wantRemaining)
			}
		})
	}
}

func TestAbsPathPatternRewriting(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		port   int
		want   string
	}{
		{
			name:  "rewrite href absolute path",
			input: `<a href="/foo/bar">link</a>`,
			port:  5500,
			want:  `<a href="/port/5500/foo/bar">link</a>`,
		},
		{
			name:  "rewrite src absolute path",
			input: `<script src="/js/app.js"></script>`,
			port:  5500,
			want:  `<script src="/port/5500/js/app.js"></script>`,
		},
		{
			name:  "rewrite link href",
			input: `<link rel="stylesheet" href="/css/style.css">`,
			port:  8080,
			want:  `<link rel="stylesheet" href="/port/8080/css/style.css">`,
		},
		{
			name:  "preserve relative URLs",
			input: `<a href="relative.html">link</a>`,
			port:  5500,
			want:  `<a href="relative.html">link</a>`,
		},
		{
			name:  "preserve protocol-relative URLs",
			input: `<script src="//cdn.example.com/lib.js"></script>`,
			port:  5500,
			want:  `<script src="//cdn.example.com/lib.js"></script>`,
		},
		{
			name:  "preserve full URLs",
			input: `<a href="https://example.com/page">link</a>`,
			port:  5500,
			want:  `<a href="https://example.com/page">link</a>`,
		},
		{
			name:  "rewrite action attribute",
			input: `<form action="/submit">`,
			port:  5500,
			want:  `<form action="/port/5500/submit">`,
		},
		{
			name:  "multiple attributes",
			input: `<link href="/css/a.css"><script src="/js/b.js">`,
			port:  5500,
			want:  `<link href="/port/5500/css/a.css"><script src="/port/5500/js/b.js">`,
		},
		{
			name:  "single quotes",
			input: `<a href='/foo'>link</a>`,
			port:  5500,
			want:  `<a href='/port/5500/foo'>link</a>`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			prefix := "/port/" + string(rune('0'+tt.port/1000)) + string(rune('0'+(tt.port%1000)/100)) + string(rune('0'+(tt.port%100)/10)) + string(rune('0'+tt.port%10))
			// Use the actual prefix format
			prefix = "/port/" + itoa(tt.port)
			result := absPathPattern.ReplaceAllString(tt.input, "${1}"+prefix+"${2}")
			if result != tt.want {
				t.Errorf("rewrite(%q) = %q, want %q", tt.input, result, tt.want)
			}
		})
	}
}

// Simple int to string for test (avoid fmt import overhead)
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func TestRewriteHTML(t *testing.T) {
	p := NewProxy(0, true, false)

	tests := []struct {
		name        string
		html        string
		contentType string
		port        int
		wantBase    bool
		wantRewrite bool
	}{
		{
			name:        "rewrites HTML with absolute paths",
			html:        `<html><head></head><body><link href="/css/style.css"></body></html>`,
			contentType: "text/html",
			port:        5500,
			wantBase:    true,
			wantRewrite: true,
		},
		{
			name:        "ignores non-HTML",
			html:        `{"href": "/api/data"}`,
			contentType: "application/json",
			port:        5500,
			wantBase:    false,
			wantRewrite: false,
		},
		{
			name:        "handles HTML with charset",
			html:        `<html><head></head><body><a href="/foo">link</a></body></html>`,
			contentType: "text/html; charset=utf-8",
			port:        5500,
			wantBase:    true,
			wantRewrite: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := &http.Response{
				Header: http.Header{
					"Content-Type": []string{tt.contentType},
				},
				Body: io.NopCloser(strings.NewReader(tt.html)),
			}

			err := p.rewriteHTML(resp, tt.port)
			if err != nil {
				t.Fatalf("rewriteHTML() error = %v", err)
			}

			body, _ := io.ReadAll(resp.Body)
			result := string(body)

			prefix := "/port/" + itoa(tt.port)
			hasBase := strings.Contains(result, `<base href="`+prefix+`/">`)
			hasRewrite := strings.Contains(result, prefix+"/")

			if tt.wantBase && !hasBase {
				t.Errorf("expected base tag with prefix %s, got: %s", prefix, result)
			}
			if !tt.wantBase && hasBase {
				t.Errorf("unexpected base tag in: %s", result)
			}
			if tt.wantRewrite && !hasRewrite {
				t.Errorf("expected URL rewriting with prefix %s, got: %s", prefix, result)
			}
		})
	}
}

func TestRewriteHTMLGzipped(t *testing.T) {
	p := NewProxy(0, true, false)

	// Create gzipped HTML content
	html := `<html><head></head><body><link href="/css/style.css"></body></html>`
	var buf strings.Builder
	gw := gzip.NewWriter(&buf)
	gw.Write([]byte(html))
	gw.Close()

	resp := &http.Response{
		Header: http.Header{
			"Content-Type":     []string{"text/html"},
			"Content-Encoding": []string{"gzip"},
		},
		Body: io.NopCloser(strings.NewReader(buf.String())),
	}

	err := p.rewriteHTML(resp, 5500)
	if err != nil {
		t.Fatalf("rewriteHTML() error = %v", err)
	}

	// Response should be decompressed
	if resp.Header.Get("Content-Encoding") != "" {
		t.Error("expected Content-Encoding to be removed")
	}

	body, _ := io.ReadAll(resp.Body)
	result := string(body)

	if !strings.Contains(result, "/port/5500/css/style.css") {
		t.Errorf("expected rewritten URL, got: %s", result)
	}
}

func TestProxyServeHTTP(t *testing.T) {
	// Create a test backend server
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<html><head></head><body><a href="/foo">link</a></body></html>`))
	}))
	defer backend.Close()

	// Extract port from backend URL
	backendPort := strings.TrimPrefix(backend.URL, "http://127.0.0.1:")

	p := NewProxy(0, true, false)
	port, err := p.Start()
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer p.Shutdown()

	// Make request to proxy
	req := httptest.NewRequest("GET", "/port/"+backendPort+"/test", nil)
	w := httptest.NewRecorder()

	p.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	body := w.Body.String()
	if !strings.Contains(body, "/port/"+backendPort+"/foo") {
		t.Errorf("expected rewritten URL in response, got: %s", body)
	}

	_ = port // used to start the proxy
}

func TestProxyInvalidRoute(t *testing.T) {
	p := NewProxy(0, false, false)

	req := httptest.NewRequest("GET", "/invalid/path", nil)
	w := httptest.NewRecorder()

	p.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", w.Code)
	}
}

func TestProxyInvalidPort(t *testing.T) {
	p := NewProxy(0, false, false)

	tests := []struct {
		path string
	}{
		{"/port/0/foo"},
		{"/port/99999/foo"},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			req := httptest.NewRequest("GET", tt.path, nil)
			w := httptest.NewRecorder()

			p.ServeHTTP(w, req)

			if w.Code != http.StatusBadRequest {
				t.Errorf("expected status 400 for %s, got %d", tt.path, w.Code)
			}
		})
	}
}
