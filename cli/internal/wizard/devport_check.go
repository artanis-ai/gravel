package wizard

import (
	"net"
	"strconv"
	"time"
)

// ServerListeningOnPort reports whether something is listening on the
// loopback interface at `port`. Used by the wizard to detect the
// classic "user already had their dev server running when they ran
// init, so the wizard wrote mount code into files the running
// process won't see until it restarts" footgun.
//
// Returns false on any dial error (port closed, address-in-use racing
// the kernel, etc.) — we only want a positive signal so a false
// negative is safer than a false positive.
//
// 200 ms timeout because we're hitting 127.0.0.1; any longer and the
// wizard pauses noticeably on every run when the port is genuinely
// free.
func ServerListeningOnPort(port int) bool {
	if port <= 0 {
		return false
	}
	conn, err := net.DialTimeout(
		"tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 200*time.Millisecond,
	)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
