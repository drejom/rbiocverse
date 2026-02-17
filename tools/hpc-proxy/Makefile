# HPC Proxy Build Configuration
#
# Build targets for multi-platform compilation

BINARY_NAME=hpc-proxy
VERSION?=dev
BUILD_TIME=$(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
LDFLAGS=-ldflags "-X main.version=$(VERSION) -X main.buildTime=$(BUILD_TIME) -s -w"

.PHONY: all build build-linux test clean install fmt vet

# Default: build for current platform
all: build

# Build for current platform
build:
	go build $(LDFLAGS) -o $(BINARY_NAME) .

# Cross-compile for Linux (HPC clusters run Linux)
build-linux:
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o $(BINARY_NAME)-linux-amd64 .

# Run tests
test:
	go test -v ./...

# Clean build artifacts
clean:
	rm -f $(BINARY_NAME) $(BINARY_NAME)-linux-amd64

# Install to ~/bin (for local testing)
install: build
	mkdir -p ~/bin
	cp $(BINARY_NAME) ~/bin/

# Format code
fmt:
	go fmt ./...

# Vet code
vet:
	go vet ./...
