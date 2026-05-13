package wizard

import (
	"net"
	"testing"
)

// devport_check_test.go covers ServerListeningOnPort.

func TestServerListeningOnPort_TrueWhenSomethingListens(t *testing.T) {
	// Bind to a free port on loopback so we have a known-listening
	// socket. The kernel assigns the port when we pass 0.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	if !ServerListeningOnPort(port) {
		t.Errorf("expected true for a port we just bound, got false")
	}
}

func TestServerListeningOnPort_FalseWhenPortFree(t *testing.T) {
	// Bind + immediately close to get a port we know is unused. There's
	// a tiny TOCTOU race (the kernel could reuse the port between
	// `Close` and `Dial`) but the window is microseconds; reliable
	// enough for unit-test purposes.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	if ServerListeningOnPort(port) {
		t.Errorf("expected false for a port we just freed, got true")
	}
}

func TestServerListeningOnPort_FalseForInvalidPort(t *testing.T) {
	for _, p := range []int{0, -1, -42} {
		if ServerListeningOnPort(p) {
			t.Errorf("port %d should be rejected as invalid, got true", p)
		}
	}
}
